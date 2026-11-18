// One-click Facebook publishing — browser tests with a mocked backend.
// Nothing reaches Facebook or a real backend: /api/crm/* is answered in-page.
//   CRM_MOCK_BASE=http://localhost:3077 node --test tests/facebook-quick-publish.test.cjs
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('fs')
const path = require('path')
const { launch, openPage, defaultFixtures } = require('./helpers/crm-mock.cjs')

const OUT = process.env.FB_EVIDENCE_DIR || path.join(__dirname, '..', 'ops', 'facebook-quick-publish', 'evidence')
fs.mkdirSync(OUT, { recursive: true })
const svg = (c, l) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${c}"/><text x="320" y="260" font-size="120" text-anchor="middle" fill="#fff">${l}</text></svg>`)}`
const IMGS = [svg('#4979a8', '1'), svg('#b27b54', '2'), svg('#668f70', '3')]
const MSG = '🏡 2-BEDROOM APARTMENT FOR RENT — SLIEMA\n\n💶 €1,850 / month\n\n🔗 https://www.2906.estate/swipe/abc123'
const pageRow = (id, name, over = {}) => ({ id, pageId: String(100 + id), name, pictureUrl: null, category: 'Real Estate', canPublish: true, status: 'active', statusReason: null, enabled: true, isDefault: false, autoPublish: false, lastSyncedAt: new Date().toISOString(), ...over })

function fbFixtures({ connected = true, configured = true, pages } = {}) {
  const st = {
    configured, setupMissing: configured ? [] : ['META_APP_ID'], appId: '1234567890', graphVersion: 'v27.0', autoPublishAvailable: false,
    connection: connected ? { state: 'active', facebookName: 'Agent Test', missingPermissions: [] } : { state: 'not_connected' },
    pages: connected ? (pages || [pageRow(11, 'Harbour Homes Malta', { isDefault: true }), pageRow(12, 'Analytics Only', { canPublish: false, status: 'missing_permission' })]) : [],
    preferences: { language: 'en', defaultTemplateId: 'classic', useEmojis: true, includeContact: false, includeLink: true, callToAction: '', autoPublishEnabled: false, autoDailyLimit: 3 },
    templates: [{ id: 'classic', name: 'Classic', builtIn: true }],
    agent: { displayName: 'Agent', publicPhone: null, colorHex: '#c2410c' },
  }
  const state = { st, pubs: [], polls: 0, duplicateOnce: false, blockers: [], failWith: null }
  const routes = [
    [/^facebook-pages\/status$/, 'GET', () => st],
    [/^facebook-pages\/pages\/\d+$/, 'PATCH', () => st],
    [/^facebook-pages\/properties\/\d+\/draft$/, 'GET', () => ({
      property: { id: 1, ref: '2906-9101', type: 'apartment', town: 'Sliema', bedrooms: 2, bathrooms: 2, rent: 1850, sale: null, availableStatus: 'available', availableDate: null },
      images: IMGS.map(u => ({ url: u, thumbnail: u })), imagesAllowed: true, imagesReason: null, maxImages: 10,
      link: 'https://www.2906.estate/swipe/abc123', linkKind: 'share', message: state.blockers.length ? '' : MSG,
      language: 'en', templateId: 'classic', emojis: true, includeContact: false, includeLink: true, blockers: state.blockers, publications: [],
    })],
    [/^facebook-pages\/publications$/, 'POST', b => {
      const body = JSON.parse(b)
      if (state.duplicateOnce && !body.confirmDuplicate) return { __status: 409, body: { error: 'This property is already published on Harbour Homes Malta. Publish again anyway?', kind: 'duplicate', existing: [] } }
      const p = { id: 500 + state.pubs.length, propertyId: body.propertyId, propertyRef: '2906-9101', pageRowId: body.pageRowId, pageName: 'Harbour Homes Malta', publicationType: 'multi_photo', state: 'queued', stateLabel: 'Queued', trigger: 'manual', message: body.message, images: body.images, link: null, language: 'en', template: 'classic', postId: null, permalinkUrl: null, publishedAt: null, error: null, attemptCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canEdit: false, canDelete: false, canRetry: false }
      state.pubs.unshift(p)
      return { publication: p, replayed: false }
    }],
    [/^facebook-pages\/publications\/\d+$/, 'GET', () => {
      const p = state.pubs[0]
      if (state.failWith) Object.assign(p, { state: 'failed', stateLabel: 'Failed', error: { kind: 'meta', message: state.failWith } })
      else if (++state.polls >= 2) Object.assign(p, { state: 'published', stateLabel: 'Published', postId: '111_9002', permalinkUrl: 'https://www.facebook.com/111/posts/9002', publishedAt: new Date().toISOString() })
      else Object.assign(p, { state: 'publishing', stateLabel: 'Publishing' })
      return { publication: p }
    }],
    [/^facebook-pages\/publications$/, 'GET', () => ({ publications: state.pubs })],
    [/^intake\/summary$/, 'GET', () => ({ counts: { needs_verification: 0, needs_correction: 0, verified_today: 0 }, items: [] })],
  ]
  return { routes, state }
}
function board(fb, me = { id: 7, username: 'agent7', name: 'Agent Seven', role: 'agent' }) {
  const f = defaultFixtures()
  f.me = { agent: { ...me, daily_reveal_limit: 50 }, reveals: { used: 0, limit: 50 } }
  f.routes = fb.routes
  return f
}
const posts = page => page.crmCalls.filter(c => c.method === 'POST' && c.path === 'facebook-pages/publications').map(c => JSON.parse(c.body))
const notice = (page, kind) => page.waitForSelector(`[data-fb-quick-notice="${kind}"]`, { timeout: 20000 })
const noticeText = page => page.$eval('[data-fb-quick-notice]', el => el.textContent)
const clickIn = (page, text) => page.evaluate(t => { const el = [...document.querySelectorAll('[data-fb-quick-notice] button, [data-fb-quick-notice] a')].find(e => e.textContent.trim() === t); if (!el) throw new Error('no ' + t); el.click() }, text)
const FIRST = '[data-fb-quick-publish="2906-9101"]'
const settle = () => new Promise(r => setTimeout(r, 300))

