'use strict'
// ============================================================================
// services/availabilityFreshness.js — progressive freshness of the last GENUINE
// owner availability confirmation (Claude, 2026-11-11).
//
// Pure functions, no I/O. The single source is properties.last_confirmed_available_at
// (written by boardAction.checkIn / markUpcoming and the owner "yes" path). This
// module only classifies that timestamp; it never changes a listing and never
// marks anything unavailable because a window expired.
// ============================================================================

const HOUR = 3600 * 1000

function settings(env = process.env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d }
  const intervalHours = n(env.NEXUS_AVAILABILITY_INTERVAL_HOURS, 48)
  return {
    intervalHours,
    // "approaching" starts at 75 % of the interval (36 h for the 48 h default).
    approachingHours: n(env.NEXUS_AVAILABILITY_APPROACHING_HOURS, intervalHours * 0.75),
    // after this the confirmation is too old to say anything about (14 days).
    staleHours: n(env.NEXUS_AVAILABILITY_STALE_HOURS, 336),
    // Consumer discovery: after this long without a fresh confirmation a listing is no
    // longer offered to consumers as available (about five days). Professionals may
    // still see it, marked unconfirmed. A policy value, not a status change.
    consumerHours: n(env.NEXUS_AVAILABILITY_CONSUMER_HOURS, 120),
  }
}

const LABELS = {
  recently_confirmed: 'Recently confirmed',
  reconfirmation_approaching: 'Reconfirmation approaching',
  confirmation_overdue: 'Confirmation overdue',
  unknown_stale: 'Unknown / stale',
}

// classify(lastConfirmedAt, { now, settings }) →
//   { state, label, lastConfirmedAt, ageHours, dueAt }
function classify(lastConfirmedAt, opts = {}) {
  const cfg = opts.settings || settings()
  const now = opts.now ? new Date(opts.now).getTime() : Date.now()
  const at = lastConfirmedAt ? new Date(lastConfirmedAt).getTime() : NaN
  if (!Number.isFinite(at)) {
    return { state: 'unknown_stale', label: LABELS.unknown_stale, lastConfirmedAt: null, ageHours: null, dueAt: null, consumerDiscoverable: false }
  }
  const ageHours = Math.max(0, (now - at) / HOUR)
  let state = 'recently_confirmed'
  if (ageHours >= cfg.staleHours) state = 'unknown_stale'
  else if (ageHours >= cfg.intervalHours) state = 'confirmation_overdue'
  else if (ageHours >= cfg.approachingHours) state = 'reconfirmation_approaching'
  return {
    state,
    label: LABELS[state],
    lastConfirmedAt: new Date(at).toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    dueAt: new Date(at + cfg.intervalHours * HOUR).toISOString(),
    consumerDiscoverable: ageHours < cfg.consumerHours,
  }
}

module.exports = { classify, settings, LABELS }
