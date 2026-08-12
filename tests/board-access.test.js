// Board sign-in + access management.
//
//   node tests/board-access.test.js
//   CRM_TOKEN=<staff jwt>  BOARD_TOKEN=<aud:board jwt>  BASE=http://crm.localhost:3000
//
// Nothing here creates a real agent: the row it looks for (TEST_EMAIL) is
// created and removed by the operator, and the request-link check uses an
// address that is deliberately NOT on the allowlist, so no mail goes out.
const puppeteer = require('puppeteer')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const HOST = new URL(BASE).hostname
const SHOTS = path.join(__dirname, 'screenshots')
const TEST_EMAIL = process.env.TEST_EMAIL || 'kevinsony1@gmail.com'

let pass = 0, fail = 0, skipped = 0
const ok   = (n, d) => { pass++; console.log(`  PASS  ${n}${d ? ` (${d})` : ''}`) }
const no   = (n, d) => { fail++; console.log(`  FAIL  ${n}${d ? `: ${d}` : ''}`) }
const skip = (n, d) => { skipped++; console.log(`  SKIP  ${n}${d ? `: ${d}` : ''}`) }

const navLabels = page => page.evaluate(() => {
  const aside = document.querySelector('aside')
  if (!aside) return null
  const LABELS = ['Dashboard', 'Inventory', 'Board', 'Board access', 'Owners', 'Earnings', 'Admin']
  const rows = Array.from(aside.querySelectorAll('div'))
    .filter(d => d.children.length <= 2 && d.innerText.trim().length < 24)
  return LABELS.filter(l => rows.some(d => new RegExp(`(^|\\s)${l}$`, 'i').test(d.innerText.trim())))
})

;(async () => {
  console.log('==== board access E2E ====')
  // The CRM only exists behind the crm.* host rewrite, so a local run has to
  // resolve crm.localhost to this machine. Against the real origin that same
  // rule would point crm.2906.estate at 127.0.0.1 and refuse every connection.
  const local = /(^|\.)localhost$/.test(HOST)
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [...(local ? [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] : []), '--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })

  // ── 1. the sign-in page ───────────────────────────────────────────────────
  try {
    await page.goto(`${BASE}/board-login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /sign-in link/i.test(document.body.innerText), { timeout: 20000 })
    const state = await page.evaluate(() => ({
      hasEmail: !!document.querySelector('input[type="email"]'),
      hasPassword: !!document.querySelector('input[type="password"]'),
      disabled: (Array.from(document.querySelectorAll('button'))
        .find(b => /Email me a sign-in link/i.test(b.innerText)) || {}).disabled,
    }))
    if (state.hasEmail && !state.hasPassword) ok('board-login renders, passwordless')
    else no('board-login renders, passwordless', JSON.stringify(state))
    if (state.disabled) ok('button stays disabled on an empty form')
    else no('button stays disabled on an empty form')
  } catch (e) { no('board-login renders, passwordless', e.message) }

  // ── 2. asking for a link never reveals who is on the list ─────────────────
  // A random address must produce the same answer as a real one.
  try {
    await page.type('input[type="email"]', 'definitely-not-an-agent@example.com', { delay: 10 })
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /Email me a sign-in link/i.test(x.innerText))
      if (b) b.click()
    })
    await page.waitForFunction(() => /Check your inbox/i.test(document.body.innerText), { timeout: 20000 })
    const leaks = await page.evaluate(() => /not found|unknown|no account|not on/i.test(document.body.innerText))
    if (!leaks) ok('unknown address gets the same answer as a known one')
    else no('unknown address gets the same answer as a known one', 'page names the address as unknown')
    await page.screenshot({ path: path.join(SHOTS, 'board-login-sent.png') })
  } catch (e) { no('unknown address gets the same answer as a known one', e.message) }

  // ── 3. a bad token says so instead of hanging ─────────────────────────────
  try {
    await page.goto(`${BASE}/board-login?token=deadbeef`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /not valid|expired|already been used/i.test(document.body.innerText), { timeout: 25000 })
    ok('an invalid link is refused with a reason')
  } catch (e) { no('an invalid link is refused with a reason', e.message) }

  // ── 4. staff can see and use the management page ──────────────────────────
  if (!process.env.CRM_TOKEN) skip('staff sees Board access', 'no CRM_TOKEN')
  else try {
    await page.setCookie({ name: 'crm_session', value: process.env.CRM_TOKEN, domain: HOST, path: '/' })
    await page.goto(`${BASE}/board-access`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /Board agents/i.test(document.body.innerText), { timeout: 30000 })
    const nav = await navLabels(page)
    if (nav && nav.includes('Board access')) ok('staff sees Board access', nav.join(', '))
    else no('staff sees Board access', `nav=${JSON.stringify(nav)}`)

    // The section heading renders before the fetch resolves, so waiting on it
    // alone reads an empty list and reports a passing product as a skip.
    await page.waitForFunction(
      e => document.body.innerText.includes(e) || /Nobody yet/i.test(document.body.innerText),
      { timeout: 20000 }, TEST_EMAIL).catch(() => {})
    const listed = await page.evaluate(e => document.body.innerText.includes(e), TEST_EMAIL)
    if (listed) ok('the list shows a board agent', TEST_EMAIL)
    else {
      const seen = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200))
      skip('the list shows a board agent', `${TEST_EMAIL} not rendered — page says: ${seen}`)
    }

    const staffProtected = await page.evaluate(() => {
      const t = document.body.innerText
      return /Staff with board access/i.test(t) && /CRM account is untouched/i.test(t)
    })
    if (staffProtected) ok('staff rows are marked as access-only removal')
    else no('staff rows are marked as access-only removal')
    await page.screenshot({ path: path.join(SHOTS, 'board-access-staff.png') })
  } catch (e) { no('staff sees Board access', e.message) }

  // ── 5. a board agent is not offered it, and the API refuses them ──────────
  if (!process.env.BOARD_TOKEN) skip('board agent cannot manage access', 'no BOARD_TOKEN')
  else try {
    await page.deleteCookie({ name: 'crm_session', domain: HOST, path: '/' })
    await page.setCookie({ name: 'crm_session', value: process.env.BOARD_TOKEN, domain: HOST, path: '/' })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /\d+\s+listings?/.test(document.body.innerText), { timeout: 60000 })
    const nav = await navLabels(page)
    if (nav && !nav.includes('Board access')) ok('board agent is not offered Board access', `sees: ${nav.join(', ')}`)
    else no('board agent is not offered Board access', `nav=${JSON.stringify(nav)}`)

    const status = await page.evaluate(async () => {
      const r = await fetch('/api/crm/board-access', { credentials: 'same-origin' })
      return r.status
    })
    if (status === 403) ok('the API refuses a board token', `${status}`)
    else no('the API refuses a board token', `expected 403, got ${status}`)
  } catch (e) { no('board agent cannot manage access', e.message) }

  await browser.close()
  console.log(`\nPASS ${pass}  SKIP ${skipped}  FAIL ${fail}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
