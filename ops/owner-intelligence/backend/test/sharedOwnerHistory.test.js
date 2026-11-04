'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const privacy = require('../services/sharedOwnerPrivacy')
const history = require('../services/sharedOwnerHistory')

const property = {
  id:701,ref:'2906-7001',owner_id:44,agency_id:1,listed_by_agent_id:10,assigned_agent_id:12,
  available_status:'available',available_date:null,bedrooms:2,longlet_price:1500,sale_price:null,
  last_confirmed_available_at:'2026-11-03T09:00:00Z',photo_count:0,
  owner_name:'Maria Borg',owner_phone:'+356 9912 3456',owner_email:'maria@example.com',
  owner_private_address:'12 Private Lane',
}
const stored = [
  { id:4,thread_id:99,direction:'agent_to_owner',body:'Would you consider €1,450?',created_at:'2026-11-03T14:03:00Z',source_message_id:'argus-4',delivery_status:'sent',sender_role:'AGENT',actor_agent_id:10,is_ai:false,provenance_source:'ARGUS_BOARD',attachment_metadata:null,property_id:701,ref:'2906-7001',conversation_status:'closed' },
  { id:3,thread_id:99,direction:'owner_to_agent',body:'The apartment is still available from December for €1,500. Call Maria Borg on +356 9912 3456 or maria@example.com.',created_at:'2026-11-03T09:47:00Z',source_message_id:'waha-3',delivery_status:'received',sender_role:'OWNER',actor_agent_id:null,is_ai:false,provenance_source:'WAHA',attachment_metadata:null,property_id:701,ref:'2906-7001',conversation_status:'closed' },
]

function fakeQuery(sql,params) {
  if (sql.includes('FROM properties p') && sql.includes('LOWER(p.ref)')) return Promise.resolve({ rows:[property] })
  if (sql.includes('FROM book_relay_messages')) return Promise.resolve({ rows:stored })
  if (sql.includes('COUNT(*)::int AS count')) return Promise.resolve({ rows:[{ status:'closed',count:1 }] })
  if (sql.includes('INSERT INTO owner_conversation_tasks')) return Promise.resolve({ rows:[{ id:8,action:params[5],status:'OPEN',due_at:params[6],created_at:'2026-11-04T10:00:00Z' }] })
  throw new Error(`Unexpected test SQL: ${sql.slice(0,100)}`)
}

test.afterEach(() => history.setQueryForTests(null))

test('1-8: two-request scenario keeps real history visible for an assigned second agent despite incomplete property data and closed state', async () => {
  history.setQueryForTests(fakeQuery)
  const viewer={ id:12,role:'agent',agency_id:1 }
  const first=await history.getPropertyHistory({ ref:'2906-7001',viewer,limit:40 })
  const reload=await history.getPropertyHistory({ ref:'2906-7001',viewer,limit:40 })
  assert.equal(first.result.messages.length,2)
  assert.deepEqual(reload.result.messages,first.result.messages,'reload reads the same persisted rows')
  assert.equal(first.result.conversationStates[0].status,'closed')
  assert.equal(first.result.facts.find(f=>f.key==='photos').label,'Photos Pending')
  assert.equal(first.result.messages[0].provenance.source,'WAHA')
  assert.match(first.result.messages[0].text,/still available from December for €1,500/)
})

test('9/10: names, phones, emails and mixed private/business content are redacted before projection', () => {
  const out=privacy.redactBusinessMessage(
    'The apartment is available for €1,500. Ask Maria Borg at +356 9912 3456 or maria@example.com.',
    { names:['Maria Borg'],phones:['+356 9912 3456'],emails:['maria@example.com'] },
  )
  assert.match(out.text,/apartment is available for €1,500/)
  assert.doesNotMatch(out.text,/Maria|9912|example\.com/)
  assert.match(out.text,/\[NAME REDACTED\]/)
  assert.match(out.text,/\[PHONE REDACTED\]/)
  assert.match(out.text,/\[EMAIL REDACTED\]/)
})

