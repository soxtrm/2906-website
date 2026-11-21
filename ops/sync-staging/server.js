'use strict'
// NEXUS SYNC staging service (2026-11-21): the patched SYNC + CRM routes on a throwaway database with
// synthetic owners, for signed-in end-to-end tests of nexussync's real pages. Not the full backend: no
// cron jobs, no queues, no WhatsApp, no e-mail; outgoing messages are captured in memory, never sent.
const path = require('path')
const ROOT = '/app'; const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: console.warn, error: console.error, debug: noop })
const fake = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (k === 'on' || k === 'once') ? () => fake : async () => null) })
stub('waha.js', fake); stub('redis.js', fake); stub('queues.js', fake)
const express = require(R('node_modules/express'))
const S = require(R('services/syncAccount.js'))
const L = require(R('services/nexusOwnerLink.js'))
const outbox = []
S._test.setSender(async (session, chat, text) => { outbox.push({ kind: 'whatsapp', text: String(text).slice(0, 80) }) })
S._test.setMailer(async m => { outbox.push({ kind: 'mail', subject: m && m.subject }); return true })

async function seed() {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int n FROM sync_accounts')
  if (n) return
  await pool.query("INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'stage-admin','Stage Admin','admin',true,true) ON CONFLICT DO NOTHING")
  const towns = ['Sliema', 'Gzira', 'Swieqi']
  const mk = async (name, phone, email, refs) => {
    const { rows: [o] } = await pool.query('INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id', [phone, name])
    const ids = []
    for (let i = 0; i < refs.length; i++) {
      const { rows: [p] } = await pool.query(
        "INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, published, available_status) VALUES ($1,$2,'Apartment',$3,2,1,$4,true,'available') RETURNING id",
        [refs[i], towns[i % 3], 1300 + i * 250, o.id])
      ids.push(p.id)
      const { rows: [row] } = await pool.query(`SELECT ${L._internal.PROPERTY_COLUMNS} FROM properties p WHERE p.id=$1`, [p.id])
      await L._internal.ensurePropertyLink(pool, row)
    }
    await S.signup({ email, password: 'stage-pass-2026', name, userAgent: 'staging-seed' })
    const { rows: [a] } = await pool.query('SELECT * FROM sync_accounts WHERE email=$1', [email])
    if (refs.length) {
      const { rows: [l] } = await pool.query("INSERT INTO nexus_owner_links (agency_key, owner_contact_id, nexus_account_ref, link_state) VALUES ('2906',$1,$2,'verified') RETURNING id", [o.id, `sync:${a.public_id}`])
      for (const id of ids) await pool.query("INSERT INTO nexus_owner_property_claims (owner_link_id, property_id, claim_state) VALUES ($1,$2,'confirmed')", [l.id, id])
    }
    return { ids, a }
  }
  // refs carry the agency prefix like production ('2906-039'), so the marketplace names the agency
  const olga = await mk('Olga Stage', '35699100001', 'olga.stage@example.test', ['2906-ST-101', '2906-ST-102', '2906-ST-103', '2906-9765', '2906-9901'])
  await mk('Bruno Stage', '35699100002', 'bruno.stage@example.test', ['2906-ST-201'])
  const dan = await mk('Dan Stage', '35699100003', 'dan.stage@example.test', [])
  await pool.query("UPDATE sync_accounts SET phone_e164='35699100003', phone_verified_at=NOW(), phone_verified_via='staging' WHERE id=$1", [dan.a.id])
  await mk('Xena Stage', '35699100004', 'xena.stage@example.test', [])
  // a CRM admin who can sign in to the staging CRM
  const bcrypt = require(R('node_modules/bcryptjs'))
  await pool.query("UPDATE agents SET email='stage-admin@example.test', password_hash=$1 WHERE id=1", [bcrypt.hashSync('stage-admin-2026', 10)])
  // marketplace chat test (2026-11-21): 2906-9765 is listed by agent Tim Stage; Uma Other is an unrelated agent of the same agency
  await pool.query("INSERT INTO agents (id, username, name, role, active, board_access, email, password_hash) VALUES (2,'stage-agent','Tim Stage','agent',true,false,'tim.stage@example.test',$1), (3,'stage-other','Uma Other','agent',true,false,'uma.other@example.test',$2) ON CONFLICT DO NOTHING",
    [bcrypt.hashSync('stage-agent-2026', 10), bcrypt.hashSync('stage-other-2026', 10)])
  await pool.query("UPDATE properties SET listed_by_agent_id=2 WHERE ref='2906-9765'")
  // NEXUS Rooms test home: one 3-bedroom apartment in St Julian's (rooms are added through the owner UI in the tests)
  await pool.query("UPDATE properties SET bedrooms=3, bathrooms=2, town='Sliema', property_type='Apartment', longlet_price=2100, listed_by_agent_id=2 WHERE ref='2906-9901'")
  // Pia: owner record with two homes, SYNC account with a confirmed mobile, claim proposed (as after 'SYNC verify')
  const { rows: [po] } = await pool.query("INSERT INTO owner_contacts (phone_normalized, name) VALUES ('35699100005','Pia Stage') RETURNING id")
  for (const [i, ref] of ['2906-ST-301', '2906-ST-302'].entries()) {
    const { rows: [p] } = await pool.query("INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, published, available_status, listed_by_agent_id) VALUES ($1,'Mellieha','Apartment',$2,2,1,$3,true,'available',1) RETURNING id", [ref, 1400 + i * 200, po.id])
    const { rows: [row] } = await pool.query(`SELECT ${L._internal.PROPERTY_COLUMNS} FROM properties p WHERE p.id=$1`, [p.id])
    await L._internal.ensurePropertyLink(pool, row)
  }
  await S.signup({ email: 'pia.stage@example.test', password: 'stage-pass-2026', name: 'Pia Stage', userAgent: 'staging-seed' })
  const { rows: [pia] } = await pool.query("UPDATE sync_accounts SET phone_e164='35699100005', phone_verified_at=NOW(), phone_verified_via='whatsapp' WHERE email='pia.stage@example.test' RETURNING *")
  await S.claimByPhone(pool, pia)
  // three pending viewing requests on Olga's first home, two days ahead
  const base = new Date(Date.now() + 2 * 86400e3); base.setUTCHours(9, 0, 0, 0)
  for (const [h, who] of [[0, 'Client A'], [2, 'Client B'], [4, 'Client C']]) {
    const at = new Date(base.getTime() + h * 3600e3)
    await pool.query("INSERT INTO property_viewings (property_id, viewing_date, status, starts_at, duration_min, requester_name, party_size, viewing_agent_name) VALUES ($1,($2::timestamptz)::date,'pending',$2,20,$3,2,'Stage Agent')", [olga.ids[0], at, who])
  }
  // listable in the marketplace projection: a known locality and one (public demo) photo
  await pool.query(`UPDATE properties p SET locality_id = v.id, images = '["https://res.cloudinary.com/du2jwqnbs/image/upload/v1785401218/2906-properties/szkbh5t1kbeayapysnct.jpg"]'::jsonb
                      FROM villages v WHERE lower(v.display_name) = lower(p.town)`)
  console.log('seeded', JSON.stringify({ olga: olga.ids }))
}

