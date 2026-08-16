// ============================================================================
// tests/board-rule-filters.test.js — the Pets / Sharing / Subletting filter.
//
// Same shape as tests/board-card-extras.test.js: crm.localhost behind the host
// rewrite, a real CRM JWT injected as the crm_session cookie.
//
// READ-ONLY. It types in the filter row and counts cards; it clicks nothing that
// writes. What it proves:
//
//   1. the API sends all three tri-state flags, subletting included
//   2. the "Pets & Sharing" control exists in the filter row at all — that was
//      the actual gap: the paw and people icons have been on the cards for a
//      while with no way to filter on them
//   3. picking "Pet-friendly" leaves EXACTLY the cards whose flag is true —
//      not the ones that merely fail to mention pets. That distinction is the
//      whole point of the tri-state, and folding null in with false is the one
//      bug here that sends an agent to a flat that turns their client away.
//   4. "No pets" is its own answer, not the complement of pet-friendly
//   5. the subletting checkbox filters, and the state survives a reload via ?pets=
//
//   BASE=https://crm.2906.estate CRM_TOKEN=… node tests/board-rule-filters.test.js
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const SHOTS = path.join(__dirname, 'screenshots')

const pass = []
const fail = []
const ok = (n, extra) => pass.push(extra ? `${n} (${extra})` : n)
const no = (n, why) => fail.push(`${n}: ${why}`)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')
  fs.mkdirSync(SHOTS, { recursive: true })

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--host-resolver-rules=MAP ${process.env.HOST_MAP || 'crm.localhost 127.0.0.1'}`,
      '--no-sandbox',
    ],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1200 })

  let payload = null
  page.on('response', async res => {
    if (res.url().includes('schedule-board/listings?') && res.status() === 200) {
      try { payload = JSON.parse(await res.text()) } catch { /* body consumed */ }
    }
  })

  // Cards present in the DOM right now.
  const refsOnScreen = () => page.evaluate(
    () => [...document.querySelectorAll('[data-ref]')].map(c => c.getAttribute('data-ref')))

  // Open the "Pets & Sharing" dropdown by its visible label, then click a chip
  // by its text. Done by text on purpose: a data-testid would pass even if the
  // control were invisible or unlabelled, and the gap being fixed here is
  // precisely "there is no visible way to filter on this".
  // Idempotent on purpose. The trigger is a TOGGLE, and clicking a chip inside
  // the panel leaves it open — so calling this twice used to close the panel and
  // the next lookup reported the control "not found in the panel", which reads
  // exactly like a missing feature. Check first, click only if it is shut.
  async function openRules() {
    const opened = await page.evaluate(() => {
      const isOpen = () => /Subletting allowed/.test(document.body.innerText)
      if (isOpen()) return true
      const b = [...document.querySelectorAll('button')].find(x => /Pets & Sharing|Pets ok|No pets|Sharing ok|No sharing|Sublet ok/.test(x.textContent || ''))
      if (!b) return false
      b.click()
      return true
    })
    await sleep(350)
    return opened
  }
  async function clickChip(label) {
    const clicked = await page.evaluate((l) => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === l)
      if (!b) return false
      b.click()
      return true
    }, label)
    await sleep(700)
    return clicked
  }
  async function toggleSublet() {
    const clicked = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('input[type=checkbox]')]
        .find(x => /Subletting allowed/.test(x.closest('label')?.textContent || ''))
      if (!cb) return false
      cb.click()
      return true
    })
    await sleep(700)
    return clicked
  }

  try {
    await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/' })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-ref]').length > 0,
      { timeout: 45000 },
    ).catch(() => {})
    await sleep(1500)

    const rows = (payload && payload.listings) || []
    if (!rows.length) { no('board loads with listings', 'no listings payload seen'); throw new Error('no data') }
    ok('board loads with listings', `${rows.length}`)

    // ── 1. the API contract ─────────────────────────────────────────────────
    const tri = v => v === true || v === false || v === null
    if (rows.every(r => tri(r.petFriendly) && tri(r.sharing) && tri(r.subletting))) {
      ok('every card carries all three tri-state flags')
    } else {
      no('every card carries all three tri-state flags',
        'petFriendly / sharing / subletting is undefined or not tri-state on some row')
    }

    const petYes  = rows.filter(r => r.petFriendly === true).map(r => r.ref)
    const petNo   = rows.filter(r => r.petFriendly === false).map(r => r.ref)
    const petNull = rows.filter(r => r.petFriendly == null).map(r => r.ref)
    const subYes  = rows.filter(r => r.subletting === true).map(r => r.ref)
    ok('flags populated',
      `pets ${petYes.length} yes / ${petNo.length} no / ${petNull.length} unstated · sublet ${subYes.length} yes`)

    const before = await refsOnScreen()
    if (!before.length) { no('cards render', '0 in the DOM'); throw new Error('no cards') }
    ok('cards render', `${before.length}`)

    // ── 2. the control exists ───────────────────────────────────────────────
    if (await openRules()) ok('filter row has a Pets & Sharing control')
    else { no('filter row has a Pets & Sharing control', 'no trigger button found'); throw new Error('no control') }

    // ── 3. Pet-friendly keeps ONLY the trues ────────────────────────────────
    if (!(await clickChip('Pet-friendly'))) {
      no('Pet-friendly chip', 'not found in the panel')
    } else {
      const after = await refsOnScreen()
      const petYesVisible = petYes.filter(r => before.includes(r))
      const same = after.length === petYesVisible.length &&
                   after.every(r => petYesVisible.includes(r))
      if (same) ok('Pet-friendly shows exactly the pets=true cards', `${after.length}`)
      else no('Pet-friendly shows exactly the pets=true cards',
        `got ${after.length} (${after.slice(0, 6).join(',')}…), expected ${petYesVisible.length}`)

      const leaked = after.filter(r => petNull.includes(r))
      if (leaked.length === 0) ok('listings that never mention pets are NOT shown as pet-friendly')
      else no('listings that never mention pets are NOT shown as pet-friendly', `leaked ${leaked.join(',')}`)
    }

    // ── 4. "No pets" is its own answer ──────────────────────────────────────
    await openRules()
    await clickChip('Pet-friendly')          // turn it back off
    await openRules()
    if (!(await clickChip('No pets'))) {
      no('No pets chip', 'not found in the panel')
    } else {
      const after = await refsOnScreen()
      const petNoVisible = petNo.filter(r => before.includes(r))
      const same = after.length === petNoVisible.length && after.every(r => petNoVisible.includes(r))
      if (same) ok('No pets shows exactly the pets=false cards', `${after.length}`)
      else no('No pets shows exactly the pets=false cards',
        `got ${after.length}, expected ${petNoVisible.length}`)
      await openRules(); await clickChip('No pets')
    }

    // ── 5. subletting checkbox ──────────────────────────────────────────────
    await openRules()
    if (!(await toggleSublet())) {
      no('Subletting checkbox', 'not found in the panel')
    } else {
      const after = await refsOnScreen()
      const subYesVisible = subYes.filter(r => before.includes(r))
      const same = after.length === subYesVisible.length && after.every(r => subYesVisible.includes(r))
      if (same) ok('Subletting allowed shows exactly the sublet=true cards', `${after.length}`)
      else no('Subletting allowed shows exactly the sublet=true cards',
        `got ${after.length}, expected ${subYesVisible.length}`)
      await openRules(); await toggleSublet()
    }

    // Subletting must NOT get a card icon — Kev's rule. It is a search feature.
    const subIcons = await page.evaluate(() =>
      [...document.querySelectorAll('[data-ref] svg[aria-label]')]
        .map(s => s.getAttribute('aria-label'))
        .filter(l => /sublet/i.test(l || '')).length)
    if (subIcons === 0) ok('subletting draws no card icon (search-only, by design)')
    else no('subletting draws no card icon', `${subIcons} sublet icons found on cards`)

    // ── 6. the filter survives a shared link ────────────────────────────────
    await page.goto(`${BASE}/schedule-board?pets=yes`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-ref]').length >= 0, { timeout: 30000 }).catch(() => {})
    await sleep(2000)
    const fromUrl = await refsOnScreen()
    const petYesVisible = petYes.filter(r => before.includes(r))
    if (fromUrl.length === petYesVisible.length && fromUrl.every(r => petYesVisible.includes(r))) {
      ok('?pets=yes restores the filter from the URL', `${fromUrl.length}`)
    } else {
      no('?pets=yes restores the filter from the URL',
        `got ${fromUrl.length}, expected ${petYesVisible.length}`)
    }
    const label = await page.evaluate(() =>
      ([...document.querySelectorAll('button')].find(x => /Pets ok/.test(x.textContent || '')) || {}).textContent || '')
    if (/Pets ok/.test(label)) ok('the trigger reflects the active filter', label.trim())
    else no('the trigger reflects the active filter', `label was "${label.trim()}"`)

    // A junk value must fall back to "don't care", not filter everything away.
    await page.goto(`${BASE}/schedule-board?pets=maybe`, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(2500)
    const junk = await refsOnScreen()
    if (junk.length === before.length) ok('?pets=maybe is ignored, not treated as a filter', `${junk.length}`)
    else no('?pets=maybe is ignored, not treated as a filter', `${junk.length} vs ${before.length} unfiltered`)

    await page.screenshot({ path: path.join(SHOTS, 'board-rule-filters.png'), fullPage: false })
  } catch (e) {
    no('run', e.message)
    await page.screenshot({ path: path.join(SHOTS, 'board-rule-filters-FAIL.png') }).catch(() => {})
  } finally {
    await browser.close()
  }

  console.log('\n── board rule filters ─────────────────────────────')
  pass.forEach(p => console.log('  PASS  ' + p))
  fail.forEach(f => console.log('  FAIL  ' + f))
  console.log(`\n${fail.length ? 'FAILURES' : 'ALL PASS'} — ${pass.length} passed, ${fail.length} failed\n`)
  process.exit(fail.length ? 1 : 0)
}

run().catch(e => { console.error('THREW', e); process.exit(2) })
