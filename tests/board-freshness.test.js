// ============================================================================
// tests/board-freshness.test.js — the Available button's freshness ladder and
// the top-right timer badge.
//
//   never confirmed    outline only
//   < 30h              full strength green
//   30–60h             half strength green
//   > 60h              faint green + amber ring  (the auto-reachout band)
//
// Every live listing has last_confirmed_available_at = NULL, so only one tier is
// reachable from real data. This test SEEDS three listings at 2h / 40h / 80h
// over ssh, asserts what the board renders, and restores all three in a finally
// block. It writes only to that one column on three rows.
// ============================================================================
const puppeteer = require('puppeteer')
const { execFileSync } = require('child_process')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const VPS = 'root@178.104.162.193'

const pass = []
const fail = []
const ok = (n, extra) => pass.push(extra ? `${n} (${extra})` : n)
const no = (n, why) => fail.push(`${n}: ${why}`)

function sql(query) {
  // Flattened first: JSON.stringify turns a real newline into a literal \n,
  // which psql -c reads as a stray backslash and rejects.
  const oneLine = String(query).replace(/\s+/g, ' ').trim()
  return execFileSync('ssh', [VPS,
    `docker exec -i 2906_postgres psql -U 2906user -d 2906db -A -t -c ${JSON.stringify(oneLine)}`,
  ], { encoding: 'utf8', timeout: 30000 }).trim()
}

