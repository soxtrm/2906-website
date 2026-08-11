// Loads the board as the genuine origin https://crm.2906.estate (via the TLS
// proxy + Chrome host-resolver mapping) and reports whether the Maps key is
// accepted for that exact origin. No header rewriting involved, so the answer
// is about the key's allow-list and nothing else.
const puppeteer = require('puppeteer')

const ORIGIN = 'https://crm.2906.estate'
const TOKEN = process.env.CRM_TOKEN

;(async () => {
  if (!TOKEN) throw new Error('CRM_TOKEN missing')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--host-resolver-rules=MAP crm.2906.estate 127.0.0.1',
      '--ignore-certificate-errors',
      '--no-sandbox',
    ],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

  await page.setCookie({ name: 'crm_session', value: TOKEN, domain: 'crm.2906.estate', path: '/' })
  const resp = await page.goto(`${ORIGIN}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  console.log('page status:', resp && resp.status())
  console.log('page origin:', await page.evaluate(() => location.origin))

  let ready = false, tiles = 0
  try {
    await page.waitForSelector('.gm-style', { timeout: 25000 })
    await new Promise(r => setTimeout(r, 3000))
    tiles = await page.evaluate(() => document.querySelectorAll('.gm-style img, .gm-style canvas').length)
    ready = await page.evaluate(() => !!(window.google && window.google.maps && window.google.maps.Map))
  } catch (e) { /* map never came up */ }

  const authError = errors.find(t => /Google Maps JavaScript API error/i.test(t))
  const cls = authError ? (authError.match(/API error:\s*(\w+)/) || [])[1] : null
  console.log(`api loaded=${ready}  tiles/canvas=${tiles}  authError=${cls || 'none'}`)
  console.log(cls
    ? `\nVERDICT: the key REFUSES ${ORIGIN} → ${cls}`
    : `\nVERDICT: the key ACCEPTS ${ORIGIN} — the map renders for the production origin`)
  await page.screenshot({ path: 'tests/screenshots/probe-real-origin.png' })
  await browser.close()
})().catch(e => { console.error('FATAL', e); process.exit(1) })