test('Board: one click posts the listing on the agent\'s default Page; no dialog, no old queue call', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures()
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    const count = await page.$$eval('[data-fb-quick-publish]', b => b.length)
    assert.ok(count >= 12, `every card has the button for a normal agent (found ${count})`)
    assert.equal(page.crmCalls.filter(c => /^facebook-pages\//.test(c.path)).length, 0, 'nothing Facebook-related is loaded before the click')
    await page.screenshot({ path: path.join(OUT, 'board-1-cards.png') })
    await page.click(FIRST)
    await notice(page, 'ok')
    const sent = posts(page)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].propertyId, 1)
    assert.equal(sent[0].pageRowId, 11, 'the default Page')
    assert.deepEqual(sent[0].images, IMGS, 'the listing photos in ranked order')
    assert.equal(sent[0].message, MSG)
    assert.match(sent[0].idempotencyKey, /^[0-9a-f]{32}$/)
    assert.equal(sent[0].confirmDuplicate, false)
    assert.match(await noticeText(page), /#2906-9101 is live on Harbour Homes Malta\./)
    assert.equal(await page.$eval('[data-fb-quick-notice] a', a => a.href), 'https://www.facebook.com/111/posts/9002', 'the link Meta returned')
    assert.equal(await page.$('.fbp-dialog'), null, 'no dialog')
    assert.equal(page.crmCalls.filter(c => /facebook-queue/.test(c.path)).length, 0, 'the old posting queue is not touched')
    await settle(); await page.screenshot({ path: path.join(OUT, 'board-2-live.png') })
    assert.deepEqual(page.consoleErrors.filter(e => !/favicon|Failed to load resource/.test(e)), [])
  } finally { await browser.close() }
})

test('Board on a phone: same one click, the notice fits the screen', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures()
    const page = await openPage(browser, { width: 390, height: 844, fixtures: board(fb, { id: 13, username: 'board13', name: 'Board Agent', role: 'board' }) })
    await page.waitForSelector(FIRST)
    await page.$eval(FIRST, el => el.scrollIntoView({ block: 'center' }))
    await page.$eval(FIRST, el => el.click())
    await notice(page, 'ok')
    assert.equal(posts(page).length, 1, 'a Board account can post too')
    const box = await page.$eval('[data-fb-quick-notice]', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right } })
    assert.ok(box.left >= 0 && box.right <= 390, `notice inside the viewport (${box.left}..${box.right})`)
    await settle(); await page.screenshot({ path: path.join(OUT, 'mobile-1-live.png') })
  } finally { await browser.close() }
})

