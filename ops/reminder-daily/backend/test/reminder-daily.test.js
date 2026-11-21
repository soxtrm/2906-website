'use strict'
// ARGUS P0 (2026-11-21): Reminder Due automation, inbox read-state, Safe Drafts import.
// Throwaway PostgreSQL with the full live schema (no live rows), synthetic owners only.
// WhatsApp, Redis and queues are stubs that RECORD; nothing reaches a real owner.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
process.env.NODE_ENV = 'test'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] }; return exports }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('config.js', { admin: {} })
const kv = new Map()
stub('redis.js', new Proxy({
  get: async k => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, String(v)); return 'OK' }, del: async k => { kv.delete(k); return 1 },
  exists: async k => (kv.has(k) ? 1 : 0), incr: async k => { const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); return n }, expire: async () => 1,
}, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => null) }))
const session = { status: 'WORKING', failNext: null }
const wire = [], seen = []
stub('waha.js', new Proxy({
  getSessionStatus: async () => ({ status: session.status }),
  sendText: async (s, phone, text) => { if (session.failNext) { const e = session.failNext; session.failNext = null; throw e } wire.push({ session: s, phone: String(phone), text }) },
  sendSeen: async (s, chatId) => { seen.push({ s, chatId }) },
  sendSeenChecked: async (s, chatId) => { seen.push({ s, chatId }); return { api: 'accepted' } },
  getWorkingSessions: async () => [{ name: 'Kevsecond' }, { name: 'Gabriela' }],
}, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => null) }))
stub('queues.js', { addJob: async () => ({ id: 'x' }), QUEUES: new Proxy({}, { get: () => ({ getJob: async () => null, add: async () => ({}) }) }) })

const lib = require(R('services/outreachLibrary.js'))
const pack = require(R('services/safeDraftsPack.js'))
const daily = require(R('services/reminderDaily.js'))
const inbox = require(R('services/inboxDisposition.js'))
const malta = (d, hm) => require(R('services/outreachSchedule.js')).maltaLocalToUTC(d, hm)
const DEC7 = '2026-12-07' // a Monday
let owners = {}

async function owner(name, phone, extra = '') {
  const r = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name ${extra ? ', do_not_contact' : ''}) VALUES ($1,$2 ${extra ? ', TRUE' : ''}) RETURNING id`, [phone, name])
  owners[name] = { id: r.rows[0].id, phone }
  return owners[name]
}
async function reminder(phone, note, due, { session: s = 'Kevsecond', timing = null, status = 'manual_approval' } = {}) {
  return (await pool.query(
    `INSERT INTO reminders (source_session, owner_phone, owner_name, original_note, parsed_timing, contact_due_date, status, auto_send_status, created_at)
     VALUES ($1,$2,'Synthetic',$3,$4,$5,'pending',$6, NOW() - interval '30 days') RETURNING id`, [s, phone, note, timing, due, status])).rows[0].id
}

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(`INSERT INTO whatsapp_accounts (session_name, phone, label, account_persona, is_active, outreach_enabled, priority) VALUES
    ('Kevsecond','35699900011','Kev second','kev',TRUE,TRUE,1), ('Gabriela','35699900012','Gabriela','gabriela',TRUE,TRUE,2)`)
  await pool.query(`INSERT INTO villages (name) VALUES ('Gzira'), ('Sliema') ON CONFLICT DO NOTHING`).catch(() => {})
  await lib.ensureSeed()
  await pool.query(`UPDATE settings SET value='2026-12-01' WHERE key='reminder_daily_since'`)
})
test.after(async () => { await pool.end() })

test('P0-C · 150 Safe Drafts imported pending review; existing texts untouched; no cross-persona, no fixed greeting', async () => {
  const before = (await pool.query(`SELECT COUNT(*)::int n, md5(string_agg(body, '|' ORDER BY id)) h FROM outreach_library_templates`)).rows[0]
  const r = await pack.importPack(pool)
  assert.equal(r.parsed, 150); assert.equal(r.inserted, 150); assert.deepEqual(r.refused, [])
  const again = await pack.importPack(pool)
  assert.equal(again.inserted, 0)
  const old = (await pool.query(`SELECT COUNT(*)::int n, md5(string_agg(body, '|' ORDER BY id)) h FROM outreach_library_templates WHERE code IS NULL`)).rows[0]
  assert.deepEqual(old, before)
  const st = (await pool.query(`SELECT review_status, COUNT(*)::int n FROM outreach_library_templates WHERE code IS NOT NULL GROUP BY 1`)).rows
  assert.deepEqual(st, [{ review_status: 'pending_review', n: 150 }])
  const per = (await pool.query(`SELECT persona, intent, COUNT(*)::int n FROM outreach_library_templates WHERE code IS NOT NULL GROUP BY 1,2`)).rows
  assert.equal(per.length, 30); assert.ok(per.every(x => x.n === 5))
  for (const t of (await pool.query(`SELECT persona, body FROM outreach_library_templates WHERE code IS NOT NULL`)).rows) {
    assert.equal(require(R('services/outreachIdentity.js')).findForeignSignatures(t.body, t.persona).length, 0)
    assert.ok(!/good (morning|afternoon|evening)/i.test(t.body))
  }
  // pending texts are never picked
  const picks = new Set()
  for (let i = 0; i < 40; i++) picks.add((await lib.pick('kev', {})).id)
  const pendingPicked = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_library_templates WHERE id = ANY($1::int[]) AND review_status <> 'approved'`, [[...picks]])).rows[0].n
  assert.equal(pendingPicked, 0)
})

