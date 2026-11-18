'use strict'
// End-to-end run of the weekly recheck on a THROW-AWAY copy of the ARGUS database.
// Real modules (patched availability.js, waha.js, ownerRecheck7d.js), synthetic owners,
// a stub WhatsApp server that records every send. Nothing leaves this container.
const http = require('http')
const assert = require('assert')

const sent = []           // every WAHA call
const queued = []         // humanDelay.queueOwnerMessage calls
const SESSIONS = [{ name: 'Kevsecond', status: 'WORKING' }, { name: 'kevthirdd', status: 'WORKING' }, { name: 'Argus4', status: 'FAILED' }, { name: 'Cedric', status: 'WORKING' }]
const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    let json = null; try { json = body ? JSON.parse(body) : null } catch {}
    sent.push({ method: req.method, url: req.url, body: json })
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/api/sessions')) return res.end(JSON.stringify(SESSIONS))
    if (/\/api\/[^/]+\/chats\/[^/]+\/messages/.test(req.url)) return res.end('[]')
    if (req.url.startsWith('/api/sendText')) return res.end(JSON.stringify({ id: `stub-${sent.length}` }))
    return res.end('{}')
  })
})

let pass = 0, fail = 0
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }

;(async () => {
  await new Promise(r => stub.listen(3999, r))
  const db = require('/app/db')
  const redis = require('/app/redis')
  const humanDelay = require('/app/services/humanDelay')
  humanDelay.queueOwnerMessage = async (o) => { queued.push(o); return { queued: true, delayMs: 0 } }
  const av = require('/app/services/availability')
  const waha = require('/app/waha')
  const R = require('/app/services/ownerRecheck7d')
  await R.ensureSchema()

  // ── synthetic data ──────────────────────────────────────────────────────
  await db.query(`UPDATE reachout_settings SET daily_cap=50 WHERE id=1`)
  await db.query(`UPDATE whatsapp_accounts SET is_active=true WHERE LOWER(session_name) IN ('kevsecond','kevthirdd','argus4','cedric')`)
  // keep every real owner out of this run: only synthetic ones are "overdue enough"
  await db.query(`UPDATE properties SET last_confirmed_available_at = NOW() WHERE published`)
  const mkOwner = async (phone, name) => (await db.query(
    `INSERT INTO owner_contacts(phone_normalized,name,source,created_at,updated_at) VALUES($1,$2,'test',NOW(),NOW()) RETURNING id`, [phone, name])).rows[0].id
  const mkProp = async (ownerId, ref, town, beds, price) => (await db.query(
    `INSERT INTO properties(ref,owner_id,town,bedrooms,longlet_price,property_type,available_status,published,system_online,last_confirmed_available_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'apartment','available',TRUE,TRUE,NOW() - INTERVAL '400 days',NOW() - INTERVAL '500 days',NOW()) RETURNING id`,
    [ref, ownerId, town, beds, price])).rows[0].id
  const A = await mkOwner('999900000001', 'Test Single'); const pA = await mkProp(A, '2906-T001', 'Gzira', 2, 1500)
  await db.query(`INSERT INTO owner_account_labels(contact_id,account_session,label,source,last_reply_at,created_at,updated_at) VALUES($1,'Argus4','owner','manual',NOW()-INTERVAL '30 days',NOW(),NOW())`, [A])
  const B = await mkOwner('999900000002', 'Test Multi')
  const pB1 = await mkProp(B, '2906-T011', 'Swieqi', 2, 1600), pB2 = await mkProp(B, '2906-T012', "St Julian's", 3, 2200), pB3 = await mkProp(B, '2906-T013', 'Sliema', 1, 1100)
  await db.query(`INSERT INTO owner_account_labels(contact_id,account_session,label,source,last_reply_at,created_at,updated_at) VALUES($1,'Kevsecond','owner','manual',NOW()-INTERVAL '20 days',NOW(),NOW())`, [B])
  const C = await mkOwner('999900000003', 'Test Unclear')
  const pC1 = await mkProp(C, '2906-T021', 'Mosta', 2, 1200), pC2 = await mkProp(C, '2906-T022', 'Naxxar', 3, 1700)
  await db.query(`INSERT INTO owner_account_labels(contact_id,account_session,label,source,last_reply_at,created_at,updated_at) VALUES($1,'Cedric','owner','manual',NOW()-INTERVAL '20 days',NOW(),NOW())`, [C])

  const DM = async (phone, session, text, id) => av.handleWebhookMessage({
    payload: { id: id || `in-${Date.now()}-${Math.random()}`, fromMe: false, timestamp: Math.floor(Date.now() / 1000) },
    session, text, isGroup: false, chatId: `${phone}@c.us`, senderPhone: phone })
  const prop = async id => (await db.query('SELECT available_status, last_confirmed_available_at, longlet_price, internal_notes FROM properties WHERE id=$1', [id])).rows[0]
  const thread = async owner => (await db.query('SELECT * FROM owner_recheck_threads WHERE owner_id=$1 AND stage<>\'skipped\' ORDER BY id DESC LIMIT 1', [owner])).rows[0]
  const sends = () => sent.filter(s => s.url.startsWith('/api/sendText'))

  // 1. Sunday: nothing
  let r = await R.runScheduled({ dryRun: false, now: new Date('2026-11-22T11:00:00Z'), perPass: 5, pace: false })
  check('Sunday pass sends nothing', r.skipped === 'sunday' && sends().length === 0, JSON.stringify(r.skipped))
  // 2. Monday 11:00 Malta: one message per owner
  r = await R.runScheduled({ dryRun: false, now: new Date('2026-11-23T10:00:00Z'), force: true, perPass: 5, pace: false })
  const toA = sends().find(s => s.body.chatId.startsWith('999900000001')), toB = sends().find(s => s.body.chatId.startsWith('999900000002')), toC = sends().find(s => s.body.chatId.startsWith('999900000003'))
  check('3 synthetic owners asked, one message each', sends().length === 3 && toA && toB && toC, `sends=${sends().length} sent=${JSON.stringify(r.sent.map(x => x.ref))} refused=${JSON.stringify(r.refused.slice(0, 5))}`)
  check('owner A: old account Argus4 offline → sent from a working account', toA && toA.body.session !== 'Argus4', toA && toA.body.session)
  check('owner A: single text with town', toA && /property in Gzira/.test(toA.body.text) && /still available/.test(toA.body.text), toA && toA.body.text)
  check('owner B: one numbered list for 3 listings', toB && /which of your properties/.test(toB.body.text) && /1\. .*Swieqi/.test(toB.body.text) && /3\. .*Sliema/.test(toB.body.text), toB && toB.body.text.slice(0, 160))
  check('owner B: sent from his own account Kevsecond', toB && toB.body.session === 'Kevsecond')
  // 3. no second ask within the week
  const before = sends().length
  await R.runScheduled({ dryRun: false, now: new Date('2026-11-23T11:00:00Z'), force: true, perPass: 5, pace: false })
  check('second pass the same day asks nobody again', sends().length === before)

  // 4. owner A: yes → viewings → pitch → price
  const tA = await thread(A)
  await DM('999900000001', toA.body.session, 'Yes still available', 'a1')
  let pa = await prop(pA)
  check('A "yes" → confirmed today', pa.available_status === 'available_confirmed' && new Date(pa.last_confirmed_available_at) > new Date(Date.now() - 60000), JSON.stringify(pa))
  check('A asked about viewings', queued.some(q => q.text === R.VIEWINGS_TEXT), JSON.stringify(queued.map(q => q.label)))
  await DM('999900000001', toA.body.session, 'So many people honestly, its stressful', 'a2')
  check('A "so many" → pitch (many)', queued.some(q => q.text === R.PITCH_MANY))
  await DM('999900000001', toA.body.session, 'A working couple, 1800 per month', 'a3')
  pa = await prop(pA)
  check('A price updated 1500 → 1800', Number(pa.longlet_price) === 1800, String(pa.longlet_price))
  check('A wishes saved in notes', /working couple/.test(pa.internal_notes || ''))
  const tA2 = (await db.query('SELECT stage, outcome FROM owner_recheck_threads WHERE id=$1', [tA.id])).rows[0]
  check('A thread finished', tA2.stage === 'done_terms', JSON.stringify(tA2))

  // 5. owner B: "Zwicky available, St Julians rented"
  await DM('999900000002', 'Kevsecond', 'The one in Zwicky is still available, St Julians is rented', 'b1')
  const [b1, b2, b3] = [await prop(pB1), await prop(pB2), await prop(pB3)]
  check('B Swieqi confirmed', b1.available_status === 'available_confirmed', b1.available_status)
  check('B St Julian\'s rented (or rented review)', ['rented', 'possibly_rented', 'pending_check'].includes(b2.available_status), b2.available_status)
  check('B Sliema untouched, task for Kev', b3.available_status === 'available' && (await db.query(`SELECT 1 FROM owner_recheck_tasks WHERE source_type='owner_recheck_7d' AND property_id=$1`, [pB3])).rows.length === 1)

  // 6. owner C: "the blue one" → Kev decides
  await DM('999900000003', 'Cedric', 'the blue one is still available', 'c1')
  const tC = await thread(C)
  check('C unclear → needs Kev, nothing changed', tC.stage === 'needs_kev' && (await prop(pC1)).available_status === 'available' && (await prop(pC2)).available_status === 'available', tC.stage)

  // 7. quiet negative stays read; data keeps it unread
  const D = await mkOwner('999900000004', 'Test Quiet')
  await DM('999900000004', 'Kevsecond', 'No sorry Kevin', 'd1')
  sent.length = 0
  await waha.markChatUnread('Kevsecond', '999900000004')
  check('"No sorry Kevin" → chat marked read, not unread', sent.some(s => s.url.includes('sendSeen')) && !sent.some(s => s.url.includes('/unread')), JSON.stringify(sent.map(s => s.url)))
  await DM('999900000004', 'Kevsecond', 'No, but I have something in March', 'd2')
  sent.length = 0
  await waha.markChatUnread('Kevsecond', '999900000004')
  check('"No, but ... March" → stays unread for Kev', sent.some(s => s.url.includes('/unread')), JSON.stringify(sent.map(s => s.url)))

  // 8. implicit yes on a normal (agent) availability check
  const E = await mkOwner('999900000005', 'Test Implicit'); const pE = await mkProp(E, '2906-T031', 'Msida', 1, 950)
  await db.query(`INSERT INTO owner_account_labels(contact_id,account_session,label,source,last_reply_at,created_at,updated_at) VALUES($1,'Kevsecond','owner','manual',NOW(),NOW(),NOW())`, [E])
  await db.query(`INSERT INTO availability_checks(property_id,owner_id,account_session,owner_chat_id,sent_at,status,source) VALUES($1,$2,'Kevsecond','999900000005@c.us',NOW()-INTERVAL '1 hour','awaiting','manual')`, [pE, E])
  await DM('999900000005', 'Kevsecond', 'Pets are fine, max 2 people. When would they like to move in and how long would they stay?', 'e1')
  check('answer without "rented" → confirmed available', (await prop(pE)).available_status === 'available_confirmed', (await prop(pE)).available_status)

  // 9. owner answering an agent's board question
  const F = await mkOwner('999900000006', 'Test Question'); const pF = await mkProp(F, '2906-T041', 'Pieta', 2, 1300)
  await db.query(`INSERT INTO owner_contact_log(owner_contact_id,owner_phone,property_id,ref,kind,status,body,scheduled_for,malta_day,created_at)
                  VALUES($1,'999900000006',$2,'2906-T041','question','sent','Are pets allowed?',NOW()-INTERVAL '3 hours',CURRENT_DATE,NOW()-INTERVAL '3 hours')`, [F, pF])
  await DM('999900000006', 'Kevsecond', 'Yes a small dog is ok', 'f1')
  check('answer to agent question → confirmed available', (await prop(pF)).available_status === 'available_confirmed', (await prop(pF)).available_status)

  console.log(`\n${pass}/${pass + fail} passed`)
  console.log('\n--- messages the stub received ---')
  for (const s of [toA, toB, toC]) if (s) console.log(`[${s.body.session}] ${s.body.text}\n`)
  console.log('--- queued replies ---'); for (const q of queued) console.log(`[${q.label}] ${q.text || '(reaction)'}`)
  await redis.quit().catch(() => {})
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
