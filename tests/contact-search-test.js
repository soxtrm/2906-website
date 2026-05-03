'use strict'
const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'

async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page    = await browser.newPage()
  const pass    = []
  const fail    = []
  const jsErrors = []
  let interceptedPayload = null

  page.on('pageerror', err => jsErrors.push(err.message))
  page.on('dialog', dialog => dialog.accept())
  page.on('console', msg => {
    if (msg.type() === 'error') jsErrors.push('[console.error] ' + msg.text())
  })

  const MOCK_AREAS = {
    key_areas: [
      { id: 1, code: 'central',    display_name: 'Central',    is_key_area: true },
      { id: 2, code: 'north',      display_name: 'North',      is_key_area: true },
      { id: 3, code: 'south-east', display_name: 'South-East', is_key_area: true },
      { id: 4, code: 'south',      display_name: 'South',      is_key_area: true },
    ],
    special_areas: [
      { id: 5, code: 'valletta', display_name: 'Valletta' },
      { id: 6, code: 'sliema',   display_name: 'Sliema' },
    ],
  }
  const MOCK_VILLAGES = {
    by_area: {},
    all_unique: [
      { code: 'sliema',     display_name: 'Sliema',      areas: ['central'] },
      { code: 'st-julians', display_name: "St Julian's", areas: ['central'] },
      { code: 'valletta',   display_name: 'Valletta',    areas: ['central'] },
    ],
  }

  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/api/locations/areas')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_AREAS) })
    } else if (url.includes('/api/locations/villages')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_VILLAGES) })
    } else if (url.includes('/api/contact-submit') && req.method() === 'POST') {
      try { interceptedPayload = JSON.parse(req.postData() || '{}') } catch {}
      console.log('  [interceptor] contact-submit intercepted')
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 8888 }) })
    } else {
      req.continue()
    }
  })

  const waitMs = ms => page.evaluate(n => new Promise(r => setTimeout(r, n)), ms)

  async function goto(p, path) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 20000 })
  }

  async function goToSearchTab(p) {
    await goto(p, '/en/contact')
    await p.waitForSelector('main', { timeout: 8000 })
    await waitMs(300)
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('find your Home') || (b.textContent || '').includes('Let us'))
      if (btn) btn.click()
    })
    await waitMs(500)
    // h3 step title "About You" has no CSS uppercase — reliable innerText check
    await p.waitForFunction(
      () => document.body.innerText.includes('About You'),
      { timeout: 8000 }
    )
  }

  async function fillStep1(p) {
    const nameInput = await p.waitForSelector('input[placeholder="Maria Borg"]', { timeout: 5000 })
    await nameInput.click({ clickCount: 3 })
    await nameInput.type('Test User')

    const phoneInput = await p.waitForSelector('input[placeholder="9999 0001"]', { timeout: 3000 })
    await phoneInput.click({ clickCount: 3 })
    await phoneInput.type('99001122')

    // Click "Remote Worker" profession chip (no CSS uppercase on these buttons)
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').trim() === 'Remote Worker')
      if (btn) btn.click()
      else console.log('[page] Remote Worker not found. Buttons:', btns.map(b => b.textContent?.trim()).slice(0, 10).join(' | '))
    })
    await waitMs(200)
  }

  async function clickNext(p) {
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next'))
      if (btn) btn.click()
    })
    await waitMs(400)
  }

  async function check(name, fn) {
    try {
      await fn(page)
      pass.push(name)
    } catch (e) {
      fail.push(`${name}: ${e.message}`)
      await page.screenshot({ path: `tests/screenshots/${name.replace(/\W/g, '_')}.png` }).catch(() => {})
    }
  }

  // ── Tests ──────────────────────────────────────────────────────────────────

  await check('contact page loads', async p => {
    await goto(p, '/en/contact')
    await p.waitForSelector('main', { timeout: 8000 })
  })

  await check('search tab label is "Let us find your Home"', async p => {
    await goto(p, '/en/contact')
    await p.waitForSelector('main', { timeout: 5000 })
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Let us find your Home')) throw new Error('"Let us find your Home" not found on contact page')
  })

  await check('no "About your Search" label present', async p => {
    await goto(p, '/en/contact')
    await p.waitForSelector('main', { timeout: 5000 })
    const text = await p.evaluate(() => document.body.innerText)
    if (text.includes('About your Search')) throw new Error('"About your Search" still present — not renamed')
  })

  await check('search tab opens step 1 (About You)', async p => {
    await goToSearchTab(p)
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('About You')) throw new Error('Step 1 "About You" h3 not found')
  })

  await check('step1 has CountryPicker nationality field', async p => {
    await goToSearchTab(p)
    // Label uses CSS uppercase: "NATIONALITY" in innerText — use toLowerCase
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('nationality')) throw new Error('Nationality label not found')
    // CountryPicker renders a button with placeholder text
    const hasCountryPicker = await p.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => {
        const t = (b.textContent || '').toLowerCase()
        return t.includes('nationality') || t.includes('select your') || t.includes('select country')
      })
    )
    if (!hasCountryPicker) throw new Error('CountryPicker button not found for nationality')
  })

  await check('step1 group size has Other option', async p => {
    await goToSearchTab(p)
    // Group size Other button: textContent = "👥Other" (emoji + text, no CSS uppercase on OptionCard)
    const hasOther = await p.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('Other'))
    )
    if (!hasOther) throw new Error('"Other" group size option not found')
  })

  await check('step1 has profession multi-select chips', async p => {
    await goToSearchTab(p)
    // ProfessionPicker buttons have no CSS uppercase
    const btns = await p.$$eval('button', els => els.map(e => (e.textContent || '').trim()))
    if (!btns.includes('Remote Worker')) throw new Error('"Remote Worker" profession chip not found')
    if (!btns.includes('IT / Tech'))    throw new Error('"IT / Tech" profession chip not found')
    if (!btns.includes('Finance'))      throw new Error('"Finance" profession chip not found')
  })

  await check('step2 has bedrooms 1-4 + Other + Any', async p => {
    await goToSearchTab(p)
    await fillStep1(p)

    await clickNext(p)
    // h3 for step 2 is t('step2_title') = "Budget & Space" — no CSS uppercase
    await p.waitForFunction(
      () => document.body.innerText.includes('Budget & Space'),
      { timeout: 8000 }
    )
    await waitMs(300)

    // Wait for "Any" button to appear in DOM (direct button check, unaffected by CSS)
    await p.waitForFunction(
      () => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Any'),
      { timeout: 5000 }
    )

    const btns = await p.$$eval('button', els => els.map(e => (e.textContent || '').trim()))
    if (!btns.includes('Other')) throw new Error('"Other" missing from bedrooms/bathrooms')
    if (!btns.includes('Any'))   throw new Error('"Any" missing from bedrooms/bathrooms')

    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('bedrooms'))  throw new Error('"Bedrooms" label not found on step 2')
    if (!text.includes('bathrooms')) throw new Error('"Bathrooms" label not found on step 2')
  })

  await check('step3 loads without crash (page 3 fix)', async p => {
    await goToSearchTab(p)
    await fillStep1(p)

    await clickNext(p)
    await p.waitForFunction(
      () => document.body.innerText.includes('Budget & Space'),
      { timeout: 8000 }
    )
    await waitMs(300)

    await clickNext(p)
    // h3 for step 3 is t('step3_title') = "Where & What" — no CSS uppercase
    await p.waitForFunction(
      () => document.body.innerText.includes('Where & What'),
      { timeout: 8000 }
    )

    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('property type')) throw new Error('Step 3 "Property Type" section not found — possible crash')
  })

  await check('group size 2 shows sharing sub-form with Person 2', async p => {
    await goToSearchTab(p)
    await waitMs(300)

    // Group size button for 2 has emoji 👫 — use it to identify uniquely
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      // The 👫 emoji is only in the group size "2" button
      const btn = btns.find(b => (b.textContent || '').includes('👫'))
      if (btn) btn.click()
      else console.log('[page] group size 2 (👫) btn not found. Texts:', btns.map(b => JSON.stringify((b.textContent || '').trim())).slice(0, 20).join(', '))
    })
    await waitMs(500)

    // "Person 2" label has CSS uppercase → "PERSON 2" in innerText → use toLowerCase
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('person 2')) throw new Error('Sharing sub-form "person 2" not shown for group size 2')
  })

  await check('full form submission completes without JS errors', async p => {
    jsErrors.length = 0
    interceptedPayload = null

    await goToSearchTab(p)
    await fillStep1(p)

    // Step 1 → 2
    await clickNext(p)
    await p.waitForFunction(
      () => document.body.innerText.includes('Budget & Space'),
      { timeout: 8000 }
    )
    await waitMs(300)

    // Step 2 → 3
    await clickNext(p)
    await p.waitForFunction(
      () => document.body.innerText.includes('Where & What'),
      { timeout: 8000 }
    )
    await waitMs(300)

    // Submit
    console.log('  [test] clicking Submit')
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').toLowerCase().includes('submit'))
      if (btn) btn.click()
      else console.log('[page] submit btn not found. Buttons:', btns.map(b => b.textContent?.trim()).join(' | '))
    })

    await p.waitForFunction(
      // "Thanks Test!" — h2 has no CSS uppercase, "Thanks" in innerText
      () => document.body.innerText.includes('Thanks') ||
            document.body.innerText.includes('Open WhatsApp'),
      { timeout: 15000 }
    ).catch(async err => {
      const txt = await p.evaluate(() => document.body.innerText.slice(0, 500))
      console.log('  [DEBUG] Page text at timeout:', txt)
      await p.screenshot({ path: 'tests/screenshots/contact_submit_timeout.png' }).catch(() => {})
      throw err
    })

    if (jsErrors.length > 0) throw new Error('JS errors during submit: ' + jsErrors.join('; '))
    if (!interceptedPayload)    throw new Error('form never sent POST to /api/contact-submit')
    if (!interceptedPayload.name)    throw new Error('name missing from payload')
    if (!interceptedPayload.phone)   throw new Error('phone missing from payload')
    if (!interceptedPayload.profession) throw new Error('profession missing from payload')
  })

  await check('success screen shown after submit', async p => {
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('thanks')) throw new Error('Success screen not shown after submit')
  })

  await check('submission payload has correct structure', async () => {
    if (!interceptedPayload) throw new Error('no intercepted payload (run submission test first)')
    if (!interceptedPayload.name)    throw new Error('name missing')
    if (!interceptedPayload.phone)   throw new Error('phone missing')
    if (!interceptedPayload.profession) throw new Error('profession missing')
    if (interceptedPayload.source !== 'website') throw new Error(`source should be "website", got "${interceptedPayload.source}"`)
    console.log('  [payload] profession:', interceptedPayload.profession)
    console.log('  [payload] source:', interceptedPayload.source)
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
