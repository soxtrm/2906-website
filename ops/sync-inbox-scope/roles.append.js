
// ── 2026-11-20: who may see which owner conversation ──────────────────────────────────────────────────────
// Appended to the SYNC account suite: same throwaway database, same synthetic owner. Agent 6 is responsible
// for T-100, agent 5 for nothing (later for T-200), agent 9 has NEXUS owner controls.
const tokFor = (id, username, extra = {}) => jwt.sign({ id, username, role: 'agent', aud: 'crm', ...extra }, process.env.JWT_SECRET)
async function as(tok, method, p, body) {
  const res = await fetch(`${base}/api/crm/sync-inbox${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json, text }
}
let ownerEmail
test('roles: the inbox is closed to Board accounts, inactive agents and foreign tokens', async () => {
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES
    (5,'agent5','Agent Five','agent',true,false), (6,'agent6','Agent Six','agent',true,false), (7,'board7','Board Seven','board',true,true),
    (8,'gone8','Gone Eight','agent',false,false), (9,'agent9','Agent Nine','agent',true,false) ON CONFLICT DO NOTHING`)
  await pool.query(`UPDATE agents SET feature_entitlements = '{"nexus_owner_link": true}'::jsonb WHERE id = 9`)
  await pool.query(`UPDATE properties SET listed_by_agent_id = 6 WHERE id = $1`, [propertyId])
  ownerEmail = (await pool.query(`SELECT email FROM sync_accounts LIMIT 1`)).rows[0].email
  assert.equal((await as(tokFor(7, 'board7'), 'GET', '/threads')).status, 403)
  assert.equal((await as(tokFor(6, 'agent6', { aud: 'board' }), 'GET', '/threads')).status, 401, 'a Board login token of a CRM agent is refused')
  assert.equal((await as(tokFor(8, 'gone8'), 'GET', '/threads')).status, 401)
  assert.equal((await as(tokFor(6, 'someone-else'), 'GET', '/threads')).status, 401, 'token name must match the account')
  assert.equal((await as(jwt.sign({ id: 6, username: 'agent6', kind: 'owner_upload' }, process.env.JWT_SECRET), 'GET', '/threads')).status, 401)
  assert.equal((await as(jwt.sign({ id: 6, username: 'agent6', aud: 'crm' }, 'another-secret'), 'GET', '/threads')).status, 401)
  assert.equal((await as('', 'GET', '/summary')).status, 401)
})

test('roles: an agent without a listing of this owner sees nothing and cannot read or answer', async () => {
  const t5 = tokFor(5, 'agent5')
  const th = await as(t5, 'GET', '/threads')
  assert.equal(th.status, 200); assert.deepEqual(th.body.threads, [])
  assert.equal((await as(t5, 'GET', `/threads/${accountId}`)).status, 404)
  assert.equal((await as(t5, 'GET', `/threads/${accountId}/context`)).status, 404)
  const before = (await pool.query(`SELECT count(*)::int n FROM nexus_owner_messages`)).rows[0].n
  assert.equal((await as(t5, 'POST', `/threads/${accountId}/reply`, { text: 'hello' })).status, 404)
  assert.equal((await pool.query(`SELECT count(*)::int n FROM nexus_owner_messages`)).rows[0].n, before, 'nothing was stored')
  const sum = await as(t5, 'GET', '/summary')
  assert.deepEqual([sum.body.unread, sum.body.pendingClaims], [0, 0])
  assert.equal((await as(t5, 'POST', `/threads/${accountId}/claim`, { ownerId, decision: 'reject' })).status, 403)
  assert.equal((await pool.query(`SELECT link_state FROM nexus_owner_links WHERE owner_contact_id=$1`, [ownerId])).rows[0].link_state, 'verified', 'the link is untouched')
})

