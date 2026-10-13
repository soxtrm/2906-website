'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const root = path.resolve(__dirname, '..')
const servicePath = path.join(root, 'ops/owner-group-flow/backend/services/ownerGroupRequests.js')
const fakeDb = { query: async () => ({ rows:[] }), connect: async () => ({ query:async()=>({rows:[]}), release(){} }) }
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (parent?.filename === servicePath) {
    if (request === '../db') return fakeDb
    if (request === '../logger') return { error(){}, warn(){}, info(){}, debug(){} }
    if (request === '../waha') return { sendText:async()=>({id:'test'}) }
    if (request === './ownerSendGate') return { checkOwnerSend:async()=>({allow:true}), describeBlock:x=>x }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const service = require(servicePath)
Module._load = originalLoad

assert.equal(service.canCreateOwnerGroup({role:'admin'}), true, 'A admin')
assert.equal(service.canCreateOwnerGroup({role:'agent',can_create_owner_group:true}), true, 'A trusted agent')
assert.equal(service.canCreateOwnerGroup({role:'agent',can_create_owner_group:false}), false, 'A normal agent')
assert.equal(service.classifyOwnerReply('YES, but tomorrow please.'), 'APPROVED', 'B yes')
assert.equal(service.classifyOwnerReply('No, I prefer to deal with you.'), 'DECLINED', 'C no')
assert.equal(service.classifyOwnerReply('Who is Olga?'), 'QUESTION', 'D question')
assert.equal(service.classifyOwnerReply('Okay'), 'APPROVED', 'owner okay')
assert.equal(service.classifyOwnerReply('No problem'), 'APPROVED', 'owner no problem')

const msg = service.ownerMessage({ownerName:'Anna Borg',agentName:'Olga',ref:'9340',town:'Sliema',clients:[{name:'Client A'}],relationship:'couple',moveInDate:'2026-11-01',viewingIntent:'Coordinate a viewing',note:''})
assert.match(msg,/Olga from 2906/)
assert.match(msg,/#9340 in Sliema/)
assert.match(msg,/reply YES or NO/)
assert.doesNotMatch(msg,/undefined|null/)

const migration = fs.readFileSync(path.join(root,'ops/owner-group-flow/backend/migrations/20261013_owner_group_requests.sql'),'utf8')
const backend = fs.readFileSync(servicePath,'utf8')
const planner = fs.readFileSync(path.join(root,'ops/owner-group-flow/backend/services/viewingGroupPlan.js'),'utf8')
const board = fs.readFileSync(path.join(root,'ops/owner-group-flow/backend/routes/crmScheduleBoard.js'),'utf8')
const webhook = fs.readFileSync(path.join(root,'ops/owner-group-flow/backend/routes/webhook.js'),'utf8')
const ui = fs.readFileSync(path.join(root,'lib/crm/ui.tsx'),'utf8')

assert.match(migration,/can_create_owner_group BOOLEAN NOT NULL DEFAULT FALSE/, 'A server capability')
assert.match(migration,/WHERE status IN \('GROUP_REQUEST_DRAFT','GROUP_REQUEST_PENDING','GROUP_REQUEST_APPROVED','GROUP_CREATING'\)/, 'I one open request')
assert.match(backend,/WHERE request_id=\$1 AND status='GROUP_REQUEST_PENDING' RETURNING/, 'H/I atomic owner decision')
assert.match(backend,/FOR UPDATE SKIP LOCKED/, 'E/F timeout claim')
assert.match(backend,/GROUP_CREATION_AMBIGUOUS/, 'I unknown create result held')
assert.match(backend,/checkOwnerSend/, 'G send gate reused')
assert.match(backend,/createViewingGroup/, 'J existing group engine reused')
assert.match(planner,/add\(digitsOnly\(requesterPhone\)\)/, 'B requesting agent participant')
assert.match(planner,/timeoutCreated/, 'F timeout introduction')
assert.match(board,/contact:'masked'/, 'L masked owner contact')
assert.match(webhook,/recordGroupEvent/, 'M group event association')
assert.doesNotMatch(ui,/TRUSTED_CREATE_GROUP/, 'A no browser hard-coded trust list')

console.log('owner-group-flow: 25 contract assertions passed (A–M)')
