'use strict'
// Synthetic staging data only (Claude, 2026-11-13). Idempotent.
//   docker compose exec argus node seed.js
// Invented owners with numbers from a reserved test range, invented listings
// with STG- references. Nothing is copied from production.
const db = require('./db')
;(async () => {
  if (!/staging/i.test(process.env.STAGING_DB_NAME || '')) throw new Error('not a staging database')
  const { rows: [admin] } = await db.query(
    `INSERT INTO agents (username, name, role, active, feature_entitlements) VALUES ('stg_admin','Staging Admin','admin',true,'{}'::jsonb)
     ON CONFLICT (username) DO UPDATE SET active=true RETURNING id`)
  const { rows: [agent] } = await db.query(
    `INSERT INTO agents (username, name, role, active, feature_entitlements) VALUES ('stg_agent','Staging Agent','agent',true,'{"nexus_owner_link":true}'::jsonb)
     ON CONFLICT (username) DO UPDATE SET active=true RETURNING id`)
  const owners = []
  for (const [i, name] of ['Staging Owner One', 'Staging Owner Two', 'Staging Owner Three'].entries()) {
    const phone = `+3569900000${i + 1}`
    const { rows: [o] } = await db.query(`SELECT id FROM owner_contacts WHERE phone_normalized=$1`, [phone])
    owners.push(o ? o.id : (await db.query(`INSERT INTO owner_contacts (name, phone_normalized) VALUES ($1,$2) RETURNING id`, [name, phone])).rows[0].id)
  }
  const listings = [
    ['STG-1001', 0, 'Sliema', 'apartment', 2, 1500, null, 'available'],
    ['STG-1002', 0, 'Gzira', 'apartment', 1, 950, null, 'available'],
    ['STG-2001', 1, 'Mosta', 'maisonette', 3, 1800, null, 'available'],
    ['STG-2002', 1, 'Valletta', 'apartment', 2, null, 420000, 'available'],
    ['STG-3001', 2, 'Mellieha', 'penthouse', 3, 2400, null, 'not_available'],
  ]
  for (const [ref, o, town, type, beds, rent, sale, status] of listings) {
    const { rowCount } = await db.query(`SELECT 1 FROM properties WHERE ref=$1`, [ref])
    if (!rowCount) await db.query(
      `INSERT INTO properties (ref, owner_id, town, property_type, bedrooms, longlet_price, sale_price, available_status, street, listed_by_agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'1 Staging Street (synthetic)',$9)`, [ref, owners[o], town, type, beds, rent, sale, status, agent.id])
  }
  console.log(JSON.stringify({ adminAgentId: admin.id, agentId: agent.id, owners, listings: listings.map(l => l[0]) }))
  process.exit(0)
})().catch(e => { console.error(e.message); process.exit(1) })
