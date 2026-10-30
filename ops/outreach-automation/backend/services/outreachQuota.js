'use strict'
// ============================================================================
// services/outreachQuota.js — hard per-account daily cap (Kev, 2026-10-29).
//
// At most 40 UNIQUE recipients per WhatsApp account per Europe/Malta calendar
// day, enforced in the backend at the moment of sending (not in the UI, not
// at planning time). The daily target (randomised 30–40 from the account's
// saved target range) only sizes auto plans; the cap is the hard limit.
//
// Concurrency: reserve() locks the (account, day) quota row FOR UPDATE inside
// one transaction, so two workers can never both take the last slot. A retry
// to the same phone on the same day finds its existing recipient row and
// does not consume a second slot. A definite send failure releases the slot
// (failed/unsent messages are not outreach). The table survives restarts, so
// a restart never resets consumed quota.
// ============================================================================
const db = require('../db')
const { maltaDateStr } = require('./outreachSchedule')

const HARD_DAILY_CAP = 40

const normPhone = p => String(p || '').replace(/\D/g, '')

function drawTarget(account, rng = Math.random) {
  const lo = Math.max(1, Math.min(HARD_DAILY_CAP, Number(account?.outreach_daily_target_min) || 30))
  const hi = Math.max(lo, Math.min(HARD_DAILY_CAP, Number(account?.outreach_daily_target_max) || 40))
  return lo + Math.floor(rng() * (hi - lo + 1))
}

async function ensureDay(client, accountId, day, rng) {
  const account = (await client.query(
    `SELECT outreach_daily_target_min, outreach_daily_target_max FROM whatsapp_accounts WHERE id = $1`, [accountId])).rows[0]
  await client.query(
    `INSERT INTO outreach_daily_quota(account_id, malta_date, target, cap)
     VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, malta_date) DO NOTHING`,
    [accountId, day, drawTarget(account, rng), HARD_DAILY_CAP])
}

async function reserve(accountId, phone, { now = new Date(), runId = null, rng = Math.random } = {}) {
  const day = maltaDateStr(now)
  const p = normPhone(phone)
  if (!p) return { ok: false, reason: 'invalid_phone', day }
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await ensureDay(client, accountId, day, rng)
    const quota = (await client.query(
      `SELECT * FROM outreach_daily_quota WHERE account_id = $1 AND malta_date = $2 FOR UPDATE`, [accountId, day])).rows[0]
    const existing = (await client.query(
      `SELECT state FROM outreach_daily_recipients WHERE account_id = $1 AND malta_date = $2 AND phone = $3`,
      [accountId, day, p])).rows[0]
    if (existing) {
      await client.query('COMMIT')
      return { ok: true, already: existing.state, day, used: quota.used, cap: quota.cap, target: quota.target }
    }
    if (quota.used >= quota.cap) {
      await client.query('COMMIT')
      return { ok: false, reason: 'daily_cap_reached', day, used: quota.used, cap: quota.cap, target: quota.target }
    }
    await client.query(
      `INSERT INTO outreach_daily_recipients(account_id, malta_date, phone, state, run_id) VALUES ($1, $2, $3, 'reserved', $4)`,
      [accountId, day, p, runId])
    const updated = (await client.query(
      `UPDATE outreach_daily_quota SET used = used + 1, updated_at = NOW()
        WHERE account_id = $1 AND malta_date = $2 RETURNING used, cap, target`, [accountId, day])).rows[0]
    await client.query('COMMIT')
    return { ok: true, day, ...updated }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function markSent(accountId, phone, day) {
  await db.query(
    `UPDATE outreach_daily_recipients SET state = 'sent', sent_at = COALESCE(sent_at, NOW())
      WHERE account_id = $1 AND malta_date = $2 AND phone = $3`, [accountId, day, normPhone(phone)])
}

// Only a still-reserved slot can be given back; a slot whose send was
// accepted (or is ambiguous and later reconciled as sent) stays consumed.
async function release(accountId, phone, day) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT 1 FROM outreach_daily_quota WHERE account_id = $1 AND malta_date = $2 FOR UPDATE`, [accountId, day])
    const del = await client.query(
      `DELETE FROM outreach_daily_recipients WHERE account_id = $1 AND malta_date = $2 AND phone = $3 AND state = 'reserved' RETURNING 1`,
      [accountId, day, normPhone(phone)])
    if (del.rows.length) {
      await client.query(`UPDATE outreach_daily_quota SET used = GREATEST(0, used - 1), updated_at = NOW() WHERE account_id = $1 AND malta_date = $2`, [accountId, day])
    }
    await client.query('COMMIT')
    return del.rows.length > 0
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function status(accountId, { now = new Date(), rng = Math.random } = {}) {
  const day = maltaDateStr(now)
  const client = await db.connect()
  try {
    await ensureDay(client, accountId, day, rng)
    const q = (await client.query(`SELECT * FROM outreach_daily_quota WHERE account_id = $1 AND malta_date = $2`, [accountId, day])).rows[0]
    const sent = (await client.query(
      `SELECT COUNT(*)::int AS n FROM outreach_daily_recipients WHERE account_id = $1 AND malta_date = $2 AND state = 'sent'`, [accountId, day])).rows[0].n
    return { day, target: q.target, cap: q.cap, used: q.used, sent, remaining: Math.max(0, q.cap - q.used), remainingToTarget: Math.max(0, q.target - q.used) }
  } finally {
    client.release()
  }
}

module.exports = { HARD_DAILY_CAP, drawTarget, reserve, markSent, release, status }
