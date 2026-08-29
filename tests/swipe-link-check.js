// Kev's Prompt A (2026-08-29): one-shot check — visit a swipe URL, assert the
// rendered page contains an expected substring. DB state setup/teardown is
// orchestrated externally (not from inside this script) to avoid nesting
// SSH-quoting inside Node string escaping. Usage:
//   node tests/swipe-link-check.js <id> "<expected substring>"
const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'

async function run() {
  const [, , id, expected] = process.argv
  if (!id || !expected) {
    console.error('usage: node swipe-link-check.js <id> "<expected substring>"')
    process.exit(2)
  }
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  page.setDefaultTimeout(20000)
  try {
    await page.goto(`${BASE}/en/swipe/${encodeURIComponent(id)}`, { waitUntil: 'networkidle2' })
    await page.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      { timeout: 10000 },
      expected,
    )
    console.log(`PASS: "${expected}" found for /swipe/${id}`)
    await browser.close()
    process.exit(0)
  } catch (e) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '(no body)')
    console.error(`FAIL: "${expected}" NOT found for /swipe/${id}`)
    console.error('Actual body text:', bodyText.slice(0, 300))
    await page.screenshot({ path: `tests/screenshots/swipe_check_${id}.png`, fullPage: true }).catch(() => {})
    await browser.close()
    process.exit(1)
  }
}

run()
