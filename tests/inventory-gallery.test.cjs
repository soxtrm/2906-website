const assert = require('node:assert/strict')
const test = require('node:test')
const { launch, openPage, defaultFixtures } = require('./helpers/crm-mock.cjs')

const svg = (colour, label) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="${colour}"/><text x="160" y="180" text-anchor="middle" font-size="72" fill="white">${label}</text></svg>`)}`

const property = {
  id: 41,
  ref: '2906-9541',
  published: true,
  type: 'apartment',
  exclusive: false,
  completeness: 92,
  images: [svg('#4979a8', '1'), svg('#b27b54', '2'), svg('#668f70', '3')],
  imageCount: 8,
  owner: { id: 9, name: 'Olga Test', phoneMasked: '+356 79•• ••70', hasPhone: true, emailMasked: null, hasEmail: false },
  location: { town: 'Sliema', street: 'Tigné Point', apt: null },
  prices: { longlet: 3500, shortlet: null, sale: null },
  beds: 3,
  baths: 2,
  rentalModes: ['long_let'],
  availableUntil: null,
  availableStatus: 'available',
  availableDate: null,
  viewingStatus: 'none',
  ownerCreator: 'Kevin',
  listingAgents: ['Kevin'],
  activityAgents: [],
  fav: false,
}

test('desktop inventory starts with a visible three-photo square gallery', async () => {
  const browser = await launch()
  try {
    const fixtures = defaultFixtures()
    fixtures.me = { ...fixtures.me, nav: ['dashboard', 'inventory', 'board', 'bookings', 'owners', 'outreach', 'profile'] }
    fixtures.routes = [
      [/^properties$/, 'GET', () => ({ properties: [property], total: 1 })],
      [/^agents$/, 'GET', () => ({ agents: [] })],
      [/^locations$/, 'GET', () => ({ locations: ['Sliema'] })],
    ]
    const page = await openPage(browser, { path: '/crm/inventory', width: 1440, height: 900, fixtures })
    await page.waitForSelector('.inventory-image-strip img')
    const result = await page.evaluate(() => {
      const rect = selector => {
        const r = document.querySelector(selector).getBoundingClientRect()
        return { x: Math.round(r.x), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }
      }
      return {
        strip: rect('.inventory-image-strip'),
        slots: [...document.querySelectorAll('.inventory-image-slot')].map(node => {
          const r = node.getBoundingClientRect()
          return { width: Math.round(r.width), height: Math.round(r.height) }
        }),
        decoded: [...document.querySelectorAll('.inventory-image-slot img')].filter(img => img.complete && img.naturalWidth > 0).length,
        count: document.querySelector('.inventory-image-count')?.textContent,
        rowHeight: Math.round(document.querySelector('.inventory-desktop-row').getBoundingClientRect().height),
        owner: rect('.inventory-owner-cell'),
        location: rect('.inventory-location-cell'),
      }
    })
    assert.equal(result.slots.length, 3)
    assert.deepEqual(result.slots, [{ width: 54, height: 54 }, { width: 54, height: 54 }, { width: 54, height: 54 }])
    assert.equal(result.decoded, 3)
    assert.equal(result.count, '+5')
    assert.ok(result.rowHeight <= 96, `inventory row stays compact (${result.rowHeight}px)`)
    assert.ok(result.owner.x > result.strip.right && result.location.x > result.owner.x, 'owner and location scan to the right of the gallery')
    if (process.env.ARGUS_SHOT) await page.screenshot({ path: process.env.ARGUS_SHOT, fullPage: false })
  } finally {
    await browser.close()
  }
})
