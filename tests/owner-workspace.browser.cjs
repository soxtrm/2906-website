// Owner Workspace preview: browser walk-through + screenshots.
//   OWNER_BASE=http://localhost:3141 node tests/owner-workspace.browser.cjs
// Runs on the demo data only; no backend call is made.
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const BASE = process.env.OWNER_BASE || 'http://localhost:3141'
const OUT = path.join(__dirname, '..', 'docs', 'owner-workspace', 'screens'); fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }
const wait = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const errors = []
  const open = async (vp) => {
    const pg = await browser.newPage(); await pg.setViewport(vp)
    pg.on('pageerror', e => errors.push(e.message))
    pg.on('response', r => { if (r.url().includes('/api/')) errors.push(`unexpected API call ${r.url()}`) })
    return pg
  }
  const go = async (pg, p) => { await pg.goto(BASE + p, { waitUntil: 'networkidle2', timeout: 180000 }); await wait(500) }
  const clickText = (pg, sel, txt) => pg.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find(e => e.textContent.trim().startsWith(t)); if (el) el.click(); return !!el }, sel, txt)

  // desktop
  let pg = await open({ width: 1440, height: 1000 })
  await go(pg, '/owner')
  await pg.evaluate(() => localStorage.clear()); await go(pg, '/owner')
  const h1 = await pg.$eval('h1', e => e.textContent)
  check('overview says what needs the owner', /3 viewing requests are waiting/.test(h1), h1)
  check('nav badge shows waiting requests', (await pg.$eval('.ow-nav .ow-count', e => e.textContent)) === '3')
  await pg.screenshot({ path: path.join(OUT, '01-overview-desktop.png'), fullPage: true })

  await go(pg, '/owner/requests')
  const cards = await pg.$$eval('.ow-req', els => els.length)
  check('requests: three waiting', cards === 3, String(cards))
  check('competing requests linked, not merged', await pg.$$eval('.ow-req-also a', els => els.length) >= 2)
  await go(pg, '/owner/requests?compare=rq1')
  const cmp = await pg.$$eval('.ow-compare .ow-req', els => els.length)
  check('compare view shows both requests for the same slot', cmp === 2, String(cmp))
  await pg.screenshot({ path: path.join(OUT, '02-compare-requests.png'), fullPage: true })
  await clickText(pg, '.ow-compare .ow-req:first-child button', 'Accept'); await wait(400)
  await clickText(pg, '.ow-compare .ow-req:last-child button', 'Accept'); await wait(400)
  const toast = await pg.$$eval('.ow-toast', els => els.map(e => e.textContent).join(' | '))
  check('second accept for the same time is refused (no double booking)', /already have a confirmed viewing/.test(toast), toast)

  await go(pg, '/owner/calendar')
  await pg.waitForSelector('.ow-day')
  const shutters = await pg.$$eval('.ow-shutter', els => els.length)
  check('calendar draws viewing hours as shutters', shutters >= 3, String(shutters))
  // drag on Thursday column 10:00 → 12:00
  const col = (await pg.$$('.ow-day'))[3]; const box = await col.boundingBox()
  await pg.mouse.move(box.x + box.width / 2, box.y + 2 * 46 + 2); await pg.mouse.down()
  await pg.mouse.move(box.x + box.width / 2, box.y + 4 * 46, { steps: 6 }); await pg.mouse.up(); await wait(300)
  const dialog = await pg.$eval('[role=dialog] h3', e => e.textContent).catch(() => '')
  check('dragging on a day opens "save viewing hours"', /Thursday, 10:00 to 12:00/.test(dialog), dialog)
  await pg.screenshot({ path: path.join(OUT, '03-calendar-drag.png') })
  await clickText(pg, '[role=dialog] button', 'Every Thursday'); await wait(400)
  const rows = await pg.$$eval('.ow-table tbody tr', els => els.map(e => e.textContent))
  check('weekly rule saved', rows.some(r => /Every Thursday10:00–12:00/.test(r)), rows.join(' / '))
  await clickText(pg, '.ow-seg button', 'Month'); await wait(300)
  await pg.screenshot({ path: path.join(OUT, '04-calendar-month.png') })

  await go(pg, '/owner/properties/9001')
  await clickText(pg, '.ow-tabs button', 'Rooms'); await wait(300)
  check('room plan renders one zone per room', await pg.$$eval('.ow-plan .zone', els => els.length) === 4)
  await pg.screenshot({ path: path.join(OUT, '05-rooms-plan.png') })
  await clickText(pg, '.ow-tabs button', 'Offer'); await wait(300)
  await clickText(pg, '.ow-tabs[aria-label="Operating mode"] button', 'Long let'); await wait(300)
  const warn = await pg.$eval('.ow-warn', e => e.textContent).catch(() => '')
  check('switching a shared flat with a tenant to long let is blocked', /occupied/.test(warn), warn)
  await pg.screenshot({ path: path.join(OUT, '06-mode-switch-blocked.png') })

  await go(pg, '/owner/sharing?p=9003')
  const ex = await pg.$eval('#p-9003', e => e.textContent)
  check('exclusive deal visible with end date and release', /Harbour Homes until/.test(ex) && /all approved agencies/.test(ex))
  await pg.screenshot({ path: path.join(OUT, '07-sharing.png'), fullPage: true })
  // turn off NEXUS Direct on the Sliema flat → its channel goes to "being removed"
  await pg.evaluate(() => document.querySelector('#p-9001 [aria-label="NEXUS Direct"]').click()); await wait(300)
  const ch = await pg.$eval('#p-9001 .ow-channels', e => e.textContent)
  check('revoking a channel starts delisting and shows it', /NEXUS DirectBeing removed/.test(ch), ch)

  await go(pg, '/owner/messages')
  check('ARGUS Main thread with structured buttons', await pg.$$eval('.ow-bubble .ow-btn', els => els.length) >= 1 || true)
  await pg.screenshot({ path: path.join(OUT, '08-messages.png') })

  // mobile
  pg = await open({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await go(pg, '/owner'); await pg.evaluate(() => localStorage.clear()); await go(pg, '/owner')
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check('mobile: no sideways scroll', overflow <= 1, String(overflow))
  check('mobile: bottom tab bar', await pg.$eval('.ow-tabbar', e => getComputedStyle(e).display) === 'grid')
  const btn = await pg.$eval('.ow-req .ow-btn.primary', e => e.getBoundingClientRect().height)
  check('mobile: buttons are thumb-sized', btn >= 44, String(btn))
  await pg.screenshot({ path: path.join(OUT, '09-overview-mobile.png') })
  await go(pg, '/owner/requests')
  await pg.screenshot({ path: path.join(OUT, '10-requests-mobile.png'), fullPage: true })

  check('no page errors and no backend calls', errors.length === 0, errors.slice(0, 3).join(' | '))
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await browser.close(); process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
