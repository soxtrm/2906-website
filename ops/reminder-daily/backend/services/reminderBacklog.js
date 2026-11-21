'use strict'
// ============================================================================
// services/reminderBacklog.js — why the old reminders are inactive (Kev, 2026-11-21).
// READ-ONLY. The 516 overdue and 652 paused reminders stay exactly as they are;
// this report sorts every pending reminder that the daily 09:00 run does NOT
// handle into one reason, and marks which could safely be REVIEWED for
// reactivation (never reactivated here).
//   safe to review = an owner request the run understands (callback / upcoming),
//   owner exists, no DNC / stop / opt-out, not contacted since the reminder was
//   created, due within the last 90 days, and the sending account still exists.
// ============================================================================
const db = require('../db')

async function report({ now = new Date() } = {}) {
  const daily = require('./reminderDaily')
  const today = daily.maltaParts(now).date
  const since = (await db.query(`SELECT value FROM settings WHERE key='reminder_daily_since'`)).rows[0]?.value || today
  const rows = (await db.query(
    `SELECT r.id, r.owner_phone, r.owner_name, r.original_note, r.parsed_timing, r.contact_due_date::text AS due, r.created_at,
            r.auto_send_status, r.auto_send_block_reason, r.source_session,
            oc.id AS owner_id, oc.do_not_contact, oc.status AS owner_status,
            EXISTS (SELECT 1 FROM owner_automation_blocks b WHERE b.active AND right(b.phone_normalized,9) = right(regexp_replace(r.owner_phone,'\\D','','g'),9)) AS stopped,
            (SELECT MAX(sent_at) FROM outreach_log l WHERE right(regexp_replace(l.phone,'\\D','','g'),9) = right(regexp_replace(r.owner_phone,'\\D','','g'),9)) AS last_outreach,
            EXISTS (SELECT 1 FROM whatsapp_accounts a WHERE lower(a.session_name) = lower(r.source_session) AND a.is_active) AS sender_ok
       FROM reminders r
       LEFT JOIN LATERAL (SELECT id, do_not_contact, status FROM owner_contacts o
                           WHERE right(regexp_replace(COALESCE(o.phone_normalized,''),'\\D','','g'),9) = right(regexp_replace(r.owner_phone,'\\D','','g'),9) ORDER BY id LIMIT 1) oc ON TRUE
      WHERE r.status = 'pending' AND (r.contact_due_date < $1::date OR r.auto_send_status = 'paused_manual')`, [since])).rows
  const towns = []
  const cats = {}
  const add = (key, label, r, safe) => {
    const c = cats[key] || (cats[key] = { key, label, count: 0, safeToReview: 0, sample: [] })
    c.count++
    if (safe) c.safeToReview++
    if (c.sample.length < 8) c.sample.push({ id: r.id, owner: r.owner_name || null, phoneLast4: String(r.owner_phone || '').slice(-4), due: r.due, timing: r.parsed_timing || null, note: String(r.original_note || '').slice(0, 140), status: r.auto_send_status, safe })
  }
  for (const r of rows) {
    const ageDays = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${r.due}T12:00:00Z`)) / 86400e3)
    const cls = daily.classify(r, towns)
    const contactedSince = r.last_outreach && new Date(r.last_outreach) > new Date(r.created_at)
    if (r.due < '2020-01-01' || ageDays < -3650) { add('broken_date', 'Date could not be read (year before 2020 or far future)', r, false); continue }
    if (!r.owner_id) { add('not_an_owner', 'Not in the owner list (friend, agent or unknown number)', r, false); continue }
    if (r.do_not_contact || r.owner_status === 'do_not_contact' || r.stopped) { add('owner_stopped', 'Owner opted out / do not contact', r, false); continue }
    if (cls.skip === 'automatic_reply_not_an_owner_request') { add('auto_reply', 'Saved from an automatic reply, not an owner request', r, false); continue }
    if (cls.skip) { add('not_a_request', 'Note is not a request to follow up', r, false); continue }
    if (contactedSince) { add('contacted_since', 'Owner was contacted again after the reminder was made', r, false); continue }
    if (!r.sender_ok) { add('sender_gone', `Original account no longer active (${r.source_session || 'unknown'})`, r, false); continue }
    if (ageDays > 90) { add('stale', 'Due more than 90 days ago — likely outdated', r, false); continue }
    const label = r.auto_send_status === 'paused_manual' ? 'Paused by you on 1 Nov — owner request, recent, owner reachable' : 'Overdue before the automatic start — owner request, recent, owner reachable'
    add(r.auto_send_status === 'paused_manual' ? 'paused_reviewable' : 'overdue_reviewable', label, r, true)
  }
  const list = Object.values(cats).sort((a, b) => b.safeToReview - a.safeToReview || b.count - a.count)
  return {
    generatedAt: now.toISOString(), since, total: rows.length,
    overdue: rows.filter(r => r.due < since).length, paused: rows.filter(r => r.auto_send_status === 'paused_manual').length,
    safeToReview: list.reduce((n, c) => n + c.safeToReview, 0), categories: list,
    note: 'Read-only. Nothing here is sent or reactivated automatically.',
  }
}

module.exports = { report }
