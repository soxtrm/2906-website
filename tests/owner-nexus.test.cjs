// Owner profile → NEXUS tab (Claude, 2026-11-11). Real page in Chromium against
// a running `next dev`; every /api/crm/* call is answered by an in-memory mock,
// so no backend, no owner and no NEXUS is touched.
//
//   CRM_MOCK_BASE=http://localhost:3117 node --test tests/owner-nexus.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { launch, openPage, serverAvailable, defaultFixtures } = require('./helpers/crm-mock.cjs')

const OWNER_ID = 7
const URL_ = 'https://nexuslink.fit/owner/activate#t=a1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const shots = path.join(__dirname, 'screenshots', 'owner-nexus')

function prop(ref, over = {}) {
  return {
    id: Number(ref.slice(-4)), ref, town: 'Sliema', transactionType: 'rent',
    statuses: { imported: true, linked: false, canonicalPropertyId: null, ownerReview: 'pending', claim: null, availability: 'available_confirmed',
      freshness: { state: 'reconfirmation_approaching', label: 'Reconfirmation approaching', lastConfirmedAt: new Date(Date.now() - 40 * 36e5).toISOString(), ageHours: 40, dueAt: null },
      distribution: 'not_authorized', publication: 'unpublished', sync: 'never' },
    eligible: false, blockedReasons: ['OWNER_LINK_NOT_VERIFIED', 'OWNER_CLAIM_NOT_CONFIRMED', 'NO_DISTRIBUTION_AUTHORIZATION'], distribution: [], lastSyncAt: null, lastSyncError: null, pendingEvents: 0, ...over,
  }
}
function fixtures() {
  const state = {
    contractVersion: '2026-11-11.v1', owner: { id: OWNER_ID, doNotContact: false },
    link: { id: null, state: 'not_invited', nexusAccountRef: null, sync: { state: 'never' } }, invitation: null,
    receiver: { configured: false, note: 'NEXUS receiver not connected yet — approved changes are queued, not delivered.' }, queue: { waiting: 0, errors: 0 },
    properties: [prop('2906-9101'), prop('2906-9102', { statuses: { ...prop('x-0001').statuses, freshness: { state: 'unknown_stale', label: 'Unknown / stale', lastConfirmedAt: null, ageHours: null, dueAt: null }, availability: 'available' } })],
    nexusProfileUrl: null,
  }
  const f = defaultFixtures()
  f.state = state
  f.routes = [
    [/^owners\/7$/, 'GET', () => ({
      owner: { id: OWNER_ID, name: 'Maria Borg', phoneMasked: '+356 •••• 4821', emailMasked: null, hasPhone: true, hasEmail: false, since: '2026-01-10T00:00:00Z', status: 'active', replyCount: 3, outreachCount: 5, doNotContact: false, phoneVariants: [], warmth: 'warm' },
      properties: [], incompleteCount: 0, accountLabels: [], preferences: { general: [], byProperty: [] }, documents: [], automation: { states: [], nextAutomationAt: null, campaigns: [] }, history: [],
    })],
    [/^owner-nexus\/7$/, 'GET', () => state],
    [/^owner-nexus\/7\/invitation$/, 'POST', () => {
      state.link = { ...state.link, id: '11111111-2222-3333-4444-555555555555', state: 'invited' }
      state.invitation = { id: 1, state: 'active', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 864e5).toISOString(), copyCount: 0, lastCopiedAt: null }
      return { link: state.link, invitation: { ...state.invitation, url: URL_ }, created: true }
    }],
    [/^owner-nexus\/7\/invitation\/copy$/, 'POST', () => { state.invitation.copyCount++; state.invitation.lastCopiedAt = new Date().toISOString(); return { invitation: { ...state.invitation, url: URL_ } } }],
    [/^owner-nexus\/7\/sync-properties$/, 'POST', () => ({ properties: state.properties.map(p => ({ ref: p.ref, queued: false, blockedReasons: p.blockedReasons })), delivery: null })],
  ]
  return f
}

