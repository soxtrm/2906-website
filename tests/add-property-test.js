'use strict'
const puppeteer = require('puppeteer')
const https = require('https')
const http  = require('http')
const BASE    = 'http://localhost:3000'
const BACKEND = 'http://178.104.162.193:3001'

// Direct backend call — bypasses the broken Next.js dev-mode API proxy
function backendPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const url  = new URL(BACKEND + path)
    const mod  = url.protocol === 'https:' ? https : http
    const req  = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page    = await browser.newPage()
  const pass    = []
  const fail    = []
  const jsErrors = []
  let   interceptedPayload = null

  page.on('pageerror', err => jsErrors.push(err.message))
  page.on('dialog', dialog => dialog.accept()) // auto-dismiss alert() calls
  page.on('console', msg => {
    if (msg.type() === 'error') jsErrors.push('[console.error] ' + msg.text())
  })

  // Mock API responses — Next.js dev-mode API proxy returns 404 with Turbopack
  const MOCK_AREAS = {
    key_areas: [
      { id: 1, code: 'central',    display_name: 'Central',    is_key_area: true },
      { id: 2, code: 'north',      display_name: 'North',      is_key_area: true },
      { id: 3, code: 'south-east', display_name: 'South-East', is_key_area: true },
      { id: 4, code: 'south',      display_name: 'South',      is_key_area: true },
    ],
    special_areas: [
      { id: 5, code: 'valletta',  display_name: 'Valletta' },
      { id: 6, code: 'sliema',    display_name: 'Sliema' },
    ],
  }
  const MOCK_VILLAGES = {
    by_area: { central: [{ code: 'sliema', display_name: 'Sliema', areas: ['central'] }] },
    all_unique: [
      { code: 'sliema',       display_name: 'Sliema',         areas: ['central'] },
      { code: 'st-julians',   display_name: "St Julian's",    areas: ['central'] },
      { code: 'valletta',     display_name: 'Valletta',       areas: ['central'] },
      { code: 'msida',        display_name: 'Msida',          areas: ['central'] },
      { code: 'bugibba',      display_name: 'Bugibba',        areas: ['north']   },
    ],
  }

  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/api/')) console.log('  [request]', req.method(), url)
    if (url.includes('/api/locations/areas')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_AREAS) })
    } else if (url.includes('/api/locations/villages')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_VILLAGES) })
    } else if (url.includes('/api/property-submit') && req.method() === 'POST') {
      try { interceptedPayload = JSON.parse(req.postData() || '{}') } catch {}
      console.log('  [interceptor] property-submit intercepted')
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 9999 }) })
    } else {
      req.continue()
    }
  })

  async function check(name, fn) {
    try {
      await fn(page)
      pass.push(name)
    } catch (e) {
      fail.push(`${name}: ${e.message}`)
      await page.screenshot({ path: `tests/screenshots/${name.replace(/\W/g, '_')}.png` }).catch(() => {})
    }
  }

  async function goto(p, path) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 20000 })
  }

  const waitMs = ms => page.evaluate(n => new Promise(r => setTimeout(r, n)), ms)

  async function clickNext(p) {
    await (p || page).locator('::-p-text(Next)').click({ timeout: 4000 })
    await waitMs(400)
  }

  async function goToStep1(p) {
    await goto(p, '/en/add-property')
    await p.waitForSelector('main', { timeout: 8000 })
    await waitMs(300)
    await clickNext(p)
    await p.waitForFunction(() => document.body.innerText.includes('Type & Location'), { timeout: 6000 })
  }

  async function goToStep2(p) {
    await goToStep1(p)
    await p.locator('::-p-text(Apartment)').click({ timeout: 4000 })
    await waitMs(200)
    // Wait for village list to load
    await p.waitForFunction(() =>
      document.querySelectorAll('.single-village-selector .max-h-48 button').length > 0,
      { timeout: 8000 }
    )
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('.single-village-selector .max-h-48 button')]
      if (btns.length > 0) btns[0].click()
    })
    await waitMs(300)
    await clickNext(p)
    await p.waitForFunction(() => document.body.innerText.includes('Step 3 of 6'), { timeout: 6000 })
  }

  async function fillAndSubmit(p) {
    await goto(p, '/en/add-property')
    await p.waitForSelector('main', { timeout: 8000 })
    await waitMs(500)

    // Step 0 → Step 1
    await p.waitForFunction(() => document.body.innerText.includes('Step 1 of 6'), { timeout: 5000 })
    await clickNext(p)

    // Step 1: property type + village
    await p.waitForFunction(() => document.body.innerText.includes('Type & Location'), { timeout: 6000 })
    await p.locator('::-p-text(Apartment)').click({ timeout: 4000 })
    await waitMs(200)
    await p.waitForFunction(() =>
      document.querySelectorAll('.single-village-selector .max-h-48 button').length > 0,
      { timeout: 8000 }
    )
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('.single-village-selector .max-h-48 button')]
      if (btns.length > 0) btns[0].click()
    })
    await waitMs(300)
    await clickNext(p)

    // Step 2: details
    await p.waitForFunction(() => document.body.innerText.includes('Step 3 of 6'), { timeout: 6000 })
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '2')
      if (btn) btn.click()
    })
    await waitMs(200)
    await p.evaluate(() => {
      const matching = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === '1')
      if (matching.length >= 2) matching[1].click()
      else if (matching.length > 0) matching[0].click()
    })
    await waitMs(200)
    const priceInput = await p.waitForSelector('input[placeholder="1500"]', { timeout: 4000 })
    await priceInput.click({ clickCount: 3 })
    await priceInput.type('1600')
    await clickNext(p)

    // Step 3: features (optional)
    await p.waitForFunction(() => document.body.innerText.includes('Step 4 of 6'), { timeout: 6000 })
    await clickNext(p)

    // Step 4: description (required, min 50 chars)
    await p.waitForFunction(() => document.body.innerText.includes('Step 5 of 6'), { timeout: 6000 })
    const descArea = await p.waitForSelector('textarea[placeholder="Describe the property in detail..."]', { timeout: 5000 })
    await descArea.type('Puppeteer automated test — this is a test property description with more than fifty characters total.')
    await clickNext(p)

    // Step 5: review + auto-title
    await p.waitForFunction(() => document.body.innerText.includes('Step 6 of 6'), { timeout: 6000 })
    await waitMs(700)

    // Submit — use evaluate click to avoid Puppeteer Locator issues with framer-motion
    console.log('  [fillAndSubmit] clicking Submit Property')
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Submit Property'))
      if (btn) { console.log('[page] found submit btn, clicking'); btn.click() }
      else console.log('[page] submit btn NOT found; buttons:', btns.map(b => b.textContent?.trim()).join(' | '))
    })
    console.log('  [fillAndSubmit] waiting for success screen')
    await p.waitForFunction(
      () => document.body.innerText.toLowerCase().includes('property submitted') ||
            document.body.innerText.toLowerCase().includes('submitted successfully'),
      { timeout: 15000 }
    ).catch(async err => {
      // Debug: dump current page text
      const txt = await p.evaluate(() => document.body.innerText.slice(0, 500))
      console.log('  [DEBUG] Page text at timeout:', txt)
      await p.screenshot({ path: 'tests/screenshots/submit_timeout.png' }).catch(() => {})
      throw err
    })
  }

  // ── Tests ──────────────────────────────────────────────────────────────────

  await check('add-property page loads', async p => {
    await goto(p, '/en/add-property')
    await p.waitForSelector('main', { timeout: 8000 })
  })

  await check('no Landlord text on page', async p => {
    await goto(p, '/en/add-property')
    await p.waitForSelector('main', { timeout: 5000 })
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (text.includes('landlord')) throw new Error('Landlord text found — should be agent-only')
  })

  await check('step0 has Kevin agent chip', async p => {
    await goto(p, '/en/add-property')
    await p.waitForSelector('main', { timeout: 5000 })
    const hasKevin = await p.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => (b.textContent || '').trim() === 'Kevin')
    )
    if (!hasKevin) throw new Error('Kevin agent chip not found on step 0')
  })

  await check('step1 has Studio in Residential types', async p => {
    await goToStep1(p)
    const has = await p.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => (b.textContent || '').trim() === 'Studio')
    )
    if (!has) throw new Error('Studio not found in property types')
  })

  await check('step1 has Warehouse in Commercial types', async p => {
    await goToStep1(p)
    const has = await p.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => (b.textContent || '').trim() === 'Warehouse')
    )
    if (!has) throw new Error('Warehouse not found in commercial property types')
  })

  await check('step1 has Available From with Now/Specific/Other', async p => {
    await goToStep1(p)
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Now')) throw new Error('Now missing from Available From')
    if (!text.includes('Specific date')) throw new Error('Specific date missing')
    if (!text.includes('Other')) throw new Error('Other missing')
  })

  await check('step2 beds/baths have 6+ and Other options', async p => {
    await goToStep2(p)
    const btns = await p.$$eval('button', els => els.map(e => (e.textContent || '').trim()))
    if (!btns.includes('6+')) throw new Error("'6+' missing from bed/bath options")
    if (!btns.includes('Other')) throw new Error("'Other' missing from bed/bath options")
  })

  await check('step3 has Brand New in features', async p => {
    await goToStep2(p)
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '2')
      if (btn) btn.click()
    })
    await waitMs(150)
    await p.evaluate(() => {
      const matching = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === '1')
      if (matching.length >= 2) matching[1].click()
      else if (matching.length > 0) matching[0].click()
    })
    const pi = await p.waitForSelector('input[placeholder="1500"]', { timeout: 3000 })
    await pi.type('1200')
    await clickNext(p)
    await p.waitForFunction(() => document.body.innerText.includes('Step 4 of 6'), { timeout: 6000 })
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Brand New')) throw new Error('Brand New not found in Features step')
  })

  await check('full form submission completes without JS errors', async p => {
    jsErrors.length = 0
    interceptedPayload = null
    await fillAndSubmit(p)
    if (jsErrors.length > 0) throw new Error('JS errors during submit: ' + jsErrors.join('; '))
    if (!interceptedPayload) throw new Error('form never sent POST to /api/property-submit')
    if (interceptedPayload.submitter_type !== 'agent') throw new Error('submitter_type is not agent')
    if (!interceptedPayload.lead_agent) throw new Error('lead_agent missing from payload')
    if (!interceptedPayload.property_type) throw new Error('property_type missing from payload')
  })

  await check('success screen shown after submit', async p => {
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('property submitted')) throw new Error('Success screen not shown')
  })

  // Real backend submission for DB verification
  await check('real backend submission accepted', async () => {
    const result = await backendPost('/api/property-submit', {
      submitter_type:      'agent',
      lead_agent:          'Puppeteer Test',
      property_type:       'Apartment',
      listing_type:        'For Rent',
      price_rent:          1600,
      bedrooms:            2,
      bathrooms:           1,
      location:            'Sliema',
      description:         'Puppeteer E2E test submission — verifying backend accepts new fields correctly.',
      available_from_type: 'now',
      brand_new:           false,
      title:               'Sliema | €1,600/mo | 2 Bedrooms - 1 Bathroom',
      village_code:        null,
      features:            [],
      photos:              [],
    })
    if (result.status !== 200) throw new Error(`Backend returned ${result.status}: ${JSON.stringify(result.data)}`)
    if (!result.data.ok) throw new Error(`Backend returned ok=false: ${JSON.stringify(result.data)}`)
    console.log(`\n  📦 Real submission ID: ${result.data.id}`)
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
