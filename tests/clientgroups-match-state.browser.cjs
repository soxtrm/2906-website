const assert = require('node:assert/strict')
const test = require('node:test')
const { launch, openPage, defaultFixtures, listing } = require('./helpers/crm-mock.cjs')
const conversation = {
  id: 71, label: 'Fixture client search', shortCode: 'C71', session: 'test',
  status: 'ARMED', enabled: true, autoMode: false,
  search: { budgetMax: 1800, bedroomsWanted: [2], locations: ['Mosta'] },
  matches: { total: 0, unsent: 0 },
}

test('Clientgroups distinguishes closed, empty and successful matching', { timeout: 60000 }, async () => {
  const browser = await launch()
  try {
    for (const width of [1440, 390]) {
      let status = 'closed'
      let matchCount = 0
      let runs = 0
      const fixtures = defaultFixtures()
      fixtures.me.agent.role = 'agent'
      fixtures.routes = [
        [/^clientgroups$/, 'GET', () => ({ clientgroups: [conversation] })],
        [/^clientgroups\/71$/, 'GET', () => ({
          state: { id: 71, name: conversation.label, client_id: 'fixture', enabled: true, status: 'ARMED' },
          client: { name: conversation.label, status, budget_max: 1800 },
          matches: matchCount ? [{ property_id: 1, ref: 'TEST-1', town: 'Mosta', match_score: 86, price: 1500 }] : [],
          events: [],
        })],
        [/^clientgroups\/71\/match-now$/, 'POST', () => {
          runs++
          return { ok: true, matchCount }
        }],
      ]
      const page = await openPage(browser, { path: '/crm/clientgroups', width, fixtures, fakeKeyboard: false })
      page.setDefaultTimeout(8500)

      const open = () => page.locator('button.crm-group-card').click()
      const close = () => page.locator('button[aria-label="Close client conversation"]').click()
      const findButton = () => page.waitForFunction(() =>
        Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent.trim() === 'Find Matches Now'))

      await open()
      const closedButton = await findButton()
      assert.equal(await closedButton.evaluate(button => button.disabled), true)
      assert.match(await page.$eval('[role="dialog"]', dialog => dialog.innerText), /client search is closed/i)
      assert.equal(runs, 0)

      await close()
      status = 'new'
      await open()
      const emptyButton = (await findButton()).asElement()
      assert.equal(await emptyButton.evaluate(button => button.disabled), false)
      await emptyButton.click()
      await page.waitForFunction(() => document.body.innerText.includes('No available properties met the saved search criteria.'))
      assert.equal(runs, 1)

      await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent.trim() === 'sent').click())
      matchCount = 1
      await (await findButton()).asElement().click()
      await page.waitForFunction(() => document.body.innerText.includes('Search completed with 1 match.'))
      assert.match(await page.$eval('[role="dialog"]', dialog => dialog.innerText), /TEST-1/)
      assert.equal(runs, 2)

      await (await findButton()).asElement().click()
      await page.waitForFunction(() => document.body.innerText.includes('Search completed with 1 match.'))
      assert.equal(runs, 3)
      assert.equal((await page.$eval('[role="dialog"]', dialog => dialog.innerText)).match(/TEST-1/g)?.length, 1)
      assert.deepEqual(page.crmCalls.filter(call => call.method !== 'GET').map(call => call.path), Array(3).fill('clientgroups/71/match-now'))
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

test('Board matching shows eligible clients and handles a genuine empty result', { timeout: 60000 }, async () => {
  const browser = await launch()
  try {
    for (const width of [1440, 390]) {
      const fixtures = defaultFixtures()
      fixtures.listings = [listing(1), listing(2)]
      fixtures.routes = [
        [/^schedule-board\/property-matches\/2906-9101$/, 'GET', () => ({
          matches: [{ clientId: 'QA-1', clientName: 'QA Client', score: 86, reasons: [{ key: 'budget', ok: true, label: 'Within budget' }] }],
        })],
        [/^schedule-board\/property-matches\/2906-9102$/, 'GET', () => ({ matches: [] })],
      ]
      for (const [ref, expected] of [['2906-9101', '86% — QA Client'], ['2906-9102', 'No active clients score high enough']]) {
        const page = await openPage(browser, { width, fixtures, fakeKeyboard: false })
        await page.locator(`[data-ref="${ref}"] button[title="More actions"]`).click()
        await page.locator(`button[data-match-btn="${ref}"]`).click()
        await page.waitForFunction(text => document.body.innerText.includes(text), {}, expected)
        assert.deepEqual(
          page.crmCalls.filter(call => call.path.includes('property-matches')).map(({ method, path }) => [method, path]),
          [['GET', `schedule-board/property-matches/${ref}`]],
        )
        assert.equal(page.crmCalls.some(call => call.method !== 'GET'), false)
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
})
