'use strict'
// ============================================================================
// services/outreachPace.js — the CRM "PACE" control, one source of truth
// (Kev, 2026-10-29).
//
// Units (unchanged): PACE is a percentage 10–100 stored per account. The send
// loop multiplies its natural per-message delay (typedDelay/coldDelay, ~50 s
// average jitter) by 100 / pace, so pace 30 ≈ 3.3× slower than pace 100.
//
// Root cause of "30 silently becomes 100": a pace saved with an expiry
// (outreach_volume_until) was READ as 100 after the expiry by both the CRM
// list and the dispatcher, while the column still held the saved value.
// Argus2/Gabriela saved 33 and sent every batch at 100 from 2026-09-29.
// A DB error during dispatch also fell back to 100.
//
// Now: a saved pace (single value or range) stays until the operator changes
// it. There is no expiry and no 100 fallback. With a range, every run draws a
// fresh value inside it (e.g. 30 → 35 → 28 → 39 → 32 for range 28–40); the
// drawn value is stored on the batch (volume_percent_snapshot) for audit.
// If the setting cannot be read the run does not start.
// ============================================================================
const db = require('../db')

const PACE_MIN = 10
const PACE_MAX = 100

class PaceUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'PaceUnavailableError'; this.code = 'PACE_UNAVAILABLE' }
}

function clampPace(value) {
  // null/'' must stay "not set": Number(null) is 0 and would clamp to 10.
  if (value === null || value === undefined || value === '') return null
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.max(PACE_MIN, Math.min(PACE_MAX, n))
}

// Effective saved range for an account row. Legacy rows without a range use
// the single saved percent; the expiry column is ignored on purpose.
function savedRange(row) {
  const legacy = clampPace(row?.outreach_volume_percent)
  const min = clampPace(row?.outreach_pace_min) ?? legacy
  const max = clampPace(row?.outreach_pace_max) ?? legacy
  if (min == null || max == null) return null
  return min <= max ? { min, max } : { min: max, max: min }
}

function drawPace(range, rng = Math.random) {
  if (!range) return null
  if (range.min === range.max) return range.min
  return range.min + Math.floor(rng() * (range.max - range.min + 1))
}

async function resolvePace(accountId, { rng = Math.random } = {}) {
  let row
  try {
    row = (await db.query(
      `SELECT id, outreach_volume_percent, outreach_pace_min, outreach_pace_max FROM whatsapp_accounts WHERE id = $1`,
      [accountId])).rows[0]
  } catch (err) {
    throw new PaceUnavailableError(`pace setting unreadable: ${err.message}`)
  }
  if (!row) throw new PaceUnavailableError(`account ${accountId} not found`)
  const range = savedRange(row)
  if (!range) throw new PaceUnavailableError(`account ${accountId} has no saved pace`)
  const percent = drawPace(range, rng)
  return { percent, range, multiplier: 100 / percent }
}

// Save a single value (min === max) or a range. outreach_volume_percent keeps
// the midpoint for older readers; the expiry is always cleared.
async function setAccountPace(accountId, { min, max = min } = {}) {
  const lo = clampPace(min)
  const hi = clampPace(max)
  if (lo == null || hi == null) {
    const err = new Error('pace must be a number between 10 and 100')
    err.code = 'invalid_pace'
    throw err
  }
  const range = lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo }
  const r = await db.query(
    `UPDATE whatsapp_accounts
        SET outreach_pace_min = $2, outreach_pace_max = $3,
            outreach_volume_percent = $4, outreach_volume_until = NULL
      WHERE id = $1 AND is_active = TRUE AND outreach_enabled = TRUE
      RETURNING id, session_name, outreach_pace_min, outreach_pace_max, outreach_volume_percent`,
    [accountId, range.min, range.max, Math.round((range.min + range.max) / 2)])
  if (!r.rows.length) throw new Error(`account ${accountId} not found`)
  return r.rows[0]
}

module.exports = { PACE_MIN, PACE_MAX, PaceUnavailableError, clampPace, savedRange, drawPace, resolvePace, setAccountPace }
