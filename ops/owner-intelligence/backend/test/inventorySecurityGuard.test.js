'use strict'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'inventory-security-test-secret'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const guard = require('../services/inventorySecurityGuard')

function fakeDatabase() {
  const agents = new Map([
    [1,{ id:1,username:'olga',name:'Olga',role:'agent',active:true }],
    [2,{ id:2,username:'adrian',name:'Adrian',role:'admin',active:true }],
    [3,{ id:3,username:'tomas',name:'Tomas',role:'agent',active:true }],
    [4,{ id:4,username:'kevin',name:'Kevin',role:'admin',active:true }],
  ])
  const policies = new Map([1,2,3].map(id => [id,{
    agent_id:id,enabled:true,delete_attempt_limit:2,delete_window_minutes:1440,
    detail_burst_limit:60,detail_burst_window_minutes:10,detail_hour_limit:150,
  }]))
  const events=[]
  const activities=[]

  const client = {
    async query(sql,params=[]) {
      const compact=sql.replace(/\s+/g,' ').trim()
      if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK' || compact.startsWith('SELECT pg_advisory_xact_lock')) return {rows:[]}
      if (compact.includes('FROM agent_inventory_security_policies p')) {
        const policy=policies.get(Number(params[0]))
        const agent=agents.get(Number(params[0]))
        return {rows:policy && policy.enabled ? [{...policy,...agent}] : []}
      }
      if (compact.startsWith('INSERT INTO agent_inventory_security_events')) {
        let eventType
        if (compact.includes("'LISTING_DELETE_ATTEMPTED'")) eventType='LISTING_DELETE_ATTEMPTED'
        else if (compact.includes("'LISTING_DETAIL_OPENED'")) eventType='LISTING_DETAIL_OPENED'
        else if (compact.includes("'INVENTORY_SECURITY_SUSPENDED'")) eventType='INVENTORY_SECURITY_SUSPENDED'
        else if (compact.includes("'INVENTORY_SECURITY_CLEARED'")) eventType='INVENTORY_SECURITY_CLEARED'
        events.push({agent_id:Number(params[0]),event_type:eventType,property_id:params[1] || null})
        return {rows:[]}
      }
      if (compact.includes("COUNT(DISTINCT property_id)::int AS listings")) {
        const ids=new Set(events.filter(e=>e.agent_id===Number(params[0]) && e.event_type==='LISTING_DELETE_ATTEMPTED').map(e=>e.property_id))
        return {rows:[{listings:ids.size}]}
      }
      if (compact.includes('AS burst_count') && compact.includes('AS hour_count')) {
        const ids=new Set(events.filter(e=>e.agent_id===Number(params[0]) && e.event_type==='LISTING_DETAIL_OPENED').map(e=>e.property_id))
        return {rows:[{burst_count:ids.size,hour_count:ids.size}]}
      }
      if (compact.startsWith('UPDATE agents') && compact.includes("security_suspended_by='inventory_security_guard'")) {
        const agent=agents.get(Number(params[0]))
        agent.security_suspended_at=agent.security_suspended_at || new Date().toISOString()
        agent.security_suspension_reason=params[1]
        agent.security_suspension_cleared_at=null
        return {rows:[{security_suspended_at:agent.security_suspended_at}]}
      }
      if (compact.startsWith('SELECT id,username,name,role,security_suspended_at')) {
        const agent=agents.get(Number(params[0]));return {rows:agent?[{...agent}]:[]}
      }
      if (compact.startsWith('UPDATE agents') && compact.includes('security_suspended_at=NULL')) {
        const agent=agents.get(Number(params[0]))
        agent.security_suspended_at=null;agent.security_suspension_reason=null
        agent.security_suspension_cleared_at=new Date().toISOString()
        return {rows:[]}
      }
      if (compact.startsWith('INSERT INTO agent_activity_log')) { activities.push({sql:compact,params});return {rows:[]} }
      throw new Error(`Unexpected SQL: ${compact}`)
    },
    release() {},
  }
  return { connect:async()=>client,agents,policies,events,activities }
}

let fake
test.beforeEach(()=>{
  fake=fakeDatabase()
  guard.setDatabaseForTests(fake)
  guard.setLoggerForTests({ warn(){} })
})
test.afterEach(()=>{
  guard.setDatabaseForTests(null)
  guard.setLoggerForTests(null)
})

