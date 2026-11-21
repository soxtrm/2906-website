'use strict'
// Restore drill client for the SYNC staging service (synthetic owner only).
//   node drill.js seed     signs in as the staging owner, uploads three documents, shares one, prints what it stored
//   node drill.js verify   reads the seed output from stdin, downloads every document through the API and compares checksums
const path = require('path'); const crypto = require('crypto')
const C = require(path.join(process.env.BACKEND_DIR || '/app', 'services/nexusLinkCrypto.js'))
const BASE = process.env.STAGE; const SECRET = process.env.SECRET
async function svc(p, body) {
  const timestamp = Math.floor(Date.now() / 1000)
  const res = await fetch(`${BASE}/api/sync-account/v1${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus-sync', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': '10.99.0.1', 'X-Nexus-Link-Signature': C.sign(SECRET, { timestamp, method: 'POST', path: p, body }) } })
  return { status: res.status, body: await res.json() }
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
;(async () => {
  const li = await svc('/login', { email: 'olga.stage@example.test', password: 'stage-pass-2026' })
  if (li.status !== 200) throw new Error('login ' + JSON.stringify(li.body))
  const session = li.body.session.token
  if (process.argv[2] === 'seed') {
    const files = [
      ['Lease 2026', 'contract', Buffer.from('%PDF-1.4\n% lease ' + crypto.randomBytes(8).toString('hex') + '\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')],
      ['Energy certificate', 'energy_certificate', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2048)])],
      ['Inventory', 'inventory', Buffer.from('%PDF-1.4\n% inventory ' + crypto.randomBytes(8).toString('hex') + '\n%%EOF\n')],
    ]
    const out = []
    for (const [title, category, buf] of files) {
      const r = await svc('/documents/upload', { session, title, category, dataBase64: buf.toString('base64'), propertyId: 1 })
      if (r.status !== 200 || r.body.document.scanState !== 'clean') throw new Error('upload ' + JSON.stringify(r.body))
      out.push({ id: r.body.document.id, title, sha: sha(buf), shared: false })
    }
    await svc('/documents/share', { session, id: out[0].id, share: true }); out[0].shared = true
    console.log(JSON.stringify(out))
  } else {
    const want = JSON.parse(require('fs').readFileSync(0, 'utf8'))
    const list = await svc('/documents', { session })
    const docs = list.body.documents || []
    let ok = 0
    for (const w of want) {
      const d = docs.find(x => x.id === w.id)
      const f = d ? await svc('/documents/file', { session, id: w.id }) : null
      const same = f && f.status === 200 && sha(Buffer.from(f.body.file.dataBase64, 'base64')) === w.sha && d.shared === w.shared && d.title === w.title
      console.log(`${same ? 'ok  ' : 'FAIL'} document ${w.id} "${w.title}"${d ? '' : ' (not listed)'}`)
      if (same) ok++
    }
    console.log(`${ok}/${want.length} documents identical after restore`)
    process.exit(ok === want.length ? 0 : 1)
  }
})().catch(e => { console.error(e.message); process.exit(2) })
