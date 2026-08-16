// ============================================================================
// tests/board-watag.test.js — E2E for WATag and the Favourites tab on
// /schedule-board.
//
// Same harness as tests/board-availability.test.js: crm.localhost behind the
// host rewrite, a real CRM JWT injected as the crm_session cookie, and the
// production backend underneath.
//
// WHAT IT DOES AND DOES NOT SEND
//   Every WhatsApp send in this suite is aimed at a THROWAWAY group that holds
//   only our own accounts (WATAG_TEST_GROUP). It gets there by giving one test
//   listing (2906-9001) a temporary anchor row pointing at that group, and
//   deleting it again in the finally block. No real category group is touched.
//
//   The ceiling is proved WITHOUT sending anything: the selection is built from
//   whatever the board shows, and the assertion is that the sixteenth pick is
//   refused. The button is never pressed on that selection.
//
//   SKIP_MUTATION=1 runs everything except the two clicks that send a "." and
//   the booking — rendering, tabs, the ceiling, the greyed-out states.
// ============================================================================
const puppeteer = require('puppeteer')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE || 'http://crm.localhost:3000'
const COOKIE_DOMAIN = new URL(BASE).hostname
const TOKEN = process.env.CRM_TOKEN
const SHOTS = path.join(__dirname, 'screenshots')
const MUTATE = process.env.SKIP_MUTATION !== '1'
const VPS = 'root@178.104.162.193'
const GROUP = process.env.WATAG_TEST_GROUP || '120363427736530383@g.us'
const SUBJECT = '2906-9001'

const pass = []
const fail = []
const skipped = []
const ok = (n, extra) => pass.push(extra ? `${n} (${extra})` : n)
const no = (n, why) => fail.push(`${n}: ${why}`)
const skip = (n, why) => skipped.push(`${n}: ${why}`)

function sql(query) {
  return execFileSync('ssh', [
    VPS,
    `docker exec -i 2906_postgres psql -U 2906user -d 2906db -A -t -c ${JSON.stringify(query)}`,
  ], { encoding: 'utf8', timeout: 30000 }).trim()
}