test('P0-A · 7 December 09:00: due reminders are planned; without an approved callback text they WAIT with the reason', async () => {
  const a = await owner('Callback Owner', '35679000001')
  const b = await owner('Upcoming Owner', '35679000002')
  const c = await owner('Auto Reply Owner', '35679000003')
  await owner('Opted Out Owner', '35679000004', 'dnc')
  const e = await owner('Double Owner', '35679000005')
  const f = await owner('Recent Owner', '35679000006')
  await reminder(a.phone, 'Please contact me in December, I might have something then', DEC7, { timing: 'December' })
  await reminder(b.phone, '3 bedroom apartment in Gzira will be available from 7th December', DEC7, { session: 'Gabriela', timing: '7th December' })
  await reminder(c.phone, 'Thanks for reaching out to SFE! You’ve got Sami. Office hours 10:30-5:30', DEC7)
  await reminder('35679000004', 'call me in December', DEC7)
  await reminder(e.phone, 'message me next month', DEC7, { timing: 'next month' })
  await reminder(e.phone, 'will have a flat in Sliema early December', DEC7)
  await reminder(f.phone, 'contact me in December', DEC7, { timing: 'December' })
  await reminder('35679000099', 'please call me in December (a friend, not an owner)', DEC7)
  await reminder(a.phone, 'backlog from before go-live', '2026-11-10')
  await reminder(b.phone, 'not due yet', '2026-12-08')
  await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,'Kevsecond','x', $2)`, [f.phone, malta('2026-12-05', '10:00')])

  const sunday = await daily.planDay(malta('2026-12-06', '09:00'))
  assert.equal(sunday.skipped, 'sunday')
  const p = await daily.planDay(malta(DEC7, '09:00'))
  const reasons = Object.fromEntries([...p.skipped, ...p.waiting, ...p.planned].map(x => [x.reminderId, `${x.state}:${x.reason || ''}`]))
  const all = Object.values(reasons).join(' | ')
  assert.match(all, /skipped:automatic_reply_not_an_owner_request/)
  assert.match(all, /skipped:friend_not_owner/)
  assert.match(all, /skipped:another_reminder_for_this_owner_today/)
  assert.match(all, /waiting:no_approved_template:owner_requested_callback:kev/)
  assert.match(all, /waiting:no_approved_template:upcoming_property_followup:gabriela/)
  assert.equal(p.planned.length, 0)
  const backlog = (await pool.query(`SELECT COUNT(*)::int n FROM reminder_dispatches d JOIN reminders r ON r.id=d.reminder_id WHERE r.contact_due_date < '2026-12-01' OR r.contact_due_date > $1`, [DEC7])).rows[0].n
  assert.equal(backlog, 0, 'backlog or future reminders were touched')
  assert.equal(wire.length, 0)
})

test('P0-A · after approving the callback / upcoming drafts the waiting ones are planned and sent with the greeting of the moment', async () => {
  const ids = (await pool.query(`SELECT id FROM outreach_library_templates WHERE intent IN ('owner_requested_callback','upcoming_property_followup') AND persona IN ('kev','gabriela')`)).rows.map(r => r.id)
  await lib.setReview(ids, 'approved', 'kev')
  await daily.replanWaiting(malta(DEC7, '09:15'))
  const planned = (await pool.query(`SELECT * FROM reminder_dispatches WHERE run_date=$1 AND state='planned' ORDER BY planned_at`, [DEC7])).rows
  assert.ok(planned.length >= 3, `planned ${planned.length}`)
  for (let m = 16; m <= 59 && wire.length < planned.length; m++) await daily.tick(malta(DEC7, `09:${String(m).padStart(2, '0')}`), { limit: 5 })
  for (let m = 0; m <= 59; m++) await daily.tick(malta(DEC7, `10:${String(m).padStart(2, '0')}`), { limit: 5 })
  const rows = (await pool.query(`SELECT d.*, r.original_note FROM reminder_dispatches d JOIN reminders r ON r.id=d.reminder_id WHERE d.run_date=$1`, [DEC7])).rows
  const sent = rows.filter(r => r.state === 'sent')
  const cb = sent.find(r => r.owner_phone === owners['Callback Owner'].phone)
  assert.ok(cb, JSON.stringify(rows.map(r => [r.owner_phone, r.state, r.reason])))
  assert.match(cb.rendered_text, /^Good morning, /)
  assert.match(cb.rendered_text, /Kevin/); assert.ok(!/Gabriela|Cedric/.test(cb.rendered_text))
  assert.ok(!/\{\{/.test(cb.rendered_text))
  const up = sent.find(r => r.owner_phone === owners['Upcoming Owner'].phone)
  assert.ok(up && /Gabriela/.test(up.rendered_text) && /3-Bedroom Apartment in G(z|ż)ira/.test(up.rendered_text), up && up.rendered_text)
  assert.equal(up.session_name, 'Gabriela')
  // an owner-requested callback date is kept even though we wrote 2 days ago (no 4-day cadence override)
  const recent = rows.find(r => r.owner_phone === owners['Recent Owner'].phone)
  assert.equal(recent.state, 'sent', `${recent.state}:${recent.reason}`)
  const dnc = rows.find(r => r.owner_phone === '35679000004')
  assert.match(`${dnc.state}:${dnc.reason}`, /skipped:owner_gate:dnc/)
  assert.ok(!wire.some(w => w.phone.endsWith('79000004')), 'opted-out owner was messaged')
  // exactly one message per owner phone
  const perPhone = {}; for (const w of wire) perPhone[w.phone] = (perPhone[w.phone] || 0) + 1
  assert.ok(Object.values(perPhone).every(n => n === 1), JSON.stringify(perPhone))
  // reminders closed, the second reminder of the double owner covered by the same message
  const dbl = (await pool.query(`SELECT status, notes FROM reminders WHERE owner_phone=$1 AND contact_due_date=$2`, [owners['Double Owner'].phone, DEC7])).rows
  assert.ok(dbl.every(r => r.status === 'contacted'), JSON.stringify(dbl))
  // the report shows every reminder with its result
  const rep = await daily.report(DEC7)
  assert.equal(rep.rows.length, rows.length)
  assert.ok(rep.summary.sent >= 3 && rep.summary.skipped >= 4)
})

test('P0-A · greeting follows the sending time (afternoon); WAHA down → retried, then sent; transport timeout → ambiguous, never repeated', async () => {
  const D = '2026-12-08'
  const g = await owner('Afternoon Owner', '35679000011')
  const h = await owner('Timeout Owner', '35679000012')
  await reminder(g.phone, 'get back to me on Tuesday please', D, { timing: 'Tuesday' })
  await reminder(h.phone, 'call me in December', D, { timing: 'December' })
  session.status = 'FAILED'
  await daily.planDay(malta(D, '14:58'))
  await daily.tick(malta(D, '15:00'), { limit: 5 }); await daily.tick(malta(D, '15:05'), { limit: 5 })
  const mine = `SELECT * FROM reminder_dispatches WHERE run_date=$1 AND owner_phone IN ('35679000011','35679000012') ORDER BY id`
  let rows = (await pool.query(mine, [D])).rows
  assert.ok(rows.every(r => r.state === 'planned' && /sender_offline/.test(r.reason || '')), JSON.stringify(rows.map(r => [r.state, r.reason])))
  session.status = 'WORKING'
  const before = wire.length
  session.failNext = Object.assign(new Error('ETIMEDOUT while sending'), { code: 'ETIMEDOUT' })
  for (const m of ['15:20', '15:30', '15:40']) await daily.tick(malta(D, m), { limit: 1 })
  rows = (await pool.query(mine, [D])).rows
  const states = rows.map(r => r.state).sort()
  assert.deepEqual(states, ['ambiguous', 'sent'], JSON.stringify(rows.map(r => [r.state, r.reason])))
  const okRow = rows.find(r => r.state === 'sent')
  assert.match(okRow.rendered_text, /^Good afternoon, /)
  assert.equal(wire.length - before, 1)
  // an ambiguous send is never repeated, even on later ticks
  for (const m of ['16:00', '16:30']) await daily.tick(malta(D, m), { limit: 5 })
  assert.equal(wire.length - before, 1)
})

test('P0-A · worker restart while sending → ambiguous, not sent twice; duplicate run of the day does nothing', async () => {
  const D = '2026-12-09'
  const k = await owner('Restart Owner', '35679000021')
  const id = await reminder(k.phone, 'contact me in December', D, { timing: 'December' })
  await daily.planDay(malta(D, '09:00'))
  await pool.query(`UPDATE reminder_dispatches SET state='sending', sending_at=$2 WHERE reminder_id=$1`, [id, malta(D, '09:01')])
  const n = wire.length
  await daily.tick(malta(D, '09:10'))
  const row = (await pool.query(`SELECT state, reason FROM reminder_dispatches WHERE reminder_id=$1`, [id])).rows[0]
  assert.deepEqual(row, { state: 'ambiguous', reason: 'worker_restarted_during_send' })
  const again = await daily.planDay(malta(D, '09:30'))
  assert.equal(again.planned.length + again.waiting.length + again.skipped.length, 0)
  assert.equal(wire.length, n)
})

test('P0-B · "No" replies: processed ones leave the inbox, actionable ones stay, opt-out cancels, a newer message wins', async () => {
  const ask = async phone => pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,'Kevsecond','Is it still available?', NOW() - interval '2 days')`, [phone])
  const o1 = await owner('Quiet Owner', '35679000031'); await ask(o1.phone)
  let r = await inbox.handle({ session: 'Kevsecond', chatId: `${o1.phone}@c.us`, phone: o1.phone, text: 'No, nothing available', messageId: 'm1' })
  assert.equal(r.action, 'marked_read'); assert.ok(seen.some(s => s.chatId === `${o1.phone}@c.us`))

  const o2 = await owner('Unasked Owner', '35679000032')
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o2.phone}@c.us`, phone: o2.phone, text: 'No', messageId: 'm2' })
  assert.equal(r.action, 'kept'); assert.equal(r.why, 'no_preceding_question')

  const o3 = await owner('January Owner', '35679000033'); await ask(o3.phone)
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o3.phone}@c.us`, phone: o3.phone, text: 'No, contact me in January', messageId: 'm3', receivedAt: new Date() })
  assert.equal(r.action, 'marked_read', JSON.stringify(r)); assert.ok(r.reminderId)
  const rem = (await pool.query(`SELECT contact_due_date::text d, status FROM reminders WHERE id=$1`, [r.reminderId])).rows[0]
  assert.equal(rem.status, 'pending'); assert.match(rem.d, /^2027-01|^2026-12/)

  const o4 = await owner('Other Flat Owner', '35679000034'); await ask(o4.phone)
  const seenBefore = seen.length
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o4.phone}@c.us`, phone: o4.phone, text: 'No, but I have another apartment', messageId: 'm4' })
  assert.equal(r.action, 'kept'); assert.equal(seen.length, seenBefore)

  const o5 = await owner('Stop Owner', '35679000035'); await ask(o5.phone)
  const pendingId = await reminder(o5.phone, 'call me in March', '2027-03-01')
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o5.phone}@c.us`, phone: o5.phone, text: 'Stop contacting me', messageId: 'm5' })
  assert.equal(r.action, 'kept'); assert.equal(r.why, 'opt_out_not_recorded')
  await pool.query(`UPDATE owner_contacts SET do_not_contact=TRUE WHERE id=$1`, [o5.id])
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o5.phone}@c.us`, phone: o5.phone, text: 'Stop contacting me', messageId: 'm5' })
  assert.equal(r.action, 'marked_read')
  assert.equal((await pool.query(`SELECT status FROM reminders WHERE id=$1`, [pendingId])).rows[0].status, 'cancelled')

  const o6 = await owner('Two Messages Owner', '35679000036'); await ask(o6.phone)
  await require(R('redis.js')).set(`inbox:last:kevsecond:${o6.phone.slice(-9)}`, 'm7-newer')
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o6.phone}@c.us`, phone: o6.phone, text: 'No', messageId: 'm6' })
  assert.equal(r.action, 'kept'); assert.equal(r.why, 'newer_message')

  const audit = (await pool.query(`SELECT action, COUNT(*)::int n FROM owner_inbox_dispositions GROUP BY 1`)).rows
  assert.ok(audit.length >= 4, JSON.stringify(audit))
  // the stay-read key protects the chat from a later "mark unread"
  assert.equal(await require(R('redis.js')).get(`recheck7d:quiet:kevsecond:${o1.phone.slice(-9)}`), '1')
})

