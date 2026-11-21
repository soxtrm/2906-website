'use strict'
// ============================================================================
// services/syncDocuments.js — private owner documents in NEXUS SYNC (Claude, 2026-11-21).
//
// Reuses ARGUS owner_documents (same table the CRM uses) with storage 'sync_private':
//   • files live on the ARGUS server in private-docs/ (never under /uploads, never on
//     Cloudinary): no public URL exists. The owner downloads through the signed SYNC
//     service; staff only through a link that expires after 10 minutes, and only after
//     the owner shared the document.
//   • only PDF, JPEG, PNG and WebP, checked by their actual bytes, up to 3 MB. PDFs
//     with active content (JavaScript, launch actions, embedded files, forms with
//     scripts) are refused. No virus scanner runs on the server yet (see report).
//   • new documents are private; the owner shares or un-shares; deleting removes the
//     file at once and keeps an audit line (no content).
//   • owners only: representatives do not see documents.
//   • quarantine: every new file is 'pending' until ClamAV (clamd, CLAMD_HOST:3310) reports it clean.
//     Pending or failed files are never opened, downloaded or shared; an infected file is removed at once.
//     If the scanner is down the file simply stays pending; rescanPending() (cron) checks it later.
// ============================================================================
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('../db')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { audit, AGENCY_KEY } = L._internal
const err = (code, message, status = 400) => new LinkError(code, message, status)

const DIR = () => process.env.SYNC_PRIVATE_DOCS_DIR || path.join(__dirname, '..', 'private-docs')
const MAX_BYTES = 3 * 1024 * 1024
const CATEGORIES = ['contract', 'id', 'energy_certificate', 'insurance', 'inventory', 'invoice', 'floor_plan', 'permit', 'other']
const STAFF_LINK_MIN = 10
// Documents stay switched off until the founder enables them after the safeguards are in place
// (scanning, encrypted backups). Off: every document call answers 503 and nothing is stored or served.
const enabled = () => process.env.SYNC_DOCUMENTS_ENABLED === '1'
function requireEnabled() { if (!enabled()) throw err('DOCUMENTS_NOT_ENABLED', 'Documents are being secured and will open soon. Nothing was stored.', 503) }
const PUBLIC_API = () => String(process.env.SYNC_STAFF_FILE_ORIGIN || 'https://api.2906.estate').replace(/\/+$/, '')

