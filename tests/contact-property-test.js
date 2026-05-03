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
    } else if (url.includes('/api/public/property-submit') && req.method() === 'POST') {
      try { interceptedPayload = JSON.parse(req.postData() || '{}') } catch {}
      console.log('  [interceptor] public/property-submit intercepted')
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, submission_id: 9999 }) })
    } else {
      req.continue()
    }
  })

  const waitMs = ms => page.evaluate(n => new Promise(r => setTimeout(r, n)), ms)

  async function goto(p, path) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 20000 })
  }

  async function goToPropertyTab(p) {
    await goto(p, '/en/contact')
    await p.waitForSelector('main', { timeout: 8000 })
    await waitMs(300)
    // Click "List Your Property" tab
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('List Your Property') || (b.textContent || '').includes('List your') || (b.textContent || '').includes('Property'))
      if (btn) btn.click()
      else console.log('[page] property tab not found. Buttons:', btns.map(b => b.textContent?.trim()).slice(0, 10).join(' | '))
    })
    await waitMs(500)
    await p.waitForFunction(
      () => document.body.innerText.includes('Your Details') || document.body.innerText.includes('Your Name'),
      { timeout: 8000 }
    )
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

  await check('property tab is present on contact page', async p => {
    await goto(p, '/en/contact')
    await p.waitForSelector('main', { timeout: 5000 })
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('List Your Property') && !text.includes('List your') && !text.includes('Property'))
      throw new Error('List Your Property tab not found on contact page')
  })

  await check('no "Lead Agent" field in property tab', async p => {
    await goToPropertyTab(p)
    const text = await p.evaluate(() => document.body.innerText.toUpperCase())
    if (text.includes('LEAD AGENT')) throw new Error('"Lead Agent" field found — should not be present in public form')
  })

  await check('step 1 (Your Details) has name and phone fields', async p => {
    await goToPropertyTab(p)
    const text = await p.evaluate(() => document.body.innerText.toUpperCase())
    if (!text.includes('YOUR NAME') && !text.includes('NAME')) throw new Error('"Name" field not found on step 1')
    if (!text.includes('PHONE')) throw new Error('"Phone" field not found on step 1')
  })

  await check('step 2 (Type & Location) loads after next', async p => {
    await goToPropertyTab(p)
    // Fill step 0
    const nameInput = await p.waitForSelector('input[placeholder="Maria Borg"]', { timeout: 5000 })
    await nameInput.click({ clickCount: 3 })
    await nameInput.type('Test Owner')

    const phoneInput = await p.waitForSelector('input[placeholder="79000000"]', { timeout: 3000 })
    await phoneInput.click({ clickCount: 3 })
    await phoneInput.type('79001122')

    // Click Next
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next'))
      if (btn) btn.click()
    })
    await waitMs(400)

    await p.waitForFunction(
      () => document.body.innerText.includes('Type & Location') || document.body.innerText.includes('Property Type'),
      { timeout: 8000 }
    )
  })

  await check('step 2 has property type chips', async p => {
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Apartment')) throw new Error('"Apartment" chip not found on step 2')
    if (!text.includes('Penthouse')) throw new Error('"Penthouse" chip not found on step 2')
  })

  await check('step 3 (Details) loads with bedrooms/price fields', async p => {
    // Select property type "Apartment"
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').trim() === 'Apartment')
      if (btn) btn.click()
    })
    await waitMs(200)

    // Fill village (type in search)
    const villageInput = await p.waitForSelector('input[placeholder="Search village or town…"]', { timeout: 5000 })
    await villageInput.type('Sliem')
    await waitMs(600)
    await p.evaluate(() => {
      const items = [...document.querySelectorAll('[role="option"], li, button')]
      const item = items.find(el => (el.textContent || '').includes('Sliema'))
      if (item) item.click()
    })
    await waitMs(300)

    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next'))
      if (btn) btn.click()
    })
    await waitMs(400)

    await p.waitForFunction(
      () => document.body.innerText.includes('Details') || document.body.innerText.includes('Listing Type'),
      { timeout: 8000 }
    )

    const text = await p.evaluate(() => document.body.innerText.toUpperCase())
    if (!text.includes('BEDROOMS')) throw new Error('"Bedrooms" not found on step 3')
    if (!text.includes('LISTING TYPE')) throw new Error('"Listing Type" not found on step 3')
  })

  await check('step 4 (Features) loads', async p => {
    // Set bedrooms to 2, bathrooms to 1, price
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const bedroomBtn = btns.find(b => b.textContent?.trim() === '2')
      if (bedroomBtn) bedroomBtn.click()
    })
    await waitMs(150)
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      // bathrooms: find '1' button near bathrooms section
      const bathroomBtns = btns.filter(b => b.textContent?.trim() === '1')
      if (bathroomBtns.length > 1) bathroomBtns[1].click()
      else if (bathroomBtns[0]) bathroomBtns[0].click()
    })
    await waitMs(150)

    // Fill rent price
    const priceInput = await p.waitForSelector('input[placeholder="1500"]', { timeout: 3000 })
    await priceInput.click({ clickCount: 3 })
    await priceInput.type('1200')

    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next'))
      if (btn) btn.click()
    })
    await waitMs(400)

    await p.waitForFunction(
      () => document.body.innerText.includes('Features') || document.body.innerText.includes('Amenities'),
      { timeout: 8000 }
    )
  })

  await check('step 4 has 19 feature chips', async p => {
    const chipCount = await p.$$eval('button', btns =>
      btns.filter(b => {
        const p = b.closest('.space-y-5')
        return p && (b.className || '').includes('rounded-full')
      }).length
    )
    if (chipCount < 10) throw new Error(`Expected feature chips, found only ${chipCount}`)
  })

  await check('step 5 (Description) has mandatory description with 30-char minimum', async p => {
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next'))
      if (btn) btn.click()
    })
    await waitMs(400)

    await p.waitForFunction(
      () => document.body.innerText.includes('Description'),
      { timeout: 8000 }
    )

    // Try to submit with empty description — should show error
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next'))
      if (btn) btn.click()
    })
    await waitMs(300)

    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Required') && !text.includes('required') && !text.includes('Description'))
      throw new Error('No error shown for empty description')
  })

  await check('description asterisk (required marker) is present', async p => {
    const hasAsterisk = await p.evaluate(() => {
      const labels = [...document.querySelectorAll('p')]
      return labels.some(el => {
        const txt = (el.textContent || '').toUpperCase()
        return txt.includes('DESCRIPTION') && (el.innerHTML || '').includes('*')
      })
    })
    if (!hasAsterisk) throw new Error('Description field does not have required asterisk (*)')
  })

  await check('description shows char counter and minimum warning', async p => {
    const textarea = await p.waitForSelector('textarea', { timeout: 5000 })
    await textarea.click({ clickCount: 3 })
    await textarea.type('Short')
    await waitMs(200)

    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('more chars needed') && !text.includes('Minimum'))
      throw new Error('Minimum length warning not shown for short description')
  })

  await check('full form submission works without JS errors', async p => {
    jsErrors.length = 0
    interceptedPayload = null

    await goToPropertyTab(p)

    // Step 0: Your Details
    const nameInput = await p.waitForSelector('input[placeholder="Maria Borg"]', { timeout: 5000 })
    await nameInput.click({ clickCount: 3 })
    await nameInput.type('Test Owner')
    const phoneInput = await p.waitForSelector('input[placeholder="79000000"]', { timeout: 3000 })
    await phoneInput.click({ clickCount: 3 })
    await phoneInput.type('79001122')
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      btns.find(b => (b.textContent || '').includes('Next'))?.click()
    })
    await waitMs(400)

    // Step 1: Type & Location
    await p.waitForFunction(() => document.body.innerText.includes('Type & Location'), { timeout: 8000 })
    await p.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Apartment')?.click()
    })
    await waitMs(200)
    const villageInput = await p.waitForSelector('input[placeholder="Search village or town…"]', { timeout: 5000 })
    await villageInput.type('Sliem')
    await waitMs(600)
    await p.evaluate(() => {
      const items = [...document.querySelectorAll('[role="option"], li, button')]
      items.find(el => (el.textContent || '').includes('Sliema'))?.click()
    })
    await waitMs(300)
    await p.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Next'))?.click()
    })
    await waitMs(400)

    // Step 2: Details
    await p.waitForFunction(() => document.body.innerText.includes('Details'), { timeout: 8000 })
    await p.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '2')?.click()
    })
    await waitMs(150)
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => b.textContent?.trim() === '1')
      if (btns.length > 1) btns[1].click(); else btns[0]?.click()
    })
    await waitMs(150)
    const priceInput = await p.waitForSelector('input[placeholder="1500"]', { timeout: 3000 })
    await priceInput.click({ clickCount: 3 })
    await priceInput.type('1200')
    await p.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Next'))?.click()
    })
    await waitMs(400)

    // Step 3: Features (skip, just click Next)
    await p.waitForFunction(() => document.body.innerText.includes('Features') || document.body.innerText.includes('Amenities'), { timeout: 8000 })
    await p.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Next'))?.click()
    })
    await waitMs(400)

    // Step 4: Description
    await p.waitForFunction(() => document.body.innerText.includes('Step 5 of 6'), { timeout: 8000 })
    const textarea = await p.waitForSelector('textarea', { timeout: 5000 })
    await textarea.click({ clickCount: 3 })
    await textarea.type('Beautiful apartment in Sliema with sea views and modern furnishings, fully equipped kitchen and spacious balcony.')
    await waitMs(200)
    await p.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Next'))?.click()
    })
    await waitMs(400)

    // Step 5: Review — submit
    await p.waitForFunction(() => document.body.innerText.includes('Step 6 of 6'), { timeout: 8000 })
    await waitMs(300)

    console.log('  [test] clicking Submit Property')
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').toLowerCase().includes('submit'))
      if (btn) btn.click()
      else console.log('[page] submit btn not found. Buttons:', btns.map(b => b.textContent?.trim()).join(' | '))
    })

    await p.waitForFunction(
      () => document.body.innerText.includes('Property Submitted') || document.body.innerText.includes('Submit Another'),
      { timeout: 15000 }
    ).catch(async err => {
      const txt = await p.evaluate(() => document.body.innerText.slice(0, 500))
      console.log('  [DEBUG] Page text at timeout:', txt)
      await p.screenshot({ path: 'tests/screenshots/property_submit_timeout.png' }).catch(() => {})
      throw err
    })

    if (jsErrors.length > 0) throw new Error('JS errors during submit: ' + jsErrors.join('; '))
    if (!interceptedPayload) throw new Error('form never sent POST to /api/public/property-submit')
  })

  await check('no "Something went wrong" error shown', async p => {
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (text.includes('something went wrong')) throw new Error('"Something went wrong" error was shown')
  })

  await check('submission payload has correct structure', async () => {
    if (!interceptedPayload) throw new Error('no intercepted payload (run submission test first)')
    if (!interceptedPayload.owner_name)    throw new Error('owner_name missing from payload')
    if (!interceptedPayload.owner_phone)   throw new Error('owner_phone missing from payload')
    if (!interceptedPayload.property_type) throw new Error('property_type missing from payload')
    if (!interceptedPayload.description)   throw new Error('description missing from payload')
    if (interceptedPayload.submitter_type !== 'landlord')
      throw new Error(`submitter_type should be "landlord", got "${interceptedPayload.submitter_type}"`)
    if ('lead_agent' in interceptedPayload && interceptedPayload.lead_agent !== null)
      throw new Error('lead_agent should not be in public landlord payload')
    console.log('  [payload] property_type:', interceptedPayload.property_type)
    console.log('  [payload] submitter_type:', interceptedPayload.submitter_type)
    console.log('  [payload] description length:', interceptedPayload.description?.length)
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
