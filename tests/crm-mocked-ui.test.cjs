// CRM UI regression suite that needs no CRM_TOKEN and no live backend.
// Run against any local dev server:
//   npx next dev -p 3000   (or set CRM_MOCK_BASE=http://localhost:3108)
//   node --test tests/crm-mocked-ui.test.cjs
// Skips (does not fail) when no server answers, so it is safe in any env.
const test = require('node:test')
const assert = require('node:assert/strict')
const { BASE, defaultFixtures, serverAvailable, launch, openPage } = require('./helpers/crm-mock.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('CRM mocked UI', { timeout: 600000 }, async t => {
  if (!(await serverAvailable())) { t.skip(`no dev server at ${BASE}`); return }
  const browser = await launch()
  t.after(() => browser.close())

  // Warm the route once so first-compile time never counts against a check.
  await (await openPage(browser)).close()

  for (const theme of ['light', 'dark']) {
    await t.test(`${theme}: ARGUS intro plays on a cold load, then leaves`, async () => {
      const fixtures = { ...defaultFixtures(), meDelayMs: 900 }
      const page = await openPage(browser, { theme, fixtures, wait: 'domcontentloaded' })
      await page.evaluate(() => sessionStorage.clear())
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.argus-intro', { timeout: 10000 })
      const early = await page.evaluate(() => ({
        htmlTheme: document.documentElement.dataset.crmTheme,
        letters: document.querySelectorAll('.argus-intro-letter').length,
        bg: getComputedStyle(document.querySelector('.argus-intro')).backgroundColor,
      }))
      assert.equal(early.htmlTheme, theme, 'saved theme is applied before hydration')
      assert.equal(early.letters, 5)
      const lum = early.bg.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b) / 3
      assert.ok(theme === 'dark' ? lum < 60 : lum > 200, `intro background follows ${theme}: ${early.bg}`)
      await page.waitForFunction(() => !document.querySelector('.argus-intro'), { timeout: 8000 })
      assert.deepEqual(page.consoleErrors, [], 'no console errors (incl. hydration mismatches)')
      await page.close()
    })
  }

  await t.test('client navigation renders without the splash', async () => {
    const page = await openPage(browser, { width: 1280, height: 800 })
    await page.waitForFunction(() => !document.querySelector('.argus-intro'), { timeout: 8000 })
    // The board's navigation lives in the header since the 2026-10-19
    // ARGUS layout (the sidebar holds the filter column there).
    const link = await page.$(':is(.crm-sidebar, .crm-header-nav) a.crm-nav-item[href*="profile"], :is(.crm-sidebar, .crm-header-nav) a.crm-nav-item:not([aria-current])')
    assert.ok(link, 'a navigation link exists')
    await link.click()
    await sleep(250)
    assert.equal(await page.$('.argus-intro'), null, 'no intro after an in-app page change')
    await page.close()
  })

  await t.test('dark mode: ARGUS wordmark is inverted, not dark-on-dark', async () => {
    const page = await openPage(browser, { theme: 'dark', width: 1280, height: 800 })
    // Board desktop: the wordmark is the ARGUS island (the sidebar brand
    // became the 2906 mark in the header).
    const filter = await page.$eval('.crm-argus-orbit img[alt=ARGUS], .crm-brand img', el => getComputedStyle(el).filter)
    assert.match(filter, /invert/)
    await page.close()
  })

  await t.test('owner chat composer stays above the keyboard with a 16px input', async () => {
    const page = await openPage(browser)
    await page.waitForSelector('[aria-label^="Owner chat"]', { timeout: 30000 })
    await page.click('[aria-label^="Owner chat"]')
    const field = await page.waitForSelector('textarea', { timeout: 10000 })
    await sleep(500)
    assert.equal(await field.evaluate(el => getComputedStyle(el).fontSize), '16px', '16px input avoids iOS focus zoom')
    await field.focus()
    await page.evaluate(() => window.__keyboard(320))
    await sleep(500)
    const box = await field.evaluate(el => ({ bottom: el.getBoundingClientRect().bottom, visible: innerHeight - 320 }))
    assert.ok(box.bottom <= box.visible + 1, `composer above keyboard: ${JSON.stringify(box)}`)
    await page.close()
  })

  await t.test('Rented tab "Anything available?" sends the owner-inventory intent', async () => {
    const page = await openPage(browser, { path: '/crm/schedule-board?view=rented', width: 1280, height: 900 })
    const button = await page.waitForSelector('xpath/.//button[contains(., "Anything available?")]', { timeout: 30000 })
    await button.click()
    await page.waitForSelector('textarea', { timeout: 10000 })
    const dialog = await page.evaluate(() => ({ title: document.body.innerText.includes('Ask about new inventory'), note: document.querySelector('textarea').value }))
    assert.equal(dialog.title, true, 'inventory-specific title')
    assert.ok(dialog.note.length > 10, 'prefilled inventory message')
    const preview = await page.$('xpath/.//button[contains(., "Preview message")]')
    assert.ok(preview, 'Preview message button exists')
    await preview.click()
    await sleep(600)
    const call = page.crmCalls.find(c => c.path.endsWith('/ask/preview'))
    assert.ok(call, 'preview was requested')
    assert.equal(JSON.parse(call.body).intent, 'owner-inventory')
    await page.close()
  })
})
