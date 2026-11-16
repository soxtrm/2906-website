// Owner Portal + Viewing Desk browser walkthrough (Claude, 2026-11-16).
// Needs: the local demo backend (ops/owner-portal/backend/test/devServer.js)
// and `next start` with OWNER_PORTAL_BACKEND pointing at it. Never production.
//   OWNER_PORTAL_WEB=http://localhost:3300 OWNER_PORTAL_API=http://127.0.0.1:3911 \
//   OWNER_PORTAL_SEED=/tmp/owner-portal-seed.json OWNER_PORTAL_SHOTS=docs/evidence/owner-portal-2026-11-16 node tests/owner-portal.e2e.cjs
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const WEB = process.env.OWNER_PORTAL_WEB || 'http://localhost:3300'
const API = process.env.OWNER_PORTAL_API || 'http://127.0.0.1:3911'
const seed = JSON.parse(fs.readFileSync(process.env.OWNER_PORTAL_SEED || '/tmp/owner-portal-seed.json', 'utf8'))
const SHOTS = process.env.OWNER_PORTAL_SHOTS || ''
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const shot = async (page, name, opts = {}) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 82, ...opts }) }
const freshInvite = async () => (await (await fetch(`${API}/api/crm/owner-portal/${seed.ownerId}/invitation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityMethod: 'Local test', purpose: 'recovery' }) })).json()).url
const noOverflow = page => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1)

;(async () => {
  const browser = await chromium.launch()
  const errors = []
  const watch = page => { page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`) }) }

  // ── Desktop owner ──
  const desk = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: 'light' })
  const page = await desk.newPage(); watch(page)
  await page.goto(seed.invite)
  await page.getByText('Are these your properties?').waitFor({ timeout: 15000 })
  check('invitation opens the portal', true)
  check('token removed from the address bar', !(await page.evaluate(() => location.hash)))
  check('session cookie is httpOnly (not visible to scripts)', !(await page.evaluate(() => document.cookie.includes('argus_owner_session'))))
  const cookie = (await desk.cookies()).find(c => c.name === 'argus_owner_session')
  check('session cookie flags', cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict', JSON.stringify(cookie && { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite }))
  await page.getByRole('button', { name: 'Yes, all mine' }).click()
  await page.getByText('Are these your properties?').waitFor({ state: 'detached' })
  await page.getByText('Needs your answer').waitFor()
  await page.waitForTimeout(500)
  await shot(page, '01-desk-desktop-light')
  check('desk shows the confirmed viewing', await page.getByText('Sample Agent D').isVisible())

  // Drag a request onto a free slot.
  const card = page.locator('article.op-request', { hasText: 'Sample Agent A' })
  const slot = page.locator('.op-week button.op-slot').nth(4)
  const slotLabel = await slot.getAttribute('aria-label')
  await card.dragTo(slot)
  const sheet = page.getByRole('dialog', { name: 'Propose this time?' })
  await sheet.waitFor()
  check('drag-and-drop opens the assignment check', true, slotLabel)
  for (const t of ['Property', 'Agent', 'Requested', 'Client', 'Duration', 'Conditions']) check(`assignment shows ${t}`, await sheet.getByText(t, { exact: true }).isVisible())
  check('assignment shows client requirements', await sheet.getByText(/one small dog/).isVisible())
  await page.waitForTimeout(350)
  await shot(page, '02-assign-sheet-desktop')
  await sheet.getByRole('button', { name: 'Propose slot' }).click()
  await page.getByRole('status').filter({ hasText: /Proposed .* now confirms with the client/ }).waitFor()
  await page.locator('article.op-request', { hasText: 'Sample Agent A' }).getByText('Slot proposed · agent checking').waitFor({ timeout: 8000 }).catch(() => {})
  check('proposal recorded, not confirmed', await page.locator('article.op-request', { hasText: 'Sample Agent A' }).getByText('Slot proposed · agent checking').isVisible())

  // Keyboard / tap alternative on desktop: select, then click a slot.
  const b = page.locator('article.op-request', { hasText: 'Sample Agent B' })
  await b.getByRole('button', { name: 'Assign a time' }).focus()
  await page.keyboard.press('Enter')
  check('keyboard selects a request', (await b.getAttribute('aria-pressed')) === 'true')
  await page.locator('.op-week button.op-slot').nth(10).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('dialog', { name: 'Propose this time?' }).waitFor()
  check('keyboard assigns a slot', true)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })

  // Availability
  await page.getByRole('navigation', { name: 'Sections' }).first().getByRole('button', { name: /Availability/ }).click()
  await page.getByText('When can agents view?').waitFor()
  await page.getByRole('button', { name: 'Sun', exact: true }).click()
  await page.getByRole('button', { name: '1 h', exact: true }).click()
  await page.waitForTimeout(300)
  await shot(page, '03-availability-desktop', { fullPage: true })
  await page.getByRole('button', { name: 'Save availability' }).click()
  await page.getByRole('status').filter({ hasText: /Availability saved: \d+ viewing windows/ }).waitFor()
  check('availability saves and publishes windows', true)

  // Properties
  await page.getByRole('navigation', { name: 'Sections' }).first().getByRole('button', { name: /Properties/ }).click()
  await page.getByRole('button', { name: /Open #OPT-/ }).first().waitFor()
  await shot(page, '04-properties-desktop')
  await page.getByRole('button', { name: /Open #OPT-/ }).first().click()
  await page.getByLabel('Pets').fill('Only small dogs')
  await page.getByRole('button', { name: 'Send changes for review' }).click()
  await page.getByRole('status').filter({ hasText: 'Sent for review' }).waitFor()
  check('owner change goes to review', await page.getByText(/Change waiting for review/).isVisible())
  await shot(page, '05-property-editor-desktop', { fullPage: true })

  // Sharing
  await page.getByRole('navigation', { name: 'Sections' }).first().getByRole('button', { name: /Sharing/ }).click()
  await page.getByRole('button', { name: 'New link' }).click()
  await page.getByRole('dialog', { name: 'New property link' }).getByRole('button', { name: 'Create link' }).click()
  const linkInput = page.getByRole('dialog', { name: 'Your property link' }).getByLabel('Link')
  await linkInput.waitFor()
  const shareUrl = await linkInput.inputValue()
  check('share link created and shown once', /\/property-link\/shr_/.test(shareUrl))
  await page.waitForTimeout(300)
  await shot(page, '06-share-link-desktop')
  await page.getByRole('button', { name: 'Done' }).click()

  // Activity
  await page.getByRole('navigation', { name: 'Sections' }).first().getByRole('button', { name: /Activity/ }).click()
  await page.getByText('Everything that changed').waitFor()
  await page.getByText('Availability updated').first().waitFor({ timeout: 8000 }).catch(() => {})
  check('activity lists the changes', await page.getByText('Slot proposed').first().isVisible() && await page.getByText('Availability updated').first().isVisible())
  await shot(page, '07-activity-desktop')

  // Dark mode desk
  const dark = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  await dark.addCookies([{ ...cookie }])
  const dp = await dark.newPage(); watch(dp)
  await dp.goto(`${WEB}/owner-portal`)
  await dp.getByText('Needs your answer').waitFor()
  await dp.waitForTimeout(500)
  await shot(dp, '08-desk-desktop-dark')
  await dark.close()

  // ── Agent on a phone ──
  const agentCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const ap = await agentCtx.newPage(); watch(ap)
  await ap.goto(shareUrl)
  await ap.getByText('Request a viewing').waitFor()
  check('agent page hides owner identity', !(await ap.content()).includes('Sample Owner') && !(await ap.content()).includes('Secret Street'))
  await shot(ap, '09-agent-link-mobile', { fullPage: true })
  check('agent page has no horizontal overflow at 390', await noOverflow(ap))
  await ap.locator('.op-slot-list button').first().click()
  await ap.getByLabel('Your name').fill('Mobile Agent')
  await ap.getByLabel('Agency').fill('Pocket Estates')
  await ap.getByLabel('People viewing').fill('2')
  await ap.getByLabel('Pets').fill('none')
  await ap.getByRole('button', { name: 'Send viewing request' }).click()
  const reqInput = ap.getByLabel('Your request link')
  await reqInput.waitFor()
  const reqUrl = await reqInput.inputValue()
  check('agent receives a private request link', /\/property-link\/request\/req_/.test(reqUrl))
  await ap.goto(reqUrl)
  await ap.getByText('Waiting for the owner to propose a time').waitFor()
  await shot(ap, '10-agent-request-waiting-mobile', { fullPage: true })

  // ── Owner on a phone: tap-to-assign ──
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const mp = await mob.newPage(); watch(mp)
  await mp.goto(await freshInvite())
  await mp.getByText('Needs your answer').waitFor()
  await mp.waitForTimeout(400)
  await shot(mp, '11-desk-mobile')
  check('owner desk has no horizontal overflow at 390', await noOverflow(mp))
  const mcard = mp.locator('article.op-request', { hasText: 'Mobile Agent' })
  await mcard.getByRole('button', { name: 'Assign a time' }).tap()
  await mp.getByText(/Placing/).waitFor()
  await mp.evaluate(() => window.scrollTo(0, 0))
  const daysWithFree = mp.locator('.op-day-strip button', { hasNotText: /^.*\n?0 free$/ })
  for (let i = 0; i < 7; i++) { if (await mp.locator('.op-slot-list button.op-slot').count()) break; await mp.locator('.op-day-strip button').nth(i + 1).tap() }
  void daysWithFree
  await shot(mp, '12-tap-assign-mobile')
  await mp.locator('.op-slot-list button.op-slot').first().tap()
  const msheet = mp.getByRole('dialog', { name: 'Propose this time?' })
  await msheet.waitFor()
  await mp.waitForTimeout(350)
  await shot(mp, '13-assign-sheet-mobile')
  const box = await msheet.boundingBox()
  check('mobile sheet fits the screen', box && box.y >= 0 && box.y + box.height <= 844 + 1, JSON.stringify(box))
  await msheet.getByRole('button', { name: 'Propose slot' }).tap()
  await mp.getByRole('status').filter({ hasText: /Proposed/ }).waitFor()
  check('tap-to-assign proposes on mobile', true)
  // Dock does not cover the last item: content bottom padding ≥ dock height.
  const dockOk = await mp.evaluate(() => { const d = document.querySelector('.op-dock').getBoundingClientRect(); const pad = parseFloat(getComputedStyle(document.querySelector('.op-main')).paddingBottom); return pad >= d.height + 10 })
  check('mobile dock leaves room for the content', dockOk)

  // Agent reconfirms → confirmed
  await ap.goto(reqUrl)
  await ap.getByText('Proposed by the owner').waitFor()
  check('agent sees the founder\'s proposal message', await ap.getByText(/Please confirm availability with your client and reconfirm in ARGUS/).first().isVisible())
  await ap.getByRole('button', { name: "I'm checking with my client" }).tap()
  await ap.getByText('Agent checking with client').first().waitFor()
  await ap.getByRole('button', { name: 'Client confirmed this time' }).tap()
  await ap.getByText('Confirmed viewing').waitFor()
  await shot(ap, '14-agent-confirmed-mobile', { fullPage: true })
  check('two-stage confirmation completes', true)

  // 360 px owner screens
  const small = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const sp = await small.newPage(); watch(sp)
  await sp.goto(await freshInvite())
  await sp.getByText('Needs your answer').waitFor()
  for (const [tab, name] of [['Availability', '15-availability-360'], ['Properties', '16-properties-360'], ['Sharing', '17-sharing-360']]) {
    await sp.locator('.op-dock').getByRole('button', { name: new RegExp(tab) }).tap()
    await sp.waitForTimeout(450)
    check(`${tab} has no horizontal overflow at 360`, await noOverflow(sp))
    await shot(sp, name)
  }
  // Sign out ends the session.
  await sp.getByRole('button', { name: 'Sign out' }).tap()
  await sp.getByRole('heading', { name: 'Open your owner link' }).waitFor()
  const after = await sp.evaluate(() => fetch('/api/owner-portal/me').then(r => r.status))
  check('sign-out revokes the session', after === 401)

  check('no JavaScript or console errors', errors.length === 0, errors.slice(0, 5).join(' | '))
  await browser.close()
  const failed = results.filter(r => !r.ok)
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
