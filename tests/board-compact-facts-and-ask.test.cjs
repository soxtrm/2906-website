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
    contact: { mode: 'owner', reachesName: 'Owner', canAsk: true, reason: null, questionsUsed: 5, questionsPerDay: 2, canQuestion: true, questionReason: null },
  })]

  const browser = await launch()
  try {
    const page = await openPage(browser, { width: 390, height: 844, theme: 'dark', fixtures })
    await page.waitForSelector('[data-ref="2906-COMPACT"]')

    const facts = await page.$$('[data-ref="2906-COMPACT"] [data-card-fact]')
    assert.equal(facts.length, 0, 'the action tray must not duplicate facts already shown by the property card')

    const tray = await page.$eval('[data-ref="2906-COMPACT"] .crm-card-action-tray', node => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }))
    assert.ok(tray.scrollWidth <= tray.clientWidth + 1, 'the compact action tray must not overflow horizontally')
    assert.ok(await page.$('[data-copy-listing-link="2906-COMPACT"]'), 'the existing card exposes its persistent listing link')
    const avButton = await page.$('[data-ref="2906-COMPACT"] .crm-card-still-available:not([disabled])')
    assert.ok(avButton, 'availability remains usable on future listings')
    const askButton = await page.$('[data-ask-btn="2906-COMPACT"]:not([disabled])')
    assert.ok(askButton, 'ASK stays usable after the old daily counter is exceeded')

    await askButton.click()
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].some(node => /Ask a question/i.test(node.textContent || '')))
    const composer = await page.$('textarea[placeholder*="pets ok"]')
    assert.ok(composer, 'ASK is directly reachable from every actionable card')

    await page.evaluate(() => {
      const heading = [...document.querySelectorAll('h2')].find(node => /Ask a question/i.test(node.textContent || ''))
      const dialog = heading?.closest('.fixed.z-\\[200\\]')
      if (!dialog) throw new Error('ASK sheet not found')
      const touch = (x, y) => new Touch({ identifier: 1, target: dialog, clientX: x, clientY: y })
      dialog.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(40, 80)] }))
      dialog.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch(42, 210)] }))
    })
    await page.waitForFunction(() => ![...document.querySelectorAll('h2')].some(node => /Ask a question/i.test(node.textContent || '')))

    assert.deepEqual(page.consoleErrors, [])
    console.log('clean action tray and always-visible ASK action passed')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
