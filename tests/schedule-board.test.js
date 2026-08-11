// ============================================================================
// tests/schedule-board.test.js — E2E for /schedule-board (CRM)
//
// The CRM only exists behind the crm.* host rewrite (see proxy.ts), so the
// test drives http://crm.localhost:3000/schedule-board with a host-resolver
// rule pointing crm.localhost at 127.0.0.1. That exercises the exact path
// production uses, instead of the /crm/... internal route.
//
// Auth: a real CRM JWT (same payload routes/crm.js /login issues) handed in
// via CRM_TOKEN, injected as the http-only crm_session cookie.
//
// Fall A safety: the backend only sends to owners when
// SCHEDULE_BOARD_FALL_A_LIVE=1. It is unset, so "Ask owner" is a dry run.
// The Fall B buttons DO send real WhatsApp messages to real agents and are
// therefore never clicked here.
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

const BASE = 'http://crm.localhost:3000'
const TOKEN = process.env.CRM_TOKEN
const SHOTS = path.join(__dirname, 'screenshots')

// Values that live in properties.street / owner_contacts — none may reach the DOM.
const FORBIDDEN_TEXT = ['San Antnin', 'Residenza Denfil', 'Triq San Ġorġ']
const FORBIDDEN_KEYS = ['street', 'apt', 'owner', 'owner_id', 'ownerPhone', 'owner_phone', 'phone', 'email']

