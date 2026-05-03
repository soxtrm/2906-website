const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'

async function run() {
  const browser = await puppeteer.launch({ headless: 'new' })
  const page = await browser.newPage()
  const pass = []
  const fail = []

  async function check(name, fn) {
    try {
      await fn(page)
      pass.push(name)
    } catch (e) {
      fail.push(`${name}: ${e.message}`)
      await page.screenshot({ path: `tests/screenshots/${name.replace(/\s/g, '_')}.png` }).catch(() => {})
    }
  }

  async function goto(p, path) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 20000 })
  }

  async function waitMs(p, ms) {
    return p.evaluate(n => new Promise(r => setTimeout(r, n)), ms)
  }

  // Click a button whose textContent includes `text` using Puppeteer's native click
  async function clickByText(p, text) {
    // Use Locator API (Puppeteer 20+) — handles retries and scrolling
    try {
      await p.locator(`::-p-text(${text})`).click({ timeout: 4000 })
      return true
    } catch { return false }
  }

  async function gotoStep1(p) {
    await goto(p, '/en/add-client')
    await p.waitForSelector('input[placeholder="Maria Borg"]', { timeout: 5000 })
    await p.type('input[placeholder="Maria Borg"]', 'Test')
    await p.locator('::-p-text(Kev)').click({ timeout: 3000 })
    await waitMs(p, 100)
    await p.locator('::-p-text(Next)').click({ timeout: 3000 })
    await p.waitForFunction(() => document.body.innerText.includes('Client Profile'), { timeout: 6000 })
    await waitMs(p, 300)
  }

  async function selectCountry(p, countryName) {
    // Click the CountryPicker trigger button containing "Select nationality"
    await p.locator('::-p-text(Select nationality)').click({ timeout: 4000 })
    await waitMs(p, 300)
    const searchInput = await p.waitForSelector('input[placeholder="Search country..."]', { timeout: 5000 })
    await searchInput.type(countryName)
    await waitMs(p, 400)
    // Click the matching country in the dropdown list
    await p.waitForFunction(name => {
      return [...document.querySelectorAll('[data-radix-popper-content-wrapper] button, [role="dialog"] button, div[style*="position"] button')]
        .some(b => (b.textContent || '').includes(name))
    }, { timeout: 3000 }, countryName).catch(() => {})
    // Find and click by matching button inside any open popover content
    await p.evaluate(name => {
      // Find the search input's ancestor popover content, or just the most recently opened popover
      const allBtns = [...document.querySelectorAll('button')]
      const btn = allBtns.find(b => {
        const txt = (b.textContent || '').trim()
        // Match country name but avoid the trigger button itself (which would say "Select nationality")
        return txt.includes(name) && !txt.includes('Select nationality') && txt.length < 50
      })
      if (btn) btn.click()
    }, countryName)
    await waitMs(p, 300)
  }

  async function fillStep1AndGoToStep2(p) {
    await gotoStep1(p)
    await selectCountry(p, 'Malta')
    const prof = await p.$('input[placeholder="e.g. Remote worker, Finance"]')
    if (prof) await prof.type('Dev')
    await p.locator('::-p-text(Next)').click({ timeout: 3000 })
    await p.waitForFunction(() => document.body.innerText.includes('Search Requirements'), { timeout: 6000 })
    await waitMs(p, 200)
  }

  // ── Tests ──────────────────────────────────────────────────────────────────

  await check('add-client page loads', async p => {
    await goto(p, '/en/add-client')
    await p.waitForSelector('main', { timeout: 5000 })
  })

  await check('step0 has no free-text nationality field', async p => {
    await goto(p, '/en/add-client')
    await p.waitForSelector('input[placeholder="Maria Borg"]', { timeout: 5000 })
    const nat = await p.$('input[placeholder="e.g. German, British"]')
    if (nat) throw new Error('Free-text nationality input found on step 0 (should be removed)')
  })

  await check('step1 has Nationality label and CountryPicker trigger', async p => {
    await gotoStep1(p)
    // innerText respects CSS text-transform: uppercase
    const bodyText = await p.evaluate(() => document.body.innerText)
    if (!bodyText.includes('NATIONALITY')) throw new Error('NATIONALITY label not found on step 1')
    if (!bodyText.includes('PROFESSION')) throw new Error('PROFESSION label not found on step 1')
    const hasPicker = await p.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('Select nationality'))
    )
    if (!hasPicker) throw new Error('CountryPicker trigger not found on step 1')
  })

  await check('step1 Nationality appears before Profession in DOM', async p => {
    await gotoStep1(p)
    const bodyText = await p.evaluate(() => document.body.innerText)
    const idxNat  = bodyText.indexOf('NATIONALITY')
    const idxProf = bodyText.indexOf('PROFESSION')
    if (idxNat === -1) throw new Error('NATIONALITY not found in step 1 innerText')
    if (idxNat > idxProf) throw new Error(`NATIONALITY at ${idxNat}, PROFESSION at ${idxProf} — wrong order`)
  })

  await check('step1 nationality required validation', async p => {
    await gotoStep1(p)
    await p.locator('::-p-text(Next)').click({ timeout: 3000 })
    await p.waitForFunction(() => document.body.innerText.includes('Required'), { timeout: 3000 })
  })

  await check('step1 CountryPicker opens search panel', async p => {
    await gotoStep1(p)
    await p.locator('::-p-text(Select nationality)').click({ timeout: 4000 })
    await waitMs(p, 300)
    const searchInput = await p.waitForSelector('input[placeholder="Search country..."]', { timeout: 5000 })
    if (!searchInput) throw new Error('Search input not found after clicking CountryPicker')
  })

  await check('step2 bedrooms has 1,2,3,4,Other and no 4+', async p => {
    await fillStep1AndGoToStep2(p)
    const btns = await p.$$eval('button', els => els.map(e => (e.textContent || '').trim()))
    if (!btns.includes('Other')) throw new Error("'Other' button not found in bedroom options")
    if (btns.includes('4+')) throw new Error("'4+' still present (should be replaced by '4' + 'Other')")
    if (!btns.includes('4')) throw new Error("'4' button missing from bedroom options")
  })

  await check('step2 Other bedroom reveals number input', async p => {
    await fillStep1AndGoToStep2(p)
    // Click the first 'Other' button (bedrooms section comes before bathrooms)
    await p.locator('::-p-text(Other)').click({ timeout: 3000 })
    await waitMs(p, 200)
    const inp = await p.$('input[placeholder="Enter number..."]')
    if (!inp) throw new Error('Custom number input not shown after clicking Other bedroom')
  })

  await check('step3 description field removed', async p => {
    await fillStep1AndGoToStep2(p)
    await p.locator('::-p-text(Next)').click({ timeout: 3000 })
    await p.waitForFunction(() => document.body.innerText.includes('Preferences'), { timeout: 5000 })
    const desc = await p.$('textarea[placeholder*="Describe the client"]')
    if (desc) throw new Error('Description textarea still present on step 3 (should be removed)')
  })

  await browser.close()

  console.log(`\nPASS: ${pass.length}  FAIL: ${fail.length}`)
  pass.forEach(p => console.log('  ✓', p))
  if (fail.length) {
    fail.forEach(f => console.error('  ✗', f))
    process.exit(1)
  }
}

run()
