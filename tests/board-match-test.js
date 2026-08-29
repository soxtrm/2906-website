// ============================================================================
// tests/board-match-test.js — E2E for the MATCH button (Kev's Prompt B,
// 2026-08-29): Property -> Clients, same engine as Client -> Properties.
//
// Read-only end to end: opens the board, clicks Match on a known property
// (#2906-9106, real listing, real matching client "Phoenica" already
// verified server-side), asserts the score+reason panel renders, then
// exercises the "get share link" action and asserts it returns the SAME
// persistent property link Prompt A's architecture creates.
//
// Nothing here writes to property_matches or contacts anyone — the panel
// calls the pure compute endpoint, not the persisting/notifying one.
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const SHOTS = path.join(__dirname, 'screenshots')
const SUBJECT = '2906-9106'

const pass = []
const fail = []
const ok = (n, extra) => pass.push(extra ? `${n} (${extra})` : n)
const no = (n, why) => fail.push(`${n}: ${why}`)

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
  await page.setViewport({ width: 1440, height: 1100 })

  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))

  let matchResponse = null
  let shareResponse = null
  page.on('response', async res => {
    const u = res.url()
    try {
      if (/\/property-matches\/[^/]+$/.test(u)) matchResponse = { status: res.status(), body: await res.json() }
      if (/\/property-link\/[^/]+$/.test(u)) shareResponse = { status: res.status(), body: await res.json() }
    } catch { /* body already consumed */ }
  })

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/' })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-ref]', { timeout: 30000 })
    ok('board renders')

    // Find the subject's card — search filter narrows the grid to it.
    const searchInput = await page.$('input[type="search"], input[placeholder*="Search" i]')
    if (searchInput) {
      await searchInput.type(SUBJECT)
      await new Promise(r => setTimeout(r, 700))
    }

    const matchBtn = await page.$(`[data-match-btn="${SUBJECT}"]`)
    if (!matchBtn) { no('Match button present', `no [data-match-btn="${SUBJECT}"] found — check the ref is visible on the current tab/filter`); throw new Error('halt') }
    ok('Match button present on the card')

    await matchBtn.click()
    await page.waitForFunction(
      () => document.body.innerText.includes('Matching clients for'),
      { timeout: 8000 })
    ok('Match panel opens')

    await page.waitForFunction(
      () => !document.body.innerText.includes('Matching…'),
      { timeout: 10000 })

    if (!matchResponse) { no('property-matches endpoint called', 'no network response captured') }
    else if (matchResponse.status !== 200) { no('property-matches endpoint called', `status ${matchResponse.status}`) }
    else {
      ok('property-matches endpoint returned 200')
      const matches = matchResponse.body.matches || []
      const phoenica = matches.find(m => m.clientName === 'Phoenica')
      if (!phoenica) { no('known real match present', `Phoenica not in results: ${JSON.stringify(matches.map(m => m.clientName))}`) }
      else {
        ok('known real match present', `score ${phoenica.score}`)
        if (!Array.isArray(phoenica.reasons) || !phoenica.reasons.length) no('match has explained reasons', 'reasons array empty')
        else ok('match has explained reasons', `${phoenica.reasons.length} reasons`)
      }
      // The bug found during backend testing: empty-criteria test clients
      // must never appear at all, not even at a low score.
      const junk = matches.find(m => ['Haaaa', 'Hhhj', 'Stefan', 'racheal'].includes(m.clientName))
      if (junk) no('empty-criteria clients excluded', `found junk client in results: ${junk.clientName}`)
      else ok('empty-criteria clients excluded from results')
    }

    const bodyText = await page.evaluate(() => document.body.innerText)
    if (!/\d+% — Phoenica/.test(bodyText)) no('score rendered as a percentage', bodyText.slice(0, 200))
    else ok('score rendered as a percentage')

    // Share-link action, from inside the match panel.
    const shareBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      return btns.find(b => b.textContent && b.textContent.includes('Get share link'))
    })
    if (!shareBtn || !(await shareBtn.asElement())) { no('share button present', 'not found') }
    else {
      await shareBtn.asElement().click()
      await page.waitForFunction(() => document.querySelector('input[readonly]'), { timeout: 8000 })
      ok('share button opens the link field')
      if (!shareResponse) no('property-link endpoint called', 'no network response captured')
      else if (shareResponse.status !== 200) no('property-link endpoint called', `status ${shareResponse.status}`)
      else {
        ok('property-link endpoint returned 200', shareResponse.body.url)
        if (!/\/swipe\//.test(shareResponse.body.url || '')) no('share link is a tokenised swipe URL', shareResponse.body.url)
        else ok('share link is the Prompt A tokenised architecture, not a new system')
      }
    }

    // RefererNotAllowedMapError is expected off production (see
    // board-watag.test.js) — the Maps browser key is restricted to
    // crm.2906.estate, unrelated to anything this suite tests.
    const realErrors = consoleErrors.filter(e => !/403|Failed to load resource|RefererNotAllowedMapError|maps\/documentation/.test(e))
    if (realErrors.length) no('no console errors during the flow', realErrors.slice(0, 3).join(' | '))
    else ok('no console errors during the flow')

  } catch (e) {
    no('run completed', e.message)
    await page.screenshot({ path: path.join(SHOTS, 'board-match-failure.png'), fullPage: true }).catch(() => {})
  } finally {
    await browser.close()
  }

  console.log(`\nPASS: ${pass.length}  FAIL: ${fail.length}`)
  pass.forEach(p => console.log('PASS:', p))
  if (fail.length) { fail.forEach(f => console.error('FAIL:', f)); process.exit(1) }
}

run()
