'use strict'
// ============================================================================
// services/dealRoomDocs.js — NEXUS Deal Room M5 (Claude, 2026-11-21)
//
// Documents & evidence, generated drafts and payment requests inside a Deal Room.
//   files      the existing private ARGUS store (SYNC_PRIVATE_DOCS_DIR / private-docs, folder deal-rooms/): never
//              public, mode 0600, real-bytes type check, script-free PDFs only, ClamAV (syncDocuments.scanBuffer).
//              Pending (scanner down) files are never served; the next download re-checks them. SHA-256 + version
//              + uploader + server time are kept; device capture data is stored as reported, never as proof, no GPS.
//   access     the client (conversation token) sees and downloads only documents meant for the parties; staff see
//              all; every download (and every refused one) is logged.
//   drafts     contract and invoice drafts are generated server-side from the Deal Room's real data and the agent's
//              terms, versioned, clearly marked DRAFT; nothing is signed or sent here.
//   payments   requests with explicit states requested -> initiated -> pending -> verified / failed / refunded /
//              cancelled. "verified" needs a provider event or an admin's manual reconciliation with a reference.
//              NEXUS holds no money; a request never claims a payment was received.
// ============================================================================
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('../db')
const D = require('./dealRooms')

class DocError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status } }
const fail = (code, message, status) => { throw new DocError(code, message, status) }
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const DIR = () => path.join(process.env.SYNC_PRIVATE_DOCS_DIR || path.join(__dirname, '..', 'private-docs'), 'deal-rooms')
const MAX = 10 * 1024 * 1024
let scan = b => require('./syncDocuments').scanBuffer(b)

const VISITOR_KINDS = ['photo', 'video', 'document', 'condition_evidence', 'signed_document']
const STAFF_KINDS = [...VISITOR_KINDS]
function sniff(buf) {
  const s4 = buf.slice(0, 4).toString('latin1')
  if (buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' }
  if (s4 === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') { const b = buf.slice(8, 12).toString('latin1'); return b.startsWith('qt') ? { mime: 'video/quicktime', ext: 'mov' } : /^(heic|heix|mif1)/.test(b) ? { mime: 'image/heic', ext: 'heic' } : { mime: 'video/mp4', ext: 'mp4' } }
  return null
}
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm|ImportData|GoToR)\b/

// ── who is asking ───────────────────────────────────────────────────────────────
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')
async function visitorRoom(convId, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(convId || '')) || !token) fail('NOT_FOUND', 'Not found.', 404)
  const { rows: [c] } = await db.query(`SELECT * FROM mp_conversations WHERE id=$1`, [convId])
  if (!c || !crypto.timingSafeEqual(Buffer.from(c.token_hash), Buffer.from(sha(token)))) fail('NOT_FOUND', 'Not found.', 404)
  const { rows: [room] } = await db.query(`SELECT * FROM deal_rooms WHERE conversation_id=$1 ORDER BY (stage IN ('completed','cancelled')), created_at DESC LIMIT 1`, [c.id])
  if (!room) fail('NO_DEAL_ROOM', 'There is no Deal Room for this conversation yet.', 404)
  return { room, conv: c }
}
const who = actor => actor.kind === 'staff' ? { actor: 'staff', agentId: actor.agent.id } : { actor: 'visitor', agentId: null }
async function roomOf(actor, id) { return actor.kind === 'staff' ? (await D.roomFor(actor.agent, id)).room : (await visitorRoom(actor.convId, actor.token)).room }

