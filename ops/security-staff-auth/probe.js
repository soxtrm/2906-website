'use strict'
// Runs INSIDE the 2906_backend container (needs its JWT_SECRET and jsonwebtoken).
// Signs a 2-minute owner-upload token for a non-existent owner (id 0), calls the
// staff owner list with a search that matches nothing, and prints only the HTTP
// status. Nothing secret is printed and no owner data can come back.
//   docker exec 2906_backend node /app/.staff-audience-probe.js
const jwt = require('jsonwebtoken') // resolves from /app/node_modules next to this file
;(async () => {
  if (!process.env.JWT_SECRET) { console.log('PROBE no JWT_SECRET in this process'); process.exit(2) }
  const token = jwt.sign({ ownerContactId: 0, aud: 'owner-upload' }, process.env.JWT_SECRET, { expiresIn: '2m' })
  for (const port of [...new Set([process.env.PORT, 3001, 3000].filter(Boolean))]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/crm/owners?search=__no_such_owner_probe__`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      console.log(`PROBE owner-upload token on /api/crm/owners -> ${r.status} (port ${port})`)
      process.exit(0)
    } catch {}
  }
  console.log('PROBE backend not reachable from inside the container'); process.exit(2)
})()
