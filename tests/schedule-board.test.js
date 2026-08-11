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

  // HOST_MAP lets the suite run against a real origin served locally, e.g.
  // HOST_MAP="crm.2906.estate 127.0.0.1" with the TLS proxy — that is the only
  // way to exercise a referrer-restricted Maps key before the key is deployed.
  const args = [
    `--host-resolver-rules=MAP ${process.env.HOST_MAP || 'crm.localhost 127.0.0.1'}`,
    '--no-sandbox',
  ]
  if (process.env.IGNORE_CERT === '1') args.push('--ignore-certificate-errors')
  const browser = await puppeteer.launch({ headless: 'new', args })
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

  // ── record the markers the real Maps API builds ────────────────────────────
  // Markers are drawn on canvas, so there is no DOM node to assert on. Google
  // assigns google.maps.Marker while its bundle loads, so a property setter
  // planted before any script runs can wrap the real constructor and keep the
  // instances — positions and colours stay verifiable, and a click can be sent
  // through Google's own event system instead of guessed pixel maths.
  if (process.env.MAPS_EXPECTED === '1') {
    await page.evaluateOnNewDocument(() => {
      window.__markers = []
      const patchMaps = maps => {
        let M
        try {
          Object.defineProperty(maps, 'Marker', {
            configurable: true,
            get() { return M },
            set(Orig) {
              function Patched(o) {
                const m = new Orig(o)
                window.__markers.push({ o, m })
                return m
              }
              Patched.prototype = Orig.prototype
              Object.setPrototypeOf(Patched, Orig)
              M = Patched
            },
          })
        } catch (e) { /* already defined — leave the real one alone */ }
      }
      let g
      Object.defineProperty(window, 'google', {
        configurable: true,
        get() { return g },
        set(v) {
          g = v
          if (v && v.maps) { patchMaps(v.maps); return }
          let maps
          try {
            Object.defineProperty(v, 'maps', {
              configurable: true,
              get() { return maps },
              set(m) { maps = m; patchMaps(m) },
            })
          } catch (e) { /* ignore */ }
        },
      })
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
    if (document.body.innerText.includes('Map needs a Google Maps key')) return 'no-key'
    if (document.body.innerText.includes('Google Maps failed to load')) return 'load-failed'
    if (document.querySelector('#gmaps-js')) return 'script-injected'
    return 'unknown'
  })
  if (mapState === 'no-key' || mapState === 'script-injected') ok('map panel state', mapState)
  else no('map panel state', mapState)


  // ── 6a. real Google map (only when the build carries a key) ───────────────
  // Google reports key problems (RefererNotAllowedMapError, ApiNotActivated…)
  // on the console, not as a failed request, so the class is picked out of the
  // console log rather than guessed.
  if (process.env.MAPS_EXPECTED === '1') {
    try {
      // Wait for the core API only — `drawing` is deliberately not loaded any
      // more, so waiting on it would hang forever.
      await page.waitForFunction(() => {
        const w = window
        return !!(w.google && w.google.maps && w.google.maps.Map && w.google.maps.Rectangle)
      }, { timeout: 40000 })
      await page.waitForFunction(
        () => document.body.innerText.includes('Draw area'), { timeout: 20000 })
      const tiles = await page.evaluate(() =>
        document.querySelectorAll('img[src*="maps.googleapis.com"], canvas').length)
      const authErr = consoleErrors.find(t => /Google Maps JavaScript API (error|warning)/i.test(t))
      if (authErr) no('google map renders', authErr.slice(0, 160))
      else ok('google map renders', `real tiles up, "Draw area" visible, ${tiles} tile/canvas nodes`)
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-map.png`) })

      // ── markers land on the right Malta towns ─────────────────────────────
      // MALTA holds the whole archipelago; SLIEMA is checked separately because
      // a plausible-looking but wrong geocode would still sit inside Malta.
      const MALTA = { south: 35.77, north: 36.10, west: 14.17, east: 14.59 }
      const SLIEMA = { lat: 35.9122, lng: 14.5019 }
      const pins = await page.evaluate(() => window.__markers.map(m => ({
        lat: typeof m.o.position.lat === 'function' ? m.o.position.lat() : m.o.position.lat,
        lng: typeof m.o.position.lng === 'function' ? m.o.position.lng() : m.o.position.lng,
        title: m.o.title || '',
        colour: m.o.icon && m.o.icon.fillColor,
      })))
      if (!pins.length) {
        skip('marker positions', 'could not capture marker instances from the real API')
      } else {
        const outside = pins.filter(p =>
          p.lat < MALTA.south || p.lat > MALTA.north || p.lng < MALTA.west || p.lng > MALTA.east)
        if (!outside.length) ok('markers inside Malta', `all ${pins.length} pins within the archipelago`)
        else no('markers inside Malta', `${outside.length} off-island, e.g. ${JSON.stringify(outside[0])}`)

        const green = pins.filter(p => p.colour === '#2f6f57').length
        if (green > 0 && green < pins.length) ok('own vs team pin colours', `${green} green, ${pins.length - green} amber`)
        else no('own vs team pin colours', `${green} green of ${pins.length}`)

        // Cross-check one town against its real coordinate, using the town the
        // API reported for that ref rather than anything the map told us.
        try {
          const byRef = {}
          for (const l of (JSON.parse(listingsBody).listings || [])) byRef[l.ref] = l.town
          const sliemaPin = pins.find(p => {
            const ref = (p.title.match(/#(\S+)/) || [])[1]
            return ref && /sliema/i.test(byRef[ref] || '')
          })
          if (!sliemaPin) throw new Error('no Sliema listing among the pins')
          const km = Math.hypot(
            (sliemaPin.lat - SLIEMA.lat) * 111,
            (sliemaPin.lng - SLIEMA.lng) * 111 * Math.cos(SLIEMA.lat * Math.PI / 180))
          if (km < 3) ok('town coordinates are real', `Sliema pin ${km.toFixed(2)} km from the real Sliema`)
          else no('town coordinates are real', `Sliema pin is ${km.toFixed(1)} km off`)
        } catch (e) { no('town coordinates are real', e.message) }
      }


    } catch (e) {
      const authErr = consoleErrors.find(t => /Google Maps JavaScript API (error|warning)/i.test(t))
      no('google map renders', authErr ? authErr.slice(0, 160) : e.message)
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-map-failed.png`) })
    }

    // ── drag a real box on the real map ──────────────────────────────────────
    try {
      // Runs BEFORE the marker-click check on purpose: that one scrolls a card
      // into view with `behavior: 'smooth'`, and the animation kept running
      // into this drag, sliding the map out from under viewport-relative mouse
      // coordinates. `.gm-style` also appears later than the button — it needs
      // the Map to have built its own DOM.
      await page.waitForSelector('.gm-style', { timeout: 30000 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForFunction(() => {
        const y = window.scrollY
        if (window.__lastY === y) return true
        window.__lastY = y
        return false
      }, { polling: 300, timeout: 15000 })
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
      no('draw area filters', e.message)
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-drag-failed.png`) })
    }

      // ── marker click scrolls its card into view ───────────────────────────
      try {
        const clickedRef = await page.evaluate(() => {
          // Pick a marker whose card is far down the grid, so "it scrolled" is
          // not simply "it was already on screen".
          const pick = window.__markers[Math.min(24, window.__markers.length - 1)]
          const ref = (pick.o.title.match(/#(\S+)/) || [])[1]
          window.scrollTo(0, 0)
          window.google.maps.event.trigger(pick.m, 'click')
          return ref
        })
        await new Promise(r => setTimeout(r, 1800))
        const seen = await page.evaluate(ref => {
          const el = Array.from(document.querySelectorAll('span'))
            .find(s => s.innerText.trim() === `#${ref}`)
          if (!el) return { found: false }
          const card = el.closest('div[style*="border-radius"]') || el.parentElement
          const r = card.getBoundingClientRect()
          return { found: true, inView: r.top > -50 && r.top < window.innerHeight, top: Math.round(r.top) }
        }, clickedRef)
        if (seen.found && seen.inView) ok('marker click scrolls to its card', `#${clickedRef} at y=${seen.top}`)
        else no('marker click scrolls to its card', `#${clickedRef} ${JSON.stringify(seen)}`)
        await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-marker-click.png`) })
      } catch (e) { no('marker click scrolls to its card', e.message) }
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
