// One-off after the 10-photo website cap (2026-10-18): re-sync every published
// website listing that currently shows more than 10 photos.
//   node /app/scripts/website-resync-image-cap.js [--go]
'use strict'
const db = require('/app/db')
const { syncPropertyToWebsite } = require('/app/services/websiteSync')
;(async () => {
  const go = process.argv.includes('--go')
  const rows = (await db.query(
    `SELECT p.id, p.ref, array_length(w.images, 1) AS n
       FROM website_properties w JOIN properties p ON p.ref = w.property_reference
      WHERE w.is_published AND array_length(w.images, 1) > 10 ORDER BY p.id`)).rows
  console.log(`${rows.length} website listings with more than 10 photos`)
  if (!go) { console.log(rows.slice(0, 10).map(r => `${r.ref}:${r.n}`).join(' ')); process.exit(0) }
  let ok = 0, skipped = 0
  for (const r of rows) {
    const out = await syncPropertyToWebsite(r.id).catch(e => ({ ok: false, reason: e.message }))
    if (out.ok) ok++; else { skipped++; console.log('skip', r.ref, out.reason) }
  }
  const left = (await db.query(`SELECT count(*)::int AS n FROM website_properties WHERE is_published AND array_length(images, 1) > 10`)).rows[0].n
  console.log(JSON.stringify({ resynced: ok, skipped, stillOver10: left }))
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