test('roles: the responsible agent reads and answers their owner, without the owner\'s e-mail or number', async () => {
  const t6 = tokFor(6, 'agent6')
  const th = await as(t6, 'GET', '/threads')
  assert.equal(th.body.threads.length, 1)
  assert.equal(th.body.threads[0].accountId, accountId); assert.equal(th.body.threads[0].email, null); assert.equal(th.body.threads[0].phone, null)
  const msgs = await as(t6, 'GET', `/threads/${accountId}`)
  assert.equal(msgs.status, 200); assert.ok(msgs.body.messages.length >= 2)
  assert.equal(msgs.body.account.email, null); assert.equal(msgs.body.account.phone, null)
  const ctx = await as(t6, 'GET', `/threads/${accountId}/context`)
  assert.equal(ctx.status, 200); assert.deepEqual(ctx.body.links[0].properties.map(p => p.ref), ['T-100'])
  for (const r of [th, msgs, ctx]) {
    assert.ok(!r.text.includes(OWNER_PHONE) && !r.text.includes(OWNER_PHONE.slice(-8)), 'no owner number anywhere in the answer')
    assert.ok(!ownerEmail || !r.text.includes(ownerEmail), 'no owner e-mail anywhere in the answer')
    assert.ok(!/password|hash|token|secret/i.test(r.text), 'no credential fields')
  }
  const reply = await as(t6, 'POST', `/threads/${accountId}/reply`, { text: 'I will call you about the keys.' })
  assert.equal(reply.status, 200)
  const last = (await pool.query(`SELECT direction, sender_kind, agent_id, sender_name, sender_org FROM nexus_owner_messages ORDER BY id DESC LIMIT 1`)).rows[0]
  assert.deepEqual([last.direction, last.sender_kind, last.agent_id, last.sender_name, last.sender_org], ['out', 'agent', 6, 'Agent Six', '2906 Real Estate'])
  assert.equal((await as(t6, 'POST', `/threads/${accountId}/claim`, { ownerId, decision: 'reject' })).status, 403, 'answering is not deciding claims')
})

test('roles: each agent sees only their own listing of a shared owner', async () => {
  const { rows: [p2] } = await pool.query(
    `INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, listed_by_agent_id) VALUES ('T-200','Gzira','Apartment',1300,1,1,$1,5) RETURNING id`, [ownerId])
  const { rows: [claim] } = await pool.query(`SELECT * FROM nexus_owner_property_claims WHERE property_id=$1 LIMIT 1`, [propertyId])
  const cols = Object.keys(claim).filter(k => k !== 'id')
  await pool.query(`INSERT INTO nexus_owner_property_claims (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`,
    cols.map(k => (k === 'property_id' ? p2.id : claim[k])))
  const c6 = await as(tokFor(6, 'agent6'), 'GET', `/threads/${accountId}/context`)
  assert.deepEqual(c6.body.links[0].properties.map(p => p.ref), ['T-100'])
  const c5 = await as(tokFor(5, 'agent5'), 'GET', `/threads/${accountId}/context`)
  assert.equal(c5.status, 200); assert.deepEqual(c5.body.links[0].properties.map(p => p.ref), ['T-200'])
  assert.equal((await as(tokFor(5, 'agent5'), 'GET', '/threads')).body.threads.length, 1)
})

test('roles: admins and agents with NEXUS owner controls keep the full inbox', async () => {
  for (const tok of [staffTok, tokFor(9, 'agent9')]) {
    const th = await as(tok, 'GET', '/threads')
    const t = th.body.threads.find(x => x.accountId === accountId)
    assert.equal(t.phone, `+${OWNER_PHONE}`)
    const ctx = await as(tok, 'GET', `/threads/${accountId}/context`)
    assert.deepEqual(ctx.body.links[0].properties.map(p => p.ref).sort(), ['T-100', 'T-200'])
    assert.equal(typeof (await as(tok, 'GET', '/summary')).body.pendingClaims, 'number')
  }
})

test('roles: an unknown account id answers 404 for everyone, with no detail', async () => {
  for (const tok of [staffTok, tokFor(6, 'agent6')]) {
    const r = await as(tok, 'GET', '/threads/00000000-0000-0000-0000-000000000000')
    assert.equal(r.status, 404); assert.equal(r.body.error, 'Account not found')
  }
})
