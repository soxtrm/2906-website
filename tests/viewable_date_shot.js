const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'
const TEST_TOKEN = process.env.CRM_TEST_TOKEN || ''

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1000 })
  await page.setCookie({ name: 'crm_session', value: TEST_TOKEN, domain: 'localhost', path: '/', httpOnly: false })

  await page.goto(`${BASE}/crm/schedule-board`, { waitUntil: 'networkidle2', timeout: 25000 })
  await new Promise(r => setTimeout(r, 1500))
  // Search for the specific ref that reported the bug.
  const searched = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="earch" i], input[type="search" i], input[type="text"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '2906-9193')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  console.log('searched?', searched)
  await new Promise(r => setTimeout(r, 1200))
  await page.screenshot({ path: 'tests/screenshots/viewable_date_fix.png' })
  await browser.close()
  console.log('done')
}
run().catch(e => { console.error(e); process.exit(1) })
