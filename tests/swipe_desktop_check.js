const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${BASE}/en/swipe/l7b9wWEBX6Yt`, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: 'tests/screenshots/swipe_single_desktop_after.png' })
  await browser.close()
  console.log('done')
}
run().catch(e => { console.error(e); process.exit(1) })
