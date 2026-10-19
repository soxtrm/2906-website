// ARGUS functional UI (founder mockups 2026-10-19). Mocked backend, no token,
// nothing leaves the browser.
//   npx next dev -p 3109 --webpack
//   CRM_MOCK_BASE=http://localhost:3109 node --test tests/crm-argus-functional-ui.test.cjs
// Screenshots: set ARGUS_SHOTS=<dir>.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { listing, defaultFixtures, serverAvailable, launch, openPage } = require('./helpers/crm-mock.cjs')

const SHOTS = process.env.ARGUS_SHOTS
const shot = async (page, name) => { if (SHOTS) { await new Promise(r => setTimeout(r, 650)); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }
const cards = page => page.$$eval('[data-ref]', els => [...new Set(els.map(e => e.getAttribute('data-ref')))].sort())
const sleep = ms => new Promise(r => setTimeout(r, ms))
// Pages share localStorage; a page left open by a failed assertion would
// keep writing its theme into the next test.
async function open(t, browser, opts) {
  const page = await openPage(browser, opts)
  t.after(() => page.close().catch(() => {}))
  return page
}

function fixtures() {
  const f = defaultFixtures()
  f.listings = [
    listing(1, { town: 'Sliema', beds: 1, price: 1200 }),
    listing(2, { town: 'Sliema', beds: 2, price: 1600 }),
    listing(3, { town: 'Gzira', beds: 2, price: 1400 }),
    listing(4, { town: 'Mosta', beds: 3, price: 2100, rentalModes: ['winter_let'], sharing: false }),
    listing(5, { town: 'Swieqi', beds: 2, price: 2500 }),
  ]
  // Beds / price run server-side; answer like the real handler would.
  f.routes = [[/^schedule-board\/listings$/, 'GET', (_, q) => ({
    listings: q.get('status') === 'rented' ? f.rented : f.listings.filter(l =>
      (!q.get('beds') || q.get('beds').split(',').includes(String(l.beds))) &&
      (!q.get('price_max') || l.price <= Number(q.get('price_max'))) && (!q.get('price_min') || l.price >= Number(q.get('price_min')))),
  })]]
  return f
}
// Clicks in a page that may still be animating.
async function click(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 })
  await page.$eval(selector, el => el.scrollIntoView({ block: 'center' }))
  await page.click(selector)
}