function sniff(buf) {
  if (buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' }
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  return null
}
// Active PDF content that has no place in a lease or a certificate.
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|AA|OpenAction\s*<<[^>]*\/S\s*\/JavaScript|SubmitForm|ImportData|GoToR)\b/
function pdfProblem(buf) {
  const s = buf.toString('latin1')
  if (PDF_ACTIVE.test(s)) return 'This PDF contains scripts or embedded files and cannot be stored. Please save it as a plain PDF (print to PDF) and try again.'
  if (/\/ObjStm\b/.test(s) && /\/Filter\s*\/FlateDecode/.test(s) && /\/(JavaScript|JS)/i.test(s)) return 'This PDF cannot be checked. Please print it to a plain PDF.'
  return null
}
// ── virus check: clamd INSTREAM over TCP ─────────────────────────────────────
const net = require('net')
function clamdScan(buf, { host = process.env.CLAMD_HOST || 'argus-clamav', port = Number(process.env.CLAMD_PORT || 3310), timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    let out = '', settled = false
    const done = (e, v) => { if (settled) return; settled = true; sock.destroy(); if (e) reject(e); else resolve(v) }
    sock.setTimeout(timeoutMs, () => done(new Error('clamd timeout')))
    sock.on('error', e => done(e))
    sock.on('data', d => { out += d.toString('latin1') })
    sock.on('close', () => {
      const r = out.replace(/\0/g, '').trim()
      if (/: OK$/.test(r)) return done(null, { clean: true })
      const m = r.match(/: (.+) FOUND$/)
      if (m) return done(null, { clean: false, signature: m[1].slice(0, 120) })
      done(new Error(`clamd answered: ${r.slice(0, 120) || 'nothing'}`))
    })
    sock.on('connect', () => {
      sock.write('zINSTREAM\0')
      for (let i = 0; i < buf.length; i += 65536) { const c = buf.subarray(i, i + 65536); const h = Buffer.alloc(4); h.writeUInt32BE(c.length); sock.write(h); sock.write(c) }
      sock.write(Buffer.alloc(4))
    })
  })
}
let scanner = clamdScan
/** Scans a stored document and records the result. Returns 'clean' | 'infected' | 'pending'. */
async function scanStored(d) {
  let res
  try { res = await scanner(fs.readFileSync(path.join(DIR(), d.storage_key))) } catch (e) { return 'pending' }
  if (res.clean) {
    await db.query(`UPDATE owner_documents SET scan_state='clean', scanned_at=NOW() WHERE id=$1`, [d.id])
    return 'clean'
  }
  try { fs.unlinkSync(path.join(DIR(), d.storage_key)) } catch { /* already gone */ }
  await db.query(`UPDATE owner_documents SET scan_state='infected', scan_signature=$2, scanned_at=NOW(), deleted_at=NOW(), visibility='private', shared_at=NULL, url='sync-deleted' WHERE id=$1`, [d.id, res.signature])
  await audit(db, null, 'SYNC_DOCUMENT_INFECTED', { document: d.id, signature: res.signature }, d.property_id ? { id: d.property_id } : null)
  return 'infected'
}
/** Cron: files that could not be checked at upload time (scanner down). */
async function rescanPending({ limit = 50 } = {}) {
  const { rows } = await db.query(`SELECT * FROM owner_documents WHERE storage='sync_private' AND scan_state='pending' AND deleted_at IS NULL AND created_at < NOW() - interval '1 minute' ORDER BY id LIMIT $1`, [limit])
  const out = { checked: 0, clean: 0, infected: 0, pending: 0 }
  for (const d of rows) { const r = await scanStored(d); out.checked++; out[r]++ }
  return out
}
const notChecked = d => { if (d.scan_state !== 'clean') throw err('DOCUMENT_NOT_CHECKED', 'This document is still being checked for viruses. Try again in a minute.', 409) }

const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

async function ownerContactFor(S, account, propertyId) {
  const own = await S.ownedProperties(account)
  if (propertyId !== undefined && propertyId !== null && propertyId !== '') {
    const p = own.find(x => x.id === Number(propertyId))
    if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
    return { ownerContactId: p.owner_contact_id, propertyId: p.id, ref: p.ref }
  }
  const { rows } = await db.query(`SELECT owner_contact_id FROM nexus_owner_links WHERE agency_key=$1 AND nexus_account_ref=$2 AND link_state='verified' ORDER BY id`, [AGENCY_KEY(), `sync:${account.public_id}`])
  if (!rows.length) throw err('OWNER_LINK_NOT_VERIFIED', 'An agent has to confirm your homes first.', 409)
  return { ownerContactId: rows[0].owner_contact_id, propertyId: null, ref: null }
}
async function ownerContactIds(account) {
  const { rows } = await db.query(`SELECT owner_contact_id FROM nexus_owner_links WHERE agency_key=$1 AND nexus_account_ref=$2 AND link_state='verified'`, [AGENCY_KEY(), `sync:${account.public_id}`])
  return rows.map(r => r.owner_contact_id)
}
const view = r => ({ id: r.id, title: r.filename, category: r.category, propertyId: r.property_id, mime: r.mime, size: r.size_bytes, shared: r.visibility === 'agency', sharedAt: r.shared_at, createdAt: r.created_at, scanState: r.scan_state || 'pending' })

