'use strict'
// Local throw-away Postgres for the owner-portal suite. Never the VPS.
//   OWNER_PORTAL_TEST_DSN=postgres://test@127.0.0.1:55440/argus_owner_test
// Loads coreStub.sql (or, with OWNER_PORTAL_SCHEMA_SQL, a production
// schema-only dump instead) and then the portal migration.
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const DSN = process.env.OWNER_PORTAL_TEST_DSN || 'postgres://test@127.0.0.1:55440/argus_owner_test'
if (!/127\.0\.0\.1|localhost/.test(DSN)) throw new Error('Refusing to run the owner-portal tests against a non-local database')
const ROOT = path.join(__dirname, '..', '..')
const pool = new Pool({ connectionString: DSN, max: 8 })

async function setup() {
  const core = process.env.OWNER_PORTAL_SCHEMA_SQL || path.join(__dirname, 'coreStub.sql')
  if (!process.env.OWNER_PORTAL_SCHEMA_SQL) await pool.query(fs.readFileSync(core, 'utf8'))
  await pool.query(fs.readFileSync(path.join(ROOT, 'migrations', '20261116_owner_portal.down.sql'), 'utf8'))
  await pool.query(fs.readFileSync(path.join(ROOT, 'migrations', '20261116_owner_portal.sql'), 'utf8'))
  await pool.query(`DELETE FROM property_viewings; DELETE FROM property_viewing_windows; DELETE FROM properties WHERE ref LIKE 'OPT-%'; DELETE FROM owner_contacts WHERE name LIKE 'OPT %'; DELETE FROM agents WHERE username LIKE 'opt_%'`)
}

let seq = 0
async function agent(role = 'admin', entitlements = {}) {
  seq++
  const { rows: [a] } = await pool.query(`INSERT INTO agents (username, name, role, feature_entitlements) VALUES ($1,$1,$2,$3) RETURNING *`, [`opt_${role}_${seq}_${Date.now()}`, role, JSON.stringify(entitlements)])
  return a
}
async function owner(fields = {}) {
  seq++
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (name, phone_normalized, owner_compliance_notes, conversation_summary, do_not_contact) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [fields.name || `OPT Owner ${seq}`, `+35699${String(seq).padStart(6, '0')}`, 'INTERNAL-COMPLIANCE-NOTE', 'INTERNAL-SUMMARY', !!fields.do_not_contact])
  return o
}
async function property(ownerId, fields = {}) {
  seq++
  const row = { ref: `OPT-${seq}`, owner_id: ownerId, town: 'Sliema', street: '12 Secret Street', property_type: 'apartment', bedrooms: 2,
    longlet_price: 1500, available_status: 'available', commission_note: 'INTERNAL-COMMISSION', internal_notes: 'INTERNAL-NOTE', description: 'Bright flat', ...fields }
  const cols = Object.keys(row)
  const { rows: [p] } = await pool.query(`INSERT INTO properties (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row))
  return p
}
module.exports = { pool, setup, agent, owner, property }
