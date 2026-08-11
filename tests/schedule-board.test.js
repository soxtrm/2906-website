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
// Fall A safety: "Ask owner" is only a dry run while the backend's
// SCHEDULE_BOARD_FALL_A_LIVE is unset. Once armed, that button messages a real
// owner — an earlier run of this file did exactly that for #2906-119. So the
// click is gated on FALL_A_ARMED being anything but 1, and the run says out
// loud that it skipped instead of quietly passing.
// The Fall B buttons always send for real and are never clicked here.
// ============================================================================
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

// Defaults to the local server behind the crm.* host rewrite; point BASE at
// https://crm.2906.estate to run the same checks against production.
const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const SHOTS = path.join(__dirname, 'screenshots')
const PREFIX = process.env.SHOT_PREFIX || 'board'

// Values that live in properties.street / owner_contacts — none may reach the DOM.
const FORBIDDEN_TEXT = ['San Antnin', 'Residenza Denfil', 'Triq San Ġorġ']
const FORBIDDEN_KEYS = ['street', 'apt', 'owner', 'owner_id', 'ownerPhone', 'owner_phone', 'phone', 'email']

const pass = []
const fail = []
const skipped = []
const ok = (n, extra) => { pass.push(extra ? `${n} (${extra})` : n) }
const no = (n, why) => { fail.push(`${n}: ${why}`) }
const skip = (n, why) => { skipped.push(`${n}: ${why}`) }

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

  await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/' })

  // ── optional: stubbed Maps API ─────────────────────────────────────────────
  // The real map needs Maps JavaScript API enabled on the key's Cloud project.
  // Until that is done the board's own area-drawing logic — anchor on mousedown,
  // resize on mousemove, commit on mouseup, mirror into the URL, filter the
  // cards — can still be exercised end to end against a stand-in for
  // google.maps. The page prefers an already-present window.google, so this
  // never loads Google's script.
  if (process.env.MAPS_STUB === '1') {
    await page.evaluateOnNewDocument(() => {
      const listeners = {}
      const mk = (lat, lng) => ({ lat: () => lat, lng: () => lng })
      class LatLngBounds {
        constructor(sw, ne) { this._sw = sw; this._ne = ne }
        getNorthEast() { return mk(this._ne.lat, this._ne.lng) }
        getSouthWest() { return mk(this._sw.lat, this._sw.lng) }
      }
      class Rectangle {
        constructor(o) { this.o = o || {}; this.bounds = this.o.bounds; window.__rects.push(this) }
        setMap(m) { this.map = m; if (!m) this.removed = true }
        setBounds(b) { this.bounds = b }
        getBounds() {
          const b = this.bounds
          if (b instanceof LatLngBounds) return b
          return new LatLngBounds({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east })
        }
      }
      class MapStub {
        constructor(div, opts) { this.div = div; this.opts = opts; window.__map = this }
        addListener(name, cb) { (listeners[name] ||= []).push(cb); return { name, cb } }
        setOptions(o) { this.opts = { ...this.opts, ...o } }
        fitBounds() {}
      }
      class Marker {
        constructor(o) { this.o = o; window.__markers.push(o) }
        setMap(m) { if (!m) { const i = window.__markers.indexOf(this.o); if (i > -1) window.__markers.splice(i, 1) } }
        addListener() { return {} }
      }
      class Circle { constructor(o) { this.o = o } setMap() {} }
      window.__rects = []
      window.__markers = []
      window.__mapStub = true
      window.google = {
        maps: {
          Map: MapStub, Rectangle, LatLngBounds, Marker, Circle,
          SymbolPath: { CIRCLE: 'circle' },
          event: { addListener: (o, n, cb) => ({ n, cb }), removeListener: () => {} },
        },
      }
      // Drive the map listeners the way a real drag would.
      window.__fireMap = (name, lat, lng) => {
        for (const cb of listeners[name] || []) cb({ latLng: mk(lat, lng) })
      }
    })
  }

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
    if (window.__mapStub) return 'stub'
    if (document.body.innerText.includes('Map needs a Google Maps key')) return 'no-key'
    if (document.body.innerText.includes('Google Maps failed to load')) return 'load-failed'
    if (document.querySelector('#gmaps-js')) return 'script-injected'
    return 'unknown'
  })
  if (mapState === 'no-key' || mapState === 'script-injected' || mapState === 'stub') ok('map panel state', mapState)
  else no('map panel state', mapState)

  // ── 6s. area drawing against the stub ─────────────────────────────────────
  if (process.env.MAPS_STUB === '1') {
    try {
      await page.waitForFunction(() => document.body.innerText.includes('Draw area'), { timeout: 20000 })
      const markers = await page.evaluate(() => window.__markers.length)
      const listed = Number(await page.evaluate(() =>
        (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1]))
      // 8 listings carry no town we can place, so a pin per placeable listing.
      if (markers > 0 && markers <= listed) ok('markers created', `${markers} pins for ${listed} listings`)
      else no('markers created', `${markers} pins for ${listed} listings`)
      const green = await page.evaluate(() =>
        window.__markers.filter(m => m.icon && m.icon.fillColor === '#2f6f57').length)
      if (green > 0) ok('own listings get green pins', `${green} of ${markers}`)
      else no('own listings get green pins', `${green} of ${markers}`)

      // arm, then drag a box across the middle of Malta
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Draw area')).click()
      })
      await page.waitForFunction(() => window.__map && window.__map.opts.draggable === false, { timeout: 10000 })
      ok('draw mode locks the map', 'draggable=false, crosshair cursor')
      await page.evaluate(() => {
        window.__fireMap('mousedown', 35.95, 14.44)
        window.__fireMap('mousemove', 35.90, 14.50)
        window.__fireMap('mouseup', 35.88, 14.52)
      })
      await page.waitForFunction(() => location.search.includes('rect='), { timeout: 15000 })
      await page.waitForFunction(() => document.body.innerText.includes('Clear area'), { timeout: 15000 })
      const drawn = Number(await page.evaluate(() =>
        (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1]))
      const rectParam = await page.evaluate(() => new URLSearchParams(location.search).get('rect'))
      if (drawn > 0 && drawn < listed) ok('draw area filters', `${listed} → ${drawn} in the box, rect=${rectParam}`)
      else no('draw area filters', `${listed} → ${drawn}`)
      const drawnMarkers = await page.evaluate(() => window.__markers.length)
      if (drawnMarkers <= drawn) ok('pins follow the box', `${drawnMarkers} pins left`)
      else no('pins follow the box', `${drawnMarkers} pins for ${drawn} listings`)

      // a shared link restores the box
      const url = await page.url()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForFunction(() => /\d+\s+listings?/.test(document.body.innerText), { timeout: 60000 })
      const restored = Number(await page.evaluate(() =>
        (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1]))
      const rectDrawn = await page.evaluate(() => window.__rects.filter(r => !r.removed).length)
      if (restored === drawn && rectDrawn === 1) ok('shared link restores the box', `${restored} listings, box redrawn`)
      else no('shared link restores the box', `${restored} vs ${drawn} listings, ${rectDrawn} rectangles`)

      // clearing puts everything back
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Clear area')).click()
      })
      await page.waitForFunction(() => !location.search.includes('rect='), { timeout: 15000 })
      await new Promise(r => setTimeout(r, 600))
      const cleared = Number(await page.evaluate(() =>
        (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1]))
      const gone = await page.evaluate(() => window.__rects.every(r => r.removed))
      if (cleared === listed && gone) ok('clear area restores', `back to ${cleared}, rectangle removed`)
      else no('clear area restores', `${cleared} vs ${listed}, rectangleRemoved=${gone}`)

      // a click without a drag must cancel, not filter everything away
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Draw area')).click()
      })
      await page.evaluate(() => {
        window.__fireMap('mousedown', 35.90, 14.48)
        window.__fireMap('mouseup', 35.90, 14.48)
      })
      await new Promise(r => setTimeout(r, 900))
      const afterTap = Number(await page.evaluate(() =>
        (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1]))
      const noRect = await page.evaluate(() => !location.search.includes('rect='))
      if (afterTap === listed && noRect) ok('stray click cancels instead of filtering', `still ${afterTap}`)
      else no('stray click cancels instead of filtering', `${afterTap} listings, rect in URL=${!noRect}`)
    } catch (e) { no('area drawing (stub)', e.message) }
  }

  // ── 6a. real Google map (only when the build carries a key) ───────────────
  // Google reports key problems (RefererNotAllowedMapError, ApiNotActivated…)
  // on the console, not as a failed request, so the class is picked out of the
  // console log rather than guessed.
  if (process.env.MAPS_EXPECTED === '1') {
    try {
      await page.waitForFunction(() => {
        const w = window
        return !!(w.google && w.google.maps && w.google.maps.drawing)
      }, { timeout: 40000 })
      await page.waitForFunction(
        () => document.body.innerText.includes('Draw area'), { timeout: 20000 })
      const tiles = await page.evaluate(() =>
        document.querySelectorAll('img[src*="maps.googleapis.com"], canvas').length)
      const authErr = consoleErrors.find(t => /Google Maps JavaScript API (error|warning)/i.test(t))
      if (authErr) no('google map renders', authErr.slice(0, 160))
      else ok('google map renders', `drawing library ready, "Draw area" visible, ${tiles} tile/canvas nodes`)
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-map.png`) })

      // Draw an area for real: arm the tool, drag a box across the middle of
      // the map, and check it both filters and lands in the URL.
      const total = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Draw area'))
        b.click()
      })
      const box = await (await page.$('.gm-style')).boundingBox()
      const x1 = box.x + box.width * 0.30, y1 = box.y + box.height * 0.28
      const x2 = box.x + box.width * 0.78, y2 = box.y + box.height * 0.80
      await page.mouse.move(x1, y1)
      await page.mouse.down()
      for (let s = 1; s <= 6; s++) {
        await page.mouse.move(x1 + ((x2 - x1) * s) / 6, y1 + ((y2 - y1) * s) / 6)
        await new Promise(r => setTimeout(r, 60))
      }
      await page.mouse.up()
      await page.waitForFunction(() => location.search.includes('rect='), { timeout: 15000 })
      await page.waitForFunction(() => document.body.innerText.includes('Clear area'), { timeout: 15000 })
      await new Promise(r => setTimeout(r, 1200))
      const drawn = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-map-drawn.png`) })
      if (Number(drawn) < Number(total)) ok('draw area filters', `${total} → ${drawn} inside the box, rect= in URL`)
      else no('draw area filters', `count did not narrow: ${total} → ${drawn}`)

      // and clearing it puts every listing back
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Clear area'))
        b.click()
      })
      await page.waitForFunction(t => !location.search.includes('rect='), { timeout: 15000 })
      await new Promise(r => setTimeout(r, 900))
      const cleared = await page.evaluate(() => (document.body.innerText.match(/(\d+)\s+listings?/) || [])[1])
      if (cleared === total) ok('clear area restores', `back to ${cleared}`)
      else no('clear area restores', `${cleared} vs ${total}`)
    } catch (e) {
      const authErr = consoleErrors.find(t => /Google Maps JavaScript API (error|warning)/i.test(t))
      no('google map renders', authErr ? authErr.slice(0, 160) : e.message)
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-map-failed.png`) })
    }
  }

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

  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-cards.png`), fullPage: false })
  await page.evaluate(() => window.scrollTo(0, 0))
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-desktop.png`), fullPage: false })

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
  try {
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /\d+\s+listings?/.test(document.body.innerText), { timeout: 60000 })
  } catch (e) {
    no('reload unfiltered board', e.message)
    await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-reload-failed.png`) })
  }

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
    await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-modal.png`) })
    const mHtml = await page.content()
    const mLeak = FORBIDDEN_TEXT.filter(s => mHtml.includes(s))
    if (!mLeak.length) ok('firewall: modal clean')
    else no('firewall: modal clean', mLeak.join(', '))
    await page.keyboard.press('Escape')
  } catch (e) { no('detail modal loads', e.message) }

  // ── 10. Fall A button end-to-end (only while it sends nothing) ────────────
  if (process.env.FALL_A_ARMED === '1') {
    skip('Fall A button click', 'backend is armed (SCHEDULE_BOARD_FALL_A_LIVE=1) — clicking would message a real owner')
  } else try {
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
    await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-falla-toast.png`) })
  } catch (e) { no('Fall A dry run wired', e.message) }

  // ── 11. mobile ────────────────────────────────────────────────────────────
  try {
    await page.setViewport({ width: 390, height: 844 })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => /\d+\s+listings?/.test(document.body.innerText), { timeout: 60000 })
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)
    await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-mobile.png`) })
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
  skipped.forEach(s => console.log('  SKIP  ' + s))
  fail.forEach(f => console.log('  FAIL  ' + f))
  console.log(`\nPASS ${pass.length}  SKIP ${skipped.length}  FAIL ${fail.length}`)
  if (fail.length) process.exit(1)
}

run().catch(e => { console.error('FATAL', e); process.exit(1) })
