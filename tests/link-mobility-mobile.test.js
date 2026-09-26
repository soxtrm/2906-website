const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')

;(async () => {
  const base = process.env.LINK_BASE || 'http://127.0.0.1:4174/Link/'
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (/\/Link\/config\.js/.test(request.url())) return request.respond({ contentType: 'text/javascript', body: "window.NEXUS_CONFIG={mode:'demo',designInventory:false};" })
    request.continue()
  })
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('nexus-link-intent-market', 'longlets')
    sessionStorage.setItem('nexus-link-profile', JSON.stringify({
      household: 'single', people: 1, nationality: 'German', jobTitle: 'Analyst', transport: 'bus', homeOffice: 'onsite',
      requirements: {}, priorities: {}, favoriteTowns: [], allowOutside: false,
      anchors: [{ type: 'work', person: 'You', location: 'Swieqi', address: 'Swieqi', placeId: 'test-work', coordinates: [14.481, 35.92], days: 5, time: '12:00' }]
    }))
  })
  await page.goto(`${base}#property/demo-sliema-01`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.mobility-reality')
  await page.waitForSelector('.confidence-observed')
  const result = await page.evaluate(() => ({
    title: document.querySelector('.mobility-reality h2')?.textContent,
    modes: [...document.querySelectorAll('.mobility-mode-name b')].slice(0, 4).map(node => node.textContent),
    dimensions: document.querySelector('.mobility-table-head')?.textContent,
    confidence: [...document.querySelectorAll('.confidence-pill')].map(node => node.textContent),
    bodyOverflow: document.documentElement.scrollWidth - innerWidth,
    routine: document.querySelector('[data-routine-options]')?.textContent,
    observedCost: [...document.querySelectorAll('.mobility-mode')].find(node => /Bolt/.test(node.textContent))?.textContent
  }))
  assert.match(result.title, /journeys/i)
  assert.deepEqual(result.modes, ['Bus', 'Bolt', 'Walk', 'Car'])
  assert.match(result.dimensions, /TIME/)
  assert.match(result.dimensions, /MONEY/)
  assert.match(result.dimensions, /RELIABILITY/)
  assert.match(result.dimensions, /COMFORT/)
  assert.ok(result.confidence.includes('UNKNOWN'))
  assert.ok(result.bodyOverflow <= 1, `mobile body overflowed by ${result.bodyOverflow}px`)
  assert.match(result.routine, /GYM & SPORT/)
  assert.match(result.observedCost, /€12\.5|€12,5/)
  const relevantErrors = errors.filter(error => !/favicon|Failed to load resource.*404/i.test(error))
  assert.deepEqual(relevantErrors, [])
  await page.screenshot({ path: 'mobility-mobile-smoke.png', fullPage: true })
  await browser.close()
  console.log('link mobility mobile smoke passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
