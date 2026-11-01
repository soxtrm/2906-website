// Runs inside argus-sandbox-api: sandbox-only JWTs (sandbox secret, 6 h).
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')
const p = new Pool({ host: 'argus-outreach-testdb', user: 'test', password: 'test', database: 'argus_test' })
p.query(`SELECT id, username, role FROM agents WHERE username LIKE 'sandbox-%'`).then(r => {
  for (const a of r.rows) console.log(a.username, jwt.sign({ id: a.id, username: a.username, role: a.role, aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: '6h' }))
  return p.end()
}).catch(e => { console.error(e.message); process.exit(1) })