test('not connected yet: nothing is posted, the agent is sent to connect a Page', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures({ connected: false })
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    await page.click(FIRST)
    await notice(page, 'connect')
    assert.match(await noticeText(page), /Connect your Facebook Page once/)
    assert.match(await page.$eval('[data-fb-quick-notice] a', a => a.getAttribute('href')), /\/integrations\/facebook$/)
    assert.equal(posts(page).length, 0)
    assert.equal(page.crmCalls.filter(c => /draft$/.test(c.path)).length, 0)
    await settle(); await page.screenshot({ path: path.join(OUT, 'board-3-connect.png') })
  } finally { await browser.close() }
})

test('several Pages switched on as destinations: one click posts on each of them, default first', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures({ pages: [pageRow(11, 'Harbour Homes Malta'), pageRow(12, 'Gozo Lettings', { isDefault: true }), pageRow(13, 'Old Page', { enabled: false })] })
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    await page.click(FIRST)
    await notice(page, 'ok')
    const sent = posts(page)
    assert.deepEqual(sent.map(b => b.pageRowId), [12, 11], 'every switched-on Page, the default first, never the switched-off one')
    assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey, 'one request per Page')
    assert.match(await noticeText(page), /live on Gozo Lettings and Harbour Homes Malta/)
  } finally { await browser.close() }
})

test('several Pages, none switched on and no default: asked once, the choice is remembered, then it posts', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures({ pages: [pageRow(11, 'Harbour Homes Malta', { enabled: false }), pageRow(12, 'Gozo Lettings', { enabled: false })] })
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    await page.click(FIRST)
    await notice(page, 'choose')
    assert.equal(posts(page).length, 0, 'nothing is posted before a Page is chosen')
    await settle(); await page.screenshot({ path: path.join(OUT, 'board-4-choose.png') })
    await clickIn(page, 'Gozo Lettings')
    await notice(page, 'ok')
    const patch = page.crmCalls.find(c => c.method === 'PATCH' && c.path === 'facebook-pages/pages/12')
    assert.deepEqual(JSON.parse(patch.body), { isDefault: true })
    assert.equal(posts(page)[0].pageRowId, 12)
  } finally { await browser.close() }
})

test('already on that Page: asks before posting again', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures(); fb.state.duplicateOnce = true
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    await page.click(FIRST)
    await notice(page, 'duplicate')
    assert.match(await noticeText(page), /already on Harbour Homes Malta/)
    assert.equal(fb.state.pubs.length, 0)
    await settle(); await page.screenshot({ path: path.join(OUT, 'board-5-duplicate.png') })
    await clickIn(page, 'Post again')
    await notice(page, 'ok')
    const sent = posts(page)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].confirmDuplicate, true)
    assert.equal(fb.state.pubs.length, 1)
  } finally { await browser.close() }
})

test('a listing that may not be published says why and posts nothing', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures(); fb.state.blockers = [{ code: 'no_fb', message: 'This listing is marked "no Facebook". The owner does not want it advertised there.' }]
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    await page.click(FIRST)
    await notice(page, 'err')
    assert.match(await noticeText(page), /marked "no Facebook"/)
    assert.equal(posts(page).length, 0)
  } finally { await browser.close() }
})

test('Facebook refuses the post: the reason is shown, not a success', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures(); fb.state.failWith = 'Facebook rejected the photos.'
    const page = await openPage(browser, { width: 1440, height: 900, fixtures: board(fb) })
    await page.waitForSelector(FIRST)
    await page.click(FIRST)
    await notice(page, 'err')
    assert.match(await noticeText(page), /Facebook rejected the photos\./)
    assert.equal(await page.$('[data-fb-quick-notice="ok"]'), null)
  } finally { await browser.close() }
})

test('the old posting-queue toggle is gone from the Board source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'crm', 'schedule-board', 'page.tsx'), 'utf8')
  for (const gone of ['toggleFbQueue', 'onFbQueue', 'fbQueueBusy', '/facebook-queue', 'In the Facebook posting queue']) assert.ok(!src.includes(gone), gone)
  assert.match(src, /<QuickFacebookButton propertyId=\{r\.id\} refLabel=\{r\.ref\}/)
})
