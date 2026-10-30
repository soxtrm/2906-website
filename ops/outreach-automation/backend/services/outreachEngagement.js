'use strict'
// ============================================================================
// services/outreachEngagement.js — reply metrics and the "Call Candidates —
// No WhatsApp Response" segment (Kev, 2026-10-29).
//
// Everything is DERIVED from the canonical tables (outreach_log for attempts,
// owner_contacts for replies and opt-outs); there is no second engagement
// store to drift. An attempt is one outreach_log row; an owner "replied" when
// any of their log rows is marked replied or owner_contacts.last_reply_at is
// after their first outreach.
//
// The call list is a MANUAL follow-up list. It never sends anything, and it
// excludes every owner who opted out on WhatsApp (DNC flag or status), has an
// active automation block or a dnc/angry label: a WhatsApp opt-out is never
// permission to phone the person instead.
// ============================================================================
const db = require('../db')
// Lazy: outreachEligibility requires this module for the no-reply stop.
const setting = (key, fallback) => require('./outreachEligibility').setting(key, fallback)

const DEFAULT_THRESHOLDS = [1, 3, 5, 6, 7]

// Per-owner attempt/reply facts. $1 = optional session filter (NULL = all).
const OWNER_FACTS = `
  WITH sends AS (
    SELECT regexp_replace(phone, '[^0-9]', '', 'g') AS phone,
           COUNT(*)::int AS attempts,
           MIN(sent_at) AS first_sent_at,
           MAX(sent_at) AS last_sent_at,
           BOOL_OR(COALESCE(replied, FALSE)) AS log_replied,
           (ARRAY_AGG(account_used ORDER BY sent_at DESC))[1] AS last_account
      FROM outreach_log
     WHERE sent_at IS NOT NULL
       AND ($1::text IS NULL OR lower(account_used) = lower($1::text))
     GROUP BY 1
  )
  SELECT s.*, oc.id AS contact_id, oc.name, oc.location, oc.property_type, oc.last_reply_at,
         (s.log_replied OR (oc.last_reply_at IS NOT NULL AND oc.last_reply_at >= s.first_sent_at AT TIME ZONE 'UTC')) AS replied,
         (COALESCE(oc.do_not_contact, FALSE) OR COALESCE(oc.status, '') = 'do_not_contact'
           OR EXISTS (SELECT 1 FROM owner_automation_blocks b WHERE b.phone_normalized = s.phone AND b.active)
           OR EXISTS (SELECT 1 FROM owner_account_labels l WHERE l.contact_id = oc.id AND l.label IN ('dnc','angry'))) AS opted_out
    FROM sends s
    LEFT JOIN owner_contacts oc ON oc.phone_normalized = s.phone`

async function thresholds() {
  const raw = await setting('engagement.report_thresholds', DEFAULT_THRESHOLDS)
  const list = (Array.isArray(raw) ? raw : DEFAULT_THRESHOLDS).map(Number).filter(n => Number.isInteger(n) && n > 0)
  return [...new Set(list)].sort((a, b) => a - b)
}

async function overview({ session = null } = {}) {
  const rows = (await db.query(OWNER_FACTS, [session])).rows
  const levels = await thresholds()
  const reviewAfter = Number(await setting('engagement.no_reply_review_after', 5))
  const contacted = rows.length
  const replied = rows.filter(r => r.replied).length
  const noReply = rows.filter(r => !r.replied && !r.opted_out)
  return {
    session,
    ownersContacted: contacted,
    ownersReplied: replied,
    replyRate: contacted ? Math.round((replied / contacted) * 1000) / 10 : 0,
    optedOut: rows.filter(r => r.opted_out).length,
    noReplyByAttempts: levels.map(n => ({ attempts: n, owners: noReply.filter(r => r.attempts >= n).length })),
    autoRetryStopsAt: reviewAfter,
    stoppedForReview: noReply.filter(r => r.attempts >= reviewAfter).length,
  }
}

async function callCandidates({ session = null, minAttempts = null, limit = 200 } = {}) {
  const min = Number(minAttempts || await setting('engagement.call_candidate_min_attempts', 3))
  const rows = (await db.query(
    `SELECT * FROM (${OWNER_FACTS}) f
      WHERE NOT f.replied AND NOT f.opted_out AND f.attempts >= $2
      ORDER BY f.attempts DESC, f.last_sent_at ASC
      LIMIT $3`, [session, min, Math.max(1, Math.min(1000, Number(limit) || 200))])).rows
  return {
    minAttempts: min,
    candidates: rows.map(r => ({
      phone: r.phone, contactId: r.contact_id, name: r.name || null,
      location: r.location || null, propertyType: r.property_type || null,
      attempts: r.attempts, firstSentAt: r.first_sent_at, lastSentAt: r.last_sent_at,
      lastAccount: r.last_account,
    })),
  }
}

// Used by the dispatch gate: true when automated retries must stop because
// the owner has had `no_reply_review_after` attempts without any reply.
async function reachedNoReplyLimit(phone) {
  const p = String(phone || '').replace(/\D/g, '')
  if (!p) return false
  const limit = Number(await setting('engagement.no_reply_review_after', 5))
  if (!Number.isFinite(limit) || limit <= 0) return false
  const r = (await db.query(
    `SELECT COUNT(*)::int AS attempts, BOOL_OR(COALESCE(replied, FALSE)) AS replied, MIN(sent_at) AS first_sent_at
       FROM outreach_log WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1 AND sent_at IS NOT NULL`, [p])).rows[0]
  if (!r || r.attempts < limit || r.replied) return false
  const c = (await db.query(`SELECT last_reply_at FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [p])).rows[0]
  if (c?.last_reply_at && new Date(c.last_reply_at) >= new Date(r.first_sent_at)) return false
  return true
}

module.exports = { DEFAULT_THRESHOLDS, thresholds, overview, callCandidates, reachedNoReplyLimit }
