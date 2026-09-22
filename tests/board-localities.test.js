// ============================================================================
// tests/board-localities.test.js — the Agent Board resolves EVERY valid Malta locality.
//
// Regression (2026-09-22): the board placed/filtered listings with a hand-kept copy of the
// backend's town table (41 towns vs 76+), so Santa Venera — and 20+ other real localities —
// had no village chip, no pin position and no filter. The backend now sends each listing's
// canonical locality (key/label/lat/lng) and the board registers it; this suite proves it
// in a real browser, with the exact towns that used to fail.
//
//   BASE=http://crm.localhost:3000 CRM_TOKEN=… ZZ_REFS='{"sv":"ZZSV-1",...}' node tests/board-localities.test.js
//
// Expects throwaway listings the runner seeds (each in a different locality the old table lacked):
//   sv Santa Venera · ta Tarxien · mt Mtarfa · gu Gudja       (+ any others the board already holds)
// Read-only: the test only loads the board and clicks village chips.
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const REFS = JSON.parse(process.env.ZZ_REFS || '{}')
const SHOTS = path.join(__dirname, 'screenshots')
const pass = [], fail = []
const ok = (n, x) => { pass.push(n); console.log(`  ok    ${n}${x ? ` — ${x}` : ''}`) }
const no = (n, why) => { fail.push(`${n}: ${why}`); console.error(`  FAIL  ${n}: ${why}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TOWN_OF = { sv: 'Santa Venera', ta: 'Tarxien', mt: 'Mtarfa', gu: 'Gudja' }

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')
  for (const k of Object.keys(TOWN_OF)) if (!REFS[k]) throw new Error(`ZZ_REFS.${k} missing`)
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

  // the village chips: <button> whose text is "<label> <count>"
  const chips = () => page.evaluate(() => [...document.querySelectorAll('button')]
    .map(b => (b.innerText || '').trim().replace(/\s+/g, ' '))
    .map(t => { const m = /^(.+?) (\d+)$/.exec(t); return m ? { label: m[1], n: Number(m[2]) } : null })
    .filter(Boolean))
  const clickChip = (label) => page.evaluate((label) => {
    const b = [...document.querySelectorAll('button')].find(x => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+$`).test((x.innerText || '').trim().replace(/\s+/g, ' ')))
    if (!b) return false
    b.click(); return true
  }, label)
  const hasRef = (ref) => page.evaluate((ref) => (document.body.innerText || '').includes(ref), ref)

  try {
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    // wait until the board has rendered the village chips for the seeded listings
    let list = []
    for (let i = 0; i < 60; i++) { list = await chips(); if (list.some(c => c.label === 'Santa Venera')) break; await sleep(500) }

    // 1. every seeded locality has its village chip (these four were missing from the old static table)
    for (const k of Object.keys(TOWN_OF)) {
      const c = list.find(x => x.label === TOWN_OF[k])
      c ? ok(`village chip: ${TOWN_OF[k]}`, `${c.n} listing(s)`) : no(`village chip: ${TOWN_OF[k]}`, `missing — chips: ${list.map(x => x.label).join(', ').slice(0, 300)}`)
    }
    // no duplicate chip for the same place ("St Paul's Bay" spelled five ways used to be five pins)
    const labels = list.map(x => x.label)
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i)
    dupes.length ? no('one chip per locality', `duplicates: ${[...new Set(dupes)].join(', ')}`) : ok('one chip per locality')

    // 2. filtering by Santa Venera keeps ITS listing and drops the others
    await page.screenshot({ path: path.join(SHOTS, 'board-localities-before.png') })
    if (await clickChip('Santa Venera')) {
      await sleep(800)
      const svIn = await hasRef(REFS.sv), taIn = await hasRef(REFS.ta), mtIn = await hasRef(REFS.mt)
      svIn ? ok('Santa Venera filter shows the Santa Venera listing', REFS.sv) : no('Santa Venera filter', `${REFS.sv} not on the board`)
      !taIn && !mtIn ? ok('Santa Venera filter hides Tarxien / Mtarfa listings') : no('Santa Venera filter', `other towns still visible (tarxien=${taIn}, mtarfa=${mtIn})`)
      await page.screenshot({ path: path.join(SHOTS, 'board-localities-santa-venera.png') })
      await clickChip('Santa Venera')          // toggle off
      await sleep(400)
    } else no('Santa Venera filter', 'chip not clickable')

    // 3. a second locality the old table lacked filters the same way (not a one-off patch)
    if (await clickChip('Tarxien')) {
      await sleep(800)
      const taIn = await hasRef(REFS.ta), svIn = await hasRef(REFS.sv)
      taIn && !svIn ? ok('Tarxien filter shows only Tarxien', REFS.ta) : no('Tarxien filter', `tarxien=${taIn} santaVenera=${svIn}`)
    } else no('Tarxien filter', 'chip not clickable')

    const realErrors = consoleErrors.filter(e => !/favicon|Failed to load resource.*(map|maps|gstatic|google)|DrawingManager|ApiNotActivated|RefererNotAllowed|Google Maps/i.test(e))
    realErrors.length ? no('no page errors', realErrors.slice(0, 3).join(' | ').slice(0, 300)) : ok('no page errors')
  } catch (e) {
    no('run', e.message)
    try { await page.screenshot({ path: path.join(SHOTS, 'board-localities-FAIL.png') }) } catch {}
  } finally {
    await browser.close()
  }
  console.log(`\nPASS: ${pass.length}  FAIL: ${fail.length}`)
  if (fail.length) { fail.forEach(f => console.error('FAIL:', f)); process.exit(1) }
}
run().catch(e => { console.error(e); process.exit(1) })
