'use strict'
// Real clamd check (not part of the unit suite): the EICAR test pattern must be FOUND, a plain PDF must be OK.
// Run inside the backend image on the network where clamd runs:  CLAMD_HOST=<name> node test/clamd-live-check.js
const path = require('path')
const R = p => path.join(process.env.BACKEND_DIR || '/app', p)
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: async () => ({ rows: [] }) }); stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
const { clamdScan } = require(R('services/syncDocuments.js'))
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
;(async () => {
  const a = await clamdScan(EICAR), b = await clamdScan(PDF), big = await clamdScan(Buffer.alloc(3 * 1024 * 1024, 7))
  console.log('eicar', JSON.stringify(a), '| pdf', JSON.stringify(b), '| 3MB', JSON.stringify(big))
  process.exit(!a.clean && b.clean && big.clean ? 0 : 1)
})().catch(e => { console.error('clamd error', e.message); process.exit(2) })
