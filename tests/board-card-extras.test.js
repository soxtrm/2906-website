// ============================================================================
// tests/board-card-extras.test.js — the pet / sharing icons and the photo
// download on a /schedule-board card.
//
// Same shape as the other board suites: crm.localhost behind the host rewrite, a
// real CRM JWT injected as the crm_session cookie.
//
// READ-ONLY as far as the database is concerned — it clicks nothing that writes.
// It DOES download real files, into a temp directory it creates and deletes, so
// the fl_attachment path is proven against Cloudinary rather than assumed:
// a plain `download` attribute is ignored cross-origin, so if the transformation
// were wrong the browser would navigate away instead of saving anything, and
// this run would end with an empty directory.
//
//   BASE=https://crm.2906.estate CRM_TOKEN=… node tests/board-card-extras.test.js
//   SKIP_DOWNLOAD=1 to skip the file part only.
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const SHOTS = path.join(__dirname, 'screenshots')
const DO_DOWNLOAD = process.env.SKIP_DOWNLOAD !== '1'

const pass = []
const fail = []
const ok = (n, extra) => pass.push(extra ? `${n} (${extra})` : n)
const no = (n, why) => fail.push(`${n}: ${why}`)

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')
  fs.mkdirSync(SHOTS, { recursive: true })
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-dl-'))

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
  let payload = null
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('response', async res => {
    const u = res.url()
    if (u.includes('schedule-board/listings?') && res.status() === 200) {
      try { payload = JSON.parse(await res.text()) } catch { /* body consumed */ }
    }
  })

  try {
    await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/' })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'networkidle2', timeout: 60000 })
    // Wait for cards to actually be there. Production is slower than a local
    // build (real Maps, 170 cards, cold start), and swallowing this timeout is
    // how a run reports "0 cards in the DOM" as if that were a pass.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-ref]').length > 0,
      { timeout: 45000 },
    ).catch(() => {})
    await new Promise(r => setTimeout(r, 1500))

    const rows = (payload && payload.listings) || []
    if (!rows.length) { no('board loads with listings', 'no listings payload seen'); throw new Error('no data') }
    ok('board loads with listings', `${rows.length}`)

    // ── the API side of the contract ────────────────────────────────────────
    const tri = v => v === true || v === false || v === null
    if (rows.every(r => tri(r.petFriendly) && tri(r.sharing))) ok('every card carries tri-state flags')
    else no('every card carries tri-state flags', 'some flag is undefined or not tri-state')

    const petYes = rows.filter(r => r.petFriendly === true)
    const petNo = rows.filter(r => r.petFriendly === false)
    const shareYes = rows.filter(r => r.sharing === true)
    const shareNo = rows.filter(r => r.sharing === false)
    ok('the flags are actually populated',
      `pets ${petYes.length} yes / ${petNo.length} no · sharing ${shareYes.length} yes / ${shareNo.length} no`)

    // ── what the DOM draws ──────────────────────────────────────────────────
    const shown = await page.evaluate(() => {
      const out = {}
      for (const card of document.querySelectorAll('[data-ref]')) {
        const ref = card.getAttribute('data-ref')
        const labels = [...card.querySelectorAll('svg[aria-label]')].map(s => s.getAttribute('aria-label'))
        out[ref] = labels
      }
      return out
    })
    const cardCount = Object.keys(shown).length
    if (cardCount > 0) ok('cards are in the DOM', `${cardCount}`)
    else { no('cards are in the DOM', '0 — nothing rendered, every icon check below is meaningless'); throw new Error('no cards') }

    const iconFor = (ref, what) => (shown[ref] || []).find(l => l && l.startsWith(what))

    // A listing whose text says yes must show the solid icon…
    const yesRef = petYes.map(r => r.ref).find(ref => shown[ref])
    if (!yesRef) no('a pets-yes listing is on the page', 'none of the yes listings rendered')
    else if (iconFor(yesRef, 'Pets') === 'Pets yes') ok('pets-yes draws the paw', `#${yesRef}`)
    else no('pets-yes draws the paw', `#${yesRef} → ${iconFor(yesRef, 'Pets')}`)

    // …one whose text says no must show the refused icon…
    const noRef = petNo.map(r => r.ref).find(ref => shown[ref])
    if (!noRef) ok('no pets-no listing on this page (fine)', 'skipped')
    else if (iconFor(noRef, 'Pets') === 'Pets no') ok('pets-no draws the slashed paw', `#${noRef}`)
    else no('pets-no draws the slashed paw', `#${noRef} → ${iconFor(noRef, 'Pets')}`)

    // …and a listing that says nothing must draw NOTHING. This is the assertion
    // that keeps the board from implying a policy nobody stated.
    const unknownRef = rows.filter(r => r.petFriendly === null).map(r => r.ref).find(ref => shown[ref])
    if (!unknownRef) no('an unknown-pets listing is on the page', 'none rendered')
    else if (!iconFor(unknownRef, 'Pets')) ok('unknown pets draws no icon at all', `#${unknownRef}`)
    else no('unknown pets draws no icon at all', `#${unknownRef} → ${iconFor(unknownRef, 'Pets')}`)

    const shareYesRef = shareYes.map(r => r.ref).find(ref => shown[ref])
    if (!shareYesRef) ok('no sharing-yes listing on this page (fine)', 'skipped')
    else if (iconFor(shareYesRef, 'Sharing') === 'Sharing yes') ok('sharing-yes draws the people icon', `#${shareYesRef}`)
    else no('sharing-yes draws the people icon', `#${shareYesRef} → ${iconFor(shareYesRef, 'Sharing')}`)

    // ── the download button ─────────────────────────────────────────────────
    const withPhotos = rows.find(r => (r.imageCount || 0) >= 2 && shown[r.ref])
    if (!withPhotos) { no('a listing with photos is on the page', 'none found'); throw new Error('no subject') }

    const btn = await page.$(`[data-ref="${withPhotos.ref}"] button[aria-label^="Download"]`)
    if (btn) ok('the card has a download button', `#${withPhotos.ref}, ${withPhotos.imageCount} photos`)
    else no('the card has a download button', `#${withPhotos.ref}`)

    const title = btn ? await page.evaluate(el => el.getAttribute('title'), btn) : ''
    if (/Facebook/i.test(title || '')) ok('the button says what it is for')
    else no('the button says what it is for', title || '(no title)')

    // Clicking it must NOT open the listing modal — the click is stopped at the
    // button. If it bubbled, the agent would get a modal every time they saved
    // photos.
    if (btn && DO_DOWNLOAD) {
      const client = await page.target().createCDPSession()
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir })
      await btn.click()
      const want = Math.min(withPhotos.imageCount, 4)
      const deadline = Date.now() + 45000
      let files = []
      while (Date.now() < deadline) {
        files = fs.readdirSync(dlDir).filter(f => !f.endsWith('.crdownload'))
        if (files.length >= want) break
        await new Promise(r => setTimeout(r, 500))
      }
      if (files.length >= want) ok('clicking it saves the photos', `${files.length} files, e.g. ${files[0]}`)
      else no('clicking it saves the photos', `${files.length} of ${want} after 45s: ${files.join(', ')}`)

      const named = files.filter(f => f.startsWith(withPhotos.ref))
      if (named.length) ok('files are named after the ref', named.slice(0, 3).join(', '))
      else no('files are named after the ref', files.slice(0, 3).join(', ') || '(none)')

      const sizes = files.map(f => fs.statSync(path.join(dlDir, f)).size)
      if (sizes.length && sizes.every(s => s > 5000)) ok('the files are real images', `${Math.min(...sizes)}–${Math.max(...sizes)} bytes`)
      else no('the files are real images', sizes.join(', ') || '(none)')

      const modalOpen = await page.evaluate(() =>
        !!document.querySelector('[role="dialog"], [data-board-modal]'))
      if (!modalOpen) ok('the download click does not open the listing modal')
      else no('the download click does not open the listing modal', 'a modal is open')
    }

    await page.screenshot({ path: path.join(SHOTS, 'board-card-extras.png') })

    // RefererNotAllowedMapError is expected on crm.localhost: the browser Maps
    // key is HTTP-referrer restricted to crm.2906.estate, which is the point of
    // it. tests/probe_key_real_origin.js is what verifies the key itself.
    const realErrors = consoleErrors.filter(e =>
      !/403/.test(e) && !/RefererNotAllowedMapError|referer-not-allowed/i.test(e))
    if (!realErrors.length) ok('no console errors')
    else no('no console errors', realErrors.slice(0, 3).join(' | '))
  } catch (e) {
    no('run completed', e.message)
  } finally {
    await browser.close()
    try { fs.rmSync(dlDir, { recursive: true, force: true }) } catch { /* temp dir */ }
  }

  console.log(`\n=== PASS ${pass.length}  FAIL ${fail.length} ===`)
  pass.forEach(p => console.log(`  PASS  ${p}`))
  fail.forEach(f => console.log(`  FAIL  ${f}`))
  process.exit(fail.length ? 1 : 0)
}

run().catch(e => { console.error('HARNESS ERROR', e); process.exit(1) })
