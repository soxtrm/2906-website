const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'
const [, , label] = process.argv

async function shot(browser, url, outfile) {
  const page = await browser.newPage()
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: outfile })
  await page.close()
}

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  await shot(browser, `${BASE}/en/swipe/l7b9wWEBX6Yt`, `tests/screenshots/swipe_single_${label}.png`)
  await shot(browser, `${BASE}/en/swipe/g4OI7qZBFXe1`, `tests/screenshots/swipe_multi_${label}.png`)
  await browser.close()
  console.log(`done: ${label}`)
}
run().catch(e => { console.error(e); process.exit(1) })
