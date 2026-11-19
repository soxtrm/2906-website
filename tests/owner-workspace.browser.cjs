// Owner Workspace preview: browser walk-through + screenshots.
//   OWNER_BASE=http://localhost:3141 node tests/owner-workspace.browser.cjs
// Runs on the demo data only; no backend call is made.
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const BASE = process.env.OWNER_BASE || 'http://localhost:3141'
const OUT = path.join(__dirname, '..', 'docs', 'owner-workspace', 'screens'); fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }
const wait = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const errors = []
  const open = async (vp) => {
    const pg = await browser.newPage(); await pg.setViewport(vp)
    pg.on('pageerror', e => errors.push(e.message))
    pg.on('response', r => { if (r.url().includes('/api/')) errors.push(`unexpected API call ${r.url()}`) })
    return pg
  }
  const go = async (pg, p) => { await pg.goto(BASE + p, { waitUntil: 'networkidle2', timeout: 180000 }); await wait(500) }
  const clickText = (pg, sel, txt) => pg.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find(e => e.textContent.trim().startsWith(t)); if (el) el.click(); return !!el }, sel, txt)

  // desktop
  let pg = await open({ width: 1440, height: 1000 })
  await go(pg, '/owner')
  await pg.evaluate(() => localStorage.clear()); await go(pg, '/owner')
  const h1 = await pg.$eval('.ow-banner h1', e => e.textContent)
  check('overview says what needs the owner', /3 people want to view your homes/.test(h1), h1)
  check('dashboard: chat names the real sender', await pg.$$eval('.ow-wa-who b', els => els.some(e => /Daniel · Harbour Homes/.test(e.textContent))))
  check('dashboard: requests to review on the side', await pg.$$eval('.ow-dash-side .ow-rrow', els => els.length) === 3)
  check('dashboard: a wish said on three homes counts for all', await pg.$$eval('.ow-wish-list.minus li', els => els.some(e => /Non-smokers only/.test(e.textContent))))
  // owner writes a wish with a nationality in it: the wish is kept, the nationality is not
  await pg.select('.ow-about select', '9001')
  await pg.type('.ow-wa-compose input', "I'm looking for a European couple, no pets"); await pg.keyboard.press('Enter'); await wait(400)
  const reply = await pg.$$eval('.ow-wa-row[data-kind="system"] .ow-wa-text', els => els[els.length - 1].textContent)
  check('chat: wishes noted, nationality refused', /Couple/.test(reply) && /No pets/.test(reply) && /cannot keep/.test(reply), reply)
  await clickText(pg, '.ow-wishes .ow-pills button', 'Tower Road'); await wait(200)
  const tw = await pg.$eval('.ow-wishes', e => e.textContent)
  check('wish list for that home has the new wishes and no nationality', /Couple/.test(tw) && /No pets/.test(tw) && !/European/i.test(tw))
  check('nav badge shows waiting requests', (await pg.$eval('.ow-nav .ow-count', e => e.textContent)) === '3')
  await pg.screenshot({ path: path.join(OUT, '01-overview-desktop.png'), fullPage: true })

  await go(pg, '/owner/requests')
  const cards = await pg.$$eval('.ow-req', els => els.length)
  check('requests: three waiting', cards === 3, String(cards))
  check('competing requests linked, not merged', await pg.$$eval('.ow-req-also a', els => els.length) >= 2)
  await go(pg, '/owner/requests?compare=rq1')
  const cmp = await pg.$$eval('.ow-compare .ow-req', els => els.length)
  check('compare view shows both requests for the same slot', cmp === 2, String(cmp))
  await pg.screenshot({ path: path.join(OUT, '02-compare-requests.png'), fullPage: true })
  await clickText(pg, '.ow-compare .ow-req:first-child button', 'Accept'); await wait(400)
  await clickText(pg, '.ow-compare .ow-req:last-child button', 'Accept'); await wait(400)
  const toast = await pg.$$eval('.ow-toast', els => els.map(e => e.textContent).join(' | '))
  check('second accept for the same time is refused (no double booking)', /already have a confirmed viewing/.test(toast), toast)

  await go(pg, '/owner/calendar')
  await pg.waitForSelector('.ow-day')
  const shutters = await pg.$$eval('.ow-band', els => els.length)
  check('calendar shows every home\'s viewing hours in its own colour', shutters >= 5, String(shutters))
  await clickText(pg, '.ow-cal .ow-pills button', 'Tower Road'); await wait(300)
  // drag on Thursday column 10:00 → 12:00
  const col = (await pg.$$('.ow-day'))[3]; const box = await col.boundingBox()
  await pg.mouse.move(box.x + box.width / 2, box.y + 2 * 50 + 2); await pg.mouse.down()
  await pg.mouse.move(box.x + box.width / 2, box.y + 4 * 50, { steps: 6 }); await pg.mouse.up(); await wait(300)
  const dialog = await pg.$eval('[role=dialog] h3', e => e.textContent).catch(() => '')
  check('dragging on a day opens "save viewing hours"', /Thursday, 10:00 to 12:00/.test(dialog), dialog)
  await pg.screenshot({ path: path.join(OUT, '03-calendar-drag.png') })
  await clickText(pg, '[role=dialog] button', 'Every Thursday'); await wait(400)
  const rows = await pg.$$eval('.ow-table tbody tr', els => els.map(e => e.textContent))
  check('weekly rule saved', rows.some(r => /Every Thursday10:00–12:00/.test(r)), rows.join(' / '))
  await clickText(pg, '.ow-seg button', 'Month'); await wait(300)
  await pg.screenshot({ path: path.join(OUT, '04-calendar-month.png') })
  await clickText(pg, '.ow-seg button', 'Week'); await wait(300)
  await pg.select('.ow-range select[aria-label="From"]', '16'); await pg.select('.ow-range select[aria-label="To"]', '20'); await wait(300)
  const hours = await pg.$$eval('.ow-hour:not(.minor)', els => els.map(e => e.textContent))
  check('calendar can be trimmed to 16–20', hours[0] === '16:00' && hours[hours.length - 1] === '20:00', hours.join(','))
  await pg.select('.ow-range select[aria-label="From"]', '8'); await pg.select('.ow-range select[aria-label="To"]', '21')
  await clickText(pg, '.ow-cal .ow-pills button', 'All homes'); await wait(200)
  await pg.click('button[aria-label="Next"]'); await wait(300)
  await pg.evaluate(() => [...document.querySelectorAll('button.ow-week-head')][1].click()); await wait(400)
  const agenda = await pg.$$eval('.ow-agenda b', els => els.map(e => e.textContent))
  check('tapping a day opens the day with who is coming', agenda.some(t => /Daniel · Harbour Homes/.test(t)), agenda.join(' | '))
  await pg.screenshot({ path: path.join(OUT, '12-day-agenda.png') })

  await go(pg, '/owner/properties/9001')
  await clickText(pg, '.ow-tabs button', 'Rooms'); await wait(300)
  check('room plan renders one zone per room', await pg.$$eval('.ow-plan .zone', els => els.length) === 4)
  await pg.screenshot({ path: path.join(OUT, '05-rooms-plan.png') })
  await clickText(pg, '.ow-tabs button', 'Offer'); await wait(300)
  await clickText(pg, '.ow-tabs[aria-label="Operating mode"] button', 'Long let'); await wait(300)
  const warn = await pg.$eval('.ow-warn', e => e.textContent).catch(() => '')
  check('switching a shared flat with a tenant to long let is blocked', /occupied/.test(warn), warn)
  await pg.screenshot({ path: path.join(OUT, '06-mode-switch-blocked.png') })

  await go(pg, '/owner/sharing?p=9003')
  const ex = await pg.$eval('#p-9003', e => e.textContent)
  check('exclusive deal visible with end date and release', /Harbour Homes until/.test(ex) && /all approved agencies/.test(ex))
  await pg.screenshot({ path: path.join(OUT, '07-sharing.png'), fullPage: true })
  // turn off NEXUS Direct on the Sliema flat → its channel goes to "being removed"
  await pg.evaluate(() => document.querySelector('#p-9001 [aria-label="NEXUS Direct"]').click()); await wait(300)
  const ch = await pg.$eval('#p-9001 .ow-channels', e => e.textContent)
  check('revoking a channel starts delisting and shows it', /NEXUS DirectBeing removed/.test(ch), ch)

  await go(pg, '/owner/messages')
  await pg.screenshot({ path: path.join(OUT, '08-messages.png') })

  // documents: send one into the chat and share it with an agency
  await go(pg, '/owner/documents')
  await clickText(pg, '.ow-docs li:first-child button', 'Send in chat'); await wait(200)
  await clickText(pg, '.ow-docs li:first-child button', 'Share'); await wait(200)
  await pg.evaluate(() => document.querySelector('.ow-doc-share input').click()); await wait(200)
  check('documents: shared with an agency', /Shared with/.test(await pg.$eval('.ow-docs li:first-child', e => e.textContent)))
  await go(pg, '/owner/messages')
  check('chat: the document arrived as a WhatsApp-style attachment', await pg.$$eval('.ow-wa-doc', els => els.length) >= 1)

  // profile: link a person and make them the one ARGUS writes to
  await go(pg, '/owner/profile')
  await clickText(pg, 'button', 'Add person'); await wait(200)
  await pg.type('#an', 'Anna'); await clickText(pg, '.ow-addperson button', 'Link to my account'); await wait(300)
  await pg.evaluate(() => { const li = [...document.querySelectorAll('.ow-people li')].find(l => /Anna/.test(l.textContent)); li.querySelector('.ow-main-pick').click() }); await wait(300)
  check('profile: linked person becomes the one main contact', await pg.$$eval('.ow-people li[data-main="true"]', els => els.length === 1 && /Anna/.test(els[0].textContent)))
  await pg.screenshot({ path: path.join(OUT, '13-profile.png'), fullPage: true })

  // sign up: email + password, mobile, WhatsApp code; a known number brings the homes in
  await go(pg, '/owner/signup')
  await pg.type('#se', 'maria.demo@example.com'); await pg.type('#sp', 'Sliema2024flat')
  await clickText(pg, 'button', 'Continue'); await wait(400)
  // SMS fallback first: a wrong code links nothing
  await clickText(pg, '.ow-seg button', 'SMS code'); await wait(200)
  await pg.type('#sph', '+356 0000 0000'); await clickText(pg, 'button', 'Send code'); await wait(300)
  await pg.type('.ow-code', '000000'); await clickText(pg, 'button', 'Confirm'); await wait(300)
  check('sign up: a wrong code links nothing', !!(await pg.$('.ow-code')))
  // WhatsApp: tap, the prepared message arrives from the owner's phone, homes are linked
  await clickText(pg, 'button', 'Use another number'); await wait(200)
  await clickText(pg, '.ow-seg button', 'WhatsApp'); await wait(200)
  await clickText(pg, 'button', 'Verify with WhatsApp'); await wait(200)
  const waiting = await pg.$eval('.ow-wa-wait', e => e.textContent).catch(() => '')
  check('sign up: WhatsApp verification waits for the prepared message', /SYNC verify [A-Z2-9]{6}/.test(waiting), waiting)
  await clickText(pg, '.ow-wa-sim button', 'Message arrived'); await wait(400)
  const done = await pg.$eval('.ow-auth-done h1', e => e.textContent).catch(() => '')
  check('sign up: the WhatsApp sender number finds the 3 homes of the owner', /found 3 homes/.test(done), done)
  await clickText(pg, '.ow-channel-pick button', 'SMS'); await wait(200)
  check('sign up: owners without WhatsApp choose another channel', await pg.$eval('.ow-channel-pick [data-ch="sms"]', e => e.getAttribute('aria-checked')) === 'true')

  // agencies: the big Malta agencies first, tick one
  await go(pg, '/owner/sharing')
  const firstAg = await pg.$eval('.ow-ag-grid .ow-ag b', e => e.textContent)
  check('agencies: the biggest come first', /Frank Salt|RE\/MAX|Dhalia|QuickLets/.test(firstAg), firstAg)
  await pg.click('.ow-ag-grid .ow-ag'); await wait(300)
  check('agencies: ticking adds it', await pg.$eval('.ow-ag-grid .ow-ag', e => e.getAttribute('aria-pressed')) === 'true')
  await pg.screenshot({ path: path.join(OUT, '15-agencies.png'), fullPage: true })

  // calendar: tap a band to change its hours
  await go(pg, '/owner/calendar')
  await clickText(pg, '.ow-cal .ow-pills button', 'Tower Road'); await wait(300)
  await pg.evaluate(() => document.querySelector('.ow-band[role="button"]').click()); await wait(300)
  check('calendar: tapping viewing hours opens an editor', !!(await pg.$('.ow-sheet .ow-sheet-times')))
  await pg.screenshot({ path: path.join(OUT, '14-calendar-edit.png') })
  await clickText(pg, '.ow-sheet button', 'Cancel')

  // add a property: several offers, drag-and-drop photo, goes to "being checked"
  await go(pg, '/owner/add')
  await clickText(pg, '.ow-choice button', 'Penthouse'); await wait(100)
  await clickText(pg, '.ow-offer button', 'Long let'); await wait(100); await clickText(pg, '.ow-offer button', 'Winter let'); await wait(200)
  const kinds = await pg.$$eval('.ow-offer button b', els => els.map(e => e.textContent))
  check('add: every offer type is there', ['Long let', 'Short let', 'Winter let', 'Summer let', 'Room rentals', 'For sale'].every(k => kinds.includes(k)), kinds.join(', '))
  const prices = await pg.$$('.ow-offer-price input'); await prices[0].type('2200'); await prices[1].type('1400')
  await pg.type('#town', 'Swieqi')
  await pg.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#3d5afe'; x.fillRect(0, 0, 400, 300)
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'flat.png', { type: 'image/png' }))
    document.querySelector('.ow-dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await pg.waitForSelector('.ow-thumbs li', { timeout: 5000 }).catch(() => null)
  check('add: a dropped photo becomes the cover', await pg.$$eval('.ow-thumbs li[data-cover="true"]', els => els.length) === 1)
  await pg.screenshot({ path: path.join(OUT, '11-add-property.png'), fullPage: true })
  await clickText(pg, '.ow-add-submit button', 'Send to ARGUS'); await wait(1500)
  const after = await pg.evaluate(() => location.pathname + ' ' + document.body.textContent)
  check('add: new property opens, marked as being checked', /\/owner\/properties\/9004/.test(after) && /Penthouse in Swieqi/.test(after), after.slice(0, 60))

  // mobile
  pg = await open({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await go(pg, '/owner'); await pg.evaluate(() => localStorage.clear()); await go(pg, '/owner')
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check('mobile: no sideways scroll', overflow <= 1, String(overflow))
  check('mobile: bottom tab bar with the add button', await pg.$eval('.ow-tabbar', e => getComputedStyle(e).display) === 'grid' && !!(await pg.$('.ow-tab-add')))
  const btn = await pg.$eval('.ow-rrow .ow-btn.primary', e => e.getBoundingClientRect().height)
  check('mobile: buttons are thumb-sized', btn >= 36, String(btn))
  await pg.screenshot({ path: path.join(OUT, '09-overview-mobile.png') })
  await go(pg, '/owner/requests')
  await pg.screenshot({ path: path.join(OUT, '10-requests-mobile.png'), fullPage: true })

  check('no page errors and no backend calls', errors.length === 0, errors.slice(0, 3).join(' | '))
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await browser.close(); process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
