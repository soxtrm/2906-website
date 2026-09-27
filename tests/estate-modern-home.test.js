const puppeteer = require('puppeteer')
const fs = require('fs')

const BASE = process.env.BASE_URL || 'http://localhost:3000'

async function run() {
  fs.mkdirSync('tests/screenshots', { recursive: true })
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  const failures = []

  async function verifyViewport(name, viewport) {
    await page.setViewport(viewport)
    await page.goto(`${BASE}/en`, { waitUntil: 'networkidle2', timeout: 30000 })
    await page.waitForSelector('main')
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('powered by nexus link'), { timeout: 15000 })

    const result = await page.evaluate(() => {
      const tabLabels = Array.from(document.querySelectorAll('[role="tab"]')).map(node => node.textContent?.trim())
      const nexusPanels = Array.from(document.querySelectorAll('main a')).filter(node => node.textContent?.includes('Open smart view')).length
      return {
        hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        tabLabels,
        nexusPanels,
        title: document.querySelector('h1')?.textContent?.trim() || '',
      }
    })

    if (result.hasOverflow) failures.push(`${name}: horizontal overflow`)
    if (!result.tabLabels.includes('Aesthetic selection') || !result.tabLabels.includes('All properties')) failures.push(`${name}: collection tabs missing`)
    if (result.nexusPanels < 1) failures.push(`${name}: compact Nexus panels missing`)
    if (!result.title) failures.push(`${name}: hero heading missing`)

    const allTab = await page.$('[role="tab"]:nth-child(2)')
    if (allTab) {
      await allTab.click()
      const selected = await allTab.evaluate(node => node.getAttribute('aria-selected'))
      if (selected !== 'true') failures.push(`${name}: all-properties tab did not activate`)
    }

    await page.screenshot({ path: `tests/screenshots/estate-modern-${name}.png`, fullPage: true })
  }

  await verifyViewport('mobile', { width: 390, height: 844, deviceScaleFactor: 1 })
  await verifyViewport('desktop', { width: 1440, height: 1000, deviceScaleFactor: 1 })

  await page.goto(`${BASE}/en/old`, { waitUntil: 'networkidle2', timeout: 30000 })
  const oldHasLegacy = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase()
    return text.includes('why choose 2906') && text.includes('featured properties')
  })
  if (!oldHasLegacy) failures.push('old route: legacy homepage sections missing')

  await browser.close()
  if (failures.length) {
    failures.forEach(failure => console.error('FAIL:', failure))
    process.exit(1)
  }
  console.log('PASS: modern homepage mobile + desktop, compact Nexus panels, collection tabs, and /old legacy route')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