for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }, { name: 'small', width: 360, height: 740 }]) {
  test(`owner NEXUS tab — ${vp.name} ${vp.width}px`, async t => {
    if (!(await serverAvailable())) return t.skip('dev server not running')
    const browser = await launch()
    t.after(() => browser.close())
    const fx = fixtures()
    const page = await openPage(browser, { path: `/crm/owner/${OWNER_ID}`, theme: 'dark', width: vp.width, height: vp.height, fixtures: fx })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'NEXUS'), { timeout: 30000 })
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'NEXUS').click())
    await page.waitForSelector('[data-testid="nexus-actions"]', { timeout: 15000 })
    const text = () => page.$eval('[data-testid="nexus-panel"]', el => el.innerText)

    // Honest initial state.
    assert.match(await text(), /Not invited/)
    assert.match(await page.$eval('[data-testid="nexus-receiver-note"]', el => el.innerText), /NEXUS sync is pending/)
    assert.match(await text(), /Owner has not authorised any distribution/)
    assert.match(await page.$eval('[data-testid="nexus-freshness-2906-9101"]', el => el.innerText), /Reconfirmation approaching · 40 h ago/)
    assert.match(await page.$eval('[data-testid="nexus-freshness-2906-9102"]', el => el.innerText), /Unknown \/ stale · never/)
    assert.doesNotMatch(await text(), /Sync: synced/)

    // One menu; actions that make no sense yet are disabled and say why.
    await page.click('[data-testid="nexus-actions"]')
    await page.waitForSelector('[data-testid="nexus-menu"]')
    const disabled = await page.$$eval('[data-testid="nexus-menu"] [role="menuitem"]', els => Object.fromEntries(els.map(e => [e.dataset.testid.replace('nexus-item-', ''), e.disabled])))
    assert.deepEqual(disabled, { invite: false, copy: true, rotate: true, revoke: true, verify: true, dispute: true, 'sync-owner': true, 'sync-props': false, retry: true, distribution: false, open: true })
    const menuBox = await page.$eval('[data-testid="nexus-menu"]', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, vw: innerWidth } })
    assert.ok(menuBox.left >= 0 && menuBox.right <= menuBox.vw + 1, 'menu stays inside the viewport')
    await page.screenshot({ path: (fs.mkdirSync(shots, { recursive: true }), path.join(shots, `${vp.name}-menu.png`)) })

    // Invite → link shown for copying; nothing but the invitation request is sent.
    await page.click('[data-testid="nexus-item-invite"]')
    await page.waitForSelector('[data-testid="nexus-invite-link"]')
    assert.equal(await page.$eval('[data-testid="nexus-invite-link"] input', el => el.value), URL_)
    await page.waitForFunction(() => /Invited — waiting for owner/.test(document.querySelector('[data-testid="nexus-link-state"]').innerText))
    const posts = page.crmCalls.filter(c => c.method === 'POST')
    assert.deepEqual(posts.map(c => c.path), ['owner-nexus/7/invitation'])
    assert.equal(posts[0].body, '{}')
    assert.ok(!page.crmCalls.some(c => /waha|outreach|swipe|message|send/i.test(c.path)), 'no messaging endpoint is called')

    // Sync while nothing is authorised: reported as not eligible, never as synced.
    await page.click('[data-testid="nexus-actions"]')
    await page.click('[data-testid="nexus-item-sync-props"]')
    await page.waitForFunction(() => /0 queued, 2 not eligible/.test(document.querySelector('[data-testid="nexus-toast"]')?.innerText || ''))

    // Verification asks how ownership was checked (dialog, not a browser prompt) — disabled until claimed.
    await page.click('[data-testid="nexus-actions"]')
    assert.equal(await page.$eval('[data-testid="nexus-item-verify"]', el => el.disabled), true)
    assert.equal(await page.$eval('[data-testid="nexus-item-copy"]', el => el.disabled), false)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid="nexus-menu"]'))

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `no horizontal page overflow (got ${overflow}px)`)
    await page.screenshot({ path: path.join(shots, `${vp.name}.png`), fullPage: true })
    assert.deepEqual(page.consoleErrors.filter(e => !/favicon|Failed to load resource|hydrat/i.test(e)), [])
  })
}
