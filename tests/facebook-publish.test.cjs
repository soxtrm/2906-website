// ARGUS × Facebook Business Pages — browser tests with a mocked backend.
// Nothing reaches Facebook: /api/crm/* is answered in-page, and navigation to
// facebook.com is intercepted and recorded.
//   CRM_MOCK_BASE=http://localhost:3077 node --test tests/facebook-publish.test.cjs
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('fs')
const path = require('path')
const { launch, openPage, defaultFixtures } = require('./helpers/crm-mock.cjs')

const OUT = process.env.FB_EVIDENCE_DIR || path.join(__dirname, '..', 'ops', 'facebook-pages', 'evidence')
fs.mkdirSync(OUT, { recursive: true })
const svg = (c, l) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${c}"/><text x="320" y="270" text-anchor="middle" font-size="120" fill="white" font-family="Arial">${l}</text></svg>`)}`
const IMGS = [svg('#4979a8', '1'), svg('#b27b54', '2'), svg('#668f70', '3'), svg('#8a5a9c', '4')]

const property = (over = {}) => ({
  id: 41, ref: '2906-9541', published: true, type: 'apartment', exclusive: false, completeness: 92, images: IMGS.map(u => ({ url: u, thumbnail: u })), imageCount: 4,
  owner: { id: 9, name: 'Owner Test', phoneMasked: '+356 79•• ••70', hasPhone: true, emailMasked: null, hasEmail: false },
  location: { town: 'Sliema', street: null, apt: null }, prices: { longlet: 1850, shortlet: null, sale: null }, beds: 2, baths: 2,
  rentalModes: ['long_let'], availableUntil: null, availableStatus: 'available', availableDate: null, viewingStatus: 'none',
  ownerCreator: 'Olga', listingAgents: ['Olga'], activityAgents: [], fav: false, listedByAgentId: 7, noFb: false, ...over,
})

const MSG = '🏡 2-BEDROOM APARTMENT FOR RENT — SLIEMA\n\n📍 Sliema, Malta\n💶 €1,850 / month\n🛏 2 Bedrooms\n🛁 2 Bathrooms\n❄️ Air-conditioning\n\n📩 Contact us to arrange a viewing.\n🔗 https://www.2906.estate/swipe/abc123'