test('11: another agency receives no private history even when ids and ref are known', async () => {
  let messageQuery=false
  history.setQueryForTests(async (sql) => {
    if (sql.includes('FROM properties p')) return { rows:[property] }
    messageQuery=true;return { rows:stored }
  })
  const out=await history.getPropertyHistory({ ref:property.ref,viewer:{id:12,role:'admin',agency_id:2} })
  assert.equal(out.reason,'forbidden')
  assert.equal(messageQuery,false,'cross-tenant denial happens before message rows are read')
})

test('12: authorized business attachment metadata is returned while sensitive files are restricted', async () => {
  const business={ ...stored[0],id:5,attachment_metadata:{ filename:'floor-plan.pdf',mimeType:'application/pdf',url:'https://files.example/floor-plan.pdf',sensitivity:'business' } }
  const sensitive={ ...stored[0],id:6,attachment_metadata:{ filename:'passport.jpg',mimeType:'image/jpeg',url:'https://files.example/passport.jpg',sensitivity:'identity' } }
  history.setQueryForTests((sql,params) => {
    if (sql.includes('FROM properties p')) return Promise.resolve({ rows:[property] })
    if (sql.includes('FROM book_relay_messages')) return Promise.resolve({ rows:[sensitive,business] })
    if (sql.includes('COUNT(*)::int AS count')) return Promise.resolve({ rows:[] })
    throw new Error('Unexpected SQL')
  })
  const out=await history.getPropertyHistory({ ref:property.ref,viewer:{id:12,role:'agent',agency_id:1} })
  assert.equal(out.result.messages[0].attachment.url,'https://files.example/floor-plan.pdf')
  assert.equal(out.result.messages[1].attachment.restricted,true)
  assert.equal(out.result.messages[1].attachment.url,undefined)
})

test('13: Board-written messages retain stable IDs, actor role and original-store provenance', async () => {
  history.setQueryForTests(fakeQuery)
  const out=await history.getPropertyHistory({ ref:property.ref,viewer:{id:12,role:'agent',agency_id:1} })
  const agent=out.result.messages.find(m=>m.senderRole==='AGENT')
  assert.equal(agent.stableId,'argus-4')
  assert.equal(agent.provenance.originalPreserved,true)
})

test('14: discriminatory clauses are restricted and cannot become normal shared matching content', () => {
  const out=privacy.redactBusinessMessage('The rent is €1,500. I do not accept Indians for this apartment. Viewings are possible Friday.')
  assert.equal(out.restricted,true)
  assert.match(out.text,/rent is €1,500/)
  assert.match(out.text,/RESTRICTED — COMPLIANCE REVIEW/)
  assert.doesNotMatch(out.text,/Indians/)
  assert.match(out.text,/Viewings are possible Friday/)
})

test('follow-up actions persist without sending a message or starting a call', async () => {
  history.setQueryForTests(fakeQuery)
  const out=await history.createFollowUpAction({ ref:property.ref,viewer:{id:12,role:'agent',agency_id:1},action:'REQUEST_CALLBACK' })
  assert.equal(out.result.messageSent,false)
  assert.equal(out.result.callStarted,false)
  assert.equal(out.result.task.action,'REQUEST_CALLBACK')
})

test('API contracts distinguish missing history from incomplete property data and enforce backend privacy projection', () => {
  const root=path.join(__dirname,'..')
  const route=fs.readFileSync(path.join(root,'routes','crmScheduleBoard.js'),'utf8')
  const service=fs.readFileSync(path.join(root,'services','sharedOwnerHistory.js'),'utf8')
  const migration=fs.readFileSync(path.join(root,'migrations','20261104_shared_owner_history.sql'),'utf8')
  assert.match(route,/code:'history_not_found'/)
  assert.match(route,/code:'history_forbidden'/)
  assert.match(service,/redactBusinessMessage\(row\.body/)
  assert.match(service,/t\.property_id=\$1 AND t\.agency_id=\$2/)
  assert.doesNotMatch(service,/photo_count[^\n]+(?:forbidden|return)/i)
  assert.match(migration,/sender_role/)
  assert.match(migration,/attachment_metadata/)
  assert.match(migration,/owner_conversation_tasks/)
  assert.match(migration,/crm_current_agency_id/)
  assert.match(migration,/book_relay_message_provenance_trigger/)
})
