'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { GOOGLE_ROUTES_CURRENT } = require('../ops/property-routing/traffic-provider-contract.cjs')
const { appendTrafficObservations, readJsonLines } = require('../ops/property-routing/traffic-history-store.cjs')
const { acquireProcessLock, releaseProcessLock } = require('../ops/property-routing/traffic-process-lock.cjs')

const compliantFixture = Object.freeze({
  id: 'licensed-fixture', historicalStorageAllowed: true,
  derivedAggregatesAllowed: true, externalMapRenderingAllowed: true,
})

test('refuses to archive current Google Routes values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-traffic-policy-'))
  assert.throws(() => appendTrafficObservations(path.join(dir, 'observations.jsonl'), GOOGLE_ROUTES_CURRENT, [{ observation_id: 'x', scanner_run_id: 'r' }]), /NOT_PERMITTED/)
})

test('four controlled scans survive a collector process restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-traffic-proof-'))
  const file = path.join(dir, 'observations.jsonl')
  const modulePath = path.resolve(__dirname, '../ops/property-routing/traffic-history-store.cjs')
  const provider = JSON.stringify(compliantFixture)
  const run = index => {
    const script = `const s=require(${JSON.stringify(modulePath)});const p=${provider};const i=${index};s.appendTrafficObservations(${JSON.stringify(file)},p,[0,1].map(n=>({observation_id:'scan-'+i+'-'+n,scanner_run_id:'scan-'+i,corridor_id:'fixture',direction:n?'backward':'forward',observed_at_utc:new Date(1700000000000+i*900000).toISOString(),collector_version:'proof'})));`
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  run(1); assert.equal(readJsonLines(file).length, 2)
  run(2); assert.equal(readJsonLines(file).length, 4)
  run(3); assert.equal(readJsonLines(file).length, 6)
  run(4); assert.equal(readJsonLines(file).length, 8)
  assert.deepEqual(readJsonLines(file).map(row => row.observation_id), [
    'scan-1-0','scan-1-1','scan-2-0','scan-2-1','scan-3-0','scan-3-1','scan-4-0','scan-4-1',
  ])
})

test('shared process lock skips a concurrent collector and recovers a stale owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-traffic-lock-'))
  const file = path.join(dir, 'collector.lock')
  const first = acquireProcessLock(file)
  assert.notEqual(first, null)
  assert.equal(acquireProcessLock(file), null)
  releaseProcessLock(file, first)
  fs.writeFileSync(file, '999999999\n')
  const recovered = acquireProcessLock(file)
  assert.notEqual(recovered, null)
  releaseProcessLock(file, recovered)
})