test('ARGUS functional UI', { timeout: 900000 }, async t => {
  if (!(await serverAvailable())) { t.skip('no dev server'); return }
  const browser = await launch()
  t.after(() => browser.close())

  await t.test('mobile: ARGUS · Market · Map · Tools · Smart Filters, light first', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures(), theme: '' })
    await page.waitForSelector('[data-ref]')
    const order = await page.$$eval('.crm-board-islands > *', els => els.map(e => e.className.toString().split(' ').find(c => /crm-(argus-orbit|board-orbs|filter-island)/.test(c))).filter(Boolean))
    assert.deepEqual(order, ['crm-argus-orbit', 'crm-board-orbs', 'crm-filter-island'])
    assert.equal(await page.$eval('html', el => el.dataset.crmTheme), 'light', 'light-first with no stored preference')
    assert.equal(await page.$$eval('.crm-filter-icons .crm-island-feature', els => els.map(e => e.dataset.testid).join(',')), 'island-price,island-availability,island-beds,island-baths,island-types,island-tenancy,island-updated,island-rental')
    assert.ok(await page.$('.crm-bottom-nav'), 'bottom navigation island kept')
    assert.ok(await page.$('.crm-horizon-chip'), 'Active / +3 Months strip kept')
    await shot(page, 'mobile-board')
  })

  await t.test('mobile: ARGUS island expands into search and collapses back', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures() })
    const before = await page.$eval('.crm-argus-orbit', el => el.getBoundingClientRect().width)
    await click(page, '.crm-argus-orbit button')
    await page.waitForSelector('.crm-argus-orbit input[type=search]')
    await sleep(800)
    const after = await page.$eval('.crm-argus-orbit', el => el.getBoundingClientRect().width)
    assert.ok(after > before + 80, `expands horizontally (${before} → ${after})`)
    await shot(page, 'mobile-search-open')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.crm-argus-orbit img[alt=ARGUS]')
  })

  await t.test('mobile: market switch — only Residential Rent is selectable', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures() })
    await click(page, '[data-testid=board-market-button]')
    await page.waitForSelector('[data-testid=board-market-panel]')
    const states = await page.$$eval('[data-testid=board-market-panel] [role=menuitemradio]', els => els.map(e => [e.dataset.testid, e.disabled, e.getAttribute('aria-checked')]))
    assert.deepEqual(states, [
      ['market-residential_rent', false, 'true'], ['market-residential_sale', true, 'false'],
      ['market-commercial_rent', true, 'false'], ['market-commercial_sale', true, 'false'], ['market-short_stays', true, 'false'],
    ])
    await shot(page, 'mobile-market')
    const before = await cards(page)
    await page.$eval('[data-testid=market-commercial_sale]', el => el.click())
    assert.deepEqual(await cards(page), before, 'a disabled market never changes the results')
  })

  await t.test('mobile: Tools holds board operations; Map toggles the map', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures() })
    await click(page, '[data-testid=board-tools-button]')
    await page.waitForSelector('[data-testid=board-tools-panel]')
    const labels = await page.$$eval('[data-testid=board-tools-panel] button span, [data-testid=board-tools-panel] a span', els => els.map(e => e.textContent.trim()))
    for (const l of ['Active board', 'Rented', 'Add property', 'Swipe Links', 'Collection settings', 'Nexus Map']) assert.ok(labels.some(x => x.startsWith(l)), `Tools has ${l}`)
    for (const nav of ['Inventory', 'Owners', 'Bookings', 'Dashboard']) assert.ok(!labels.includes(nav), `Tools does not duplicate navigation (${nav})`)
    await shot(page, 'mobile-tools')
    await click(page, '[data-testid=board-tools-button]')
    await page.waitForFunction(() => !document.querySelector('[data-testid=board-tools-panel]'))
    await click(page, '[data-testid=board-map-button]')
    await page.waitForFunction(() => document.querySelector('[data-testid=board-map-button]')?.getAttribute('aria-pressed') === 'true', { timeout: 10000 })
  })

  await t.test('mobile: filter state is shared — panel, results, and survives closing', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures() })
    await page.waitForSelector('[data-ref]')
    await page.click('[data-testid=island-beds]')
    await page.waitForSelector('#crm-mobile-filter-panel')
    await page.$$eval('#crm-filter-bedrooms button', els => els.find(e => e.textContent.trim() === '2').click())
    await page.waitForFunction(() => new Set([...document.querySelectorAll('[data-ref]')].map(e => e.dataset.ref)).size === 3)
    assert.deepEqual(await cards(page), ['2906-9102', '2906-9103', '2906-9105'])
    await shot(page, 'mobile-filters-beds')
    // Close with "Show N results", then reopen via a different icon: still 2 beds.
    await page.click('.crm-show-results')
    await page.waitForFunction(() => !document.querySelector('#crm-mobile-filter-panel'))
    await page.waitForFunction(() => document.querySelectorAll('[data-ref]').length > 0, { timeout: 10000 })
    assert.deepEqual(await cards(page), ['2906-9102', '2906-9103', '2906-9105'], 'closing the panel keeps the filter')
    assert.equal(await page.$eval('[data-testid=island-beds]', el => el.dataset.selected), 'true')
    await page.click('[data-testid=island-price]')
    await page.waitForSelector('#crm-filter-price input', { visible: true })
    const pressed = await page.$$eval('#crm-filter-bedrooms button[aria-pressed=true]', els => els.map(e => e.textContent.trim()))
    assert.deepEqual(pressed, ['2'])
    await page.type('#crm-filter-price input[placeholder="Any"]', '1500')
    await page.waitForFunction(() => new Set([...document.querySelectorAll('[data-ref]')].map(e => e.dataset.ref)).size === 1)
    assert.deepEqual(await cards(page), ['2906-9103'])
    assert.match(page.url(), /beds=2/)
  })

  await t.test('desktop: 2906 header + navigation, ARGUS island, left filter column', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures(), width: 1440, height: 900 })
    await page.waitForSelector('[data-ref]')
    await page.waitForSelector('[data-testid=board-filter-rail]')
    assert.ok(await page.$eval('.crm-agency-brand img', el => el.getAttribute('alt') === '2906' && el.getBoundingClientRect().width > 40), '2906 mark visible')
    const navLabels = await page.$$eval('.crm-header-nav > .crm-nav-item', els => els.filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()))
    assert.deepEqual(navLabels, ['Dashboard', 'Inventory', 'Board', 'Bookings', 'Outreach', 'Profile'], 'labelled primary nav')
    // Header order: 2906 · ARGUS group (over the results) · nav · theme.
    const xs = await page.evaluate(() => ['.crm-agency-brand', '.crm-argus-orbit', '[data-testid=board-tools-button]', '.crm-header-nav', '.crm-header-actions'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().left)))
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, `left-to-right order ${xs}`)
    const resultsLeft = await page.$eval('[data-ref]', el => el.getBoundingClientRect().left)
    assert.ok(Math.abs(xs[1] - resultsLeft) <= 24, `ARGUS lines up with the results (${xs[1]} vs ${resultsLeft})`)
    assert.ok(navLabels.includes('Board') || navLabels.some(l => /Board/.test(l)), `header nav: ${navLabels.join(', ')}`)
    const rail = await page.$$eval('[data-testid=board-filter-rail] section', els => els.map(e => e.dataset.rail))
    assert.deepEqual(rail, ['location', 'price', 'booking', 'beds', 'baths', 'types', 'specials', 'season'])
    // Rail is on the left of the results.
    const railBox = await page.$eval('[data-testid=board-filter-rail]', el => el.getBoundingClientRect().toJSON())
    const cardBox = await page.$eval('[data-ref]', el => el.getBoundingClientRect().toJSON())
    assert.ok(railBox.right <= cardBox.left, 'filters left, results right')
    // ARGUS stays a collapsed island on desktop until clicked.
    assert.ok(await page.$('.crm-argus-orbit img[alt=ARGUS]'), 'collapsed by default')
    const w0 = await page.$eval('.crm-argus-orbit', el => el.getBoundingClientRect().width)
    assert.equal(await page.$('.crm-filter-island') && await page.$eval('.crm-filter-island', el => getComputedStyle(el).display), 'none')
    await shot(page, 'desktop-board')
    await click(page, '.crm-argus-orbit button')
    await sleep(800)
    const w1 = await page.$eval('.crm-argus-orbit', el => el.getBoundingClientRect().width)
    assert.ok(w1 > w0 + 100, `desktop island is longer when searching (${w0} → ${w1})`)
    await shot(page, 'desktop-search-open')
    await page.keyboard.press('Escape')
    // Sections start collapsed; the agent opens what they need.
    assert.equal(await page.$$eval('[data-testid=board-filter-rail] .crm-rail-toggle[aria-expanded=true]', els => els.length), 0)
    // Rule icons beside the star: winter + crossed-out sharing on 9104.
    assert.deepEqual(await page.$$eval('[data-ref="2906-9104"] .crm-card-rule-icons i', els => els.map(e => e.dataset.rule + (e.dataset.no ? ':no' : ''))), ['winter', 'pets', 'sharing:no'])
    // The modern card uses a stable landscape photo above the property facts.
    const photoLayout = await page.$eval('[data-ref="2906-9101"]', card => {
      const photo = card.querySelector('.crm-listing-photo').getBoundingClientRect()
      const body = card.querySelector('.crm-listing-card-body').getBoundingClientRect()
      const box = card.getBoundingClientRect()
      return { gap: body.top - photo.bottom, widthGap: box.width - photo.width, ratio: photo.width / photo.height }
    })
    assert.ok(Math.abs(photoLayout.gap) <= 2, `photo meets the property facts (gap ${photoLayout.gap}px)`)
    assert.ok(Math.abs(photoLayout.widthGap) <= 2 && photoLayout.ratio > 1.5, `photo is full-width landscape (${JSON.stringify(photoLayout)})`)
    assert.equal(await page.$eval('[data-ref="2906-9101"] .crm-card-availability', el => el.textContent.trim()), 'Available')
    assert.doesNotMatch(await page.$eval('[data-ref="2906-9101"]', el => el.textContent), /\bON MARKET\b|\bFree\b/i)
    await page.click('[data-rail=types] .crm-rail-toggle')
    const typeLabels = await page.$$eval('[data-rail=types] .crm-rail-body button', els => els.map(el => el.textContent.trim()))
    for (const expected of ['Apartment', 'Penthouse', 'Maisonette', 'Townhouse', 'House of Character', 'Detached Villa', 'Farmhouse']) {
      assert.ok(typeLabels.includes(expected), `property type rail includes ${expected}`)
    }
    await page.click('[data-rail=types] .crm-rail-toggle')
    // Rail and results share the state.
    await page.click('[data-rail=beds] .crm-rail-toggle')
    await page.waitForSelector('[data-rail=beds] .crm-rail-body')
    await page.$$eval('[data-rail=beds] button', els => els.find(e => e.textContent.trim() === '2').click())
    await page.waitForFunction(() => new Set([...document.querySelectorAll('[data-ref]')].map(e => e.dataset.ref)).size === 3)
    // One section at a time: opening Price closes Bedrooms, whose choice
    // stays visible as a summary next to its label.
    await page.click('[data-rail=price] .crm-rail-toggle')
    await page.waitForSelector('[data-rail=price] .crm-rail-body')
    assert.deepEqual(await page.$$eval('[data-rail][data-open=true]', els => els.map(e => e.dataset.rail)), ['price'])
    assert.equal(await page.$eval('[data-rail=beds] .crm-rail-summary', el => el.textContent), '2')
    await page.type('[data-rail=price] input[placeholder="Any"]', '1500')
    await page.waitForFunction(() => new Set([...document.querySelectorAll('[data-ref]')].map(e => e.dataset.ref)).size === 1)
    assert.deepEqual(await cards(page), ['2906-9103'])
    assert.equal(await page.$eval('[data-rail=beds]', el => el.dataset.selected), 'true')
    await shot(page, 'desktop-filtered')
    await click(page, '[data-testid=board-tools-button]')
    await page.waitForSelector('[data-testid=board-tools-panel]')
    await shot(page, 'desktop-tools')
  })

  await t.test('desktop dark-blue mode is still available', async t2 => {
    const page = await open(t2, browser, { fixtures: fixtures(), width: 1440, height: 900, theme: 'dark' })
    await page.waitForSelector('[data-testid=board-filter-rail]')
    assert.equal(await page.$eval('html', el => el.dataset.crmTheme), 'dark')
    await shot(page, 'desktop-dark')
  })

  await t.test('availability calendar: Save never reposts, Save & Repost reposts once', async t2 => {
    const f = fixtures()
    f.listings[0] = { ...f.listings[0], availableDate: '2026-11-01' }
    const page = await open(t2, browser, { fixtures: f, width: 1440, height: 900 })
    await page.waitForSelector('[data-ref="2906-9101"]')
    const openDialog = async () => {
      await page.$eval('[data-ref="2906-9101"] button[title="Correct the available / viewing dates"]', el => el.click())
      await page.waitForSelector('[data-testid=av-save]')
    }
    await openDialog()
    await shot(page, 'av-dialog')
    const input = await page.$('input[type=date]')
    await input.click({ clickCount: 1 })
    await page.$eval('input[type=date]', el => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, '2026-11-15'); el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    page.crmCalls.length = 0
    await page.click('[data-testid=av-save]')
    await page.waitForFunction(() => !document.querySelector('[data-testid=av-save]'))
    const saveCalls = page.crmCalls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)
    assert.deepEqual(saveCalls, ['PATCH properties/1'], 'Save = CRM only')
    assert.ok(!page.crmCalls.some(c => /av-date-confirm/.test(c.path)))

    await openDialog()
    page.crmCalls.length = 0
    await page.$eval('[data-testid=av-save-repost]', el => { el.click(); el.click() })   // double tap
    await page.waitForFunction(() => !document.querySelector('[data-testid=av-save-repost]'))
    const reposts = page.crmCalls.filter(c => /av-date-confirm/.test(c.path))
    assert.equal(reposts.length, 1, 'one repost request even on a double tap')
  })

  await t.test('Rented?: an owner reply "rented" stays on the board behind the Rented? chip', async t2 => {
    const f = fixtures()
    f.listings[2] = { ...f.listings[2], availableStatus: 'pending_check', statusChangeReason: 'Possibly rented — owner said: "rented sorry"' }
    f.listings[3] = { ...f.listings[3], availableStatus: 'pending_check', statusChangeReason: 'Owner replied twice but the classifier could not read it: "hm"' }
    const page = await open(t2, browser, { fixtures: f, width: 1440, height: 900 })
    await page.waitForSelector('[data-ref]')
    assert.ok((await cards(page)).includes('2906-9103'), 'still on the Active board')
    assert.equal(await page.$eval('[data-testid=rented-question-count]', el => el.textContent), '1')
    await page.$$eval('.crm-horizon-chip', els => els.find(e => /Rented\?/.test(e.textContent)).click())
    await page.waitForFunction(() => new Set([...document.querySelectorAll('[data-ref]')].map(e => e.dataset.ref)).size === 1)
    assert.deepEqual(await cards(page), ['2906-9103'], 'only the possibly-rented listing')
    assert.equal(await page.$eval('[data-ref="2906-9103"] [data-testid=rented-question-badge]', el => el.textContent), 'Rented?')
    await shot(page, 'desktop-rented-question')
  })

  await t.test('phone: an open sheet pushes the bottom island down to its line', async t2 => {
    const f = fixtures()
    f.listings[0] = { ...f.listings[0], availableDate: '2026-11-01' }
    const page = await open(t2, browser, { fixtures: f })
    await page.waitForSelector('[data-ref="2906-9101"]')
    await page.$eval('[data-ref="2906-9101"] button[title="Correct the available / viewing dates"]', el => el.click())
    await page.waitForSelector('[data-testid=av-save-repost]')
    await sleep(700)
    const hit = await page.$eval('[data-testid=av-save-repost]', el => {
      const b = el.getBoundingClientRect()
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return !!top && (top === el || el.contains(top))
    })
    assert.ok(hit, 'Save & Repost is the top element at its own position')
    const nav = await page.$eval('.crm-bottom-nav', el => el.getBoundingClientRect().height)
    assert.ok(nav <= 24, `island collapsed to its line (${nav}px)`)
    await shot(page, 'mobile-sheet-island-line')
  })

  await t.test('property editor: Save vs Save & Repost (admin)', async t2 => {
    const f = fixtures()
    const prop = {
      id: 1, ref: '2906-9101', type: 'apartment', beds: 2, baths: 1, sizeSqm: 80, published: false,
      location: { town: 'Sliema', street: 'Tower Road', apt: '4' }, prices: { longlet: 1600, sale: null, shortlet: false },
      availableStatus: 'available', availableDate: '2026-11-01', viewingStatus: 'none', viewingDate: null, viewingNotes: '',
      internalNotes: '', description: 'Mock', exclusive: false, exclusiveUntil: null, rentalModes: ['long_let'], availableUntil: null,
      hasBalcony: null, balconySize: null, hasStudyRoom: null, parkingAvailable: null, listingAgents: ['QA Agent'], activityAgents: [], activityAgent: null, activityAgentId: null, listedByAgentId: 1, ownerCreator: null, ownerCreatorId: null,
      categoryOverride: null, categoryOverrideReason: null, completeness: 80, imageCount: 0, images: [], fav: false,
      owner: { id: 7, name: 'Test Owner', phoneMasked: '+356 •••• ••19', hasPhone: true, emailMasked: null, hasEmail: false },
    }
    f.routes = [
      ...f.routes,
      [/^properties\/1$/, 'GET', () => ({ property: prop, activities: [], agents: [] })],
      [/^properties\/1$/, 'PATCH', () => ({ ok: true, activitiesLogged: 1, completeness: 80 })],
      [/av-date-confirm$/, 'POST', () => ({ ok: true, message: '#2906-9101 dates confirmed — reposting to its category group now.' })],
    ]
    const page = await open(t2, browser, { path: '/crm/property/1', fixtures: f, width: 1280, height: 900 })
    await page.waitForSelector('[data-testid=property-save]', { timeout: 20000 })
    await shot(page, 'property-editor')
    page.crmCalls.length = 0
    await page.click('[data-testid=property-save]')
    await page.waitForFunction(() => /Saved/.test(document.body.innerText))
    assert.ok(page.crmCalls.some(c => c.method === 'PATCH' && c.path === 'properties/1'))
    assert.ok(!page.crmCalls.some(c => /av-date-confirm/.test(c.path)), 'Save never reposts')
    page.crmCalls.length = 0
    await page.$eval('[data-testid=property-save-repost]', el => { el.click(); el.click() })
    await page.waitForFunction(() => /reposting to its category group/.test(document.body.innerText), { timeout: 15000 })
    const order = page.crmCalls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)
    assert.deepEqual(order, ['PATCH properties/1', 'POST schedule-board/listings/2906-9101/av-date-confirm'], 'save first, then one repost')
  })
})