// Parse "rgb(47, 111, 87)" / "rgba(47, 111, 87, 0.55)" into an alpha number.
// The ladder is expressed as alpha over one hue, so alpha IS the brightness.
function alphaOf(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || '')
  if (!m) return null
  const parts = m[1].split(',').map(s => parseFloat(s.trim()))
  return parts.length === 4 ? parts[3] : 1
}
function isFreshHue(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || '')
  if (!m) return false
  const [r, g, b] = m[1].split(',').map(s => parseFloat(s.trim()))
  return r === 47 && g === 111 && b === 87
}

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')

  // Three active listings to dress up, newest first so they land on page one.
  const refs = sql(`SELECT ref FROM properties
                     WHERE COALESCE(available_status,'available') IN ('available','available_confirmed')
                     ORDER BY created_at DESC LIMIT 3`).split('\n').map(s => s.trim()).filter(Boolean)
  if (refs.length < 3) throw new Error(`need 3 active listings, found ${refs.length}`)
  const [freshRef, ageingRef, staleRef] = refs
  console.log(`  fresh=${freshRef}  ageing=${ageingRef}  stale=${staleRef}`)

  const before = {}
  for (const r of refs) {
    before[r] = sql(`SELECT COALESCE(available_status,'') || '|' || COALESCE(last_confirmed_available_at::text,'') FROM properties WHERE ref = '${r}'`)
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [`--host-resolver-rules=MAP ${process.env.HOST_MAP || 'crm.localhost 127.0.0.1'}`, '--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1100 })
  await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/', httpOnly: true, sameSite: 'Lax' })

  try {
    // ── seed the three ages ───────────────────────────────────────────────────
    const seed = (ref, hours) => sql(
      `UPDATE properties SET available_status = 'available_confirmed', ` +
      `last_confirmed_available_at = NOW() - INTERVAL '${hours} hours' WHERE ref = '${ref}'`)
    seed(freshRef, 2)
    seed(ageingRef, 40)
    seed(staleRef, 80)

    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'networkidle2', timeout: 45000 })
    await page.waitForFunction(() => document.body.innerText.includes('#2906-'), { timeout: 25000 })

    // Read each card's Available button + timer badge, keyed by ref.
    const cards = await page.evaluate(() => {
      const out = {}
      for (const span of Array.from(document.querySelectorAll('span'))) {
        const t = (span.textContent || '').trim()
        if (!/^#2906-[A-Za-z0-9-]+$/.test(t)) continue
        // Walk up to the card, then find its Available button and timer pill.
        let card = span
        for (let i = 0; i < 6 && card; i++) {
          if (card.querySelector && card.querySelector('img')) break
          card = card.parentElement
        }
        if (!card) continue
        const btn = Array.from(card.querySelectorAll('button'))
          .find(b => /Available$/.test((b.textContent || '').trim()))
        const pill = Array.from(card.querySelectorAll('span'))
          .find(s => /^(unconfirmed|just now|\d+h)$/.test((s.textContent || '').trim()))
        if (!btn) continue
        const cs = getComputedStyle(btn)
        out[t.slice(1)] = {
          text: (btn.textContent || '').trim(),
          bg: cs.backgroundColor,
          color: cs.color,
          border: cs.borderColor,
          pill: pill ? (pill.textContent || '').trim() : null,
          pillBorder: pill ? getComputedStyle(pill).borderColor : null,
        }
      }
      return out
    })

    const f = cards[freshRef], a = cards[ageingRef], s = cards[staleRef]
    if (!f || !a || !s) {
      no('all three seeded cards rendered',
        `fresh=${!!f} ageing=${!!a} stale=${!!s}`)
    } else {
      // ── the ladder ────────────────────────────────────────────────────────
      const af = alphaOf(f.bg), aa = alphaOf(a.bg), as = alphaOf(s.bg)
      if (isFreshHue(f.bg) && isFreshHue(a.bg) && isFreshHue(s.bg))
        ok('all three tiers use the one freshness hue')
      else no('all three tiers use the one freshness hue', `${f.bg} / ${a.bg} / ${s.bg}`)

      if (af > aa && aa > as)
        ok('green fades monotonically as the confirmation ages', `${af} > ${aa} > ${as}`)
      else no('green fades monotonically as the confirmation ages', `2h=${af} 40h=${aa} 80h=${as}`)

      if (af === 1) ok('<30h burns at full strength', String(af))
      else no('<30h burns at full strength', String(af))

      if (aa > 0.4 && aa < 1) ok('30–60h is half strength', String(aa))
      else no('30–60h is half strength', String(aa))

      if (as < 0.3) ok('>60h is faint', String(as))
      else no('>60h is faint', String(as))

      // The stale band is the one that triggers an owner re-ask, so it gets a
      // marker that is not just "a bit paler than the last one".
      const amber = /201,\s*138,\s*26/.test(s.border) || /201,\s*138,\s*26/.test(s.pillBorder || '')
      if (amber) ok('>60h carries the amber reachout ring')
      else no('>60h carries the amber reachout ring', `border=${s.border} pill=${s.pillBorder}`)

      // ── the timer badge ───────────────────────────────────────────────────
      if (f.pill === '2h') ok('timer reads 2h on the fresh card', f.pill)
      else no('timer reads 2h on the fresh card', String(f.pill))
      if (a.pill === '40h') ok('timer reads 40h on the ageing card', a.pill)
      else no('timer reads 40h on the ageing card', String(a.pill))
      if (s.pill === '80h') ok('timer reads 80h on the stale card', s.pill)
      else no('timer reads 80h on the stale card', String(s.pill))

      if (f.text === '✓ Available' && s.text === '✓ Available')
        ok('confirmed cards read "✓ Available"')
      else no('confirmed cards read "✓ Available"', `${f.text} / ${s.text}`)
    }

    // ── the unconfirmed tier, from a real untouched row ──────────────────────
    const untouched = sql(`SELECT ref FROM properties
                            WHERE COALESCE(available_status,'available') = 'available'
                              AND last_confirmed_available_at IS NULL
                            ORDER BY created_at DESC LIMIT 1`).trim()
    const u = cards[untouched]
    if (!u) {
      // Not on the first screen is fine — assert the tier exists somewhere.
      const anyUnconfirmed = Object.values(cards).some(c => c.pill === 'unconfirmed')
      if (anyUnconfirmed) ok('the unconfirmed tier renders', 'found on another card')
      else no('the unconfirmed tier renders', `no card showed "unconfirmed"`)
    } else {
      if (u.pill === 'unconfirmed') ok('never-confirmed card reads "unconfirmed"', untouched)
      else no('never-confirmed card reads "unconfirmed"', String(u.pill))
      if (alphaOf(u.bg) === 0 || /rgba\(0,\s*0,\s*0,\s*0\)/.test(u.bg) || u.bg === 'rgb(255, 255, 255)')
        ok('never-confirmed is outline-only, no fill', u.bg)
      else no('never-confirmed is outline-only, no fill', u.bg)
      if (u.text === 'Available') ok('never-confirmed omits the tick', u.text)
      else no('never-confirmed omits the tick', u.text)
    }

  } finally {
    for (const r of refs) {
      const [status, lcaa] = before[r].split('|')
      sql(`UPDATE properties SET available_status = ${status ? `'${status}'` : 'NULL'}, ` +
          `last_confirmed_available_at = ${lcaa ? `'${lcaa}'` : 'NULL'} WHERE ref = '${r}'`)
    }
    const check = refs.map(r =>
      sql(`SELECT COALESCE(available_status,'') || '|' || COALESCE(last_confirmed_available_at::text,'') FROM properties WHERE ref = '${r}'`))
    const restored = refs.every((r, i) => check[i] === before[r])
    console.log(`  restored: ${restored ? 'yes' : 'NO — CHECK BY HAND'} (${check.join(' , ')})`)
    if (restored) ok('all three rows restored exactly')
    else no('all three rows restored exactly', check.join(' , '))
    await browser.close()
  }

  console.log(`\n=== PASS ${pass.length}  FAIL ${fail.length} ===`)
  pass.forEach(p => console.log(`  PASS  ${p}`))
  fail.forEach(f2 => console.log(`  FAIL  ${f2}`))
  if (fail.length) process.exit(1)
}

run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1) })
