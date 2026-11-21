'use strict'
// Production check on one migrated document: served while shared, refused right after revoking (same unexpired
// link), served again after re-sharing; wrong signature and expired link refused. Restores the original visibility.
// docker exec 2906_backend node /app/scripts/docs-revocation-check.js <documentId>
const db = require('/app/db'); const SD = require('/app/services/syncDocuments')
;(async () => {
  const id = Number(process.argv[2])
  const { rows: [d] } = await db.query(`SELECT visibility FROM owner_documents WHERE id=$1 AND storage='sync_private' AND sync_account_id IS NULL`, [id])
  if (!d || d.visibility !== 'agency') throw new Error('pick a migrated, shared document')
  const u = new URL(SD._test.staffLink(id)); const q = { exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') }
  const res = {}
  try {
    res.shared = !!(await SD._test.staffFile(id, q))
    await db.query(`UPDATE owner_documents SET visibility='private' WHERE id=$1`, [id])
    res.afterRevoking = !!(await SD._test.staffFile(id, q))
  } finally { await db.query(`UPDATE owner_documents SET visibility='agency' WHERE id=$1`, [id]) }
  res.sharedAgain = !!(await SD._test.staffFile(id, q))
  res.wrongSignature = !!(await SD._test.staffFile(id, { exp: q.exp, sig: 'x'.repeat(43) }))
  res.expired = !!(await SD._test.staffFile(id, { exp: String(Math.floor(Date.now() / 1000) - 5), sig: q.sig }))
  const ok = res.shared && !res.afterRevoking && res.sharedAgain && !res.wrongSignature && !res.expired
  console.log(`shared: ${res.shared ? 'served' : 'REFUSED'} | after revoking: ${res.afterRevoking ? 'SERVED' : 'refused'} | shared again: ${res.sharedAgain ? 'served' : 'REFUSED'} | wrong signature: ${res.wrongSignature ? 'SERVED' : 'refused'} | expired: ${res.expired ? 'SERVED' : 'refused'} => ${ok ? 'OK' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
})().catch(e => { console.error(e.message); process.exit(2) })
