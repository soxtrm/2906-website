'use strict'
// ============================================================================
// Copy owner documents from public Cloudinary links into private ARGUS storage (Claude, 2026-11-21).
//   node /app/scripts/cloudinary-docs-migrate.js check | manifest | copy | verify | report | revert
//   check     which documents are on Cloudinary, type, size, whether the link opens without login
//   manifest  root-only record of every original reference (id -> Cloudinary address), written BEFORE copying
//   copy      download, virus-check (ClamAV), store privately, point the row at the private copy, keep the
//             original address in legacy_url. Floor plans (category 'plan') stay public on purpose. Any type is
//             handled: images open in the browser, Word files and videos are served to staff only as downloads.
//             The Cloudinary original is NOT touched.
//   verify    private file present + checksum, owner/property unchanged vs the manifest, staff link works
//   report    cleanup report: migrated, failed, verified, originals still public, other references to them
//   revert    point migrated rows back to their Cloudinary address (private copies stay on disk)
// Never prints document addresses or contents; the manifest and the report with addresses stay root-only on the server.
// ============================================================================
const crypto = require('crypto'); const fs = require('fs'); const path = require('path')
const ROOT = process.env.BACKEND_DIR || '/app'
const db = require(path.join(ROOT, 'db'))
const SD = require(path.join(ROOT, 'services/syncDocuments'))
const DIR = () => process.env.SYNC_PRIVATE_DOCS_DIR || path.join(ROOT, 'private-docs')
const MANIFEST = () => process.env.MIGRATION_MANIFEST || '/app/private-docs/.cloudinary-manifest.json'
const MAX = 30 * 1024 * 1024
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc' }
// tests only: serve "Cloudinary" from a local server
const fetchUrl = u => { const r = process.env.MIGRATE_URL_REWRITE; if (!r) return u; const [from, to] = r.split('=>'); return u.startsWith(from) ? to + u.slice(from.length) : u }
const legacyRows = () => db.query(`SELECT id, url, category, filename, owner_contact_id, property_id FROM owner_documents WHERE storage='cloudinary' AND COALESCE(category,'') <> 'plan' AND url LIKE 'https://res.cloudinary.com/%' ORDER BY id`)
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const head = u => fetch(fetchUrl(u), { method: 'HEAD' }).then(r => ({ status: r.status, type: (r.headers.get('content-type') || '').split(';')[0], size: Number(r.headers.get('content-length')) || null })).catch(() => ({ status: 0 }))
const log = (...a) => console.log(...a)

async function check() {
  const { rows } = await legacyRows()
  for (const r of rows) { const h = await head(r.url); log(`doc ${r.id}: ${h.status} ${h.type} ${h.size ?? '?'} bytes${h.status === 200 ? '  <- opens without login' : ''}`) }
  log(`${rows.length} documents on Cloudinary (floor plans excluded)`)
  return rows.length
}

async function manifest() {
  const { rows } = await db.query(`SELECT id, url, legacy_url, storage, category, filename, owner_contact_id, property_id, created_at FROM owner_documents WHERE url LIKE 'https://res.cloudinary.com/%' OR legacy_url IS NOT NULL ORDER BY id`)
  const prev = fs.existsSync(MANIFEST()) ? JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')) : {}
  for (const r of rows) prev[r.id] = prev[r.id] || { original: r.legacy_url || r.url, category: r.category, owner_contact_id: r.owner_contact_id, property_id: r.property_id, created_at: r.created_at, recorded_at: new Date().toISOString() }
  fs.mkdirSync(path.dirname(MANIFEST()), { recursive: true, mode: 0o700 })
  fs.writeFileSync(MANIFEST(), JSON.stringify(prev, null, 1), { mode: 0o600 })
  log(`manifest: ${Object.keys(prev).length} original references recorded (root only)`)
  return Object.keys(prev).length
}

