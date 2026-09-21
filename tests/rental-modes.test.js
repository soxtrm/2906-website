// ============================================================================
// tests/rental-modes.test.js — WINTER tag, "until <Month>", rental-mode tabs / picker.
//
// Real browser (Puppeteer) against the CRM behind the crm.* host rewrite, with a real CRM
// JWT injected as the crm_session cookie (same as the other board suites).
//
//   BASE=http://crm.localhost:3000 CRM_TOKEN=… node tests/rental-modes.test.js
//
// Expects three throwaway listings the runner seeds (refs ZZWIN-1/2/3, all Sliema €1,400):
//   ZZWIN-1  winter let, until 2027-04-30
//   ZZWIN-2  plain long let, no end date          → NO tag, NO until line
//   ZZWIN-3  winter + short let, until 2027-04-30
// Writes only to ZZWIN-2's rental modes (then puts it back).
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const IDS = JSON.parse(process.env.ZZ_IDS || '{}')
const SHOTS = path.join(__dirname, 'screenshots')
const pass = [], fail = []
const ok = (n, x) => { pass.push(x ? `${n} (${x})` : n); console.log(`  ok    ${n}${x ? ` — ${x}` : ''}`) }
const no = (n, why) => { fail.push(`${n}: ${why}`); console.error(`  FAIL  ${n}: ${why}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')
  if (!IDS.w1 || !IDS.w2 || !IDS.w3) throw new Error('ZZ_IDS env var missing ({"w1":..,"w2":..,"w3":..})')
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [`--host-resolver-rules=MAP ${process.env.HOST_MAP || 'crm.localhost 127.0.0.1'}`, '--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/' })

  // the card / row that contains a ref, found by text (the smallest block holding the ref and its price)
  const cardProbe = (ref) => page.evaluate((ref) => {
    const blocks = [...document.querySelectorAll('div, tr')].filter(el => el.innerText && el.innerText.includes(ref) && el.innerText.includes('1,400') && el.innerText.length < 900)
    blocks.sort((a, b) => a.innerText.length - b.innerText.length)
    const el = blocks[0]
    if (!el) return null
    const winter = el.querySelector('[data-testid="badge-winter"]')
    const short = el.querySelector('[data-testid="badge-short"]')
    const until = el.querySelector('[data-testid="until-line"]')
    // "NEXT TO the locality": the badge shares a parent with the town label, after it
    const nextToTown = !!winter && (() => {
      const kids = [...winter.parentElement.children]
      const townIdx = kids.findIndex(k => /Sliema/.test(k.innerText || ''))
      return townIdx >= 0 && townIdx < kids.indexOf(winter)
    })()
    return { winter: !!winter, short: !!short, until: until ? until.innerText.trim() : null, nextToTown, text: el.innerText.replace(/\s+/g, ' ').slice(0, 200) }
  }, ref)

  const resetW2 = () => page.evaluate(id => fetch(`/api/crm/properties/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rental_modes: [] }) }).then(r => r.status), IDS.w2)

  try {
    // deterministic start: ZZWIN-2 is a plain, unclassified long let whatever an earlier run left behind
    await page.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    const st0 = await resetW2()
    st0 === 200 ? ok('setup: ZZWIN-2 reset to unclassified long let') : no('setup reset', `HTTP ${st0}`)

    // ── 1. SCHEDULE BOARD ────────────────────────────────────────────────────
    console.log('-- board')
    await page.goto(`${BASE}/schedule-board?q=ZZWIN`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForFunction(() => document.body.innerText.includes('ZZWIN-1'), { timeout: 60000 }).catch(() => {})
    await sleep(1500)
    // Board cards do not print the ref (only the brand mark), so the three throwaway cards are found by
    // content: the innermost block holding a photo placeholder, Sliema and the €1.400 price. With the
    // free-text filter on ZZWIN there are exactly three, told apart by which tags they carry.
    const cards = await page.evaluate(() => {
      const isCard = el => { const t = el.innerText || ''; return t.includes('no photo') && t.includes('Sliema') && /1[.,]400/.test(t) && t.length < 500 }
      const all = [...document.querySelectorAll('div')].filter(isCard)
      const inner = all.filter(el => !all.some(o => o !== el && el.contains(o)))
      return inner.map(el => {
        const winter = el.querySelector('[data-testid="badge-winter"]'), short = el.querySelector('[data-testid="badge-short"]'), until = el.querySelector('[data-testid="until-line"]')
        const nextToTown = !!winter && (() => { const kids = [...winter.parentElement.children]; const ti = kids.findIndex(k => /Sliema/.test(k.innerText || '')); return ti >= 0 && ti < kids.indexOf(winter) })()
        return { winter: !!winter, short: !!short, until: until ? until.innerText.trim() : null, nextToTown }
      })
    })
    cards.length === 3 ? ok('board: exactly the three test cards render', `${cards.length}`) : no('board: three test cards', `found ${cards.length}`)
    const winterOnly = cards.filter(c => c.winter && !c.short), both = cards.filter(c => c.winter && c.short), plain = cards.filter(c => !c.winter && !c.short)
    winterOnly.length === 1 && winterOnly[0].nextToTown && winterOnly[0].until === 'until April'
      ? ok('card with a Bis date (ZZWIN-1): WINTER tag sits NEXT TO the locality, "until April" under Available') : no('winter card', JSON.stringify(winterOnly))
    both.length === 1 && both[0].nextToTown && both[0].until === 'until April'
      ? ok('card winter + short let (ZZWIN-3): WINTER and SHORT tags, "until April"') : no('winter+short card', JSON.stringify(both))
    plain.length === 1 && plain[0].until == null
      ? ok('card WITHOUT a Bis date (ZZWIN-2): no tag, no until line — unchanged') : no('plain card must show nothing extra', JSON.stringify(plain))
    // the map block sits above the cards: bring the cards into view so the tags are IN the screenshot
    await page.evaluate(() => { const el = document.querySelector('[data-testid="badge-winter"]'); if (el) el.scrollIntoView({ block: 'center' }) })
    await sleep(400)
    await page.screenshot({ path: path.join(SHOTS, 'rental-board-cards.png') })
    ok('screenshot', 'tests/screenshots/rental-board-cards.png')

    // rental filter (dropdown) — Winter → w1 + w3, Short → w3, Long → w2
    const refsShown = () => page.evaluate(() => ['ZZWIN-1', 'ZZWIN-2', 'ZZWIN-3'].filter(r => document.body.innerText.includes(r)))
    const pick = async (mode) => {
      const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => /^Rental/.test(b.innerText.trim())))
      await btn.asElement().click(); await sleep(300)
      await page.click(`[data-testid="rental-filter-${mode}"]`); await sleep(700)
    }
    await pick('winter_let')
    let shown = await refsShown()
    JSON.stringify(shown) === JSON.stringify(['ZZWIN-1', 'ZZWIN-3']) ? ok('board filter Rental → Winter let', shown.join(', ')) : no('board filter winter', shown.join(', '))
    await page.screenshot({ path: path.join(SHOTS, 'rental-board-filter-winter.png') })
    await pick('short_let'); shown = await refsShown()
    JSON.stringify(shown) === JSON.stringify(['ZZWIN-3']) ? ok('board filter Rental → Short let', shown.join(', ')) : no('board filter short', shown.join(', '))
    await pick('long_let'); shown = await refsShown()
    JSON.stringify(shown) === JSON.stringify(['ZZWIN-2']) ? ok('board filter Rental → Long let', shown.join(', ')) : no('board filter long', shown.join(', '))

    // ── 2. INVENTORY (CRM list) ──────────────────────────────────────────────
    console.log('-- inventory')
    await page.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('[data-testid="rental-tabs"]', { timeout: 60000 })
    await page.click('[data-testid="rental-tab-winter_let"]')
    // the list re-renders up to 500 rows: wait for the filtered result, not a fixed delay
    await page.waitForFunction(() => document.body.innerText.includes('ZZWIN-1') && !document.body.innerText.includes('ZZWIN-2'), { timeout: 30000 }).catch(() => {})
    await sleep(500)
    const inv = await page.evaluate(() => ({ text: document.body.innerText, winter: document.querySelectorAll('[data-testid="badge-winter"]').length }))
    inv.text.includes('ZZWIN-1') && inv.text.includes('ZZWIN-3') && !inv.text.includes('ZZWIN-2') ? ok('inventory tab Winter let → ZZWIN-1 + ZZWIN-3, not ZZWIN-2') : no('inventory winter tab', `1:${inv.text.includes('ZZWIN-1')} 3:${inv.text.includes('ZZWIN-3')} 2:${inv.text.includes('ZZWIN-2')}`)
    inv.winter > 0 ? ok('inventory rows carry the WINTER tag', `${inv.winter} tag(s)`) : no('inventory WINTER tag', 'none')
    await page.screenshot({ path: path.join(SHOTS, 'rental-inventory-winter.png') })
    await page.click('[data-testid="rental-tab-short_let"]'); await sleep(2000)
    const invS = await page.evaluate(() => document.body.innerText)
    invS.includes('ZZWIN-3') && !invS.includes('ZZWIN-1') && !invS.includes('ZZWIN-2') ? ok('inventory tab Short let → only ZZWIN-3') : no('inventory short tab', 'wrong rows')

    // ── 3. PROPERTY DETAIL: picker + until ───────────────────────────────────
    console.log('-- property page')
    await page.goto(`${BASE}/property/${IDS.w1}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('[data-testid="field-available-until"]', { timeout: 60000 })
    const d1 = await page.evaluate(() => ({
      until: document.querySelector('[data-testid="field-available-until"]').value,
      winterChecked: document.querySelector('[data-testid="mode-winter_let"] input').checked,
      shortChecked: document.querySelector('[data-testid="mode-short_let"] input').checked,
      badge: !!document.querySelector('[data-testid="badge-winter"]'),
      untilLine: document.querySelector('[data-testid="until-line"]')?.innerText || null,
    }))
    d1.until === '2027-04-30' && d1.winterChecked && !d1.shortChecked && d1.badge && d1.untilLine === 'until April'
      ? ok('property page ZZWIN-1: picker shows Winter let, Bis field 2027-04-30, header tag + "until April"') : no('property page ZZWIN-1', JSON.stringify(d1))
    await page.screenshot({ path: path.join(SHOTS, 'rental-property-page.png') })

    await page.goto(`${BASE}/property/${IDS.w2}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('[data-testid="mode-short_let"]', { timeout: 60000 })
    // deterministic start: ZZWIN-2 must be a plain, unclassified long let (clear any modes left by an earlier run)
    await page.evaluate(id => fetch(`/api/crm/properties/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rental_modes: [] }) }), IDS.w2)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="mode-short_let"]', { timeout: 60000 }); await sleep(800)
    const saveAndWait = async () => {
      const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => /^Save/i.test(b.innerText.trim())))
      const resp = page.waitForResponse(r => r.request().method() === 'PATCH' && /\/properties\/\d+$/.test(r.url()), { timeout: 30000 })
      await btn.asElement().click(); return (await resp).status()
    }
    await page.click('[data-testid="mode-short_let"] input')     // add SHORT to a plain long let
    const st = await saveAndWait()
    if (st !== 200) no('edit ZZWIN-2: save', `HTTP ${st}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="mode-short_let"]', { timeout: 60000 }); await sleep(800)
    const d2 = await page.evaluate(() => ({ short: document.querySelector('[data-testid="mode-short_let"] input').checked, long: document.querySelector('[data-testid="mode-long_let"] input').checked, badgeShort: !!document.querySelector('[data-testid="badge-short"]') }))
    d2.short && d2.long && d2.badgeShort ? ok('edit ZZWIN-2: Long let + Short let saved, SHORT tag appears (several modes at once)') : no('edit ZZWIN-2', JSON.stringify(d2))
    await page.screenshot({ path: path.join(SHOTS, 'rental-property-edit.png') })
    // put it back to "unclassified" (waits for the save — no drift between runs)
    await page.evaluate(id => fetch(`/api/crm/properties/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rental_modes: [] }) }), IDS.w2)

    const relevantErrors = consoleErrors.filter(e => !/favicon|Failed to load resource.*(maps|google)|ERR_BLOCKED|net::ERR|RefererNotAllowedMapError|Google Maps JavaScript API/i.test(e))   // the Maps key is referrer-restricted: localhost is refused by design
    relevantErrors.length === 0 ? ok('no console/page errors') : no('console errors', relevantErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }
  console.log(`\nPASS: ${pass.length}  FAIL: ${fail.length}`)
  if (fail.length) { fail.forEach(f => console.error('FAIL:', f)); process.exit(1) }
}
run().catch(e => { console.error(e); process.exit(1) })
