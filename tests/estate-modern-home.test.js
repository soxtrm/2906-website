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
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('smart intelligence'), { timeout: 15000 })

    const result = await page.evaluate(() => {
      const tabLabels = Array.from(document.querySelectorAll('[role="tab"]')).map(node => node.textContent?.trim())
      const permanentSmartCards = Array.from(document.querySelectorAll('article')).filter(node => node.textContent?.includes('SMART FILTER')).length
      return {
        hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        tabLabels,
        permanentSmartCards,
        title: document.querySelector('h1')?.textContent?.trim() || '',
      }
    })

    if (result.hasOverflow) failures.push(`${name}: horizontal overflow`)
    if (!result.tabLabels.includes('Aesthetic selection') || !result.tabLabels.includes('All properties')) failures.push(`${name}: collection tabs missing`)
    if (result.permanentSmartCards !== 0) failures.push(`${name}: smart data is attached before the filter is active`)
    if (!result.title) failures.push(`${name}: hero heading missing`)

    const allTab = await page.$('[role="tab"]:nth-child(2)')
    if (allTab) {
      await allTab.click()
      const selected = await allTab.evaluate(node => node.getAttribute('aria-selected'))
      if (selected !== 'true') failures.push(`${name}: all-properties tab did not activate`)
    }

    const smartToggleFound = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.includes('Smart intelligence'))
      button?.click()
      return Boolean(button)
    })
    if (!smartToggleFound) failures.push(`${name}: Smart intelligence control missing`)
    else {
      await new Promise(resolve => setTimeout(resolve, 100))
      const choiceCount = await page.$$eval('button[aria-pressed]', nodes => nodes.filter(node => /Weekly shop|Coast|Health|Gym/.test(node.textContent || '')).length)
      if (choiceCount < 4) failures.push(`${name}: Smart intelligence priorities missing`)
    }

    await page.screenshot({ path: `tests/screenshots/estate-modern-${name}.png`, fullPage: true })
  }

  await verifyViewport('mobile', { width: 390, height: 844, deviceScaleFactor: 1 })
  await verifyViewport('desktop', { width: 1440, height: 1000, deviceScaleFactor: 1 })

  const propertyHref = await page.$eval('a[href*="/property/"]', node => node.getAttribute('href'))
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.goto(`${BASE}${propertyHref}`, { waitUntil: 'networkidle2', timeout: 45000 })
  await page.waitForSelector('h1')
  const detail = await page.evaluate(() => ({
    hasOverview: document.body.innerText.includes('See how this home fits real life.'),
    hasPros: document.body.innerText.includes('AT A GLANCE · ADVANTAGES'),
    hasTradeoffs: document.body.innerText.includes('CHECK BEFORE YOU DECIDE'),
    hasWeeklyShop: document.body.innerText.includes('Weekly shopping'),
    hasSmartStats: document.body.innerText.toLowerCase().includes('area signals') && document.body.innerText.toLowerCase().includes('weekly shop'),
    hasNexusLink: Boolean(document.querySelector('a[href*="link-matrix"]')),
    hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }))
  if (!detail.hasOverview || !detail.hasPros || !detail.hasTradeoffs || !detail.hasWeeklyShop || !detail.hasSmartStats || !detail.hasNexusLink) failures.push(`property detail: decision overview incomplete ${JSON.stringify(detail)}`)
  if (detail.hasOverflow) failures.push('property detail: horizontal overflow')
  await page.screenshot({ path: 'tests/screenshots/property-life-overview-mobile.png', fullPage: true })

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
  console.log('PASS: clean listing cards, optional smart filter, property life overview, responsive layouts, and /old legacy route')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
