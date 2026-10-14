const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')

const makeListing = (id, ref, town, localityKey) => ({
  id, ref, town, localityKey, localityLabel: town, localityLat: 35.9, localityLng: 14.45,
  subLocation: null, type: 'apartment', beds: 2, baths: 1, sizeSqm: 90, price: 1500,
  salePrice: null, shortlet: false, availableStatus: 'available', availableDate: null,
  viewingDate: null, viewingStatus: null, hasViewingLocation: false, exclusive: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  lastConfirmedAvailableAt: null, statusChangeReason: null, images: [], imageCount: 0,
  listedBy: { id: 1, displayName: 'Kevin', colorHex: '#4056e8' }, isMine: true,
  viewing: null, bookingsPossible: true, isHotProperty: false, isFavourite: false,
  contact: { mode: 'owner', reachesName: 'Owner', canAsk: true, reason: null, questionsUsed: 0, questionsPerDay: 2, canQuestion: true, questionReason: null },
  description: `${town} test listing`, features: Array.from({ length: 24 }, (_, index) => `Feature ${index + 1}`),
})

const listings = [
  makeListing(1, '2906-SLIEMA', 'Sliema', 'sliema'),
  makeListing(2, '2906-JULIANS', "St Julian's", 'st-julians'),
  makeListing(3, '2906-MELLIEHA', 'Mellieħa', 'mellieha'),
]

;(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(() => localStorage.setItem('crm_theme_pref', 'dark'))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const raw = request.url()
    if (!raw.includes('/api/crm/')) return request.continue()
    const json = body => request.respond({ contentType: 'application/json', body: JSON.stringify(body) })
    if (raw.endsWith('/api/crm/me')) return json({ agent: { id: 1, username: 'kevin', name: 'Kevin', role: 'admin', daily_reveal_limit: 50 }, reveals: { used: 0, limit: 50 }, nav: ['dashboard', 'inventory', 'board', 'bookings', 'access', 'owners', 'clientgroups', 'ownergroups', 'outreach', 'agentchats', 'profile', 'baseinventory'] })
    const detail = raw.match(/schedule-board\/listings\/(2906-[A-Z]+)$/)
    if (detail) return json(listings.find(listing => listing.ref === detail[1]))
    if (raw.includes('schedule-board/listings?status=rented')) return json({ listings: [] })
    if (raw.includes('schedule-board/listings?')) {
      const selected = new URL(raw).searchParams.get('towns')?.split(',').filter(Boolean) || []
      return json({ listings: selected.length ? listings.filter(listing => selected.includes(listing.localityKey)) : listings })
    }
    if (raw.includes('schedule-board/towns')) return json({ towns: listings.map(listing => ({ key: listing.localityKey, label: listing.town, n: 1 })) })
    if (raw.includes('schedule-board/notifications')) return json({ notifications: [] })
    if (raw.includes('property-changes/pending')) return json([])
    if (raw.includes('schedule-board/config')) return json({})
    if (raw.includes('reachout-settings')) return json({ mode: 'off' })
    return json({})
  })

  await page.goto('http://localhost:4174/crm/schedule-board', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('.crm-listing-card').length === 3)
  const clickArea = label => page.$$eval('.crm-area-chip', (buttons, text) => {
    const button = buttons.find(candidate => candidate.querySelector('span')?.textContent === text)
    if (!button) throw new Error(`Missing area ${text}`)
    button.click()
  }, label)

  await clickArea('Central')
  await page.waitForFunction(() => document.querySelectorAll('.crm-listing-card').length === 2)
  await clickArea('North')
  await page.waitForFunction(() => document.querySelectorAll('.crm-listing-card').length === 3)
  const selectedAreas = await page.$$eval('.crm-area-chip[aria-pressed="true"] span', nodes => nodes.map(node => node.textContent))
  assert.deepEqual(selectedAreas.sort(), ['Central', 'North'], 'areas combine as an OR union')
  assert.deepEqual(await page.$$eval('.crm-city-chip:not(.crm-city-any) span', nodes => nodes.map(node => node.textContent).sort()), ['Mellieħa', 'Sliema', "St Julian's"], 'town row contains the deduplicated union of selected areas')
  assert.equal(await page.$eval('.crm-area-chip span', node => node.closest('button').disabled), false)
  const southDisabled = await page.$$eval('.crm-area-chip', buttons => buttons.find(button => button.querySelector('span')?.textContent === 'South')?.disabled)
  assert.equal(southDisabled, true, 'an area with zero listings cannot create an empty search')

  await clickArea('Central')
  await page.waitForFunction(() => document.querySelectorAll('.crm-listing-card').length === 1)
  assert.equal(await page.$eval('.crm-listing-card', card => card.getAttribute('aria-label').includes('Mellieħa')), true, 'removing one area preserves the other area')

  await page.$eval('.crm-listing-card', card => card.click())
  await page.waitForSelector('.crm-listing-detail-close')
  await page.$eval('.crm-listing-detail-dialog', dialog => { dialog.scrollTop = dialog.scrollHeight })
  const closeGeometry = await page.$eval('.crm-listing-detail-close', button => {
    const rect = button.getBoundingClientRect()
    return { top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight }
  })
  assert.ok(closeGeometry.top >= 0 && closeGeometry.bottom <= closeGeometry.viewportHeight, 'listing close stays vertically visible after scrolling')
  assert.ok(closeGeometry.right <= closeGeometry.viewportWidth, 'listing close stays inside the phone viewport')
  await page.$eval('.crm-listing-detail-close', button => button.click())
  await page.waitForSelector('.crm-listing-detail-dialog', { hidden: true })

  await browser.close()
  console.log('mobile multi-area selection and persistent listing close passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
