// Screenshots of the real SYNC workspace with a test session (token read from a file, never printed).
//   SYNC_SESSION_FILE=... OWNER_BASE=http://localhost:3141 node tests/sync-live-shots.cjs <outdir>
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const BASE = process.env.OWNER_BASE || 'http://localhost:3141'
const out = process.argv[2] || 'shots'
const token = fs.readFileSync(process.env.SYNC_SESSION_FILE, 'utf8').trim()
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const pg = await browser.newPage()
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await pg.setCookie({ name: 'sync_session', value: token, url: BASE })
  await pg.evaluateOnNewDocument(() => { try { sessionStorage.setItem('ow_splash', '1'); localStorage.removeItem('ow_mode') } catch {} })
  const errors = []
  pg.on('pageerror', e => errors.push(e.message))
  const shot = async (url, name, after) => {
    await pg.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 120000 })
    await new Promise(r => setTimeout(r, 1800))
    if (after) await after()
    const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await pg.screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
    console.log(name, 'overflow', overflow)
  }
  await shot('/owner', '01-overview')
  await shot('/owner/properties', '02-homes')
  const first = await pg.evaluate(() => document.querySelector('.lv-card')?.getAttribute('href'))
  if (first) {
    await shot(first, '03-home')
    await shot(first + '?tab=edit', '04-home-edit')
    await shot(first + '?tab=share', '05-home-share')
    await shot(first + '?tab=hours', '06-home-hours')
  }
  await shot('/owner/requests', '07-requests')
  await shot('/owner/calendar', '08-calendar')
  await shot('/owner/messages', '09-chat')
  await shot('/owner/settings', '10-settings')
  await pg.deleteCookie({ name: 'sync_session', url: BASE })
  await shot('/owner/login', '11-login')
  console.log('errors', errors.length ? errors : 'none')
  await browser.close()
})().catch(e => { console.error(e.message); process.exit(1) })
