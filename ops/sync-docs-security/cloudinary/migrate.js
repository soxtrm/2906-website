'use strict'
// ============================================================================
// Copy owner documents from public Cloudinary links into private ARGUS storage (Claude, 2026-11-21).
// Runs inside the backend container:  node /app/scripts/cloudinary-docs-migrate.js check | copy | verify | revert
//   check   which documents are on Cloudinary and whether their link opens without login (status only, no content kept)
//   copy    download each (not floor plans: category 'plan' is public on the website on purpose), virus-check with
//           ClamAV, store privately, then point the row at the private copy. The Cloudinary original is NOT touched;
//           its address stays in legacy_url until the founder approves removing it.
//   verify  every migrated row: private file present, checksum equal, original still reachable (nothing lost)
//   revert  point migrated rows back to their Cloudinary address (private copies stay on disk)
// Never prints document addresses or contents.
// ============================================================================
const crypto = require('crypto'); const fs = require('fs'); const path = require('path')
const db = require('/app/db')
const SD = require('/app/services/syncDocuments')
const DIR = process.env.SYNC_PRIVATE_DOCS_DIR || '/app/private-docs'
const MAX = 25 * 1024 * 1024
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc' }
const legacyRows = () => db.query(`SELECT id, url, category, filename FROM owner_documents WHERE storage='cloudinary' AND COALESCE(category,'') <> 'plan' AND url LIKE 'https://res.cloudinary.com/%' ORDER BY id`)
const sha = b => crypto.createHash('sha256').update(b).digest('hex')

async function check() {
  const { rows } = await legacyRows()
  for (const r of rows) {
    const res = await fetch(r.url, { method: 'HEAD' }).catch(() => null)
    console.log(`doc ${r.id}: ${res ? res.status : 'no answer'} ${res?.headers.get('content-type') || ''} ${res?.headers.get('content-length') || '?'} bytes${res?.status === 200 ? '  <- opens without login' : ''}`)
  }
  console.log(`${rows.length} documents on Cloudinary (floor plans excluded)`)
}

async function copy() {
  const { rows } = await legacyRows()
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  let done = 0
  for (const r of rows) {
    try {
      const res = await fetch(r.url)
      if (!res.ok) { console.log(`doc ${r.id}: download ${res.status}, skipped`); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > MAX) { console.log(`doc ${r.id}: size ${buf.length}, skipped`); continue }
      const mime = String(res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
      const scan = await SD.clamdScan(buf)
      if (!scan.clean) { console.log(`doc ${r.id}: VIRUS CHECK FAILED (${scan.signature}), left unchanged for review`); continue }
      const key = `${crypto.randomUUID()}.${EXT[mime] || 'bin'}`
      fs.writeFileSync(path.join(DIR, key), buf, { mode: 0o600, flag: 'wx' })
      const u = await db.query(
        `UPDATE owner_documents SET storage='sync_private', storage_key=$2, mime=$3, size_bytes=$4, sha256=$5, scan_state='clean', scanned_at=NOW(),
                legacy_url=url, url='sync-private:' || $2 WHERE id=$1 AND storage='cloudinary'`, [r.id, key, mime, buf.length, sha(buf)])
      if (!u.rowCount) { fs.unlinkSync(path.join(DIR, key)); console.log(`doc ${r.id}: changed meanwhile, skipped`); continue }
      await db.query(`INSERT INTO agent_activity_log (actor_role, actor_display_name, action_type, details) VALUES ('system','cloudinary-migration','OWNER_DOCUMENT_MADE_PRIVATE',$1::jsonb)`, [JSON.stringify({ document: r.id, bytes: buf.length, mime })])
      console.log(`doc ${r.id}: private copy stored (${mime}, ${buf.length} bytes, virus check clean)`); done++
    } catch (e) { console.log(`doc ${r.id}: ${e.message}, skipped`) }
  }
  console.log(`${done}/${rows.length} copied`)
}

async function verify() {
  const { rows } = await db.query(`SELECT id, storage_key, sha256, legacy_url FROM owner_documents WHERE legacy_url IS NOT NULL ORDER BY id`)
  let ok = 0
  for (const r of rows) {
    const p = path.join(DIR, r.storage_key)
    const same = fs.existsSync(p) && sha(fs.readFileSync(p)) === r.sha256
    const orig = await fetch(r.legacy_url, { method: 'HEAD' }).then(x => x.status).catch(() => 0)
    console.log(`doc ${r.id}: private copy ${same ? 'ok' : 'MISSING OR CHANGED'}, original ${orig === 200 ? 'still on Cloudinary' : 'status ' + orig}`)
    if (same) ok++
  }
  console.log(`${ok}/${rows.length} private copies verified`)
  return ok === rows.length
}

async function revert() {
  const u = await db.query(`UPDATE owner_documents SET storage='cloudinary', url=legacy_url, storage_key=NULL, legacy_url=NULL WHERE legacy_url IS NOT NULL AND storage='sync_private' AND sync_account_id IS NULL`)
  console.log(`${u.rowCount} rows point to Cloudinary again (private copies kept on disk)`)
}

const mode = process.argv[2]
;({ check, copy, verify, revert }[mode] || (async () => console.log('usage: check | copy | verify | revert')))()
  .then(r => process.exit(r === false ? 1 : 0)).catch(e => { console.error(e.message); process.exit(2) })