const app = express()
app.use(express.json({ limit: '6mb' }))
app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
app.use('/api/crm/sync-inbox', require(R('routes/crmSyncInbox.js')))
app.use('/api/crm/property-features', require(R('routes/crmPropertyFeatures.js')))
// Marketplace conversations (2026-11-21), when the live code has them
// NEXUS Rooms (2026-11-21), when the live code has them
try { app.use('/api/crm/property-rooms', require(R('routes/crmPropertyRooms.js'))); app.use('/api/nexus/rooms', require(R('routes/nexusRooms.js'))) } catch (e) { console.log('rooms not in live code', e.message) }
try { app.use('/api/crm/deal-rooms', require(R('routes/crmDealRooms.js'))) } catch (e) { console.log('deal rooms not in live code', e.message) }
try { app.use('/api/nexus/mp-deal', require(R('routes/marketplaceDealRoom.js'))) } catch (e) { console.log('deal room client route not in live code', e.message) }
try { app.use('/api/crm/marketplace-inbox', require(R('routes/crmMarketplaceInbox.js'))); app.use('/api/nexus/mp', require(R('routes/marketplaceConversations.js'))) } catch (e) { console.log('marketplace conversations not in live code', e.message) }
app.use('/api/nexus', require(R('routes/nexusBridge.js')))
app.use('/api/crm', require(R('routes/crm.js')))
app.get('/stage/outbox', (req, res) => res.json(outbox))
seed().then(() => app.listen(3901, '0.0.0.0', () => console.log('SYNC staging on 3901'))).catch(e => { console.error('seed failed', e); process.exit(1) })