test('P0-B · owner answers "No" to "is it still available?": not_available (not rented), no thank-you text; explicit "rented" still goes to Rented?', async () => {
  const queued = []
  stub('services/humanDelay.js', new Proxy({ queueOwnerMessage: async m => { queued.push(m) } }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => null) }))
  const av = require(R('services/availability.js'))
  const o = await owner('Availability Owner', '35679000041')
  const mk = async (ref, reply, msgId) => {
    const p = (await pool.query(`INSERT INTO properties (ref, town, property_type, owner_id, available_status, published) VALUES ($1,'Sliema','apartment',$2,'available',TRUE) RETURNING id`, [ref, o.id])).rows[0]
    const c = (await pool.query(
      `INSERT INTO availability_checks (property_id, owner_id, status, reply_text, reply_message_id, owner_chat_id, account_session)
       VALUES ($1,$2,'replied_no',$3,$4,$5,'Kevsecond') RETURNING *`, [p.id, o.id, reply, msgId, `${o.phone}@c.us`])).rows[0]
    return { p, c: { ...c, ref, available_status: 'available' } }
  }
  const a = await mk('T-1', 'No', 'msgA')
  const ra = await av.__onRented(a.c, { ownerSession: 'Kevsecond', ownerChat: `${o.phone}@c.us`, replyMsgId: 'msgA' })
  assert.equal(ra.notAvailable, true)
  assert.equal((await pool.query(`SELECT available_status FROM properties WHERE id=$1`, [a.p.id])).rows[0].available_status, 'not_available')
  const b = await mk('T-2', 'It is rented, sorry', 'msgB')
  await av.__onRented(b.c, { ownerSession: 'Kevsecond', ownerChat: `${o.phone}@c.us`, replyMsgId: 'msgB' })
  assert.equal((await pool.query(`SELECT available_status FROM properties WHERE id=$1`, [b.p.id])).rows[0].available_status, 'pending_check')
  assert.equal(queued.filter(m => /thank/i.test(m.text || '')).length, 0, JSON.stringify(queued))
})


