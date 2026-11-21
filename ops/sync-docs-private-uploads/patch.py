#!/usr/bin/env python3
"""Confidential owner documents from the CRM and WhatsApp go to private storage (2026-11-21). Usage: patch.py <backend dir> [--check]

routes/crm.js, routes/crmOwnergroups.js, routes/ownerUpload.js   uploadDocBuffer -> storeStaffDocument (virus check, private file)
routes/crmScheduleBoard.js                                      uploadOwnerAttachment -> storeStaffDocument
services/bookRelay.js                                           WhatsApp owner attachments -> storeStaffDocument
The INSERTs stay unchanged: a database trigger completes rows whose url is 'sync-private:<key>'.
CRM answers carry 10-minute links instead of file addresses. CRM edit/delete now protect only the owner's own SYNC
uploads (sync_account_id), so staff keep editing and deleting what staff uploaded; deleting removes the private file.
Listing photos, floor plans and marketing media are untouched (other functions). Exact anchors, line-ending aware,
already-applied spots are skipped, nothing is written unless every anchor matches."""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv
OLD_UPLOAD = ("async function uploadDocBuffer(buffer, mimeType, filename) {\n"
              "  const res = await cloudinary.uploader.upload(`data:${mimeType};base64,${buffer.toString('base64')}`, {\n"
              "    folder: '2906-owner-documents',\n"
              "    resource_type: 'auto',\n"
              "    filename_override: filename,\n"
              "    use_filename: true,\n"
              "  })\n"
              "  return res.secure_url\n"
              "}\n")
NEW_UPLOAD = ("// Owner documents are confidential: private ARGUS storage with a virus check, never a public link (2026-11-21).\n"
              "async function uploadDocBuffer(buffer, mimeType, filename) {\n"
              "  return require('../services/syncDocuments').storeStaffDocument(buffer, mimeType, filename)\n"
              "}\n")
SD = "require('../services/syncDocuments')"
EDITS = {
    'routes/crm.js': [
        (OLD_UPLOAD, NEW_UPLOAD),
        ("         RETURNING id, filename, url, uploaded_by, created_at, category, property_id, notes`,\n"
         "        [ownerId, f.originalname, url, uploadedBy, category, propertyId, notes])\n"
         "      inserted.push(r.rows[0])\n",
         "         RETURNING id, filename, url, uploaded_by, created_at, category, property_id, notes, storage, visibility, deleted_at`,\n"
         "        [ownerId, f.originalname, url, uploadedBy, category, propertyId, notes])\n"
         f"      inserted.push({SD}.staffDocumentRows(r.rows)[0])\n"),
        ("AND owner_contact_id = $${params.length} AND storage = 'cloudinary'\n"
         "       RETURNING id, filename, url, uploaded_by, created_at, category, property_id, notes`, params)\n",
         "AND owner_contact_id = $${params.length} AND sync_account_id IS NULL\n"
         "       RETURNING id, filename, url, uploaded_by, created_at, category, property_id, notes, storage, visibility, deleted_at`, params)\n"),
        ("    res.json({ ok: true, document: r.rows[0] })\n",
         f"    res.json({{ ok: true, document: {SD}.staffDocumentRows(r.rows)[0] || r.rows[0] }})\n"),
        ("    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2 AND storage = 'cloudinary'`,\n"
         "      [parseInt(req.params.docId), parseInt(req.params.id)])\n",
         "    const gone = await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2 AND sync_account_id IS NULL RETURNING storage, storage_key`,\n"
         "      [parseInt(req.params.docId), parseInt(req.params.id)])\n"
         f"    {SD}.removeStoredFiles(gone.rows)\n"),
    ],
    'routes/crmOwnergroups.js': [
        (OLD_UPLOAD, NEW_UPLOAD),
        ("        `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id, filename, url, uploaded_by, created_at`,\n"
         "        [state.owner_contact_id, f.originalname, url, a.username])\n"
         "      saved.push(ins.rows[0])\n",
         "        `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id, filename, url, uploaded_by, created_at, storage, visibility, deleted_at`,\n"
         "        [state.owner_contact_id, f.originalname, url, a.username])\n"
         f"      saved.push({SD}.staffDocumentRows(ins.rows)[0])\n"),
        ("    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2 AND storage = 'cloudinary'`, [parseInt(req.params.docId), state.owner_contact_id])\n",
         "    const gone = await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2 AND sync_account_id IS NULL RETURNING storage, storage_key`, [parseInt(req.params.docId), state.owner_contact_id])\n"
         f"    {SD}.removeStoredFiles(gone.rows)\n"),
    ],
    'routes/ownerUpload.js': [(OLD_UPLOAD, NEW_UPLOAD)],
    'routes/crmScheduleBoard.js': [
        ("async function uploadOwnerAttachment(file) {\n"
         "  const uploaded = await cloudinary.uploader.upload(\n"
         "    `data:${file.mimetype || 'application/octet-stream'};base64,${file.buffer.toString('base64')}`,\n"
         "    { folder: '2906-owner-documents', resource_type: 'auto',\n"
         "      filename_override: file.originalname, use_filename: true })\n"
         "  return uploaded.secure_url\n"
         "}\n",
         "// Owner documents are confidential: private ARGUS storage with a virus check, never a public link (2026-11-21).\n"
         "async function uploadOwnerAttachment(file) {\n"
         f"  return {SD}.storeStaffDocument(file.buffer, file.mimetype, file.originalname)\n"
         "}\n"),
    ],
    'services/bookRelay.js': [
        ("  const cloudinary = require('cloudinary').v2\n"
         "  const uploaded = await cloudinary.uploader.upload(\n"
         "    `data:${mime};base64,${media.buffer.toString('base64')}`,\n"
         "    { folder: '2906-owner-documents', resource_type: 'auto', filename_override: filename, use_filename: true })\n"
         "  await db.query(\n"
         "    `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, property_id, notes)\n"
         "     VALUES ($1,$2,$3,'owner-whatsapp',$4,'Received in owner relay chat')`,\n"
         "    [thread.owner_id, filename, uploaded.secure_url, thread.property_id])\n"
         "  return { filename, url: uploaded.secure_url }\n",
         "  // confidential: private ARGUS storage with a virus check, never a public link (2026-11-21)\n"
         "  const url = await require('./syncDocuments').storeStaffDocument(media.buffer, mime, filename)\n"
         "  await db.query(\n"
         "    `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, property_id, notes)\n"
         "     VALUES ($1,$2,$3,'owner-whatsapp',$4,'Received in owner relay chat')`,\n"
         "    [thread.owner_id, filename, url, thread.property_id])\n"
         "  return { filename, url }\n"),
    ],
}

plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')):
            print(f'already applied in {rel}: {old[:50]!r}'); continue
        hit = None
        for nl in ('\n', '\r\n'):
            o, n = old.replace('\n', nl), new.replace('\n', nl)
            c = text.count(o)
            if c == 1: hit = (o, n); break
            if c > 1: print(f'ANCHOR {c}x in {rel}: {old[:70]!r}'); sys.exit(1)
        if not hit: print(f'ANCHOR 0x in {rel}: {old[:70]!r}'); sys.exit(1)
        text = text.replace(hit[0], hit[1])
    plan.append((path, text))
if check: print('anchors ok'); sys.exit(0)
for path, text in plan:
    open(path, 'wb').write(text.encode('utf-8'))
    print('patched', path)
