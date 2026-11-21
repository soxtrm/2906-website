#!/usr/bin/env python3
"""NEXUS SYNC calendar backend (2026-11-21). Usage: patch.py <backend dir> [--check]

services/syncAccount.js       owner viewing hours in the home state carry `own` (set in SYNC) and `proposedFor` (viewing id);
                              proposing another time is refused when it overlaps a pending/confirmed viewing;
                              new ownerAddWindow / ownerRemoveWindow for the calendar (single viewing hours)
routes/syncAccountService.js  POST /owner/window/add, /owner/window/remove (signed SYNC service, owner session)
Overlapping viewings themselves are already impossible: property_viewings_no_overlap (EXCLUDE constraint).
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
NEW_FUNCS = r'''// ── SYNC calendar (2026-11-21): single viewing hours + clash check ────────────
// Overlapping viewings are refused by the database (property_viewings_no_overlap). These checks keep the
// owner's own actions honest before anything is written: no proposal on a taken time, no doubled hours.
async function viewingClash(propertyId, startsAt, minutes, exceptId) {
  const { rows: [c] } = await db.query(
    `SELECT starts_at FROM property_viewings
      WHERE property_id=$1 AND status IN ('pending','confirmed') AND id <> COALESCE($4::int, 0) AND starts_at IS NOT NULL
        AND starts_at < $2::timestamptz + make_interval(mins => $3::int)
        AND starts_at + make_interval(mins => COALESCE(duration_min, 20)) > $2::timestamptz
      ORDER BY starts_at LIMIT 1`, [propertyId, startsAt, Math.max(5, Number(minutes) || 20), exceptId || null])
  return c ? new Date(c.starts_at).toLocaleString('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
}
async function ownerAddWindow(account, { propertyId, start, end }) {
  const p = await ownedProperty(account, propertyId, 'schedule')
  const a = new Date(start), b = new Date(end), now = Date.now()
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b <= a || b - a < 15 * 60e3 || b - a > 14 * 3600e3 || a.getTime() < now - 5 * 60e3 || a.getTime() > now + 92 * 86400e3)
    throw err('RANGE_INVALID', 'Choose between 15 minutes and 14 hours, within the next three months.')
  const { rows: [dup] } = await db.query(
    `SELECT id FROM property_viewing_windows WHERE property_id=$1 AND status='active' AND kind='window' AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz LIMIT 1`,
    [p.id, a.toISOString(), b.toISOString()])
  if (dup) throw err('WINDOW_OVERLAP', 'You already have viewing hours at this time.', 409)
  const r = await windows().addWindow(p.id, { kind: 'window', start: a.toISOString(), end: b.toISOString(), confirmation: 'full_window' },
    { sourceType: 'owner_sync', evidence: 'Owner opened viewing hours in the SYNC calendar', reference: `sync:${account.public_id}:cal:${Date.now()}`, createdBy: 'owner', confidence: 'explicit' })
  if (!r || !r.id) throw err('WINDOW_NOT_SAVED', 'These hours could not be saved. Please try again.', 409)
  await audit(db, null, 'SYNC_VIEWING_WINDOW_ADDED', { account: account.public_id, window: r.id, start: a.toISOString(), end: b.toISOString() }, { id: p.id, ref: p.ref })
  return { window: { id: r.id, start: a.toISOString(), end: b.toISOString(), own: true } }
}
async function ownerRemoveWindow(account, { propertyId, windowId }) {
  const p = await ownedProperty(account, propertyId, 'schedule')
  const { rows: [w] } = await db.query(
    `SELECT id, source_type FROM property_viewing_windows WHERE id=$1 AND property_id=$2 AND status='active' AND kind='window'`, [Number(windowId) || 0, p.id])
  if (!w) throw err('WINDOW_NOT_FOUND', 'These viewing hours were not found.', 404)
  if (w.source_type !== 'owner_sync') throw err('WINDOW_NOT_OWN', 'The agency set these hours. Ask them in the chat to change them.', 403)
  await windows().cancelWindow(p.id, w.id, `sync:${account.public_id}`)
  await audit(db, null, 'SYNC_VIEWING_WINDOW_REMOVED', { account: account.public_id, window: w.id }, { id: p.id, ref: p.ref })
  return { removed: true }
}

'''
EDITS = {
    'services/syncAccount.js': [
        ("    db.query(`SELECT id, property_id, starts_at, ends_at FROM property_viewing_windows WHERE property_id = ANY($1::int[]) AND status='active' AND kind='window' AND ends_at > NOW() ORDER BY starts_at LIMIT 400`, [ids]),\n",
         "    db.query(`SELECT id, property_id, starts_at, ends_at, source_type, source_reference FROM property_viewing_windows WHERE property_id = ANY($1::int[]) AND status='active' AND kind='window' AND ends_at > NOW() ORDER BY starts_at LIMIT 400`, [ids]),\n"),
        ("      windows: w.rows.filter(x => x.property_id === id).map(x => ({ id: x.id, start: x.starts_at, end: x.ends_at })),\n",
         "      windows: w.rows.filter(x => x.property_id === id).map(x => ({ id: x.id, start: x.starts_at, end: x.ends_at, own: x.source_type === 'owner_sync', proposedFor: (m => (m ? Number(m[1]) : null))(/:propose:(\\d+)$/.exec(x.source_reference || '')) })),\n"),
        ("      const end = new Date(at.getTime() + 30 * 60e3)\n",
         "      const end = new Date(at.getTime() + 30 * 60e3)\n"
         "      const clash = await viewingClash(v.property_id, at.toISOString(), 30, v.id)\n"
         "      if (clash) throw err('SLOT_TAKEN', `Another viewing is already booked at ${clash}. Choose a free time.`, 409)\n"),
        ("// Viewing hours: the owner sets whole days (several ranges per day). Each day\n",
         NEW_FUNCS + "// Viewing hours: the owner sets whole days (several ranges per day). Each day\n"),
        ("  staffNotice,\n", "  staffNotice, viewingClash, ownerAddWindow, ownerRemoveWindow,\n"),
    ],
    'routes/syncAccountService.js': [
        ("router.post('/owner/hours', send(async req => S.ownerSetDays(await me(req), { propertyId: req.body?.propertyId, days: req.body?.days })))\n",
         "router.post('/owner/hours', send(async req => S.ownerSetDays(await me(req), { propertyId: req.body?.propertyId, days: req.body?.days })))\n"
         "// SYNC calendar (2026-11-21): single viewing hours\n"
         "router.post('/owner/window/add', send(async req => S.ownerAddWindow(await me(req), { propertyId: req.body?.propertyId, start: req.body?.start, end: req.body?.end })))\n"
         "router.post('/owner/window/remove', send(async req => S.ownerRemoveWindow(await me(req), { propertyId: req.body?.propertyId, windowId: req.body?.windowId })))\n"),
    ],
}
plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}'); continue
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
    open(path, 'wb').write(text.encode('utf-8')); print('patched', path)