for (const [id,name] of [[1,'Olga'],[2,'Adrian'],[3,'Tomas']]) {
  test(`${name}: first two listing delete attempts retain access; third is blocked and suspends`, async()=>{
    const originalRole=fake.agents.get(id).role
    assert.equal((await guard.recordDeleteAttempt({agentId:id,propertyId:101})).allowed,true)
    assert.equal((await guard.recordDeleteAttempt({agentId:id,propertyId:102})).allowed,true)
    const third=await guard.recordDeleteAttempt({agentId:id,propertyId:103})
    assert.equal(third.allowed,false)
    assert.equal(third.suspended,true)
    assert.equal(fake.agents.get(id).security_suspension_reason,'suspected_inventory_moves')
    assert.equal(fake.agents.get(id).role,originalRole,'role/rights are never rewritten')
  })
}

test('unprotected agents are not tracked or suspended',async()=>{
  for(let i=0;i<5;i++) assert.equal((await guard.recordDeleteAttempt({agentId:4,propertyId:200+i})).allowed,true)
  assert.equal(fake.events.length,0)
  assert.equal(guard.isSuspended(fake.agents.get(4)),false)
})

test('repeated attempts on one listing count as one listing, not three',async()=>{
  for(let i=0;i<10;i++) assert.equal((await guard.recordDeleteAttempt({agentId:1,propertyId:777})).allowed,true)
  assert.equal(guard.isSuspended(fake.agents.get(1)),false)
})

test('normal browsing and repeated opens of one listing do not trigger copy protection',async()=>{
  for(let i=0;i<100;i++) {
    const result=await guard.recordDetailOpen({agentId:1,propertyId:501})
    assert.equal(result.allowed,true)
  }
  assert.equal(guard.isSuspended(fake.agents.get(1)),false)
})

test('a burst of 60 different inventory details triggers a suspected-copy suspension',async()=>{
  for(let i=1;i<60;i++) assert.equal((await guard.recordDetailOpen({agentId:1,propertyId:i})).allowed,true)
  const threshold=await guard.recordDetailOpen({agentId:1,propertyId:60})
  assert.equal(threshold.allowed,false)
  assert.equal(threshold.suspended,true)
  assert.equal(fake.agents.get(1).security_suspension_reason,'suspected_inventory_moves')
})

test('admin review clears only suspension state and preserves policy, active flag and role',async()=>{
  await guard.recordDeleteAttempt({agentId:2,propertyId:1})
  await guard.recordDeleteAttempt({agentId:2,propertyId:2})
  await guard.recordDeleteAttempt({agentId:2,propertyId:3})
  const before={role:fake.agents.get(2).role,active:fake.agents.get(2).active}
  const result=await guard.clearSuspension({agentId:2,clearedByAgentId:4})
  assert.deepEqual(result,{found:true,cleared:true})
  assert.equal(guard.isSuspended(fake.agents.get(2)),false)
  assert.equal(fake.agents.get(2).role,before.role)
  assert.equal(fake.agents.get(2).active,before.active)
  assert.equal(fake.policies.get(2).enabled,true)
})

test('route and migration contracts keep monitoring inventory-only and enforce live-session suspension',()=>{
  const root=path.join(__dirname,'..')
  const crm=fs.readFileSync(path.join(root,'routes','crm.js'),'utf8')
  const board=fs.readFileSync(path.join(root,'routes','crmScheduleBoard.js'),'utf8')
  const migration=fs.readFileSync(path.join(root,'migrations','20261106_inventory_security_guard.sql'),'utf8')
  assert.match(crm,/recordDetailOpen\([\s\S]*crm_property_detail/)
  assert.match(crm,/recordDeleteAttempt\([\s\S]*crm_property_archive/)
  assert.match(board,/recordDeleteAttempt\([\s\S]*schedule_board_duplicate_delete/)
  assert.match(crm,/status\(423\)[\s\S]*security_suspended/)
  assert.match(board,/status\(423\)[\s\S]*security_suspended/)
  assert.doesNotMatch(crm,/router\.get\('\/properties',[\s\S]{0,600}recordDetailOpen/,
    'ordinary inventory list/filter loads are not treated as suspicious clicks')
  assert.match(migration,/olga\|adrian\|tomas/)
  assert.doesNotMatch(migration,/UPDATE agents SET (?:role|active)/i)
})