test('Update 3 · context-specific "No", one decision per turn, read after save, callback pause, manual pause, approval checks, canary isolation', async () => {
  const av = require(R('services/availability.js'))
  const c = t => av.classifyReply(t).status
  assert.equal(c('No'), 'replied_no')
  assert.equal(c('No sorry, not at the moment'), 'replied_no')
  assert.equal(c('No, this apartment is unavailable'), 'replied_no')
  assert.equal(c('No, nothing else available'), 'replied_other')
  assert.equal(c('Yes still available'), 'replied_available')
  const scope = require(R('services/ownerScopeReply.js')).classifyOwnerScope
  assert.equal(scope('No, nothing else available').scope, null)
  assert.equal(scope('No, nothing available at the moment').scope, 'owner_all_unavailable')
  assert.equal(inbox.decide('No, nothing else available').kind, 'quiet_no')

  // one decision per turn
  const o = await owner('Turn Owner', '35679000051')
  await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,'Kevsecond','Is it still available?', NOW() - interval '1 day')`, [o.phone])
  assert.equal((await inbox.finalTurn({ phone: o.phone, session: 'Kevsecond', text: 'No' })).final, true)
  assert.equal((await inbox.finalTurn({ phone: o.phone, session: 'Kevsecond', text: 'No, but I have another apartment in Msida' })).final, false)
  assert.equal((await inbox.finalTurn({ phone: '35679000052', session: 'Kevsecond', text: 'No' })).final, false)

  // read only after the answer is saved
  const p = (await pool.query(`INSERT INTO properties (ref, town, property_type, owner_id, available_status, published) VALUES ('T-9','Sliema','apartment',$1,'available',TRUE) RETURNING id`, [o.id])).rows[0]
  const chk = (await pool.query(`INSERT INTO availability_checks (property_id, owner_id, status, owner_chat_id, account_session, created_at) VALUES ($1,$2,'awaiting',$3,'Kevsecond', NOW() - interval '1 hour') RETURNING id`, [p.id, o.id, `${o.phone}@c.us`])).rows[0]
  let r = await inbox.handle({ session: 'Kevsecond', chatId: `${o.phone}@c.us`, phone: o.phone, text: 'No', messageId: 't1', receivedAt: new Date() })
  assert.equal(r.why, 'answer_not_saved')
  await pool.query(`UPDATE availability_checks SET status='replied_no', reply_at=NOW() WHERE id=$1`, [chk.id])
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${o.phone}@c.us`, phone: o.phone, text: 'No', messageId: 't1', receivedAt: new Date() })
  assert.equal(r.action, 'marked_read')

  // callback date holds the other automations until that date
  const cb = await owner('Pause Owner', '35679000053')
  await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,'Kevsecond','Is it still available?', NOW() - interval '1 day')`, [cb.phone])
  r = await inbox.handle({ session: 'Kevsecond', chatId: `${cb.phone}@c.us`, phone: cb.phone, text: 'No, contact me in February', messageId: 't2', receivedAt: new Date() })
  assert.equal(r.action, 'marked_read')
  const due = (await pool.query(`SELECT contact_due_date::text d FROM reminders WHERE id=$1`, [r.reminderId])).rows[0].d
  const until = (await pool.query(`SELECT owner_contact_paused_until::text u FROM owner_contacts WHERE id=$1`, [cb.id])).rows[0].u
  assert.equal(until, due)
  const gate = await require(R('services/ownerSendGate.js')).checkOwnerSend({ phone: cb.phone, kind: 'availability', automated: true })
  assert.equal(gate.allow, false); assert.match(gate.reason, /owner_contact_paused/)

  // a reminder a person paused stays paused; a same-day earlier message defers a callback
  const D = '2026-12-10'
  const mp = await owner('Manual Pause Owner', '35679000054')
  const id1 = await reminder(mp.phone, 'please contact me in December', D, { timing: 'December', status: 'paused_manual' })
  const sd = await owner('Same Day Owner', '35679000055')
  const id2 = await reminder(sd.phone, 'please contact me in December', D, { timing: 'December' })
  await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,'Kevsecond','x', $2)`, [sd.phone, malta(D, '08:40')])
  await daily.planDay(malta(D, '09:00'))
  for (const m of ['09:10', '09:20', '09:30', '09:40']) await daily.tick(malta(D, m), { limit: 5 })
  const st = Object.fromEntries((await pool.query(`SELECT reminder_id, state, reason FROM reminder_dispatches WHERE reminder_id = ANY($1::int[])`, [[id1, id2]])).rows.map(x => [x.reminder_id, `${x.state}:${x.reason}`]))
  assert.equal(st[id1], 'skipped:paused_by_hand')
  assert.match(st[id2], /^waiting:owner_already_contacted_today/)

  // approval refuses a text that signs as somebody else; canary texts are never picked for owners
  const bad = (await pool.query(`INSERT INTO outreach_library_templates (persona, number, body, intent, review_status, code) VALUES ('gabriela', 480, $1, 'owner_requested_callback', 'pending_review', 'ARGUS-TEST-BAD-01') RETURNING id`,
    ['{{opening}}I hope you are well. Following up as agreed about your property.\n\nKevin Eich'])).rows[0].id
  await assert.rejects(lib.setReview([bad], 'approved', 'test'), /invalid_template|cannot approve/)
  await pool.query(`INSERT INTO outreach_library_templates (persona, number, body, intent, review_status, code) VALUES ('cedric', 481, $1, 'owner_requested_callback', 'approved', 'ARGUS-CANARY-CEDRIC-01')`,
    ['{{opening}}ARGUS CANARY self-check, please ignore.\n\nCedric'])
  for (let i = 0; i < 20; i++) await assert.rejects(lib.pick('cedric', { intent: 'owner_requested_callback' }), /no approved/)
  assert.match((await lib.pick('cedric', { intent: 'owner_requested_callback', allowCanary: true })).body, /CANARY/)
})


