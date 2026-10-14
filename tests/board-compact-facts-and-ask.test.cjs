const assert = require('node:assert/strict')
const { launch, openPage, defaultFixtures, listing } = require('./helpers/crm-mock.cjs')

;(async () => {
  const fixtures = defaultFixtures()
  fixtures.listings = [listing(1, {
    ref: '2906-COMPACT',
    leaseType: 'winter_let',
    rentalModes: ['winter_let', 'short_let'],
    availableUntil: '2027-04-30',
    petFriendly: false,
    sharing: false,
  })]

  const browser = await launch()
  try {
    const page = await openPage(browser, { width: 390, height: 844, theme: 'dark', fixtures })
    await page.waitForSelector('[data-ref="2906-COMPACT"]')

    const facts = await page.$$eval('[data-ref="2906-COMPACT"] [data-card-fact]', nodes => nodes.map(node => ({
      key: node.getAttribute('data-card-fact'),
      label: node.getAttribute('aria-label'),
      slashed: !!node.querySelector('i'),
    })))
    assert.deepEqual(facts, [
      { key: 'winter-let', label: 'Winter let', slashed: false },
      { key: 'pets', label: 'Pets: not allowed', slashed: true },
      { key: 'sharing', label: 'Sharing: not allowed', slashed: true },
    ])

    const tray = await page.$eval('[data-ref="2906-COMPACT"] .crm-card-action-tray', node => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }))
    assert.ok(tray.scrollWidth <= tray.clientWidth + 1, 'the compact action tray must not overflow horizontally')

    await page.click('[data-ask-btn="2906-COMPACT"]')
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].some(node => /Ask a question/i.test(node.textContent || '')))
    const composer = await page.$('textarea[placeholder*="pets ok"]')
    assert.ok(composer, 'ASK is directly reachable from every actionable card')

    assert.deepEqual(page.consoleErrors, [])
    console.log('compact winter/rule facts and always-visible ASK action passed')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
