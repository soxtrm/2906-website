// Board search & quick filters (2026-10-18 audit). Mocked backend, no token.
//   npx next dev -p 3000 --webpack   then   node --test tests/crm-board-search.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const { BASE, listing, defaultFixtures, serverAvailable, launch, openPage } = require('./helpers/crm-mock.cjs')

const ago = days => new Date(Date.now() - days * 86_400_000).toISOString()
function fixtures() {
  const f = defaultFixtures()
  f.listings = [
    listing(1, { categoryGroups: ['seafront'], isMine: true }),
    listing(2, { categoryGroups: ['bed2'], description: 'Two minutes to the waterfront', isMine: false }),
    listing(3, { latestPriceChangeAt: ago(2), latestPriceOld: 2000, latestPriceNew: 1800, isMine: false }),
    listing(4, { latestPriceChangeAt: ago(2), latestPriceOld: 1500, latestPriceNew: 1700, isMine: false }),
    listing(5, { latestPriceChangeAt: ago(30), latestPriceOld: 2000, latestPriceNew: 1500, isHotProperty: true, isMine: false }),
    listing(6, { viewingDate: ago(-2), isMine: false }),
  ]
  return f
}
const cards = page => page.$$eval('[data-ref]', els => [...new Set(els.map(e => e.getAttribute('data-ref')))].sort())

test('board search & quick filters', { timeout: 600000 }, async t => {
  if (!(await serverAvailable())) { t.skip(`no dev server at ${BASE}`); return }
  const browser = await launch()
  t.after(() => browser.close())
  await (await openPage(browser)).close()

  const expect = {
    seafront: ['2906-9101'],               // strict category, not the "waterfront" copy of 9102
    price_drop: ['2906-9103'],             // dropped within 14 days; 9104 rose, 9105 dropped 30 days ago
    hot: ['2906-9105'],
    viewing: ['2906-9106'],
    mine: ['2906-9101'],
  }
  for (const [key, refs] of Object.entries(expect)) {
    await t.test(`quick=${key}`, async () => {
      const page = await openPage(browser, { path: `/crm/schedule-board?quick=${key}`, width: 1280, height: 900, fixtures: fixtures() })
      await page.waitForSelector('[data-ref]', { timeout: 15000 })
      assert.deepEqual(await cards(page), refs)
      await page.close()
    })
  }

  await t.test('search text is normalised before it reaches the API', async () => {
    const page = await openPage(browser, { path: '/crm/schedule-board', width: 1280, height: 900, fixtures: fixtures() })
    const urls = []
    page.on('request', r => { if (r.url().includes('/api/crm/schedule-board/listings')) urls.push(decodeURIComponent(r.url())) })
    for (const typed of ['#2906-9104', 'Gżira', 'st. julian’s']) {
      await page.goto(`${BASE}/crm/schedule-board?q=${encodeURIComponent(typed)}`, { waitUntil: 'networkidle2' })
    }
    assert.ok(urls.some(u => u.endsWith('/listings/2906-9104')), `"#2906-9104" opens the exact ref: ${urls.join(' | ')}`)
    assert.ok(urls.some(u => /q=gzira(&|$)/i.test(u)), 'Gżira → gzira')
    assert.ok(urls.some(u => /q=st julians(&|$)/i.test(u.replace(/\+/g, ' '))), 'st. julian’s → st julians')
    await page.close()
  })
})
