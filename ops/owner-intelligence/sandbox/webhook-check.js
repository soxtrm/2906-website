// Runs INSIDE argus-sandbox-api (internal network only). Drives the real HTTP
// routes of the sandbox backend; synthetic owner numbers; WAHA unreachable.
const fs = require('fs')
const { Pool } = require('pg')
const tokens = Object.fromEntries(fs.readFileSync('/tmp/tokens.txt', 'utf8').trim().split('\n').map(l => l.split(' ')))
const db = new Pool({ host: 'argus-outreach-testdb', user: 'test', password: 'test', database: 'argus_test' })
const API = 'http://127.0.0.1:3001'
const api = (path, token, opts = {}) => fetch(`${API}${path}`, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) } })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))
const hook = payload => fetch(`${API}/webhook/waha`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.status)
const sleep = ms => new Promise(r => setTimeout(r, ms))
// The sandbox is slow (crons wait on the unreachable WAHA); poll instead of guessing.
async function until(sql, pred, ms = 30000) {
  const t0 = Date.now()
  let row
  while (Date.now() - t0 < ms) { row = (await db.query(sql)).rows[0]; if (pred(row)) return row; await sleep(500) }
  return row
}
const out = []
const check = (name, ok, detail = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)

;(async () => {
  // 1. warning before anything was requested
  let w = await api('/api/crm/schedule-board/location-attention', tokens['sandbox-jason'])
  check('viewing without address shows a warning for Jason', w.status === 200 && w.body.warnings.some(x => x.ref === '2906-S001'), JSON.stringify(w.body?.warnings?.map(x => [x.ref, x.urgency])))

  // 2. Ask for Location through the real route: WAHA unreachable → Failed, never Sent
  const r1 = await api('/api/crm/schedule-board/listings/2906-S001/request-location', tokens['sandbox-jason'], { method: 'POST', body: '{}' })
  check('request through the real route is persisted and shown as Failed (no WhatsApp in sandbox), not Sent',
    r1.body?.request?.status === 'failed' && !r1.body.request.sentAt, `${r1.status} ${r1.body?.request?.status} ${r1.body?.request?.error}`)
  const again = await api('/api/crm/schedule-board/listings/2906-S001/location-request', tokens['sandbox-jason'])
  check('status survives a reload (GET)', again.body?.request?.status === 'failed')

  // 3. controlled fixture: a request that WAS sent and awaits the owner
  await db.query(`UPDATE property_location_requests SET status='awaiting_owner', sent_at=NOW(), error=NULL, session_name='Kevsecond', owner_chat_id='35699000101@c.us' WHERE ref='2906-S001'`)

  // 4. vague reply via the real webhook → request stays open, reply recorded
  const ts = Math.floor(Date.now() / 1000)
  let st = await hook({ event: 'message', session: 'Kevsecond', payload: { id: `false_35699000101@c.us_SBX${ts}A`, from: '35699000101@c.us', fromMe: false, body: 'It is near the church, you will see it', timestamp: ts } })
  let row = await until(`SELECT status, last_owner_reply_text FROM property_location_requests WHERE ref='2906-S001'`, r => /church/.test(r?.last_owner_reply_text || ''))
  check('vague reply → still awaiting owner, reply recorded', row.status === 'awaiting_owner' && /church/.test(row.last_owner_reply_text || ''), `webhook ${st} ${row.status}`)

  // 5. location pin via the real webhook (no text body)
  st = await hook({ event: 'message', session: 'Kevsecond', payload: { id: `false_35699000101@c.us_SBX${ts}B`, from: '35699000101@c.us', fromMe: false, body: '', type: 'location', location: { latitude: 35.9187, longitude: 14.4893 }, timestamp: ts + 5 } })
  row = await until(`SELECT status, answer_kind, answer_message_id, latitude, notified_at FROM property_location_requests WHERE ref='2906-S001'`, r => r?.status === 'agent_notified')
  check('pin through the webhook → linked to the request, agent notified', row.status === 'agent_notified' && row.answer_kind === 'pin', `webhook ${st} ${JSON.stringify(row)}`)
  const n = (await db.query(`SELECT n.kind FROM agent_listing_notifications n JOIN agents a ON a.id=n.agent_id WHERE a.username='sandbox-jason'`)).rows.map(x => x.kind)
  check('in-app notification for Jason', n.includes('location_received'), JSON.stringify(n))

  // 6. the same webhook event again → no second processing
  st = await hook({ event: 'message', session: 'Kevsecond', payload: { id: `false_35699000101@c.us_SBX${ts}B`, from: '35699000101@c.us', fromMe: false, body: '', type: 'location', location: { latitude: 1, longitude: 1 }, timestamp: ts + 5 } })
  await sleep(8000)
  row = (await db.query(`SELECT latitude FROM property_location_requests WHERE ref='2906-S001'`)).rows[0]
  check('duplicate webhook delivery changes nothing', Number(row.latitude) === 35.9187)

  // 7. visibility: Jason (viewing) sees the location; an unrelated agent does not
  const j = await api('/api/crm/schedule-board/listings/2906-S001/location-request', tokens['sandbox-jason'])
  const l = await api('/api/crm/schedule-board/listings/2906-S001/location-request', tokens['sandbox-lister'])
  check('viewing agent sees the map link', !!j.body?.request?.location?.mapsUrl)
  check('listing agent sees it too', !!l.body?.request?.location?.mapsUrl)
  w = await api('/api/crm/schedule-board/location-attention', tokens['sandbox-jason'])
  check('viewing warning resolved', !w.body.warnings.some(x => x.ref === '2906-S001'))

  // 8. owner attribution via the real owners route
  const o = await api('/api/crm/owners?search=Sandbox', tokens['sandbox-admin'])
  const one = (o.body?.owners || []).find(x => x.name === 'Sandbox Owner One')
  check('owners list: contacted by Cedric, last message by Kevin, reply needed',
    one?.attribution?.contactedBy?.person === 'Cedric' && one?.attribution?.lastMessageBy?.person === 'Kevin' && one?.attribution?.status === 'agent_action_needed',
    JSON.stringify(one?.attribution && { c: one.attribution.contactedBy, l: one.attribution.lastMessageBy, s: one.attribution.status }))

  // 9. nothing left the sandbox
  const sent = (await db.query(`SELECT COUNT(*)::int n FROM outreach_log WHERE right(phone,7) IN ('9000101','9000102')`)).rows[0].n
  check('no outreach rows for the fixture owners', sent === 0)
  console.log(out.join('\n'))
  await db.end()
})().catch(e => { console.error('ERROR', e); process.exit(1) })
