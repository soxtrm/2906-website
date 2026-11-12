'use strict'
// Mint a short-lived STAGING staff session for a staging agent.
//   docker compose exec argus node staff-token.js <agentId> [hours]
// Works only with the staging JWT secret; it is useless against production.
const jwt = require('jsonwebtoken')
const db = require('./db')
;(async () => {
  const id = Number(process.argv[2]); const hours = Math.min(Number(process.argv[3]) || 8, 24)
  const { rows: [a] } = await db.query('SELECT id, role, active FROM agents WHERE id=$1', [id])
  if (!a || !a.active) { console.error('no such active staging agent'); process.exit(1) }
  console.log(jwt.sign({ id: a.id, role: a.role, aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: `${hours}h` }))
  process.exit(0)
})().catch(e => { console.error(e.message); process.exit(1) })