test('Update 4 · the four real conversations, one reply per owner turn, recheck timing, 21-day cadence, callback priority, preview, backlog', async () => {
  // regression cases from Kev's screenshots (21 Nov)
  const d = t => inbox.decide(t).kind
  assert.equal(d("I'm sorry I have nothing available at the moment, thank you for asking"), 'quiet_no')       // Andrew Zammit
  assert.equal(d('There is nothing available atm'), 'quiet_no')                                             // Barbara
  assert.equal(d('As I said we have some just one bedroom, going from 3 to 4. But all are taken.'), 'quiet_no') // Barbara
  assert.equal(d('Good morning. Thank you Keith, I will when we have something available'), 'owner_will_update') // Barbara
  assert.equal(d('Welcome'), 'closing')                                                                      // Andrew Zammit
  assert.equal(d('Not at the moment but I might have something in February'), 'future_availability')
  assert.equal(d('No, but I have another apartment'), 'other_property')
  assert.equal(d('I am looking for a family. or maybe 4 sharing over 35 of age'), 'not_negative')           // Raymond: real information
  assert.equal(d('Who is this?'), 'actionable')

  // one owner turn -> at most one automated reply; a final turn -> none; a person is never blocked
  const guard = require(R('services/ownerTurnGuard.js'))
  const bot = { automated: true, module: 'autoOwnerConversation' }, av2 = { automated: true, module: 'availability' }, human = { automated: false, module: 'person_or_route' }
  const chat = '35679000061@c.us'
  await guard.noteInbound({ session: 'Argus2', phone: '35679000061', chatId: chat, final: true })
  assert.equal((await guard.check('Argus2', chat, 'No worries, thank you for your feedback', { caller: bot })).reason, 'owner_turn_final')
  assert.equal((await guard.check('Argus2', chat, 'Ok, thank you, noted. I will not ask again', { caller: av2 })).allow, false)
  assert.equal((await guard.check('Argus2', chat, 'Kev typing in the CRM', { caller: human })).allow, true)
  assert.equal(await guard.reactionAllowed('Argus2', 'false_35679000061@c.us_ABC'), false)
  await new Promise(r => setTimeout(r, 10))
  await guard.noteInbound({ session: 'Argus2', phone: '35679000061', chatId: chat, final: false, at: Date.now() + 5 })
  await new Promise(r => setTimeout(r, 10))
  assert.equal((await guard.check('Argus2', chat, 'first answer', { caller: av2 })).allow, true)
  await guard.noteSent('Argus2', chat)
  assert.equal((await guard.check('Argus2', chat, 'second answer from another module', { caller: bot })).reason, 'already_replied_this_turn')

  // weekly recheck: "yes" written before the viewings question went out is NOT its answer (Raymond)
  const r7 = require(R('services/ownerRecheck7d.js'))
  await r7.ensureSchema()
  const ro = await owner('Raymond Regression', '35679000062')
  const th = (await pool.query(`INSERT INTO owner_recheck_threads (owner_id, session, chat_id, stage, property_ids, step_at, sent_at) VALUES ($1,'Kevsecond',$2,'asked_viewings','{}', NOW() + interval '60 seconds', NOW()) RETURNING id`, [ro.id, `${ro.phone}@c.us`])).rows[0].id
  const res = await r7.handleInbound({ payload: { id: 'r1', fromMe: false }, session: 'Kevsecond', text: 'yes', senderPhone: ro.phone, chatId: `${ro.phone}@c.us` })
  assert.equal(res.reason, 'before_question_sent')
  assert.equal((await pool.query(`SELECT stage FROM owner_recheck_threads WHERE id=$1`, [th])).rows[0].stage, 'asked_viewings')

  // 21-day no-stock cadence: a paused owner is not eligible for outreach from ANY account
  assert.equal(require(R('services/ownerScopeReply.js')).PAUSE_DAYS, 21)
  const acc = (await pool.query(`SELECT id FROM whatsapp_accounts WHERE session_name='Kevsecond'`)).rows[0].id
  await pool.query(`UPDATE owner_contacts SET owner_contact_paused_until = CURRENT_DATE + 21 WHERE id=$1`, [ro.id])
  const cc = await require(R('services/cooldownRules.js')).canContact(ro.id, acc)
  assert.equal(cc.allowed, false); assert.match(cc.reason, /owner_paused_until/)

  // "might have something in February": follow-up about 3 weeks before February, month kept, no invented day
  const fo = await owner('February Owner', '35679000063')
  await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,'Kevsecond','x', NOW() - interval '1 day')`, [fo.phone])
  const fr = await inbox.handle({ session: 'Kevsecond', chatId: `${fo.phone}@c.us`, phone: fo.phone, text: 'Not at the moment but I might have something in February', messageId: 'f1', receivedAt: new Date() })
  assert.equal(fr.action, 'marked_read', JSON.stringify(fr))
  const rem = (await pool.query(`SELECT contact_due_date::text d, parsed_timing FROM reminders WHERE id=$1`, [fr.reminderId])).rows[0]
  assert.equal(rem.parsed_timing, 'in February')
  assert.ok(rem.d < '2027-02-01' && rem.d >= '2027-01-01', rem.d)
  assert.equal((await pool.query(`SELECT owner_contact_paused_until::text u FROM owner_contacts WHERE id=$1`, [fo.id])).rows[0].u, rem.d)

  // an owner-requested callback wins over a no-stock pause; an upcoming follow-up does not
  const D = '2026-12-11'
  const cbo = await owner('Callback Paused Owner', '35679000064')
  const upo = await owner('Upcoming Paused Owner', '35679000065')
  await pool.query(`UPDATE owner_contacts SET owner_contact_paused_until = '2026-12-31' WHERE id = ANY($1::int[])`, [[cbo.id, upo.id]])
  const c1 = await reminder(cbo.phone, 'please contact me in December', D, { timing: 'December' })
  const c2 = await reminder(upo.phone, 'the 2 bedroom flat in Sliema will be available in December', D, { timing: 'December' })
  const pv = await daily.preview(D)
  assert.ok([...pv.planned, ...pv.waiting].some(x => x.id === c1), JSON.stringify(pv).slice(0, 300))
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM reminder_dispatches WHERE run_date=$1`, [D])).rows[0].n, 0, 'preview wrote records')
  await daily.planDay(malta(D, '09:00'))
  for (const m of ['09:10', '09:20', '09:30', '09:40']) await daily.tick(malta(D, m), { limit: 5 })
  const st = Object.fromEntries((await pool.query(`SELECT reminder_id, state, reason FROM reminder_dispatches WHERE reminder_id = ANY($1::int[])`, [[c1, c2]])).rows.map(x => [x.reminder_id, `${x.state}:${x.reason}`]))
  assert.match(st[c1], /^sent:/)
  assert.match(st[c2], /^skipped:owner_gate:owner_contact_paused/)

  // backlog report is read-only and explains every inactive reminder
  const before = (await pool.query(`SELECT md5(string_agg(id||status||auto_send_status, ',' ORDER BY id)) h FROM reminders`)).rows[0].h
  const bl = await require(R('services/reminderBacklog.js')).report()
  assert.ok(bl.total >= 1 && bl.categories.length >= 1, JSON.stringify(bl).slice(0, 200))
  assert.equal((await pool.query(`SELECT md5(string_agg(id||status||auto_send_status, ',' ORDER BY id)) h FROM reminders`)).rows[0].h, before)
})


test('Update 5 · real owner replies of 21 Nov read correctly', async () => {
  const cases = [
    ['Hi at this moment i dont have thanks gd', 'quiet_no'],
    ["It's not anymore", 'quiet_no'],
    ['Hi Gabriela. Nothing at the moment.', 'quiet_no'],
    ["Hi Gabriela, Unfortunately I don't . all rented. Thanks and have a good weekend", 'quiet_no'],
    ['Sorry, fully booked', 'quiet_no'],
    ['Sorry I have no properties.', 'quiet_no'],
    ['No, nothing available at the moment', 'quiet_no'],
    ['Hi Gabriela, I have an apt. In Mercury tower availible for rent', 'other_property'],
    ['Hello As from 1/1/27 I have one bedroom for 1 person available in a flat of 150m2 to rent', 'other_property'],
    ['They all love it but none give me my price . I will wait for the right client with no pets', 'actionable'],
    ["The price I repeat is not negotiable . It's been rented for 1800 for 2 years . If I don't", 'not_negative'],
    ['Hi Which company do you work for please as you forgot to mention ?', 'actionable'],
    ["No it's 1,550", 'not_negative'],
  ]
  for (const [text, want] of cases) assert.equal(inbox.decide(text).kind, want, text)
})
