const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'
const TEST_TOKEN = process.env.CRM_TEST_TOKEN || ''

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.setCookie({ name: 'crm_session', value: TEST_TOKEN, domain: 'localhost', path: '/', httpOnly: false })

  await page.goto(`${BASE}/crm/clientgroups`, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, 1000))
  await page.screenshot({ path: 'tests/screenshots/clientgroups_list.png' })

  // Open the first card's detail sheet to see the restyled controls.
  const opened = await page.evaluate(() => {
    const card = document.querySelector('[class*="cursor-pointer"][class*="rounded-lg"]')
    if (card) { card.click(); return true }
    return false
  })
  console.log('clientgroups: opened a card?', opened)
  await new Promise(r => setTimeout(r, 1200))
  await page.screenshot({ path: 'tests/screenshots/clientgroups_detail_controls.png' })

  await page.goto(`${BASE}/crm/ownergroups`, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, 1000))
  await page.screenshot({ path: 'tests/screenshots/ownergroups_list.png' })

  const ownerHref = await page.evaluate(() => {
    const card = document.querySelector('[class*="cursor-pointer"][class*="rounded-lg"]')
    return card ? true : false
  })
  if (ownerHref) {
    await page.evaluate(() => document.querySelector('[class*="cursor-pointer"][class*="rounded-lg"]').click())
    await new Promise(r => setTimeout(r, 1200))
    // Click the "Owner Flows" tab
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const b = btns.find(x => x.textContent?.trim() === 'Owner Flows')
      if (b) b.click()
    })
    await new Promise(r => setTimeout(r, 800))
    await page.screenshot({ path: 'tests/screenshots/ownergroups_flows_controls.png' })
  }
  console.log('ownergroups: opened detail?', ownerHref)

  await browser.close()
  console.log('done')
}
run().catch(e => { console.error(e); process.exit(1) })