// Post a stand-in listing message into the throwaway group and record it as the
// subject's anchor, so the "." this suite sends has somewhere safe to land.
function armSubject() {
  const script = `
    const config = require('/app/config');
    (async () => {
      const res = await fetch(config.waha.url + '/api/sendText', {
        method: 'POST',
        headers: {'Content-Type':'application/json','X-Api-Key':config.waha.apiKey},
        body: JSON.stringify({ session:'Kevsecond', chatId:'${GROUP}',
          text:'#${SUBJECT} · WATag E2E fixture · not a real property' }),
      });
      const j = await res.json();
      console.log(j.id || (j.key && j.key.id));
    })();
  `.replace(/\n\s*/g, ' ')
  const msgId = execFileSync('ssh', [
    VPS, `docker exec 2906_backend node -e ${JSON.stringify(script)}`,
  ], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop().trim()
  if (!msgId || msgId === 'undefined') throw new Error('could not post the fixture message')
  // The fixture listing is 'not_available' in the database, which is exactly
  // where a test property belongs — but the ACTIVE board is the surface under
  // test, so it has to be visible for the length of the run. Put back in
  // disarm().
  sql(`UPDATE properties SET available_status='available' WHERE ref='${SUBJECT}'`)
  // One line: sql() hands the query to psql -c through JSON.stringify, and a
  // real newline arrives there as a literal backslash-n that psql rejects.
  sql(`INSERT INTO property_publishing_status (property_id, channel, target_ref, status, posted_at, external_ref) SELECT id, 'category_groups', '${GROUP}', 'posted', NOW(), '${msgId}' FROM properties WHERE ref='${SUBJECT}' ON CONFLICT (property_id, channel, target_ref) DO UPDATE SET status='posted', external_ref=EXCLUDED.external_ref, posted_at=NOW()`)
  return msgId
}

function disarm() {
  try {
    sql(`DELETE FROM property_publishing_status WHERE channel='category_groups' AND target_ref='${GROUP}'`)
    sql(`DELETE FROM agent_favourites WHERE property_id IN (SELECT id FROM properties WHERE ref='${SUBJECT}')`)
    sql(`DELETE FROM property_viewings WHERE source='agent_book' AND property_id IN (SELECT id FROM properties WHERE ref='${SUBJECT}')`)
    sql(`DELETE FROM property_activities WHERE activity_type='watag_anchor'`)
    sql(`UPDATE properties SET available_status='not_available' WHERE ref='${SUBJECT}'`)
  } catch (e) { console.error('cleanup failed:', e.message) }
}

async function run() {
  if (!TOKEN) throw new Error('CRM_TOKEN env var missing')
  fs.mkdirSync(SHOTS, { recursive: true })

  // armed is set BEFORE the fixture is built, not after: armSubject makes
  // several writes and a failure halfway through still needs the finally block
  // to put production back. Learned the hard way — a syntax error in the second
  // statement left the fixture listing sitting on the live board.
  let armed = false
  if (MUTATE) { armed = true; armSubject() }

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
  const calls = { watagOne: null, watagBulk: null, favourites: 0, book: null }
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('response', async res => {
    const u = res.url()
    if (!u.includes('/api/crm/schedule-board')) return
    if (/\/favourites(\?|$)/.test(u)) calls.favourites++
    try {
      if (/\/watag$/.test(u) && res.request().method() === 'POST') calls.watagBulk = await res.json()
      if (/\/listings\/[^/]+\/watag$/.test(u)) calls.watagOne = { status: res.status(), body: await res.json() }
      if (/\/listings\/[^/]+\/book$/.test(u)) calls.book = await res.json()
    } catch { /* body already consumed or not json */ }
  })

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.setCookie({ name: 'crm_session', value: TOKEN, domain: COOKIE_DOMAIN, path: '/' })
    await page.goto(`${BASE}/schedule-board`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-ref]', { timeout: 30000 })

    const cards = await page.$$('[data-ref]')
    if (!cards.length) throw new Error('no cards rendered — the rest of the suite would be vacuous')
    ok('board renders', `${cards.length} cards`)

    // ── 1. the WATag controls exist ─────────────────────────────────────────
    const oneBtns = await page.$$('[data-watag-one]')
    oneBtns.length === cards.length
      ? ok('every card has a WATag button', `${oneBtns.length}`)
      : no('every card has a WATag button', `${oneBtns.length} buttons for ${cards.length} cards`)

    const selectAll = await page.$('[data-watag-selectall]')
    selectAll ? ok('the toolbar has a Select for WATag control')
              : no('the toolbar has a Select for WATag control', 'not found')

    // ── the star ────────────────────────────────────────────────────────────
    // Top-left of every card, on every tab, and it is a toggle so it has to
    // arrive already pointing the right way.
    const stars = await page.$$('[data-favourite]')
    stars.length === cards.length
      ? ok('every card has a favourites star', `${stars.length}`)
      : no('every card has a favourites star', `${stars.length} stars for ${cards.length} cards`)

    const starTop = await page.$$eval('[data-favourite]', els => els.slice(0, 3).map(e => {
      const b = e.getBoundingClientRect()
      const card = e.closest('[data-ref]').getBoundingClientRect()
      return { dx: Math.round(b.left - card.left), dy: Math.round(b.top - card.top),
               w: Math.round(b.width), h: Math.round(b.height) }
    }))
    starTop.every(s => s.dx < 20 && s.dy < 20)
      ? ok('the star sits in the top-left corner', JSON.stringify(starTop[0]))
      : no('the star sits in the top-left corner', JSON.stringify(starTop))
    starTop.every(s => s.w >= 30 && s.h >= 30)
      ? ok('and clears the 30px tap floor')
      : no('and clears the 30px tap floor', JSON.stringify(starTop))

    if (MUTATE) {
      // Star a listing, and check the state survives a reload rather than only
      // looking right until the page is refreshed.
      const first = await page.$eval('[data-favourite]', e => e.getAttribute('data-favourite'))
      await page.click(`[data-favourite="${first}"]`)
      await page.waitForResponse(r => /\/favourite$/.test(r.url()), { timeout: 20000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 700))
      const on = await page.$eval(`[data-favourite="${first}"]`, e => e.getAttribute('aria-pressed'))
      on === 'true' ? ok('clicking the star fills it', `#${first}`)
                    : no('clicking the star fills it', `aria-pressed=${on}`)

      await page.reload({ waitUntil: 'networkidle2' })
      await page.waitForSelector('[data-favourite]', { timeout: 30000 })
      const still = await page.$eval(`[data-favourite="${first}"]`, e => e.getAttribute('aria-pressed'))
        .catch(() => 'missing')
      still === 'true' ? ok('and it is still filled after a reload')
                       : no('and it is still filled after a reload', `aria-pressed=${still}`)

      // Put it back.
      await page.click(`[data-favourite="${first}"]`)
      await page.waitForResponse(r => /\/favourite$/.test(r.url()), { timeout: 20000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 600))
      sql(`DELETE FROM agent_favourites WHERE agent_id=1 AND property_id IN (SELECT id FROM properties WHERE ref='${first}')`)
    }

    // The send button must NOT be there before anything is picked.
    const sendBefore = await page.$('[data-watag-send]')
    !sendBefore ? ok('no send button until something is picked')
                : no('no send button until something is picked', 'it is already there')

    // ── 2. the greyed-out state is honest ───────────────────────────────────
    const tagStates = await page.$$eval('[data-watag-one]', els => els.map(e => ({
      ref: e.getAttribute('data-watag-one'),
      disabled: e.disabled,
      title: e.getAttribute('title') || '',
    })))
    const dead = tagStates.filter(s => s.disabled)
    dead.length
      ? ok('listings with no stored group message are greyed out', `${dead.length} of ${tagStates.length}`)
      : skip('listings with no stored group message are greyed out', 'every visible listing is taggable')
    if (dead.length) {
      dead.every(s => /no saved group message|off the market/i.test(s.title))
        ? ok('and each says why in its tooltip')
        : no('and each says why in its tooltip', JSON.stringify(dead.slice(0, 2)))
    }
    const live = tagStates.filter(s => !s.disabled)
    if (!live.length) throw new Error('nothing on the board is taggable — cannot test the rest')

    // ── 3. the pick box and the ceiling ─────────────────────────────────────
    const picks = await page.$$('[data-watag-pick]')
    picks.length === live.length
      ? ok('a pick box on exactly the taggable cards', `${picks.length}`)
      : no('a pick box on exactly the taggable cards', `${picks.length} boxes, ${live.length} taggable`)

    const wanted = Math.min(16, picks.length)
    if (wanted < 16) {
      skip('the 16th pick is refused', `only ${picks.length} taggable cards on this board`)
    } else {
      for (let i = 0; i < 16; i++) {
        await picks[i].click()
        await new Promise(r => setTimeout(r, 60))
      }
      const count = await page.$$eval('[data-watag-pick][aria-pressed="true"]', e => e.length)
      count === 15
        ? ok('the 16th pick is refused — the selection stops at 15')
        : no('the 16th pick is refused', `${count} are selected`)

      const label = await page.$eval('[data-watag-send]', e => e.textContent.trim())
      label.includes('WATag 15')
        ? ok('the send button names the count', label)
        : no('the send button names the count', label)

      const notice = await page.$$eval('span', els =>
        els.map(e => e.textContent || '').find(t => /15 is the maximum/.test(t)) || '')
      notice ? ok('and the ceiling is stated on screen', notice.trim())
             : no('and the ceiling is stated on screen', 'no notice found')

      // Unpick everything again — nothing in this block may be sent.
      for (let i = 0; i < 16; i++) {
        const el = (await page.$$('[data-watag-pick]'))[i]
        const on = await el.evaluate(e => e.getAttribute('aria-pressed') === 'true')
        if (on) { await el.click(); await new Promise(r => setTimeout(r, 40)) }
      }
      const left = await page.$$eval('[data-watag-pick][aria-pressed="true"]', e => e.length)
      left === 0 ? ok('the selection clears again') : no('the selection clears again', `${left} left`)
    }

    // ── 4. Select for WATag caps at 15 too ──────────────────────────────────
    await page.click('[data-watag-selectall]')
    await new Promise(r => setTimeout(r, 350))
    const bulkCount = await page.$$eval('[data-watag-pick][aria-pressed="true"]', e => e.length)
    bulkCount <= 15 && bulkCount > 0
      ? ok('Select for WATag never picks more than 15', `${bulkCount} picked`)
      : no('Select for WATag never picks more than 15', `${bulkCount} picked`)
    await page.click('[data-watag-send] ~ button')   // the "clear" link
    await new Promise(r => setTimeout(r, 250))

    // ── 5. a real tag, into the throwaway group ─────────────────────────────
    if (!MUTATE) {
      skip('one WATag sends a "." into the group', 'SKIP_MUTATION=1')
      skip('booking puts the listing in Favourites', 'SKIP_MUTATION=1')
    } else {
      const subject = await page.$(`[data-watag-one="${SUBJECT}"]`)
      if (!subject) {
        skip('one WATag sends a "." into the group', `${SUBJECT} is not on the active board`)
      } else {
        await subject.click()
        await page.waitForResponse(
          r => /\/listings\/[^/]+\/watag$/.test(r.url()), { timeout: 30000 })
        await new Promise(r => setTimeout(r, 1200))
        // `ok: true` is not enough — a `duplicate` is also ok:true and sends
        // nothing. Two runs of this suite inside a minute hit the double-click
        // guard, and an assertion that accepted tagged=0 called that a pass.
        const w = (calls.watagOne && calls.watagOne.body) || {}
        if (w.status === 'duplicate') {
          skip('one WATag sends a "." into the group',
            'the double-click guard fired — this listing was tagged under a minute ago')
          skip('and it is in the audit log', 'nothing was sent')
        } else {
          calls.watagOne.status === 200 && w.ok === true && w.tagged >= 1
            ? ok('one WATag sends a "." into the group', `tagged ${w.tagged}`)
            : no('one WATag sends a "." into the group', JSON.stringify(calls.watagOne))

          const audit = sql(`SELECT count(*) FROM property_activities WHERE activity_type='watag_anchor'`)
          Number(audit) > 0 ? ok('and it is in the audit log') : no('and it is in the audit log', audit)
        }
      }
    }

    // ── 6. the Favourites tab ───────────────────────────────────────────────
    const favTab = await page.$('[data-tab="favourites"]')
    favTab ? ok('the Favourites tab exists') : no('the Favourites tab exists', 'not found')

    if (MUTATE) {
      // Book the subject and watch it turn up on the tab by itself.
      const bookBtn = await page.$(`[data-ref="${SUBJECT}"] button ::-p-text(Book)`)
        || await page.evaluateHandle((ref) => {
          const card = document.querySelector(`[data-ref="${ref}"]`)
          return card && [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Book')
        }, SUBJECT)
      const el = bookBtn && bookBtn.asElement ? bookBtn.asElement() : bookBtn
      if (!el) {
        skip('booking puts the listing in Favourites', 'no Book button on the subject card')
      } else {
        await el.click()
        await new Promise(r => setTimeout(r, 700))
        // Fill the dialog: Clients and a date are the two required fields
        // (BookDialog.submit refuses without them). Clients is the autofocused
        // input, which is a stabler handle than its placeholder — that is
        // example text and changes with the copy.
        // Type into Clients for real (React reads key events happily), and set
        // the date through the native setter — a <input type="date"> takes
        // locale-formatted keystrokes and typing "2026-08-19" into one lands as
        // nonsense. Then read both back: "the field looks filled" and "React
        // has the value" are different claims, and only the second books.
        const dateWanted = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
        const clients = await page.evaluateHandle(() => {
          const labels = [...document.querySelectorAll('label')]
          const l = labels.find(x => /^clients/i.test(x.textContent.trim()))
          return l && l.parentElement && l.parentElement.querySelector('input')
        })
        const cEl = clients.asElement()
        if (cEl) { await cEl.click(); await cEl.type('WATag E2E Client', { delay: 12 }) }
        await page.evaluate((d) => {
          const el = [...document.querySelectorAll('input')].find(i => i.type === 'date')
          if (!el) return
          const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
          p.set.call(el, d)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }, dateWanted)
        await new Promise(r => setTimeout(r, 250))
        const filled = await page.evaluate(() => {
          const inputs = [...document.querySelectorAll('input')]
          const text = inputs.find(i => i.value && /WATag E2E Client/.test(i.value))
          const date = inputs.find(i => i.type === 'date')
          return !!(text && date && date.value)
        })
        if (!filled) {
          skip('booking puts the listing in Favourites', 'could not fill the booking form')
          // Close it, or the sheet swallows every click the rest of the suite
          // makes and three later checks fail for no reason of their own.
          await page.keyboard.press('Escape').catch(() => {})
          await new Promise(r => setTimeout(r, 400))
        } else {
          const submit = await page.evaluateHandle(() =>
            [...document.querySelectorAll('button')].find(b => /^book viewing/i.test(b.textContent.trim())))
          const sEl = submit.asElement()
          if (sEl) {
            await sEl.click()
            await page.waitForResponse(r => /\/book$/.test(r.url()), { timeout: 30000 }).catch(() => {})
            await new Promise(r => setTimeout(r, 1800))
          }
          calls.book && calls.book.favourited === true
            ? ok('the booking reports it was favourited')
            : no('the booking reports it was favourited', JSON.stringify(calls.book))

          const dbFav = sql(`SELECT count(*) FROM agent_favourites f JOIN properties p ON p.id=f.property_id WHERE p.ref='${SUBJECT}'`)
          Number(dbFav) > 0
            ? ok('booking puts the listing in Favourites', `${dbFav} row(s)`)
            : no('booking puts the listing in Favourites', `${dbFav} rows`)
        }
      }
    }

    // Open the tab, and PROVE the grid switched before asserting on it. Without
    // this the board's own cards are still on screen and every check below
    // passes against the wrong view — which is exactly what happened when a
    // booking dialog stayed open and swallowed the click.
    await page.click('[data-tab="favourites"]')
    await page.waitForResponse(r => /\/favourites(\?|$)/.test(r.url()), { timeout: 30000 }).catch(() => {})
    await page.waitForFunction(
      () => document.body.innerText.includes('Everything you have booked a viewing on'),
      { timeout: 15000 })
      .then(() => ok('the Favourites tab actually opens'))
      .catch(() => no('the Favourites tab actually opens', 'the grid never switched'))
    await new Promise(r => setTimeout(r, 900))

    const favCards = await page.$$eval('[data-ref]', els => els.map(e => e.getAttribute('data-ref')))
    if (MUTATE) {
      favCards.includes(SUBJECT)
        ? ok('the booked listing is on the Favourites tab')
        : no('the booked listing is on the Favourites tab', JSON.stringify(favCards.slice(0, 6)))

      const line = await page.$eval(`[data-ref="${SUBJECT}"]`, e => e.innerText).catch(() => '')
      line.toLowerCase().includes('viewing')
        ? ok('and the card says which viewing it is here for')
        : no('and the card says which viewing it is here for', line.slice(0, 120))

      const removeBtn = await page.$(`[data-unfavourite="${SUBJECT}"]`)
      if (!removeBtn) no('a favourite can be removed from the card', 'no remove control')
      else {
        await removeBtn.click()
        await new Promise(r => setTimeout(r, 1400))
        const after = await page.$$eval('[data-ref]', els => els.map(e => e.getAttribute('data-ref')))
        !after.includes(SUBJECT)
          ? ok('a favourite can be removed from the card')
          : no('a favourite can be removed from the card', 'still there')
        const still = sql(`SELECT count(*) FROM property_viewings WHERE source='agent_book' AND property_id IN (SELECT id FROM properties WHERE ref='${SUBJECT}')`)
        Number(still) > 0
          ? ok('and the viewing survives the removal', `${still} viewing(s)`)
          : no('and the viewing survives the removal', `${still}`)
      }
    } else {
      ok('the Favourites tab loads', `${favCards.length} cards`)
    }

    calls.favourites > 0
      ? ok('the tab reads its own endpoint', `${calls.favourites} calls`)
      : no('the tab reads its own endpoint', '0 calls to /favourites')

    // ── 6b. the detail modal offers the same actions as the card ────────────
    // It used to offer exactly one button while the card behind it offered
    // five, so opening a listing to read it took every other action away.
    await page.click('[data-tab="board"]')
    await page.waitForSelector('[data-ref]', { timeout: 20000 })
    await new Promise(r => setTimeout(r, 900))
    // The modal opens ON TOP of the grid — the cards stay in the DOM — so the
    // signal is "one more WATag button than before", not "exactly one".
    const beforeModal = await page.$$eval('[data-watag-one]', e => e.length)
    await page.click('[data-ref] img')
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-watag-one]').length === n + 1,
      { timeout: 15000 }, beforeModal)
      .then(() => ok('the detail modal opens'))
      .catch(() => no('the detail modal opens', `still ${beforeModal} WATag buttons — no modal`))
    const modal = await page.evaluate(() => ({
      watag: document.querySelectorAll('[data-watag-one]').length,
      star: document.querySelectorAll('[data-favourite]').length,
      book: [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Book').length,
    }))
    modal.watag >= 1 && modal.star >= 1 && modal.book >= 1
      ? ok('the modal carries WATag, the star and Book', JSON.stringify(modal))
      : no('the modal carries WATag, the star and Book', JSON.stringify(modal))
    await page.keyboard.press('Escape')
    await new Promise(r => setTimeout(r, 500))

    // ── 7. the firewall, on the new surface ─────────────────────────────────
    // A phone number or an email on this tab would be a firewall break. The
    // word "owner" itself is allowed — the buttons say "Ask Owner" — so only
    // contact details are matched.
    const body = await page.evaluate(() => document.body.innerText)
    const leak = body.match(/[\w.+-]+@[\w.-]+\.\w+|\+?356\s?\d{4}\s?\d{4}/)
    leak
      ? no('no owner contact details on the Favourites tab', leak[0])
      : ok('no owner contact details on the Favourites tab')

    await page.screenshot({ path: path.join(SHOTS, 'board-watag-favourites.png') })

    // RefererNotAllowedMapError is expected off production: the Maps browser key
    // is HTTP-referrer restricted to crm.2906.estate, so a localhost run always
    // draws an empty map. It is not a defect and it is not this suite's subject.
    consoleErrors.filter(e =>
      !/403|Failed to load resource|RefererNotAllowedMapError|maps\/documentation/.test(e)).length === 0
      ? ok('no console errors')
      : no('no console errors', consoleErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    if (armed) disarm()
  }
}

run()
  .then(() => {
    console.log(`\nPASS ${pass.length}  FAIL ${fail.length}  SKIP ${skipped.length}\n`)
    pass.forEach(p => console.log('  ok   ' + p))
    skipped.forEach(s => console.log('  skip ' + s))
    fail.forEach(f => console.log('  FAIL ' + f))
    process.exit(fail.length ? 1 : 0)
  })
  .catch(e => {
    console.error('\nSUITE CRASHED:', e.message)
    pass.forEach(p => console.log('  ok   ' + p))
    fail.forEach(f => console.log('  FAIL ' + f))
    process.exit(1)
  })
