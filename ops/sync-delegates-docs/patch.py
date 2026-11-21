#!/usr/bin/env python3
"""SYNC representatives + private owner documents (2026-11-21). Usage: patch.py <backend dir> [--check]

services/syncAccount.js   representatives: ownedProperties(account, perm) also returns homes delegated with that
                          permission; viewings need 'view', viewing decisions and hours 'schedule', availability and
                          price proposals 'edit' (through the owner's link); the owner's conversation about a given
                          home needs 'message'; /me lists represented homes with role and permissions.
routes/syncAccountService.js  signed routes for representatives and documents.
routes/crm.js             owner profile: private SYNC documents never listed, shared ones only with a 10-minute link;
                          CRM cannot edit or delete an owner's own SYNC documents; the expiring file route.
routes/crmOwnergroups.js  same rule for the owner-group documents list and delete.
Each anchor must match exactly once; the line endings of the matched spot are kept (crm.js mixes CRLF and LF)."""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv

SA = 'services/syncAccount.js'
EDITS = {
    SA: [
        ("async function ownedProperties(account) {\n",
         "async function ownedProperties(account, perm = null) {\n"),
        ("        AND p.archived_at IS NULL AND NOT COALESCE(p.is_staging,false)`, [AGENCY_KEY(), accountRef(account)])\n  return rows\n}\nasync function ownedProperty(account, propertyId) {\n  const p = (await ownedProperties(account)).find(x => x.id === Number(propertyId))\n",
         "        AND p.archived_at IS NULL AND NOT COALESCE(p.is_staging,false)`, [AGENCY_KEY(), accountRef(account)])\n"
         "  if (!perm) return rows\n"
         "  // representatives (2026-11-21): homes delegated to this account with this permission, re-checked on every call\n"
         "  const del = await require('./syncDelegates').delegatedProperties(account, perm)\n"
         "  return [...rows.map(r => ({ ...r, role: 'owner' })), ...del.filter(d => !rows.some(r => r.id === d.id))]\n"
         "}\nasync function ownedProperty(account, propertyId, perm = null) {\n  const p = (await ownedProperties(account, perm)).find(x => x.id === Number(propertyId))\n"),
        ("async function ownerViewings(account) {\n  const props = await ownedProperties(account)\n",
         "async function ownerViewings(account) {\n  const props = await ownedProperties(account, 'view')\n"),
        ("async function ownerDecide(account, { viewingId, decision, note, proposeStart }) {\n  const props = await ownedProperties(account)\n",
         "async function ownerDecide(account, { viewingId, decision, note, proposeStart }) {\n  const props = await ownedProperties(account, 'schedule')\n"),
        ("  const p = await ownedProperty(account, propertyId)\n  if (!Array.isArray(days) || !days.length || days.length > 62)",
         "  const p = await ownedProperty(account, propertyId, 'schedule')\n  if (!Array.isArray(days) || !days.length || days.length > 62)"),
        ("  return { agencyKey: agency, links: out }\n}\n",
         "  // homes this account looks after as a representative (2026-11-21): facts and state only, no owner contact data\n"
         "  const groups = {}\n"
         "  for (const d of await require('./syncDelegates').delegatedProperties(account, 'view')) (groups[d.delegateId] = groups[d.delegateId] || []).push(d)\n"
         "  for (const [delegateId, ds] of Object.entries(groups)) {\n"
         "    const v = await require('./nexusOwnerInbound').readOwnerLink({ linkId: ds[0].ownerLinkPublicId, nexusAccountRef: ds[0].ownerRef })\n"
         "    const ids = ds.map(d => d.id)\n"
         "    const props = v.properties.filter(x => ids.includes(x.sourcePropertyId))\n"
         "    const st = await propertyState(account, props.map(x => x.sourcePropertyId))\n"
         "    out.push({ linkId: delegateId, agencyKey: agency, state: 'verified', role: 'delegate', permissions: ds[0].permissions, properties: props.map(x => ({ ...x, state: st[x.sourcePropertyId] || null })) })\n"
         "  }\n"
         "  return { agencyKey: agency, links: out }\n}\n"),
        ("  if (!link) throw err('OWNER_LINK_NOT_VERIFIED', 'An agent has to confirm this home for you first.', 409)\n",
         "  // a representative with 'edit' acts through the owner's link, for availability and price/description only\n"
         "  if (!link && ['property.owner_updated', 'availability.answered'].includes(eventType)) {\n"
         "    const d = (await require('./syncDelegates').delegatedProperties(account, 'edit')).find(x => x.externalId === ext)\n"
         "    if (d) { const { rows: [ol] } = await db.query(`SELECT * FROM nexus_owner_links WHERE id=$1 AND link_state='verified'`, [d.ownerLinkId]); link = ol || null }\n"
         "  }\n"
         "  if (!link) throw err('OWNER_LINK_NOT_VERIFIED', 'An agent has to confirm this home for you first.', 409)\n"),
        ("  return { messages: rows.map(messageView) }\n}\n",
         "  // representatives with 'message': the owner's conversation about the homes they were given (2026-11-21)\n"
         "  const dm = await require('./syncDelegates').delegatedProperties(account, 'message')\n"
         "  let extra = []\n"
         "  if (dm.length) extra = (await db.query(`SELECT * FROM nexus_owner_messages WHERE agency_key=$1 AND account_id = ANY($2::bigint[]) AND property_id = ANY($3::int[]) AND id > $4 ORDER BY id LIMIT 300`,\n"
         "    [AGENCY_KEY(), [...new Set(dm.map(d => d.ownerAccountId))], dm.map(d => d.id), Number(after) || 0])).rows\n"
         "  return { messages: [...rows, ...extra].sort((a, b) => Number(a.id) - Number(b.id)).map(messageView) }\n}\n"),
        ("  const links = await linksOf(db, account)\n  const { rows: [m] } = await db.query(\n    `INSERT INTO nexus_owner_messages (agency_key, account_id, owner_link_id, property_id, direction, sender_kind, sender_name, body)\n     VALUES ($1,$2,$3,$4,'in','owner',$5,$6) RETURNING *`,\n    [AGENCY_KEY(), account.id, links[0]?.id || null, Number.isInteger(propertyId) ? propertyId : null, account.display_name || null, body])\n",
         "  const links = await linksOf(db, account)\n"
         "  // a representative with 'message' writes into the owner's conversation, only about a home they were given\n"
         "  const dm = Number.isInteger(propertyId) && !(await ownedProperties(account)).some(p => p.id === propertyId)\n"
         "    ? (await require('./syncDelegates').delegatedProperties(account, 'message')).find(d => d.id === propertyId) : null\n"
         "  const { rows: [m] } = await db.query(\n    `INSERT INTO nexus_owner_messages (agency_key, account_id, owner_link_id, property_id, direction, sender_kind, sender_name, body)\n     VALUES ($1,$2,$3,$4,'in','owner',$5,$6) RETURNING *`,\n"
         "    [AGENCY_KEY(), dm ? dm.ownerAccountId : account.id, dm ? dm.ownerLinkId : (links[0]?.id || null), Number.isInteger(propertyId) ? propertyId : null,\n"
         "     dm ? `${account.display_name || 'Representative'} (representative)` : (account.display_name || null), body])\n"),
        # the owner's own latest availability answer, so SYNC shows what they said while ARGUS updates the listing
        ("  const [p, u, g, w] = await Promise.all([\n", "  const [p, u, g, w, aa] = await Promise.all([\n"),
        ("AND status='active' AND kind='window' AND ends_at > NOW() ORDER BY starts_at LIMIT 400`, [ids]),\n  ])\n",
         "AND status='active' AND kind='window' AND ends_at > NOW() ORDER BY starts_at LIMIT 400`, [ids]),\n"
         "    db.query(`SELECT DISTINCT ON (property_id) property_id, outcome, available_from, created_at FROM owner_availability_answers\n"
         "               WHERE agency_key=$1 AND property_id = ANY($2::int[]) ORDER BY property_id, created_at DESC, id DESC`, [agency, ids]),\n  ])\n"),
        ("      windows: w.rows.filter(x => x.property_id === id).map(x => ({ id: x.id, start: x.starts_at, end: x.ends_at })),\n",
         "      windows: w.rows.filter(x => x.property_id === id).map(x => ({ id: x.id, start: x.starts_at, end: x.ends_at })),\n"
         "      answer: (a => (a ? { outcome: a.outcome, availableFrom: a.available_from, at: a.created_at } : null))(aa.rows.find(x => x.property_id === id)),\n"),
    ],
    'routes/syncAccountService.js': [
        ("router.post('/owner/activity', send(async req => PC.activity(S, await me(req), { before: req.body?.before })))\n",
         "router.post('/owner/activity', send(async req => PC.activity(S, await me(req), { before: req.body?.before })))\n"
         "// Representatives (2026-11-21): the invitation link is the token; accepting needs a signed-in, matching, confirmed identity\n"
         "const SD = require('../services/syncDelegates')\n"
         "router.post('/delegates', send(async req => SD.list(await me(req))))\n"
         "router.post('/delegates/invite', send(async req => SD.invite(S, await me(req), { name: req.body?.name, kind: req.body?.kind, target: req.body?.target, propertyIds: req.body?.propertyIds, permissions: req.body?.permissions })))\n"
         "router.post('/delegates/update', send(async req => SD.update(S, await me(req), { delegateId: req.body?.delegateId, propertyIds: req.body?.propertyIds, permissions: req.body?.permissions })))\n"
         "router.post('/delegates/revoke', send(async req => SD.revoke(await me(req), { delegateId: req.body?.delegateId })))\n"
         "router.post('/invites/preview', send(async req => SD.preview({ token: req.body?.token })))\n"
         "router.post('/invites/accept', send(async req => SD.accept(await me(req), { token: req.body?.token })))\n"
         "router.post('/invites/decline', send(async req => SD.decline(await me(req), { token: req.body?.token })))\n"
         "// Private owner documents (2026-11-21)\n"
         "const SDOC = require('../services/syncDocuments')\n"
         "router.post('/documents', send(async req => SDOC.list(await me(req))))\n"
         "router.post('/documents/upload', send(async req => SDOC.upload(S, await me(req), { propertyId: req.body?.propertyId, category: req.body?.category, title: req.body?.title, dataBase64: req.body?.dataBase64 })))\n"
         "router.post('/documents/file', send(async req => SDOC.file(await me(req), { id: req.body?.id })))\n"
         "router.post('/documents/share', send(async req => SDOC.share(await me(req), { id: req.body?.id, share: req.body?.share === true })))\n"
         "router.post('/documents/delete', send(async req => SDOC.remove(await me(req), { id: req.body?.id })))\n"),
    ],
    'routes/crm.js': [
        ("      db.query(`SELECT d.id, d.filename, d.url, d.uploaded_by, d.created_at, d.category, d.notes,\n                       d.property_id, p.ref AS property_ref\n                  FROM owner_documents d LEFT JOIN properties p ON p.id = d.property_id\n                 WHERE d.owner_contact_id = $1 ORDER BY d.created_at DESC`, [id]),\n",
         "      db.query(`SELECT d.id, d.filename, d.url, d.uploaded_by, d.created_at, d.category, d.notes,\n                       d.property_id, p.ref AS property_ref, d.storage, d.visibility, d.deleted_at\n                  FROM owner_documents d LEFT JOIN properties p ON p.id = d.property_id\n                 WHERE d.owner_contact_id = $1 AND d.visibility = 'agency' AND d.deleted_at IS NULL ORDER BY d.created_at DESC`, [id]),\n"),
        ("      documents: documents.rows,\n",
         "      documents: require('../services/syncDocuments').staffDocumentRows(documents.rows),\n"),
        ("      `UPDATE owner_documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND owner_contact_id = $${params.length}\n",
         "      `UPDATE owner_documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND owner_contact_id = $${params.length} AND storage = 'cloudinary'\n"),
        ("    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2`,\n      [parseInt(req.params.docId), parseInt(req.params.id)])\n",
         "    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2 AND storage = 'cloudinary'`,\n      [parseInt(req.params.docId), parseInt(req.params.id)])\n"),
        ("// DELETE /api/crm/owners/:id/documents/:docId\n",
         "// GET /api/crm/owner-documents/:docId/file?exp=&sig= — an owner's shared SYNC document, through the 10-minute\n"
         "// link the owner profile hands to signed-in staff (2026-11-21). Private or deleted documents answer 404.\n"
         "router.get('/owner-documents/:docId/file', (req, res) => require('../services/syncDocuments').staffFileHandler(req, res))\n\n"
         "// DELETE /api/crm/owners/:id/documents/:docId\n"),
    ],
    'routes/crmOwnergroups.js': [
        ("          `SELECT id, filename, url, uploaded_by, created_at FROM owner_documents WHERE owner_contact_id = $1 ORDER BY created_at DESC`,\n          [state.owner_contact_id])).rows\n",
         "          `SELECT id, filename, url, uploaded_by, created_at, storage, visibility, deleted_at FROM owner_documents WHERE owner_contact_id = $1 AND visibility = 'agency' AND deleted_at IS NULL ORDER BY created_at DESC`,\n          [state.owner_contact_id])).rows\n"),
        ("      : []\n\n    res.json({ state, ownerContact, properties, profile, preferenceComparison, contacts, campaigns, events: events.rows, documents })\n",
         "      : []\n\n    res.json({ state, ownerContact, properties, profile, preferenceComparison, contacts, campaigns, events: events.rows, documents: require('../services/syncDocuments').staffDocumentRows(documents) })\n"),
        ("    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2`, [parseInt(req.params.docId), state.owner_contact_id])\n",
         "    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2 AND storage = 'cloudinary'`, [parseInt(req.params.docId), state.owner_contact_id])\n"),
    ],
}

plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        # already applied? (checked first: several replacements still contain their own anchor)
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}: {old[:50]!r}'); continue
        hit = None
        for nl in ('\n', '\r\n'):
            o, n = old.replace('\n', nl), new.replace('\n', nl)
            c = text.count(o)
            if c == 1: hit = (o, n); break
            if c > 1: print(f'ANCHOR {c}x in {rel}: {old[:70]!r}'); sys.exit(1)
        if not hit:
            if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}: {old[:50]!r}'); continue
            print(f'ANCHOR 0x in {rel}: {old[:70]!r}'); sys.exit(1)
        text = text.replace(hit[0], hit[1])
    plan.append((path, text))
if check: print('anchors ok'); sys.exit(0)
for path, text in plan:
    open(path, 'wb').write(text.encode('utf-8'))
    print('patched', path)
