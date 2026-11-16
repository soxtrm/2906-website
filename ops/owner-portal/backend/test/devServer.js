'use strict'
// LOCAL demo backend for screenshots and browser tests only (Claude, 2026-11-16).
// Local Postgres, sample owner "Sample Owner", sample properties, sample agent
// requests. Never point this at production. Prints the owner invitation link.
//   NODE_PATH=<pg+express> node test/devServer.js [port]
const express = require('express')
const T = require('./helpers/db')
const routes = require('../routes/ownerPortalRoutes')
const S = require('../services/ownerSchedule')

const PORT = Number(process.argv[2] || 3911)
const WEB = process.env.OWNER_PORTAL_WEB || 'http://localhost:3300'
const img = n => `/link-marketplace/assets/${n}`

;(async () => {
  await T.setup()
  const admin = await T.agent('admin')
  const owner = await T.owner({ name: 'OPT Sample Owner' })
  const p1 = await T.property(owner.id, { town: 'Sliema', sub_location: 'Tower Road', property_type: 'Apartment', bedrooms: 2, bathrooms: 2, size_sqm: 95, longlet_price: 1850,
    description: 'Sample listing for the owner-portal demo. Bright corner apartment, open-plan kitchen, two balconies.', feature_tags: ['Air conditioning', 'Balcony', 'Lift', 'Sea view'],
    images: JSON.stringify([img('bahar-ic-caghaq-malta-0476-justlettersandnumbers.webp'), img('birzebbuga-pretty-bay-frank-vincentz.webp'), img('bugibba-dawret-il-gzejjer-frank-vincentz.webp')]) })
  const p2 = await T.property(owner.id, { town: 'Gzira', property_type: 'Penthouse', bedrooms: 3, bathrooms: 2, size_sqm: 140, longlet_price: 2600,
    description: 'Sample penthouse with a large terrace.', feature_tags: ['Terrace', 'Parking'], images: JSON.stringify([img('birgu-vittoriosa-mrpanygoff.webp')]) })
  const p3 = await T.property(owner.id, { town: 'Balzan', property_type: 'Maisonette', bedrooms: 2, longlet_price: 1350, available_status: 'available', images: JSON.stringify([img('balzan-annunciation.webp')]) })

  const app = express()
  app.set('trust proxy', true)
  const staffAuth = (req, res, next) => { req.agent = { id: admin.id }; next() }
  const r = routes({ db: T.pool, staffAuth, portalUrl: `${WEB}/owner-portal`, shareUrl: `${WEB}/property-link` })
  app.use('/api/owner-portal', r.owner); app.use('/api/owner-share', r.share); app.use('/api/crm/owner-portal', r.staff)
  const P = r.portal

  // Owner signs in once (to set up rules and a share link like a real owner would).
  const inv = await P.inviteOwner({ ownerId: owner.id, agentId: admin.id, identityMethod: 'Local demo seed' })
  const { sessionToken } = await P.claimInvitation({ token: inv.token })
  const me = await P.authenticate(sessionToken)
  const week = (extra = {}) => ({ weekly: [1, 2, 3, 4, 5].flatMap(day => [{ day, start: '10:00', end: '13:00' }, { day, start: '16:00', end: '19:00' }]).concat([{ day: 6, start: '10:00', end: '12:30' }]),
    breaks: [], exceptions: [], blocked: [], durationMin: 30, bufferMin: 15, noticeHours: 2, horizonDays: 21, approval: 'manual', ...extra })
  await P.saveRules(me, p1.id, week())
  await P.saveRules(me, p2.id, week({ durationMin: 20, bufferMin: 10 }))
  const link = await P.createShareLink(me, { propertyIds: [p1.id, p2.id, p3.id], label: 'For agents' })

  const day = n => new Intl.DateTimeFormat('en-CA', { timeZone: S.TZ }).format(new Date(Date.now() + n * 86400000))
  const at = (n, t) => new Date(S.zonedToEpoch(day(n), t)).toISOString()
  const next = n => { for (let i = n; i < n + 7; i++) if (![0].includes(new Date(`${day(i)}T12:00:00Z`).getUTCDay())) return i; return n }
  const d1 = next(1), d2 = next(d1 + 1)
  await P.shareRequest(link.token, { propertyId: p1.id, agent: { name: 'Sample Agent A', agency: 'Partner Homes' }, client: { people: 2, groupType: 'couple', moveIn: day(30), pets: 'one small dog', budgetNote: 'up to €1,900', clientRef: 'A-1' }, preferred: [{ start: at(d1, '10:30') }, { start: at(d1, '17:00') }] })
  await P.shareRequest(link.token, { propertyId: p1.id, agent: { name: 'Sample Agent B', agency: 'Harbour Lettings' }, client: { people: 1, groupType: 'single', notes: 'Relocating for work, viewing by video is fine', clientRef: 'B-7' }, preferred: [{ start: at(d2, '11:00') }] })
  await P.shareRequest(link.token, { propertyId: p2.id, agent: { name: 'Sample Agent C', agency: 'Island Realty' }, client: { people: 4, groupType: 'family', moveIn: day(45) }, preferred: [{ start: at(d1, '16:00') }] })
  const confirmed = await P.shareRequest(link.token, { propertyId: p1.id, agent: { name: 'Sample Agent D', agency: 'Partner Homes' }, client: { people: 3, groupType: 'sharers', clientRef: 'D-2' }, preferred: [] })
  const deskNow = await P.desk(me, { days: 7 })
  const dReq = deskNow.requests.find(x => x.agent.name === 'Sample Agent D')
  const free = deskNow.calendars.find(c => c.propertyId === p1.id).slots.find(s => s.state === 'free' && s.date === day(d2) && s.start > at(d2, '15:59'))
  await P.ownerAct(me, dReq.id, 'propose', { start: free.start })
  await P.requestAct(confirmed.requestToken, 'confirm')
  await P.logout(sessionToken)

  // A fresh, unused invitation for the browser.
  const fresh = await P.inviteOwner({ ownerId: owner.id, agentId: admin.id, identityMethod: 'Local demo seed', purpose: 'recovery' })
  require('fs').writeFileSync(process.env.OWNER_PORTAL_SEED_OUT || '/tmp/owner-portal-seed.json', JSON.stringify({ invite: fresh.url, share: `${WEB}/property-link/${link.token}`, ownerId: owner.id, properties: [p1.id, p2.id, p3.id] }, null, 2))
  app.listen(PORT, '127.0.0.1', () => console.log(`owner-portal demo backend on :${PORT}`))
})().catch(e => { console.error(e); process.exit(1) })
