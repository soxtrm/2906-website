// Shared harness for CRM browser tests that must run WITHOUT a live backend
// or CRM_TOKEN: every /api/crm/* request is answered from in-memory fixtures,
// maps/tiles are stubbed, and nothing ever reaches a real owner or client.
//
//   const { launch, openPage, listing } = require('./helpers/crm-mock.cjs')
//
// Requests the page makes are recorded on `page.crmCalls` so a test can
// assert on what would have been sent (method, path, JSON body).
const puppeteer = require('puppeteer')

const BASE = process.env.CRM_MOCK_BASE || 'http://localhost:3000'
const now = () => new Date().toISOString()

function listing(id, overrides = {}) {
  const town = overrides.town || ['Sliema', 'Gzira', 'Swieqi', 'Mosta'][id % 4]
  return {
    id, ref: `2906-${9100 + id}`, town, subLocation: null, type: 'apartment', beds: 1 + (id % 3), baths: 1,
    sizeSqm: 80, price: 1100 + id * 50, salePrice: null, shortlet: false, availableStatus: 'available',
    availableDate: null, leaseType: 'long_let', availableUntil: null, rentalModes: ['long_let'],
    units: { groupRootId: null, total: 1, available: 1 }, localityKey: town.toLowerCase(), localityLabel: town,
    localityLat: 35.91, localityLng: 14.49, viewingDate: null, viewingStatus: null, hasViewingLocation: false,
    exclusive: false, createdAt: now(), updatedAt: now(), recentlyRentedAt: null, lastConfirmedAvailableAt: now(),
    statusChangeReason: null, availability: { kind: 'now', date: null, label: 'Available now' }, streetName: null,
    petFriendly: true, sharing: true, subletting: null, canTag: true, isFavourite: false, isHotProperty: false,
    starStep: 0, bookingsPossible: false, viewingWindow: null, viewingsFrom: null, bookings: [], petsPolicy: null,
    lastChatAt: null, viewing: null, images: [], imageCount: 0,
    listedBy: { id: 1, displayName: 'QA', colorHex: '#52a6ff' }, isMine: true, category: 'letting',
    description: `Mock listing ${id}`, facebookQueueStatus: 'none',
    contact: { mode: 'owner', reachesName: 'Owner', canAsk: true, reason: null, questionsUsed: 0, questionsPerDay: 3, canQuestion: true, questionReason: null },
    ...overrides,
  }
}

function defaultFixtures() {
  return {
    me: { agent: { id: 1, username: 'qa', name: 'QA Agent', role: 'admin', daily_reveal_limit: 50 }, reveals: { used: 0, limit: 50 } },
    listings: Array.from({ length: 12 }, (_, i) => listing(i + 1)),
    rented: [listing(90, { availableStatus: 'rented', recentlyRentedAt: now() })],
    favourites: [],
    relay: {
      open: true, ownerLabel: 'Owner 4821', persona: 'kev', events: [], otherActivity: [],
      messages: Array.from({ length: 14 }, (_, i) => ({ id: i + 1, direction: i % 2 ? 'owner_to_agent' : 'agent_to_owner', text: `Message ${i + 1}`, at: new Date(Date.now() - (20 - i) * 60000).toISOString() })),
    },
    meDelayMs: 0,
  }
}

function respond(fixtures, path, method, body, search = new URLSearchParams()) {
  // Per-test overrides: fixtures.routes = [[/regex/, 'METHOD' | null, (body, search) => json]]
  for (const [re, m, fn] of fixtures.routes || []) if (re.test(path) && (!m || m === method)) return fn(body, search)
  if (path === 'me') return fixtures.me
  if (path === 'schedule-board/favourites') return { listings: fixtures.favourites }
  if (path === 'schedule-board/listings') return { listings: search.get('status') === 'rented' ? fixtures.rented : fixtures.listings }
  if (/^schedule-board\/listings\/[^/]+\/relay$/.test(path)) return fixtures.relay
  if (/\/relay\/message$/.test(path) && method === 'POST') {
    const text = JSON.parse(body || '{}').text
    fixtures.relay = { ...fixtures.relay, messages: [...fixtures.relay.messages, { id: fixtures.relay.messages.length + 1000, direction: 'agent_to_owner', text, at: now() }] }
    return { ok: true }
  }
  if (/\/ask\/preview$/.test(path)) return { text: 'Hello, is anything else coming free soon?', to: 'Owner' }
  if (/\/ask\/send$/.test(path)) return { message: 'Sent.' }
  return { accounts: [], plans: [], items: [], rows: [], tasks: [], listings: [], notifications: [], changes: [], groups: [], settings: {} }
}

/** In-page stand-in for the on-screen keyboard: window.__keyboard(px). */
function installFakeVisualViewport() {
  const target = new EventTarget()
  const state = { height: innerHeight }
  const vv = Object.defineProperties(target, {
    height: { get: () => state.height }, width: { get: () => innerWidth }, offsetTop: { value: 0 },
    offsetLeft: { value: 0 }, scale: { value: 1 }, pageTop: { value: 0 }, pageLeft: { value: 0 },
  })
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv })
  window.__keyboard = px => { state.height = innerHeight - px; vv.dispatchEvent(new Event('resize')) }
}

async function serverAvailable() {
  try { const res = await fetch(`${BASE}/crm/login`, { redirect: 'manual' }); return res.status < 500 } catch { return false }
}

async function launch() { return puppeteer.launch({ headless: true, args: ['--disable-dev-shm-usage'] }) }

async function openPage(browser, { path = '/crm/schedule-board', theme = 'light', width = 390, height = 844, fixtures = defaultFixtures(), fakeKeyboard = true, wait = 'networkidle2', waitForIntro = true } = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width, height, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(value => { try { localStorage.setItem('crm_theme_pref', value) } catch {} }, theme)
  if (fakeKeyboard) await page.evaluateOnNewDocument(installFakeVisualViewport)
  page.crmCalls = []
  page.consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') page.consoleErrors.push(m.text()) })
  page.on('pageerror', e => page.consoleErrors.push(String(e.message || e)))
  await page.setRequestInterception(true)
  page.on('request', async req => {
    const url = new URL(req.url())
    if (url.pathname.startsWith('/api/crm/')) {
      const path = url.pathname.replace('/api/crm/', '')
      page.crmCalls.push({ method: req.method(), path, body: req.postData() || null })
      if (path === 'me' && fixtures.meDelayMs) await new Promise(r => setTimeout(r, fixtures.meDelayMs))
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(respond(fixtures, path, req.method(), req.postData(), url.searchParams)) })
    }
    if (/maps\.googleapis|mapbox|tiles\./.test(req.url())) return req.respond({ status: 204, body: '' })
    req.continue()
  })
  await page.goto(`${BASE}${path}`, { waitUntil: wait, timeout: 180000 })
  // A fresh tab is a cold load: the ARGUS intro covers the page until it
  // dissolves, so interactions must wait for it.
  if (waitForIntro && wait !== 'domcontentloaded') await page.waitForFunction(() => !document.querySelector('.argus-intro'), { timeout: 10000 })
  return page
}

module.exports = { BASE, listing, defaultFixtures, serverAvailable, launch, openPage }