function fbFixtures({ connected = true, configured = true } = {}) {
  const st = {
    configured, setupMissing: configured ? [] : ['META_APP_ID'], appId: '1234567890', graphVersion: 'v27.0', autoPublishAvailable: true,
    connection: connected ? { state: 'active', facebookName: 'Olga Test', connectedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), missingPermissions: [] } : { state: 'not_connected' },
    pages: connected ? [
      { id: 11, pageId: '101', name: 'Olga Homes Malta', pictureUrl: null, category: 'Real Estate', canPublish: true, status: 'active', statusReason: null, enabled: true, isDefault: true, autoPublish: false, lastSyncedAt: new Date().toISOString() },
      { id: 12, pageId: '102', name: 'Olga Analytics Only', pictureUrl: null, category: null, canPublish: false, status: 'missing_permission', statusReason: 'Your role on this Page does not allow creating posts.', enabled: false, isDefault: false, autoPublish: false, lastSyncedAt: new Date().toISOString() },
    ] : [],
    preferences: { language: 'en', defaultTemplateId: 'classic', useEmojis: true, includeContact: false, includeLink: true, callToAction: '', autoPublishEnabled: false, autoDailyLimit: 3 },
    templates: [{ id: 'classic', name: 'Classic', builtIn: true }, { id: 'short', name: 'Short', builtIn: true }, { id: 'original', name: 'Listing text', builtIn: true }],
    agent: { displayName: 'Olga', publicPhone: '+356 7900 0000', colorHex: '#c2410c' },
  }
  const pubs = []
  const state = { st, pubs, posts: [], polls: 0, duplicateOnce: false }
  const draft = search => ({
    property: { id: 41, ref: '2906-9541', type: 'apartment', town: 'Sliema', bedrooms: 2, bathrooms: 2, rent: 1850, sale: null, availableStatus: 'available', availableDate: null },
    images: IMGS.map(u => ({ url: u, thumbnail: u })), imagesAllowed: true, imagesReason: null, maxImages: 10,
    link: 'https://www.2906.estate/swipe/abc123', linkKind: 'share', message: search.get('language') === 'de' ? MSG.replace('FOR RENT', 'ZU VERMIETEN') : MSG,
    language: search.get('language') || 'en', templateId: search.get('templateId') || 'classic', emojis: true, includeContact: false, includeLink: true, blockers: [], publications: [],
  })
  const routes = [
    [/^facebook-pages\/status$/, 'GET', () => st],
    [/^facebook-pages\/connect$/, 'POST', () => ({ url: 'https://www.facebook.com/v27.0/dialog/oauth?client_id=1234567890&redirect_uri=https%3A%2F%2Fcrm.2906.estate%2Fintegrations%2Ffacebook%2Fcallback&state=STATE123&response_type=code&scope=pages_show_list' })],
    [/^facebook-pages\/connect\/complete$/, 'POST', () => ({ ...fbFixtures().state.st })],
    [/^facebook-pages\/properties\/\d+\/draft$/, 'GET', (_b, s) => draft(s)],
    [/^facebook-pages\/publications$/, 'POST', b => {
      const body = JSON.parse(b)
      if (state.duplicateOnce && !body.confirmDuplicate) return { __status: 409, body: { error: 'This property is already published on Olga Homes Malta. Publish again anyway?', kind: 'duplicate', existing: [{ id: 1, state: 'published', publishedAt: new Date().toISOString(), permalinkUrl: 'https://www.facebook.com/101/posts/9001' }] } }
      const p = { id: 500 + pubs.length, propertyId: body.propertyId, propertyRef: '2906-9541', pageRowId: body.pageRowId, pageName: 'Olga Homes Malta', publicationType: body.images.length > 1 ? 'multi_photo' : body.images.length ? 'photo' : 'link', state: 'queued', stateLabel: 'Queued', trigger: 'manual', message: body.message, images: body.images, link: 'https://www.2906.estate/swipe/abc123?utm_source=facebook', language: 'en', template: 'classic', postId: null, permalinkUrl: null, publishedAt: null, lastCheckedAt: null, error: null, nextAttemptAt: null, attemptCount: 0, replacesId: null, editedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canEdit: false, canDelete: false, canRetry: false }
      pubs.unshift(p)
      return { publication: p, replayed: false }
    }],
    [/^facebook-pages\/publications\/\d+$/, 'GET', () => {
      const p = pubs[0]
      if (++state.polls >= 2) Object.assign(p, { state: 'published', stateLabel: 'Published', postId: '101_9002', permalinkUrl: 'https://www.facebook.com/101/posts/9002', publishedAt: new Date().toISOString(), canEdit: true, canDelete: true })
      else Object.assign(p, { state: 'publishing', stateLabel: 'Publishing' })
      return { publication: p }
    }],
    [/^facebook-pages\/publications$/, 'GET', () => ({ publications: pubs })],
  ]
  return { routes, state }
}

function fixturesWith(fb, extra = []) {
  const f = defaultFixtures()
  f.me = { agent: { id: 7, username: 'olga', name: 'Olga', role: 'agent', daily_reveal_limit: 50 }, reveals: { used: 0, limit: 50 }, nav: ['dashboard', 'inventory', 'board', 'profile'] }
  f.routes = [...fb.routes, ...extra,
    [/^intake\/summary$/, 'GET', () => ({ counts: { needs_verification: 0, needs_correction: 0, verified_today: 0 }, items: [] })],
    [/^properties$/, 'GET', () => ({ properties: [property(), property({ id: 42, ref: '2906-9542', noFb: true }), property({ id: 43, ref: '2906-9543', listedByAgentId: 99 })], total: 3 })],
    [/^properties\/41$/, 'GET', () => ({ property: { ...property(), description: 'x' }, activities: [] })],
    [/^agents$/, 'GET', () => ({ agents: [] })], [/^locations$/, 'GET', () => ({ locations: ['Sliema'] })]]
  return f
}
const posts = page => page.crmCalls.filter(c => c.method === 'POST' && c.path === 'facebook-pages/publications').map(c => JSON.parse(c.body))
const settle = () => new Promise(r => setTimeout(r, 450))   // let the dialog's open animation finish before a screenshot
const clickText = (page, sel, text) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find(e => e.textContent.trim().includes(t) && !e.disabled); if (!el) throw new Error('no ' + t); el.click() }, sel, text)