async function copy() {
  if (!fs.existsSync(MANIFEST())) throw new Error('run "manifest" first')
  const known = JSON.parse(fs.readFileSync(MANIFEST(), 'utf8'))
  const { rows } = await legacyRows()
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 })
  const out = { copied: 0, failed: [] }
  for (const r of rows) {
    if (!known[r.id]) { out.failed.push([r.id, 'not in manifest']); log(`doc ${r.id}: not in the manifest, left unchanged`); continue }
    try {
      const res = await fetch(fetchUrl(r.url))
      if (!res.ok) throw new Error(`download ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > MAX) throw new Error(`size ${buf.length}`)
      const mime = String(res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
      const scan = await SD.scanBuffer(buf)   // ClamAV in production
      if (!scan.clean) throw new Error(`virus check failed (${scan.signature})`)
      const key = `${crypto.randomUUID()}.${EXT[mime] || 'bin'}`
      fs.writeFileSync(path.join(DIR(), key), buf, { mode: 0o600, flag: 'wx' })
      const u = await db.query(
        `UPDATE owner_documents SET storage='sync_private', storage_key=$2, mime=$3, size_bytes=$4, sha256=$5, scan_state='clean', scanned_at=NOW(),
                legacy_url=url, url='sync-private:' || $2 WHERE id=$1 AND storage='cloudinary' AND url=$6`, [r.id, key, mime, buf.length, sha(buf), r.url])
      if (!u.rowCount) { fs.unlinkSync(path.join(DIR(), key)); throw new Error('row changed meanwhile') }
      await db.query(`INSERT INTO agent_activity_log (actor_role, actor_display_name, action_type, target_property_id, details) VALUES ('system','cloudinary-migration','OWNER_DOCUMENT_MADE_PRIVATE',$2,$1::jsonb)`,
        [JSON.stringify({ document: r.id, bytes: buf.length, mime }), r.property_id])
      log(`doc ${r.id}: private copy stored (${mime}, ${buf.length} bytes, virus check clean)`); out.copied++
    } catch (e) { out.failed.push([r.id, e.message]); log(`doc ${r.id}: NOT migrated, row unchanged (${e.message})`) }
  }
  log(`${out.copied}/${rows.length} copied, ${out.failed.length} left unchanged`)
  return out
}

async function verify() {
  const known = fs.existsSync(MANIFEST()) ? JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')) : {}
  const { rows } = await db.query(`SELECT * FROM owner_documents WHERE legacy_url IS NOT NULL ORDER BY id`)
  const res = []
  for (const r of rows) {
    const p = path.join(DIR(), r.storage_key || '')
    const file = !!r.storage_key && fs.existsSync(p) && sha(fs.readFileSync(p)) === r.sha256
    const m = known[r.id]
    const meta = !!m && Number(m.owner_contact_id) === Number(r.owner_contact_id) && (m.property_id ?? null) === (r.property_id ?? null) && m.original === r.legacy_url
    const listed = SD.staffDocumentRows([r])[0]
    let staff = false
    if (listed) {
      const u = new URL(listed.url)
      const f = await SD._test.staffFile(r.id, { exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') })
      staff = !!f && sha(f.buf) === r.sha256
    }
    log(`doc ${r.id}: private file ${file ? 'ok' : 'MISSING/CHANGED'}, owner+property ${meta ? 'unchanged' : 'DIFFERENT'}, staff link ${staff ? 'works' : 'FAILS'}, ${r.visibility === 'agency' ? 'visible in the CRM' : 'not in the CRM'}`)
    res.push({ id: r.id, ok: file && meta && staff })
  }
  log(`${res.filter(x => x.ok).length}/${res.length} private replacements verified`)
  return res
}

// every text column of every table, once, for the Cloudinary ids of the originals (owner_documents itself excluded)
async function references(ids) {
  if (!ids.length) return {}
  const { rows: cols } = await db.query(`SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema
     WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.data_type IN ('text','character varying','jsonb','json') AND c.table_name <> 'owner_documents'`)
  const re = ids.map(x => x.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const hits = {}
  for (const c of cols) {
    try {
      const { rows } = await db.query(`SELECT substring("${c.column_name}"::text from $1) AS m, COUNT(*)::int n FROM "${c.table_name}" WHERE "${c.column_name}"::text ~ $1 GROUP BY 1`, [`(${re})`])
      for (const r of rows) { const id = ids.find(x => x.token === r.m)?.id; if (id) (hits[id] = hits[id] || []).push(`${c.table_name}.${c.column_name} (${r.n})`) }
    } catch { /* column type without ~ */ }
  }
  return hits
}

async function report() {
  const known = fs.existsSync(MANIFEST()) ? JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')) : {}
  const ver = await verify()
  const { rows: still } = await legacyRows()
  const ids = Object.entries(known).map(([id, m]) => ({ id: Number(id), url: m.original, token: (m.original.split('/upload/')[1] || '').replace(/^v\d+\//, '').replace(/\.[a-z0-9]+$/i, '') })).filter(x => x.token)
  const refs = await references(ids)
  const lines = []
  for (const x of ids) {
    const h = await head(x.url)
    const v = ver.find(y => y.id === x.id)
    lines.push({ id: x.id, migrated: !!v, verified: !!v?.ok, notMigrated: still.some(s => s.id === x.id), originalPublic: h.status === 200, originalStatus: h.status, otherReferences: refs[x.id] || [] })
  }
  const full = { at: new Date().toISOString(), documents: lines.map(l => ({ ...l, original: known[l.id].original })) }
  const out = path.join(path.dirname(MANIFEST()), '.cloudinary-cleanup-report.json')
  fs.writeFileSync(out, JSON.stringify(full, null, 1), { mode: 0o600 })
  for (const l of lines) log(`doc ${l.id}: ${l.migrated ? (l.verified ? 'migrated + verified' : 'migrated, NOT verified') : 'NOT migrated'} | original ${l.originalPublic ? 'STILL PUBLIC' : 'status ' + l.originalStatus} | other references: ${l.otherReferences.length ? l.otherReferences.join(', ') : 'none'}`)
  log(`report with the original addresses: ${out} (root only)`)
  return lines
}

async function revert() {
  const u = await db.query(`UPDATE owner_documents SET storage='cloudinary', url=legacy_url, storage_key=NULL, legacy_url=NULL, scan_state=NULL WHERE legacy_url IS NOT NULL AND storage='sync_private' AND sync_account_id IS NULL`)
  log(`${u.rowCount} rows point to Cloudinary again (private copies kept on disk)`)
  return u.rowCount
}

module.exports = { check, manifest, copy, verify, report, revert }
if (require.main === module) {
  const fn = module.exports[process.argv[2]]
  ;(fn || (async () => log('usage: check | manifest | copy | verify | report | revert')))()
    .then(r => process.exit(Array.isArray(r) && r.some(x => x.ok === false) ? 1 : 0)).catch(e => { console.error(e.message); process.exit(2) })
}