async function upload(S, account, { propertyId, category, title, dataBase64 }) {
  requireEnabled()
  if (!CATEGORIES.includes(category)) throw err('CATEGORY_INVALID', 'Choose what kind of document this is.')
  const name = cleanName(title)
  if (!name) throw err('TITLE_INVALID', 'Give the document a name.')
  if (typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) throw err('FILE_TOO_LARGE', 'Files can be up to 3 MB.', 413)
  const buf = Buffer.from(dataBase64, 'base64')
  if (!buf.length || buf.length > MAX_BYTES) throw err('FILE_TOO_LARGE', 'Files can be up to 3 MB.', 413)
  const kind = sniff(buf)
  if (!kind) throw err('FILE_TYPE', 'Only PDF, JPG, PNG or WebP files.', 415)
  if (kind.mime === 'application/pdf') { const p = pdfProblem(buf); if (p) throw err('FILE_UNSAFE', p, 422) }
  const owner = await ownerContactFor(S, account, propertyId)
  const { rows: [{ n, recent }] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)::int n, COUNT(*) FILTER (WHERE created_at > NOW() - interval '1 hour')::int recent
       FROM owner_documents WHERE sync_account_id=$1`, [account.id])
  if (n >= 200) throw err('TOO_MANY', 'You can keep up to 200 documents.', 429)
  if (recent >= 30) throw err('TOO_MANY', 'Too many uploads. Please wait a little.', 429)
  const key = `${crypto.randomUUID()}.${kind.ext}`
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(DIR(), key), buf, { mode: 0o600, flag: 'wx' })
  try {
    const { rows: [d] } = await db.query(
      `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, category, property_id, visibility, storage, storage_key, mime, size_bytes, sha256, sync_account_id, scan_state)
       VALUES ($1,$2,$3,'owner-sync',$4,$5,'private','sync_private',$6,$7,$8,$9,$10,'pending') RETURNING *`,
      [owner.ownerContactId, name, `sync-private:${key}`, category, owner.propertyId, key, kind.mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), account.id])
    await audit(db, null, 'SYNC_DOCUMENT_UPLOADED', { account: account.public_id, document: d.id, category }, owner.propertyId ? { id: owner.propertyId, ref: owner.ref } : null)
    const state = await scanStored(d)
    if (state === 'infected') throw err('FILE_INFECTED', 'This file failed the virus check and was not stored.', 422)
    return { document: view({ ...d, scan_state: state }) }
  } catch (e) { if (e.code !== 'FILE_INFECTED') { try { fs.unlinkSync(path.join(DIR(), key)) } catch { /* */ } } throw e }
}

async function mine(account, id, { forUpdate = false } = {}) {
  const ids = await ownerContactIds(account)
  const { rows: [d] } = await db.query(
    `SELECT * FROM owner_documents WHERE id=$1 AND storage='sync_private' AND deleted_at IS NULL AND owner_contact_id = ANY($2::int[])${forUpdate ? ' FOR UPDATE' : ''}`, [Number(id) || 0, ids])
  if (!d) throw err('DOCUMENT_NOT_FOUND', 'Document not found.', 404)
  return d
}

async function list(account) {
  requireEnabled()
  const ids = await ownerContactIds(account)
  if (!ids.length) return { documents: [] }
  const { rows } = await db.query(`SELECT * FROM owner_documents WHERE storage='sync_private' AND deleted_at IS NULL AND owner_contact_id = ANY($1::int[]) ORDER BY created_at DESC LIMIT 200`, [ids])
  return { documents: rows.map(view), categories: CATEGORIES }
}

async function file(account, { id }) {
  requireEnabled()
  const d = await mine(account, id)
  notChecked(d)
  const buf = fs.readFileSync(path.join(DIR(), d.storage_key))
  return { file: { name: d.filename, mime: d.mime, size: buf.length, dataBase64: buf.toString('base64') } }
}

async function share(account, { id, share: on }) {
  requireEnabled()
  const d = await mine(account, id)
  if (on) notChecked(d)
  const vis = on ? 'agency' : 'private'
  await db.query(`UPDATE owner_documents SET visibility=$2, shared_at=CASE WHEN $2='agency' THEN NOW() ELSE NULL END WHERE id=$1`, [d.id, vis])
  await audit(db, null, on ? 'SYNC_DOCUMENT_SHARED' : 'SYNC_DOCUMENT_UNSHARED', { account: account.public_id, document: d.id }, d.property_id ? { id: d.property_id } : null)
  return { document: view({ ...d, visibility: vis, shared_at: on ? new Date() : null }) }
}

async function remove(account, { id }) {
  requireEnabled()
  const d = await mine(account, id)
  try { fs.unlinkSync(path.join(DIR(), d.storage_key)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  await db.query(`UPDATE owner_documents SET deleted_at=NOW(), visibility='private', shared_at=NULL, url='sync-deleted' WHERE id=$1`, [d.id])
  await audit(db, null, 'SYNC_DOCUMENT_DELETED', { account: account.public_id, document: d.id }, d.property_id ? { id: d.property_id } : null)
  return { deleted: true }
}

// ── staff side: shared documents only, through links that expire ────────────
const staffKey = () => { const k = process.env.JWT_SECRET || ''; if (k.length < 16) throw new Error('JWT_SECRET missing'); return k }
const staffSig = (id, exp) => crypto.createHmac('sha256', staffKey()).update(`sync-doc:${id}:${exp}`).digest('base64url')
function staffLink(id) {
  const exp = Math.floor(Date.now() / 1000) + STAFF_LINK_MIN * 60
  return `${PUBLIC_API()}/api/crm/owner-documents/${id}/file?exp=${exp}&sig=${staffSig(id, exp)}`
}
/** CRM lists: private SYNC documents are never in them; shared ones get a 10-minute link instead of a file address. */
function staffDocumentRows(rows) {
  return (rows || []).filter(r => (r.visibility || 'agency') === 'agency' && !r.deleted_at)
    .map(r => { const o = { ...r }; if (r.storage === 'sync_private') o.url = staffLink(r.id); delete o.storage; delete o.visibility; delete o.deleted_at; delete o.storage_key; return o })
}
async function staffFile(id, { exp, sig }) {
  if (!enabled()) return null
  const e = Number(exp)
  if (!Number.isInteger(e) || e < Date.now() / 1000 || e > Date.now() / 1000 + STAFF_LINK_MIN * 60 + 5) return null
  const want = staffSig(Number(id), e)
  if (typeof sig !== 'string' || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null
  const { rows: [d] } = await db.query(`SELECT d.*, a.public_id AS owner_public_id FROM owner_documents d LEFT JOIN sync_accounts a ON a.id=d.sync_account_id
      WHERE d.id=$1 AND d.storage='sync_private' AND d.visibility='agency' AND d.deleted_at IS NULL AND d.scan_state='clean'`, [Number(id) || 0])
  if (!d) return null
  const buf = fs.readFileSync(path.join(DIR(), d.storage_key))
  await audit(db, null, 'SYNC_DOCUMENT_OPENED_BY_AGENCY', { owner: d.owner_public_id, document: d.id }, d.property_id ? { id: d.property_id } : null)
  return { name: d.filename, mime: d.mime, buf }
}
/** Express handler for GET /api/crm/owner-documents/:docId/file?exp=&sig= */
async function staffFileHandler(req, res) {
  try {
    const f = await staffFile(req.params.docId, req.query || {})
    if (!f) return res.status(404).json({ error: 'Link expired or not available. Open the owner profile again.' })
    res.set({ 'Content-Type': f.mime, 'Content-Length': String(f.buf.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `${f.mime === 'application/pdf' || f.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"` })
    res.end(f.buf)
  } catch (e) { res.status(500).json({ error: 'Failed' }) }
}

module.exports = { upload, list, file, share, remove, staffDocumentRows, staffFileHandler, rescanPending, scanStored, clamdScan, CATEGORIES, MAX_BYTES,
  _test: { sniff, pdfProblem, staffLink, staffFile, setScanner: fn => { scanner = fn || clamdScan } } }
