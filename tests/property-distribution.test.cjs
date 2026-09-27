const assert = require('assert')
const { loadPropertyDistribution } = require('../ops/outreach-control/propertyDistribution')

const queries = []
const db = {
  query(sql, params) {
    queries.push({ sql, params })
    if (sql.includes('property_publishing_status')) return Promise.resolve({ rows: [
      { channel: 'facebook', status: 'posted' },
      { channel: 'facebook', status: 'failed' },
      { channel: 'category_groups', status: 'scheduled' },
    ] })
    return Promise.resolve({ rows: [{ slug: '2906-9001', is_published: true }] })
  },
}

loadPropertyDistribution(db, { id: 9001, ref: '2906-9001', published: true }).then(result => {
  const byKey = Object.fromEntries(result.channels.map(channel => [channel.key, channel]))
  assert.equal(byKey.crm.status, 'connected')
  assert.equal(byKey.website.status, 'live')
  assert.equal(byKey.facebook.status, 'posted')
  assert.equal(byKey.facebook.count, 1)
  assert.equal(byKey.owner_groups.status, 'scheduled')
  assert.equal(byKey.marketplaces.status, 'ready')
  assert.equal(byKey.matched_clients.status, 'manual')
  assert.deepEqual(queries[0].params, [9001])
  assert.deepEqual(queries[1].params, ['2906-9001'])
  console.log('PASS: property distribution reports channel evidence without changing canonical facts')
}).catch(error => { console.error(error); process.exit(1) })