const pass = []
const fail = []
const ok = (n, extra) => { pass.push(extra ? `${n} (${extra})` : n) }
const no = (n, why) => { fail.push(`${n}: ${why}`) }

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')
  fs.mkdirSync(SHOTS, { recursive: true })

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--host-resolver-rules=MAP crm.localhost 127.0.0.1', '--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })

  const consoleErrors = []
  const badResponses = []
  let listingsBody = null

  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('response', async res => {
    const u = res.url()
    if (u.includes('/api/crm/')) {
      if (res.status() >= 400) badResponses.push(`${res.status()} ${u}`)
      if (u.includes('schedule-board/listings?') && res.status() === 200) {
        try { listingsBody = await res.text() } catch { /* consumed */ }
      }
    }
  })

  await page.setCookie({ name: 'crm_session', value: TOKEN, domain: 'crm.localhost', path: '/' })

  // ── 1. board loads under the production path ───────────────────────────────
  const resp = await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  if (resp && resp.status() === 200) ok('board responds 200')
  else no('board responds 200', `status ${resp && resp.status()}`)

  // The count label in the filter bar flips from "loading…" to "N listings".
  try {
    await page.waitForFunction(
      () => /\d+\s+listings?/.test(document.body.innerText),
      { timeout: 90000 })
    const count = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
    ok('listings loaded', `${count} listings`)
  } catch (e) { no('listings loaded', e.message) }

  // ── 2. cards rendered ─────────────────────────────────────────────────────
  const refs = await page.evaluate(() =>
    Array.from(document.body.innerText.matchAll(/#(2906-\d+)/g)).map(m => m[1]))
  if (refs.length) ok('cards rendered', `${new Set(refs).size} refs`)
  else no('cards rendered', 'no #2906-xxx ref found in the DOM')

  // ── 3. Fall A vs Fall B button sets ───────────────────────────────────────
  const btns = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim())
    const c = l => t.filter(x => x === l).length
    return { askOwner: c('Ask owner'), availability: c('Availability'), comment: c('Comment'), location: c('Location') }
  })
  // NB: the badge is text-transform:uppercase, and innerText reports the
  // *rendered* text — so it reads "YOURS", not "Yours".
  const yours = await page.evaluate(() =>
    Array.from(document.querySelectorAll('span')).filter(s => s.innerText.trim().toUpperCase() === 'YOURS').length)
  if (btns.askOwner > 0 && yours > 0) ok('Fall A cards present', `${yours} "Yours" badges, ${btns.askOwner} "Ask owner"`)
  else no('Fall A cards present', `askOwner=${btns.askOwner} yours=${yours}`)
  if (btns.availability > 0 && btns.comment > 0) ok('Fall B cards present', `${btns.availability} Availability / ${btns.comment} Comment / ${btns.location} Location`)
  else no('Fall B cards present', JSON.stringify(btns))
  if (btns.askOwner === yours) ok('Ask-owner count matches Yours badges')
  else no('Ask-owner count matches Yours badges', `${btns.askOwner} vs ${yours}`)

  // ── 4. firewall: DOM ──────────────────────────────────────────────────────
  const html = await page.content()
  const leakedText = FORBIDDEN_TEXT.filter(s => html.includes(s))
  if (!leakedText.length) ok('firewall: no street value in DOM')
  else no('firewall: no street value in DOM', leakedText.join(', '))

  // ── 5. firewall: API payload ──────────────────────────────────────────────
  if (listingsBody) {
    let leakedKeys = []
    try {
      const j = JSON.parse(listingsBody)
      const sample = (j.listings || [])[0] || {}
      leakedKeys = FORBIDDEN_KEYS.filter(k => Object.prototype.hasOwnProperty.call(sample, k))
    } catch (e) { leakedKeys = ['unparseable'] }
    const leakedVals = FORBIDDEN_TEXT.filter(s => listingsBody.includes(s))
    if (!leakedKeys.length && !leakedVals.length) ok('firewall: listings payload clean')
    else no('firewall: listings payload clean', `keys=${leakedKeys} values=${leakedVals}`)
  } else no('firewall: listings payload clean', 'listings response never captured')

  // ── 6. map fallback / map canvas ──────────────────────────────────────────
  const mapState = await page.evaluate(() => {
    if (document.body.innerText.includes('Map needs a Google Maps key')) return 'no-key'
    if (document.body.innerText.includes('Google Maps failed to load')) return 'load-failed'
    if (document.querySelector('#gmaps-js')) return 'script-injected'
    return 'unknown'
  })
  if (mapState === 'no-key' || mapState === 'script-injected') ok('map panel state', mapState)
  else no('map panel state', mapState)

  // ── 6b. card photos actually resolve ──────────────────────────────────────
  // The card <img> is loading="lazy", so nothing below the fold is fetched
  // until it is scrolled near. Scroll the grid in, then read naturalWidth —
  // a broken Cloudinary URL would leave it at 0.
  try {
    await page.evaluate(() => window.scrollBy(0, 900))
    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.src.includes('res.cloudinary.com'))
      return imgs.length > 0 && imgs.filter(i => i.complete && i.naturalWidth > 0).length >= 3
    }, { timeout: 30000 })
    const shot = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.src.includes('res.cloudinary.com'))
      return { total: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length }
    })
    ok('card photos load', `${shot.loaded}/${shot.total} cloudinary images decoded`)
  } catch (e) { no('card photos load', e.message) }

  await page.screenshot({ path: path.join(SHOTS, 'board-cards.png'), fullPage: false })
  await page.evaluate(() => window.scrollTo(0, 0))
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: path.join(SHOTS, 'board-desktop.png'), fullPage: false })

  // ── 7. filters + URL state ────────────────────────────────────────────────
  try {
    const before = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.trim() === '2+')
      b.click()
    })
    await page.waitForFunction(u => location.search.includes('beds=2'), { timeout: 15000 })
    await new Promise(r => setTimeout(r, 2500))
    const after = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
    if (Number(after) <= Number(before)) ok('beds filter narrows + URL state', `${before} → ${after}, ?beds=2`)
    else no('beds filter narrows + URL state', `${before} → ${after}`)
  } catch (e) { no('beds filter narrows + URL state', e.message) }

  // ── 8. village chip filter ────────────────────────────────────────────────
  try {
    const chip = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /^[A-ZŻĠĦĊ][^\n]{2,24}\s\d+$/.test(x.innerText.trim()))
      if (!b) return null
      const label = b.innerText.trim()
      b.click()
      return label
    })
    if (!chip) throw new Error('no village chip found')
    await page.waitForFunction(() => location.search.includes('towns='), { timeout: 15000 })
    await new Promise(r => setTimeout(r, 1200))
    const after = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
    ok('village chip filters', `${chip} → ${after} listings, ?towns= in URL`)
  } catch (e) { no('village chip filters', e.message) }

  // reset back to the unfiltered board
  await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => /\d+\s+listings?/.test(document.body.innerText), { timeout: 60000 })

  // ── 9. detail modal (the endpoint that used to 404) ────────────────────────
  let modalRef = null
  try {
    modalRef = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('span')).find(x => /^#2906-\d+$/.test(x.innerText.trim()))
      if (!s) return null
      s.click()
      return s.innerText.trim().slice(1)
    })
    if (!modalRef) throw new Error('no ref span to click')
    await page.waitForFunction(
      () => document.body.innerText.includes('viewing location on file') ||
            document.body.innerText.includes('Could not load listing'),
      { timeout: 30000 })
    const modalErr = await page.evaluate(() => document.body.innerText.includes('Could not load listing'))
    if (modalErr) no('detail modal loads', `error state for #${modalRef}`)
    else ok('detail modal loads', `#${modalRef}`)
    await page.screenshot({ path: path.join(SHOTS, 'board-modal.png') })
    const mHtml = await page.content()
    const mLeak = FORBIDDEN_TEXT.filter(s => mHtml.includes(s))
    if (!mLeak.length) ok('firewall: modal clean')
    else no('firewall: modal clean', mLeak.join(', '))
    await page.keyboard.press('Escape')
  } catch (e) { no('detail modal loads', e.message) }

  // ── 10. Fall A button end-to-end (dry run, sends nothing) ─────────────────
  try {
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.trim() === 'Ask owner')
      if (!b) return false
      b.click()
      return true
    })
    if (!clicked) throw new Error('no "Ask owner" button')
    // The optimistic "Contacting…" toast is replaced by the result toast, which
    // itself self-destructs after 5.2s — so wait for the *result* wording and
    // read it in the same breath, no sleep in between.
    await page.waitForFunction(
      () => /not armed yet|dry_run|Request failed|no account|nobody/i.test(document.body.innerText),
      { timeout: 40000 })
    const toast = await page.evaluate(() => {
      const m = document.body.innerText.match(/[^\n]*(not armed yet|dry_run|Request failed|no account|nobody)[^\n]*/i)
      return m ? m[0].trim() : null
    })
    if (toast && /not armed yet/i.test(toast)) ok('Fall A dry run wired', toast.slice(0, 120))
    else if (toast) no('Fall A dry run wired', `unexpected toast: ${toast.slice(0, 160)}`)
    else no('Fall A dry run wired', 'no toast text')
    await page.screenshot({ path: path.join(SHOTS, 'board-falla-toast.png') })
  } catch (e) { no('Fall A dry run wired', e.message) }

  // ── 11. mobile ────────────────────────────────────────────────────────────
  try {
    await page.setViewport({ width: 390, height: 844 })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /\d+\s+listings?/.test(document.body.innerText), { timeout: 60000 })
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)
    await page.screenshot({ path: path.join(SHOTS, 'board-mobile.png') })
    if (!wide) ok('mobile: no horizontal overflow')
    else no('mobile: no horizontal overflow', `scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)}`)
  } catch (e) { no('mobile: no horizontal overflow', e.message) }

  // ── 12. console / network hygiene ─────────────────────────────────────────
  const realErrors = consoleErrors.filter(t =>
    !/favicon|Download the React DevTools|preload|Failed to load resource: the server responded with a status of 40[34].*(png|jpg|jpeg|webp)/i.test(t))
  if (!realErrors.length) ok('no console errors')
  else no('no console errors', realErrors.slice(0, 4).join(' | '))
  if (!badResponses.length) ok('no failing /api/crm calls')
  else no('no failing /api/crm calls', badResponses.slice(0, 4).join(' | '))

  await browser.close()

  console.log('\n==== schedule-board E2E ====')
  pass.forEach(p => console.log('  PASS  ' + p))
  fail.forEach(f => console.log('  FAIL  ' + f))
  console.log(`\nPASS ${pass.length}  FAIL ${fail.length}`)
  if (fail.length) process.exit(1)
}

run().catch(e => { console.error('FATAL', e); process.exit(1) })