// ── documents ─────────────────────────────────────────────────────────────────
async function upload(actor, roomId, { kind, title, filename, dataBase64, captureMeta, visibility }) {
  const room = await roomOf(actor, roomId)
  if (['completed', 'cancelled'].includes(room.stage)) fail('ROOM_CLOSED', 'This Deal Room is closed.', 409)
  const kinds = actor.kind === 'staff' ? STAFF_KINDS : VISITOR_KINDS
  if (!kinds.includes(kind)) fail('KIND_INVALID', 'Choose photo, video, document, condition evidence or signed document.')
  const buf = Buffer.from(String(dataBase64 || '').replace(/^data:[^,]*,/, ''), 'base64')
  if (!buf.length) fail('FILE_REQUIRED', 'Choose a file.')
  if (buf.length > MAX) fail('FILE_TOO_LARGE', 'Files up to 10 MB.')
  const t = sniff(buf); if (!t) fail('TYPE_NOT_ALLOWED', 'Photos (JPEG, PNG, WebP, HEIC), videos (MP4, MOV) or PDF only.')
  if (t.mime === 'application/pdf' && PDF_ACTIVE.test(buf.toString('latin1'))) fail('PDF_ACTIVE', 'This PDF contains scripts or embedded files. Please save it as a plain PDF.')
  let res = null; try { res = await scan(buf) } catch { res = null }   // scanner down: stored as pending, never served until clean
  if (res && !res.clean) fail('INFECTED', 'The virus check rejected this file. Nothing was stored.', 422)
  const key = `${crypto.randomUUID()}.${t.ext}`
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(DIR(), key), buf, { mode: 0o600, flag: 'wx' })
  const meta = captureMeta && typeof captureMeta === 'object' ? Object.fromEntries(Object.entries(captureMeta).filter(([k]) => ['capturedAt', 'device', 'camera'].includes(k)).map(([k, v]) => [k, clean(v, 80)])) : {}
  const w = who(actor)
  const vis = actor.kind === 'staff' && visibility === 'staff' ? 'staff' : 'parties'
  const { rows: [d] } = await db.query(
    `INSERT INTO deal_room_documents (deal_room_id, kind, title, filename, mime, size_bytes, sha256, storage_key, actor, agent_id, visibility, scan_state, capture_meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
    [room.id, kind, clean(title, 160) || clean(filename, 160) || kind, clean(filename, 160) || null, t.mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), key, w.actor, w.agentId, vis, res ? 'clean' : 'pending', JSON.stringify(meta)])
  await D.event(db, room.id, { kind: 'document_added', actor: w.actor, agentId: w.agentId, visibility: vis, data: { documentId: Number(d.id), kind, title: clean(title, 160) || kind } })
  return { documentId: Number(d.id) }
}

async function documentsOf(roomId, audience) {
  const { rows } = await db.query(
    `SELECT d.id, d.kind, d.title, d.filename, d.mime, d.size_bytes, d.sha256, d.version, d.actor, d.visibility, d.scan_state, d.capture_meta, d.created_at, a.name AS agent_name, a.alias AS agent_alias,
            (SELECT count(*) FROM deal_room_document_access x WHERE x.document_id=d.id AND x.action='download') AS downloads
       FROM deal_room_documents d LEFT JOIN agents a ON a.id = d.agent_id
      WHERE d.deal_room_id=$1 AND d.deleted_at IS NULL ${audience === 'staff' ? '' : `AND d.visibility='parties'`} ORDER BY d.id`, [roomId])
  return rows.map(d => ({ id: Number(d.id), kind: d.kind, title: d.title, filename: d.filename, mime: d.mime, size: d.size_bytes, version: d.version,
    from: d.actor === 'visitor' ? 'client' : d.agent_alias || d.agent_name || 'agency', internal: d.visibility === 'staff', scan: d.scan_state, at: d.created_at,
    ...(audience === 'staff' ? { sha256: d.sha256, captureMeta: d.capture_meta, downloads: Number(d.downloads) } : {}) }))
}

async function download(actor, roomId, docId) {
  const room = await roomOf(actor, roomId)
  const { rows: [d] } = await db.query(`SELECT * FROM deal_room_documents WHERE id=$1 AND deal_room_id=$2 AND deleted_at IS NULL`, [Number(docId) || 0, room.id])
  const w = who(actor)
  if (!d || (actor.kind !== 'staff' && d.visibility !== 'parties')) {
    if (d) await db.query(`INSERT INTO deal_room_document_access (document_id, actor, agent_id, action) VALUES ($1,$2,$3,'refused')`, [d.id, w.actor, w.agentId])
    fail('NOT_FOUND', 'Document not found.', 404)
  }
  if (d.body != null) {   // generated draft
    await db.query(`INSERT INTO deal_room_document_access (document_id, actor, agent_id, action) VALUES ($1,$2,$3,'download')`, [d.id, w.actor, w.agentId])
    return { mime: 'text/html; charset=utf-8', filename: `${d.kind.replace('_', '-')}-v${d.version}.html`, buffer: Buffer.from(d.body, 'utf8') }
  }
  let buf; try { buf = fs.readFileSync(path.join(DIR(), d.storage_key)) } catch { fail('FILE_MISSING', 'The file is not available.', 410) }
  if (d.scan_state === 'pending') {
    let res = null; try { res = await scan(buf) } catch { res = null }
    if (!res) fail('SCAN_PENDING', 'This file is still being checked. Try again in a few minutes.', 409)
    if (!res.clean) { try { fs.unlinkSync(path.join(DIR(), d.storage_key)) } catch { /* */ } await db.query(`UPDATE deal_room_documents SET scan_state='infected', deleted_at=now() WHERE id=$1`, [d.id]); fail('INFECTED', 'The virus check rejected this file; it was removed.', 410) }
    await db.query(`UPDATE deal_room_documents SET scan_state='clean' WHERE id=$1`, [d.id])
  } else if (d.scan_state !== 'clean') fail('NOT_AVAILABLE', 'This file is not available.', 410)
  if (crypto.createHash('sha256').update(buf).digest('hex') !== d.sha256) fail('INTEGRITY', 'The stored file does not match its fingerprint and is not served.', 409)
  await db.query(`INSERT INTO deal_room_document_access (document_id, actor, agent_id, action) VALUES ($1,$2,$3,'download')`, [d.id, w.actor, w.agentId])
  return { mime: d.mime, filename: d.filename || `document-${d.id}`, buffer: buf }
}

async function remove(agent, roomId, docId) {
  const { room } = await D.roomFor(agent, roomId)
  const u = await db.query(`UPDATE deal_room_documents SET deleted_at=now() WHERE id=$1 AND deal_room_id=$2 AND deleted_at IS NULL RETURNING id, title, storage_key, visibility`, [Number(docId) || 0, room.id])
  if (!u.rows[0]) fail('NOT_FOUND', 'Document not found.', 404)
  if (u.rows[0].storage_key) { try { fs.unlinkSync(path.join(DIR(), u.rows[0].storage_key)) } catch { /* */ } }
  await D.event(db, room.id, { kind: 'document_removed', actor: 'staff', agentId: agent.id, visibility: u.rows[0].visibility, data: { documentId: Number(docId), title: u.rows[0].title } })
}

// ── generated drafts ──────────────────────────────────────────────────────────
const eur = c => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const cents = v => { const n = Math.round(Number(String(v ?? '').replace(/[^0-9.]/g, '')) * 100); return Number.isFinite(n) && n > 0 && n <= 100000000 ? n : null }
const isoDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null
async function context(room) {
  const { rows: [p] } = room.property_id ? await db.query(`SELECT ref, town, property_type, bedrooms FROM properties WHERE id=$1`, [room.property_id]) : { rows: [] }
  const { rows: [c] } = await db.query(`SELECT visitor_name FROM mp_conversations WHERE id=$1`, [room.conversation_id])
  const { rows: [a] } = room.agent_id ? await db.query(`SELECT name, alias FROM agents WHERE id=$1`, [room.agent_id]) : { rows: [] }
  const home = p ? `${p.bedrooms ? `${p.bedrooms}-Bedroom ` : ''}${p.property_type ? p.property_type[0].toUpperCase() + p.property_type.slice(1) : 'Home'} in ${p.town || 'Malta'} (Ref ${p.ref})` : `Ref ${room.listing_ref}`
  return { home, client: c ? c.visitor_name : 'the client', agent: a ? a.alias || a.name : 'the listing agent' }
}
const page = (title, inner) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}h1{font-size:24px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}.draft{display:inline-block;padding:4px 10px;border:2px solid #c2410c;color:#c2410c;font-weight:800;letter-spacing:.08em}.muted{color:#666;font-size:13px}</style><body>${inner}</body></html>`
async function nextVersion(roomId, kind) { const { rows: [r] } = await db.query(`SELECT id, version FROM deal_room_documents WHERE deal_room_id=$1 AND kind=$2 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`, [roomId, kind]); return r ? { version: r.version + 1, supersedes: r.id } : { version: 1, supersedes: null } }
async function storeDraft(agent, room, kind, title, html, data) {
  const v = await nextVersion(room.id, kind)
  const { rows: [d] } = await db.query(
    `INSERT INTO deal_room_documents (deal_room_id, kind, title, mime, size_bytes, sha256, body, version, supersedes, actor, agent_id, visibility, scan_state)
     VALUES ($1,$2,$3,'text/html',$4,$5,$6,$7,$8,'staff',$9,'parties','not_applicable') RETURNING id`,
    [room.id, kind, title, Buffer.byteLength(html), crypto.createHash('sha256').update(html).digest('hex'), html, v.version, v.supersedes, agent.id])
  await D.event(db, room.id, { kind: 'draft_created', actor: 'staff', agentId: agent.id, data: { documentId: Number(d.id), kind, version: v.version, ...data } })
  return { documentId: Number(d.id), version: v.version }
}
async function contractDraft(agent, roomId, t) {
  const { room } = await D.roomFor(agent, roomId)
  const rent = cents(t.monthlyRent), deposit = cents(t.deposit), start = isoDay(t.startDate), months = Math.min(60, Math.max(1, Number(t.months) || 0))
  if (!rent || !start || !months) fail('TERMS_REQUIRED', 'Monthly rent, start date and term in months are needed for a draft.')
  const x = await context(room)
  const html = page('Lease agreement draft', `<p class="draft">DRAFT · NOT SIGNED · FOR DISCUSSION</p><h1>Lease agreement (draft)</h1>
<p><b>Property:</b> ${esc(x.home)}<br><b>Tenant:</b> ${esc(x.client)}<br><b>Landlord:</b> the owner of the property (identity added when the parties agree to exchange details)<br><b>Prepared by:</b> ${esc(x.agent)}, listing agent</p>
<table><tr><th>Term</th><td>${months} month${months === 1 ? '' : 's'} from ${esc(start)}</td></tr><tr><th>Monthly rent</th><td>${eur(rent)}</td></tr>${deposit ? `<tr><th>Security deposit</th><td>${eur(deposit)}</td></tr>` : ''}${t.notes ? `<tr><th>Further terms</th><td>${esc(clean(t.notes, 1200))}</td></tr>` : ''}</table>
<p class="muted">This draft is generated from the Deal Room for discussion. It is not a binding contract until both parties sign the final version. Malta requires residential private leases to be registered with the Housing Authority.</p>`)
  return storeDraft(agent, room, 'contract_draft', `Lease agreement draft`, html, { monthlyRent: rent, deposit, start, months })
}
async function invoiceDraft(agent, roomId, t) {
  const { room } = await D.roomFor(agent, roomId)
  const items = (Array.isArray(t.items) ? t.items : []).slice(0, 10).map(i => ({ label: clean(i.label, 120), amount: cents(i.amount) })).filter(i => i.label && i.amount)
  if (!items.length) fail('ITEMS_REQUIRED', 'Add at least one line with a label and an amount.')
  const total = items.reduce((s, i) => s + i.amount, 0), due = isoDay(t.dueDate)
  const x = await context(room)
  const html = page('Invoice draft', `<p class="draft">DRAFT · NOT ISSUED · NO PAYMENT RECEIVED</p><h1>Invoice (draft)</h1>
<p><b>For:</b> ${esc(x.client)}<br><b>Regarding:</b> ${esc(x.home)}<br><b>Prepared by:</b> ${esc(x.agent)}${due ? `<br><b>Due:</b> ${esc(due)}` : ''}</p>
<table>${items.map(i => `<tr><td>${esc(i.label)}</td><td style="text-align:right">${eur(i.amount)}</td></tr>`).join('')}<tr><th>Total</th><th style="text-align:right">${eur(total)}</th></tr></table>
<p class="muted">Draft only. NEXUS does not hold or move money. Payment details are given by the agency directly and a payment counts as received only after it is verified.</p>`)
  return storeDraft(agent, room, 'invoice_draft', `Invoice draft`, html, { total, items: items.length })
}

// ── payment requests ──────────────────────────────────────────────────────────
const PAY_LABEL = { requested: 'Requested · not received', initiated: 'Initiated by the client', pending: 'Pending confirmation', verified: 'Verified', failed: 'Failed', refunded: 'Refunded', cancelled: 'Cancelled' }
const PAY_NEXT = { requested: ['initiated', 'pending', 'cancelled'], initiated: ['pending', 'failed', 'cancelled'], pending: ['verified', 'failed'], verified: ['refunded'], failed: ['requested', 'cancelled'], refunded: [], cancelled: [] }
async function paymentsOf(roomId) {
  const { rows } = await db.query(`SELECT * FROM deal_room_payment_requests WHERE deal_room_id=$1 ORDER BY id`, [roomId])
  return rows.map(p => ({ id: Number(p.id), kind: p.kind, label: p.label, amount: p.amount_cents / 100, currency: p.currency, status: p.status, statusLabel: PAY_LABEL[p.status], verifiedVia: p.verified_via, reference: p.reference, updatedAt: p.updated_at, next: PAY_NEXT[p.status] }))
}
async function requestPayment(agent, roomId, { kind, label, amount }) {
  const { room } = await D.roomFor(agent, roomId)
  if (!['deposit', 'first_rent', 'agency_fee', 'other'].includes(kind)) fail('KIND_INVALID', 'Choose deposit, first rent, agency fee or other.')
  const c = cents(amount); if (!c) fail('AMOUNT_INVALID', 'Enter an amount.')
  const { rows: [p] } = await db.query(`INSERT INTO deal_room_payment_requests (deal_room_id, kind, label, amount_cents, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
    [room.id, kind, clean(label, 120) || kind.replace('_', ' '), c, agent.id])
  await D.event(db, room.id, { kind: 'payment_requested', actor: 'staff', agentId: agent.id, data: { paymentId: Number(p.id), kind, amount: c / 100 } })
  return { paymentId: Number(p.id) }
}
async function paymentStatus(agent, roomId, paymentId, { status, reference, note }) {
  const { room } = await D.roomFor(agent, roomId)
  const { rows: [p] } = await db.query(`SELECT * FROM deal_room_payment_requests WHERE id=$1 AND deal_room_id=$2`, [Number(paymentId) || 0, room.id])
  if (!p) fail('NOT_FOUND', 'Payment request not found.', 404)
  if (!(PAY_NEXT[p.status] || []).includes(status)) fail('STATUS_NOT_ALLOWED', `From "${PAY_LABEL[p.status]}" the next state is ${(PAY_NEXT[p.status] || []).map(s => `"${PAY_LABEL[s]}"`).join(' or ') || 'none'}.`, 409)
  const ref = clean(reference, 120) || null
  // "verified" only from a provider event (none connected yet) or an administrator's manual reconciliation with a reference
  if (status === 'verified' && (agent.role !== 'admin' || !ref)) fail('VERIFY_NOT_ALLOWED', 'Only an administrator can mark a payment verified, after reconciling it with a bank or provider reference.', 403)
  const u = await db.query(`UPDATE deal_room_payment_requests SET status=$3, verified_via=CASE WHEN $3='verified' THEN 'manual_reconciliation' ELSE verified_via END,
         reference=COALESCE($4, reference), note=COALESCE($5, note), updated_by=$6, updated_at=now() WHERE id=$1 AND status=$2 RETURNING id`,
    [p.id, p.status, status, ref, clean(note, 600) || null, agent.id])
  if (!u.rows[0]) fail('STATUS_CHANGED', 'Someone changed this payment request a moment ago. Reload it.', 409)
  await D.event(db, room.id, { kind: 'payment_status', actor: 'staff', agentId: agent.id, data: { paymentId: Number(p.id), from: p.status, to: status, via: status === 'verified' ? 'manual_reconciliation' : undefined } })
}

module.exports = { DocError, visitorRoom, upload, documentsOf, download, remove, contractDraft, invoiceDraft, paymentsOf, requestPayment, paymentStatus,
  _test: { setScanner: fn => { scan = fn }, sniff } }