test('desktop: listing page → Customise post → Page → Photos → Review → Publish, confirmed by Meta', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures()
    const page = await openPage(browser, { path: '/crm/property/41', width: 1440, height: 900, fixtures: fixturesWith(fb) })
    await page.waitForSelector('button[aria-label="Choose the Page, photos and text before posting"]')
    await page.click('button[aria-label="Choose the Page, photos and text before posting"]')
    await page.waitForSelector('.fbp-dialog [role="radiogroup"]')
    const accent = await page.$eval('.fbp-dialog', el => getComputedStyle(el).getPropertyValue('--fbp-accent').trim())
    assert.equal(accent, '#c2410c', 'the agent\'s own colour is the accent')
    const pageState = await page.$$eval('.fbp-dialog [role="radio"]', r => r.map(x => ({ t: x.textContent, checked: x.getAttribute('aria-checked'), disabled: x.getAttribute('aria-disabled') })))
    assert.equal(pageState[0].checked, 'true')
    assert.equal(pageState[1].disabled, 'true')
    await settle(); await page.screenshot({ path: path.join(OUT, 'desktop-1-page.png') })
    await clickText(page, '.fbp-dialog-foot button', 'Next')
    await page.waitForSelector('.fbp-grid-imgs')
    assert.equal(await page.$$eval('.fbp-img[aria-pressed="true"]', x => x.length), 4)
    await page.click('.fbp-img:nth-child(4)')                 // deselect photo 4
    await page.click('button[aria-label="Move photo 1 right"]') // reorder 1,2,3 → 2,1,3
    await settle(); await page.screenshot({ path: path.join(OUT, 'desktop-2-photos.png') })
    await clickText(page, '.fbp-dialog-foot button', 'Next')
    await page.waitForSelector('textarea[aria-label="Advertisement text"]')
    await page.$eval('textarea[aria-label="Advertisement text"]', el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
    await page.type('textarea[aria-label="Advertisement text"]', '\nViewings this week.')
    const preview = await page.$eval('.fbp-preview', el => ({ text: el.querySelector('.fbp-preview-text').textContent, imgs: el.querySelectorAll('.fbp-mosaic img').length, name: el.querySelector('.fbp-preview-name').textContent }))
    assert.match(preview.text, /Viewings this week\./)
    assert.equal(preview.imgs, 3)
    assert.equal(preview.name, 'Olga Homes Malta')
    await settle(); await page.screenshot({ path: path.join(OUT, 'desktop-3-review.png') })
    await clickText(page, '.fbp-dialog-foot button', 'Next')
    await page.waitForSelector('.fbp-confirm')
    const confirm = await page.$eval('.fbp-confirm', el => el.textContent)
    assert.match(confirm, /2-bedroom apartment in Sliema/)
    assert.match(confirm, /Olga Homes Malta/)
    assert.match(confirm, /Multi-photo post with property link/)
    await settle(); await page.screenshot({ path: path.join(OUT, 'desktop-4-confirm.png') })
    assert.equal(posts(page).length, 0, 'nothing is sent before Publish now')
    await clickText(page, '.fbp-dialog-foot button', 'Publish now')
    await page.waitForFunction(() => document.querySelector('.fbp-success .fbp-h')?.textContent === 'Successfully published', { timeout: 15000 })
    const sent = posts(page)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].pageRowId, 11)
    assert.deepEqual(sent[0].images, [IMGS[1], IMGS[0], IMGS[2]], 'the chosen order is sent')
    assert.match(sent[0].message, /Viewings this week\.$/)
    assert.match(sent[0].idempotencyKey, /^[0-9a-f]{32}$/)
    const open = await page.$eval('.fbp-success a.fbp-btn-fb', a => a.href)
    assert.equal(open, 'https://www.facebook.com/101/posts/9002', 'the link Meta returned')
    const share = await page.$eval('.fbp-success a[href*="dialog/share"]', a => a.href)
    assert.match(share, /app_id=1234567890/)
    await settle(); await page.screenshot({ path: path.join(OUT, 'desktop-5-published.png') })
    assert.deepEqual(page.consoleErrors.filter(e => !/favicon|Failed to load resource/.test(e)), [])
  } finally { await browser.close() }
})

