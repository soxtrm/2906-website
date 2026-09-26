const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')

const makeProperty = (index, market = 'longlets') => ({
  id: `2906-${market}-${index}`,
  area: index % 2 ? 'sliema' : 'st-julians',
  areaLabel: index % 2 ? 'Sliema' : "St Julian's",
  coordinates: [14.50 + index * .0005, 35.91 + index * .0003],
  locationDisclosure: 'approximate',
  market,
  status: 'available',
  listable: true,
  rent: market === 'sales' ? 420000 : 1200 + index * 50,
  currency: 'EUR',
  rentPeriod: market === 'sales' ? null : 'month',
  bedrooms: index % 3 + 1,
  bathrooms: 1,
  size: 72 + index,
  availableFrom: '2026-10-01',
  rentalModes: market === 'stays' ? ['SHORT_LET'] : ['LONG_LET'],
  propertyType: 'apartment',
  images: [`https://images.test/${market}-${index}.jpg`],
  featureFacts: { balcony: { status: 'KNOWN', value: true } },
  description: `Bright ${market} apartment number ${index} with a balcony.`,
  updatedAt: '2026-09-26T10:00:00Z'
})

;(async () => {
  const base = process.env.MARKET_BASE || 'http://127.0.0.1:4174/link-marketplace/'
  const inventory = [...Array.from({ length: 12 }, (_, index) => makeProperty(index + 1)), makeProperty(90, 'sales')]
  const places = [
    { name: 'Daily Market', kind: 'grocery', coordinates: [14.501, 35.912] },
    { name: 'ATM', kind: 'atm', coordinates: [14.502, 35.913] },
    { name: 'Sports Centre', kind: 'sport', coordinates: [14.503, 35.914] }
  ]
  let savedRequest = null
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 1 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = request.url()
    if (url.endsWith('/api/nexus/inventory')) return request.respond({ contentType: 'application/json', body: JSON.stringify({ meta: { firewall_leaks: [] }, properties: inventory }) })
    if (url.endsWith('/api/nexus/places')) return request.respond({ contentType: 'application/json', body: JSON.stringify({ records: places }) })
    if (url.endsWith('/api/nexus/interest') && request.method() === 'POST') {
      savedRequest = JSON.parse(request.postData())
      return request.respond({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    if (request.resourceType() === 'image' && /images\.test/.test(url)) return request.abort()
    request.continue()
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.listing-card')
  let state = await page.evaluate(() => ({
    cards: document.querySelectorAll('.listing-card').length,
    sales: [...document.querySelectorAll('.listing-card')].some(card => /420,000/.test(card.textContent)),
    overflow: document.documentElement.scrollWidth - innerWidth,
    columns: getComputedStyle(document.querySelector('.listing-grid')).gridTemplateColumns.split(' ').length
  }))
  assert.equal(state.cards, 12)
  assert.equal(state.sales, false, 'sale listing leaked into the default rental market')
  assert.ok(state.overflow <= 1, `mobile marketplace overflowed by ${state.overflow}px`)
  assert.equal(state.columns, 2)

  await page.type('#query', 'no listing can match this')
  assert.equal(await page.$$eval('.listing-card', cards => cards.length), 12, 'draft filter applied before Show homes')
  await page.click('#apply-filters')
  await page.waitForFunction(() => document.querySelectorAll('.listing-card').length === 0)
  assert.match(await page.$eval('#filter-state span', node => node.textContent), /Showing applied/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.listing-card')
  assert.equal(await page.$eval('#query', input => input.value), '')
  assert.equal(await page.$$eval('.listing-card', cards => cards.length), 12, 'reload did not reset marketplace filters')

  await page.click('[data-market="sales"]')
  await page.waitForFunction(() => document.querySelectorAll('.listing-card').length === 1)
  assert.match(await page.$eval('.listing-card', card => card.textContent), /€420,000/)

  await page.click('[data-market="longlets"]')
  await page.click('.listing-card')
  await page.waitForSelector('#property-drawer[open]')
  await page.click('#property-drawer [data-open-tunnel]')
  await page.waitForSelector('#tunnel-dialog[open]')
  await page.click('[data-role="agent"]')
  await page.type('#tunnel-form input[type="email"]', 'agent@example.com')
  await page.select('#tunnel-form select[name="window"]', 'day')
  await page.$eval('#tunnel-form input[name="date"]', input => { input.value = '2026-10-02' })
  await page.click('.tunnel-submit')
  await page.waitForFunction(() => document.querySelector('.tunnel-submit')?.textContent.includes('Saved'))
  assert.equal(savedRequest.criteria.requesterRole, 'agent')
  assert.equal(savedRequest.criteria.contactRoute, 'best')
  assert.equal(savedRequest.criteria.scheduling.window, 'day')
  assert.match(savedRequest.criteria.propertyRef, /^2906-longlets-/)

  await page.click('[data-temp-schedule]')
  await page.waitForSelector('.temporary-schedule')
  assert.match(await page.$eval('.schedule-status', node => node.textContent), /QR CONNECTION PENDING/)

  await page.screenshot({ path: 'marketplace-mobile-smoke.png', fullPage: true })
  await browser.close()
  console.log('link marketplace mobile flow passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
