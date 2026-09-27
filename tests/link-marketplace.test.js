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
  images: [`https://images.test/${market}-${index}.jpg`, `https://images.test/${market}-${index}-2.jpg`],
  featureFacts: { balcony: { status: 'KNOWN', value: true } },
  description: `Bright ${market} apartment number ${index} with a balcony.`,
  updatedAt: '2026-09-26T10:00:00Z'
})

;(async () => {
  const base = process.env.MARKET_BASE || 'http://127.0.0.1:4174/link-marketplace/'
  const inventory = [...Array.from({ length: 12 }, (_, index) => makeProperty(index + 1)), makeProperty(90, 'sales')]
  const places = [
    { id:'nexus-place:1', name: 'Daily Market', kind: 'grocery', coordinates: [14.501, 35.912] },
    { id:'nexus-place:2', name: 'ATM', kind: 'atm', coordinates: [14.502, 35.913] },
    { id:'nexus-place:3', name: 'Sports Centre', kind: 'sport', coordinates: [14.503, 35.914] }
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
    if (url.includes('/api/nexus/property-routing?')) return request.respond({contentType:'application/json',body:JSON.stringify(url.includes('&place=')?{status:'CONNECTED',geometry:{type:'LineString',coordinates:[[14.501,35.912],[14.502,35.913]]}}:{status:'CONNECTED',publicCoordinates:[14.501,35.912],precision:'APPROXIMATE',originBasis:'PRIVATE_VERIFIED_LOCATION',places:places.map(p=>({id:p.id,routeVerified:true,walkingSeconds:420,walkingDistanceMetres:580,drivingSeconds:180,drivingDistanceMetres:840,routeConfidence:'MODELLED',routeSource:'OSRM / OpenStreetMap'}))})})
    if (url.endsWith('/api/nexus/interest') && request.method() === 'POST') {
      savedRequest = JSON.parse(request.postData())
      return request.respond({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    if (request.resourceType() === 'image' && /images\.test/.test(url)) return request.abort()
    request.continue()
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.listing-card')
  assert.equal(await page.title(), 'Nexus Housing — Malta homes')
  let state = await page.evaluate(() => ({
    cards: document.querySelectorAll('.listing-rail')[0]?.querySelectorAll('.listing-card').length,
    sales: [...document.querySelectorAll('.listing-card')].some(card => /420,000/.test(card.textContent)),
    overflow: document.documentElement.scrollWidth - innerWidth,
    cardWidth: document.querySelector('.listing-card')?.getBoundingClientRect().width,
    smartData: document.querySelector('.card-smart')?.textContent
  }))
  assert.equal(state.cards, 12)
  assert.equal(state.sales, false, 'sale listing leaked into the default rental market')
  assert.ok(state.overflow <= 1, `mobile marketplace overflowed by ${state.overflow}px`)
  assert.ok(state.cardWidth >= 280, `marketplace cards are too narrow at ${state.cardWidth}px`)
  assert.equal(state.smartData, undefined, 'front cards must stay free of smart-data blocks')
  const wheelScroll = await page.$eval('.listing-rail', async rail => {
    rail.style.scrollBehavior = 'auto'
    rail.scrollLeft = 5
    const pointer=(type,x,pointerType='mouse')=>rail.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:100,pointerType}))
    const wheel=(deltaX=0)=>{const e=new WheelEvent('wheel',{deltaX,deltaY:180,bubbles:true,cancelable:true});rail.querySelector('.listing-card').dispatchEvent(e);return e.defaultPrevented}
    pointer('pointerenter',100)
    const defaultPrevented=wheel()
    pointer('pointermove',132)
    await new Promise(resolve=>setTimeout(resolve,550))
    const before=rail.scrollLeft,rightPrevented=wheel(),after=rail.scrollLeft
    pointer('pointermove',110)
    const leftPrevented=wheel()
    await new Promise(resolve=>setTimeout(resolve,950))
    const leftStillReleased=!wheel()
    pointer('pointerleave',110)
    pointer('pointerenter',100)
    await new Promise(resolve=>setTimeout(resolve,950))
    const dwellPrevented=wheel(),horizontalNative=!wheel(250)
    pointer('pointerleave',100)
    pointer('pointerenter',100,'touch')
    const touchNative=!wheel()
    return {before,after,defaultPrevented,rightPrevented,leftPrevented,leftStillReleased,dwellPrevented,horizontalNative,touchNative}
  })
  assert.ok(wheelScroll.after > wheelScroll.before, `mouse wheel did not move the hovered property rail horizontally: ${JSON.stringify(wheelScroll)}`)
  assert.equal(wheelScroll.defaultPrevented,false,'ordinary page scrolling must not be captured')
  assert.equal(wheelScroll.rightPrevented,true)
  assert.equal(wheelScroll.leftPrevented,false)
  assert.equal(wheelScroll.leftStillReleased,true,'leftward escape must persist while hovering')
  assert.equal(wheelScroll.dwellPrevented,true)
  assert.equal(wheelScroll.horizontalNative,true)
  assert.equal(wheelScroll.touchNative,true)

  await page.click('.card-favourite')
  assert.equal(await page.$eval('.card-favourite',n=>n.getAttribute('aria-pressed')),'true')
  await page.click('[data-select-home]')
  assert.equal(await page.$eval('[data-selection-count]',n=>n.textContent),'1')
  await page.click('[data-card-photo="1"]')
  assert.equal(await page.$eval('[data-card-photo="1"]',n=>n.getAttribute('aria-pressed')),'true')
  await page.click('.card-locality-link')
  await page.waitForSelector('#village-drawer[open] .brochure-map .leaflet-pane')
  assert.ok(await page.$('#village-drawer .brochure-stories'))
  await page.screenshot({path:'brochure-mobile-smoke.png'})
  await page.click('#village-drawer [data-close]')
  assert.equal(await page.$eval('.matrix-banner',n=>n.getAttribute('href')),'/link-matrix')
  await page.type('#query', 'no listing can match this')
  assert.equal(await page.$eval('.listing-rail', rail => rail.querySelectorAll('.listing-card').length), 12, 'draft filter applied before Show homes')
  await page.click('#apply-filters')
  await page.waitForFunction(() => document.querySelectorAll('.listing-card').length === 0)
  assert.match(await page.$eval('#filter-state span', node => node.textContent), /Showing applied/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.listing-card')
  assert.equal(await page.$eval('#query', input => input.value), '')
  assert.equal(await page.$eval('.listing-rail', rail => rail.querySelectorAll('.listing-card').length), 12, 'reload did not reset marketplace filters')

  await page.click('[data-market="sales"]')
  await page.waitForFunction(() => document.querySelector('.listing-rail')?.querySelectorAll('.listing-card').length === 1)
  assert.match(await page.$eval('.listing-card', card => card.textContent), /€420,000/)

  await page.click('[data-market="longlets"]')
  await page.click('.listing-card')
  await page.waitForSelector('#property-drawer[open]')
  await page.click('[data-gallery-index="1"]')
  await page.waitForFunction(()=>document.querySelector('[data-gallery-index="1"]')?.getAttribute('aria-pressed')==='true')
  assert.equal(await page.$eval('.world-photo-count',n=>n.textContent), '2 / 2')
  assert.equal(await page.$eval('.world-hero',n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)')
  assert.equal(await page.$eval('.source-pill',n=>n.textContent),'AGENCY')
  const intelligence = await page.evaluate(() => ({
    world: Boolean(document.querySelector('.property-world')),
    connectors: document.querySelectorAll('[data-connector]').length,
    precision: document.querySelector('.property-anchor-label')?.textContent,
    matrixHref: document.querySelector('.world-bridges a')?.getAttribute('href'),
    fit: document.querySelector('.fit-section')?.textContent
  }))
  assert.equal(intelligence.world, true)
  assert.equal(intelligence.connectors, 10)
  assert.match(intelligence.precision, /APPROXIMATE/)
  assert.match(intelligence.matrixHref, /\/link-matrix#\/property\/2906-longlets-/)
  assert.match(intelligence.fit, /Powered by Nexus Link/)
  await page.click('[data-connector="daily"]')
  await new Promise(resolve => setTimeout(resolve, 750))
  assert.equal(await page.$eval('.intelligence-map', map => map.dataset.activeConnector), 'daily')
  assert.match(await page.$eval('[data-connector-results]', node => node.textContent), /Daily Market/)
  await page.waitForFunction(()=>document.querySelector('[data-connector-results]')?.textContent.includes('7 min walk'))
  assert.match(await page.$eval('[data-connector-results]',node=>node.textContent), /0.58 km/)
  await page.waitForSelector('.leaflet-container')
  await page.click('[data-map-place="nexus-place:1"]')
  await page.waitForFunction(()=>document.querySelector('[data-map-route-note]')?.textContent.includes('Walking route'))
  await page.click('[data-route-mode="car"]')
  await page.waitForFunction(()=>document.querySelector('[data-map-route-note]')?.textContent.includes('Driving route'))
  await page.screenshot({ path: 'marketplace-property-mobile-smoke.png', fullPage: false })
  await page.click('[data-connector="mobility"]')
  assert.match(await page.$eval('[data-connector-results]', node => node.textContent), /9 individual observations/)
  assert.match(await page.$eval('[data-connector-results]', node => node.textContent), /Road kilometres required/)
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