test('mobile: property page panel, full-screen dialog, duplicate needs explicit confirmation', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures()
    fb.state.duplicateOnce = true
    const page = await openPage(browser, { path: '/crm/property/41', width: 390, height: 844, fixtures: fixturesWith(fb) })
    await page.waitForSelector('section[aria-label="Facebook posts for this listing"]')
    await page.$eval('button[aria-label="Choose the Page, photos and text before posting"]', el => el.click())   // the panel below is still loading and can shift the layout under a pointer click
    await page.waitForSelector('.fbp-dialog [role="radiogroup"]')
    const box = await page.$eval('.fbp-dialog', el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) } })
    assert.deepEqual(box, { w: 390, h: 844, x: 0 }, 'full screen on a phone')
    const overflow = await page.evaluate(() => document.querySelector('.fbp-dialog-body').scrollWidth > document.querySelector('.fbp-dialog-body').clientWidth)
    assert.equal(overflow, false, 'no sideways scrolling')
    await settle(); await page.screenshot({ path: path.join(OUT, 'mobile-1-page.png') })
    for (let i = 0; i < 3; i++) await clickText(page, '.fbp-dialog-foot button', 'Next')
    await page.waitForSelector('.fbp-confirm')
    await clickText(page, '.fbp-dialog-foot button', 'Publish now')
    await page.waitForFunction(() => /Publish again anyway/.test(document.querySelector('.fbp-dialog-foot')?.textContent || ''))
    await settle(); await page.screenshot({ path: path.join(OUT, 'mobile-2-duplicate.png') })
    assert.equal(fb.state.pubs.length, 0)
    await clickText(page, '.fbp-dialog-foot button', 'Publish again anyway')
    await page.waitForFunction(() => document.querySelector('.fbp-success .fbp-h')?.textContent === 'Successfully published', { timeout: 15000 })
    const sent = posts(page)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].confirmDuplicate, true)
    assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey, 'same request id: a retry cannot create two posts')
    await settle(); await page.screenshot({ path: path.join(OUT, 'mobile-3-published.png') })
  } finally { await browser.close() }
})

test('connect: official Meta dialog, callback hands the code to the backend and clears it from the URL', async () => {
  const browser = await launch()
  try {
    const fb = fbFixtures({ connected: false })
    const page = await openPage(browser, { path: '/crm/integrations/facebook', width: 1280, height: 900, fixtures: fixturesWith(fb) })
    await page.waitForFunction(() => /Connect Facebook/.test(document.body.textContent))
    await settle(); await page.screenshot({ path: path.join(OUT, 'settings-not-connected.png'), fullPage: true })
    const facebookNav = new Promise(resolve => page.on('request', r => { if (r.url().startsWith('https://www.facebook.com/')) resolve(r.url()) }))
    await clickText(page, 'button', 'Connect Facebook')
    const url = new URL(await facebookNav)
    assert.equal(url.pathname, '/v27.0/dialog/oauth')
    assert.equal(url.searchParams.get('state'), 'STATE123')

    const p2 = await openPage(browser, { path: '/crm/integrations/facebook/callback?code=AQBcode&state=STATE123', width: 1280, height: 900, fixtures: fixturesWith(fbFixtures()) })
    await p2.waitForFunction(() => location.search.includes('connected=1'), { timeout: 15000 })
    const complete = p2.crmCalls.find(c => c.path === 'facebook-pages/connect/complete')
    assert.deepEqual(JSON.parse(complete.body), { code: 'AQBcode', state: 'STATE123', error: null })
    assert.ok(!p2.url().includes('AQBcode'), 'the code does not stay in the address bar')
    await p2.waitForFunction(() => /Business Pages/.test(document.body.textContent) && /Olga Homes Malta/.test(document.body.textContent))
    await settle(); await p2.screenshot({ path: path.join(OUT, 'settings-connected.png'), fullPage: true })
  } finally { await browser.close() }
})

test('setup pending: no publish buttons until the server is configured', async () => {
  const browser = await launch()
  try {
    const page = await openPage(browser, { path: '/crm/inventory', width: 1440, height: 900, fixtures: fixturesWith(fbFixtures({ configured: false })) })
    await page.waitForSelector('.inventory-desktop-row, tr')
    await new Promise(r => setTimeout(r, 800))
    assert.equal(await page.$$eval('[data-fb-quick-publish], button[aria-label="Choose the Page, photos and text before posting"], button[aria-label="Publish to Facebook"]', b => b.length), 0)
  } finally { await browser.close() }
})

test('inventory: every listing has the one-click button, also for listings of other agents; "no Facebook" listings are disabled', async () => {
  const browser = await launch()
  try {
    const page = await openPage(browser, { path: '/crm/inventory', width: 1440, height: 900, fixtures: fixturesWith(fbFixtures()) })
    await page.waitForSelector('[data-fb-quick-publish]')
    const buttons = await page.$$eval('[data-fb-quick-publish]', b => b.map(x => ({ ref: x.getAttribute('data-fb-quick-publish'), disabled: x.disabled, label: x.getAttribute('aria-label') })))
    const byRef = Object.fromEntries(buttons.map(b => [b.ref, b]))
    assert.equal(byRef['2906-9541'].disabled, false, 'own listing')
    assert.equal(byRef['2906-9543'].disabled, false, 'a listing of another agent can be posted too')
    assert.equal(byRef['2906-9542'].disabled, true, 'owner said no Facebook')
    assert.match(byRef['2906-9542'].label, /no Facebook/)
  } finally { await browser.close() }
})
