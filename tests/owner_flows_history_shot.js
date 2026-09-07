const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'
const TEST_TOKEN = process.env.CRM_TEST_TOKEN || ''

async function fullContentHeight(page) {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('body *'))
    let tallest = 0
    for (const el of all) {
      const cs = getComputedStyle(el)
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) tallest = Math.max(tallest, el.scrollHeight)
    }
    return Math.max(tallest, document.documentElement.scrollHeight)
  })
}

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  const viewport = { width: 1440, height: 900 }
  await page.setViewport(viewport)
  await page.setCookie({ name: 'crm_session', value: TEST_TOKEN, domain: 'localhost', path: '/', httpOnly: false })

  await page.goto(`${BASE}/crm/owner/2282`, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, 800))
  await page.evaluate(() => { Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Flows')?.click() })
  await new Promise(r => setTimeout(r, 500))
  let h = await fullContentHeight(page)
  await page.setViewport({ ...viewport, height: h + 40 })
  await page.screenshot({ path: 'tests/screenshots/owner_automation_flows.png' })
  await page.setViewport(viewport)

  await page.goto(`${BASE}/crm/owner/3721`, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, 800))
  await page.evaluate(() => { Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'History')?.click() })
  await new Promise(r => setTimeout(r, 500))
  h = await fullContentHeight(page)
  await page.setViewport({ ...viewport, height: h + 40 })
  await page.screenshot({ path: 'tests/screenshots/owner_multi_history.png' })

  await browser.close()
  console.log('done')
}
run().catch(e => { console.error(e); process.exit(1) })
