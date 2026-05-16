const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  page.setDefaultTimeout(30000)
  const pass = []
  const fail = []

  async function check(name, url, selector) {
    try {
      await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector(selector, { timeout: 8000 })
      pass.push(name)
    } catch (e) {
      fail.push(`${name}: ${e.message}`)
      await page.screenshot({ path: `tests/screenshots/${name.replace(/\s/g,'_')}.png`, fullPage: true })
    }
  }

  async function checkMap() {
    const name = 'malta map overlays'
    try {
      await page.goto(`${BASE}/en`, { waitUntil: 'networkidle2', timeout: 30000 })
      // Wait for base map to load
      await page.waitForSelector('img[alt="Malta map outline"]', { timeout: 8000 })
      const overlayCount = await page.$$eval('img[alt$=" region"]', els => els.length)
      if (overlayCount !== 6) throw new Error(`expected 6 region overlays, got ${overlayCount}`)
      pass.push(name)
    } catch (e) {
      fail.push(`${name}: ${e.message}`)
      await page.screenshot({ path: `tests/screenshots/${name.replace(/\s/g,'_')}.png`, fullPage: true })
    }
  }

  await check('homepage',       '/en',                'main')
  await checkMap()
  await check('all-properties', '/en/all-properties', 'main')
  await check('contact',        '/en/contact',        'input')
  await check('german locale',  '/de',                'main')

  await browser.close()
  console.log(`PASS: ${pass.length}  FAIL: ${fail.length}`)
  pass.forEach(p => console.log('PASS:', p))
  if (fail.length) { fail.forEach(f => console.error('FAIL:', f)); process.exit(1) }
}

run()
