const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const root = process.env.MATCHING_BACKEND
if (!root) throw new Error('Set MATCHING_BACKEND to the staged backend directory.')

function load(name, dependencies) {
  const filename = path.join(root, 'services', name + '.js')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    process: { env: {} },
    require: dependency => dependencies[dependency] || {},
  }, { filename })
  return module.exports
}

for (const status of ['closed', null, 'new']) {
  test(`manual matching: ${status ?? 'missing'} search`, async () => {
    const writes = []
    const db = { async query(sql, params) {
      if (sql.includes('FROM client_assistant_state')) return { rows: [{ id: 7, client_id: 'QA-1' }] }
      if (sql.includes('FROM clients WHERE id')) return { rows: status ? [{ id: 'QA-1', status }] : [] }
      if (/^\s*SELECT\b/.test(sql)) return { rows: [] }
      writes.push([sql.trim().split(/\s+/).slice(0, 3).join(' '), params])
      return { rows: [] }
    } }
    const common = { '../db': db, '../logger': { info() {}, warn() {} } }
    const engine = load('matchEngine', {
      ...common,
      './maltaPlaceGraph': { loadRelationshipIndex: () => new Map(), loadMarketCharacterIndex: () => new Map() },
      './mobilityEngine': { loadTravelTimeIndex: () => new Map() },
    })
    const assistant = load('clientAssistant', { ...common, './matchEngine': engine })
    const result = JSON.parse(JSON.stringify(await assistant.findMatchesNow(7)))

    if (status === 'new') {
      assert.deepEqual(result, { ok: true, matchCount: 0 })
      assert.deepEqual(writes.map(([sql]) => sql), ['UPDATE property_matches SET', 'INSERT INTO client_assistant_events'])
    } else {
      assert.deepEqual(result, { ok: false, reason: status ? 'This client search is closed.' : 'Client search not found.' })
      assert.deepEqual(writes, [])
    }
  })
}
