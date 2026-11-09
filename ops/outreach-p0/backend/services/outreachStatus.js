'use strict'
// ============================================================================
// services/outreachStatus.js — traffic-light semantics for ARGUS Outreach
// (Claude, 2026-11-10, P0). PURE functions: no DB, no WhatsApp. Two separate
// models, never conflated:
//   accountHealth(...) — is this sending identity able / scheduled to work?
//   runStatus(plan)    — what happened (or will happen) to one run/job?
// Colours: green | yellow | red | gray | unknown. Every result carries a text
// label and reason, so colour is never the only signal.
// ============================================================================
const HEALTHY = new Set(['WORKING', 'CONNECTED'])
const OFFLINE = new Set(['FAILED', 'STOPPED', 'SCAN_QR_CODE', 'STARTING', 'DISCONNECTED', 'LOGGED_OUT'])
const STALE_MS = 10 * 60 * 1000

const humanize = s => String(s || '').replace(/[:_]/g, ' ').replace(/\s+/g, ' ').trim()

// Malta wall-clock minutes for a Date.
function maltaMinutes(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]))
  return (Number(p.hour) % 24) * 60 + Number(p.minute)
}
const toMin = hhmm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null }

/**
 * @param {object} i
 *   sessionStatus  WAHA status string or 'UNKNOWN'
 *   telemetryAt    Date the session status was read (stale → unknown)
 *   restricted, restrictionUntil, restrictionReason
 *   autoMode       'v2' | 'legacy' | 'off'
 *   suspendedReason, suspendedRecoverable  (V2 automation)
 *   manualPaused   { at, by, reason } | null
 *   target         effective daily target (0 = no capacity)
 *   runningPlan    a plan currently dispatching (or null)
 *   nextRun        { at, status } | null
 *   window         { start:'08:30', end:'19:30' }
 *   now            Date
 */
function accountHealth(i) {
  const now = i.now || new Date()
  const tAt = i.telemetryAt ? new Date(i.telemetryAt) : null
  const base = { telemetryAt: tAt ? tAt.toISOString() : null, nextAt: i.nextRun?.at || null }
  const state = String(i.sessionStatus || 'UNKNOWN').toUpperCase()
  if (!tAt || now - tAt > STALE_MS || state === 'UNKNOWN') {
    return { ...base, color: 'unknown', code: 'unknown', label: 'Unknown', reason: 'WhatsApp session status could not be read just now', action: 'Refresh; check the WAHA service if this persists' }
  }
  if (!HEALTHY.has(state)) {
    return { ...base, color: 'red', code: 'offline', label: 'Offline', reason: `WhatsApp session ${humanize(state).toLowerCase()}`, action: state === 'SCAN_QR_CODE' ? 'Scan the QR code to reconnect this number' : 'Reconnect the WhatsApp session' }
  }
  if (i.restricted) {
    const until = i.restrictionUntil ? new Date(i.restrictionUntil) : null
    return { ...base, color: 'red', code: 'blocked', label: 'Blocked', reason: `Restricted${i.restrictionReason ? ` — ${humanize(i.restrictionReason)}` : ''}${until ? ` until ${until.toISOString()}` : ''}`, action: 'Wait for the restriction to end or lift it manually' }
  }
  if (i.manualPaused) {
    return { ...base, color: 'gray', code: 'paused', label: 'Manually paused', reason: `Paused${i.manualPaused.by ? ` by ${i.manualPaused.by}` : ''}${i.manualPaused.reason ? ` — ${i.manualPaused.reason}` : ''}`, action: 'Resume when ready' }
  }
  if (i.autoMode === 'off') {
    return { ...base, color: 'gray', code: 'auto_off', label: 'Auto off', reason: 'No automatic outreach for this account', action: 'Turn Auto on or plan a manual run' }
  }
  if (i.autoMode === 'v2' && i.suspendedReason) {
    if (i.suspendedRecoverable) return { ...base, color: 'yellow', code: 'needs_review', label: 'Needs review', reason: `Automation suspended — ${humanize(i.suspendedReason)}`, action: 'Resumes automatically once the cause is gone' }
    return { ...base, color: 'red', code: 'blocked', label: 'Blocked', reason: `Automation stopped — ${humanize(i.suspendedReason)}`, action: 'Fix the cause and save the automation again' }
  }
  if (Number(i.target) === 0) {
    return { ...base, color: 'gray', code: 'no_capacity', label: 'No capacity', reason: 'Daily target is 0 — nothing will be sent', action: 'Raise the daily target to resume planning' }
  }
  if (i.runningPlan) {
    return { ...base, color: 'green', code: 'sending', label: 'Sending', reason: 'A run is dispatching now', action: null }
  }
  const ws = toMin(i.window?.start || '08:30'), we = toMin(i.window?.end || '19:30'), nowMin = maltaMinutes(now)
  if (!i.nextRun) {
    return { ...base, color: 'yellow', code: 'needs_review', label: 'Needs review', reason: 'Auto is on but no upcoming run is planned', action: 'Check the schedule and eligible contacts' }
  }
  if (nowMin < ws || nowMin >= we) {
    return { ...base, color: 'yellow', code: 'waiting', label: 'Waiting for allowed hours', reason: `Sending window ${i.window?.start || '08:30'}–${i.window?.end || '19:30'} Malta`, action: null }
  }
  if (i.nextRun.status === 'ready' && new Date(i.nextRun.at) - now <= 2 * 3600_000) {
    return { ...base, color: 'green', code: 'ready', label: 'Ready', reason: 'Next run passed its preflight checks', action: null }
  }
  return { ...base, color: 'yellow', code: 'scheduled', label: 'Scheduled', reason: 'Next run is planned', action: null }
}

/** Run / job status. "Executed" means provider-accepted sends were recorded; never "delivered". */
function runStatus(plan, now = new Date()) {
  if (!plan) return { color: 'gray', code: 'not_configured', label: 'Not configured', reason: null }
  const s = plan.status, o = plan.outcome, accepted = Number(plan.accepted_count ?? plan.accepted ?? 0)
  const why = plan.outcome_reason ? humanize(plan.outcome_reason) : null
  if (s === 'completed') {
    if (o === 'no_sends' || accepted === 0) return { color: 'red', code: 'failed', label: 'Failed', reason: why || '0 messages accepted by the provider', accepted }
    return { color: 'green', code: 'executed', label: o === 'partial' ? 'Executed (partial)' : 'Executed', reason: `${accepted} accepted by the provider${o === 'partial' ? ' — some entries not sent' : ''}`, accepted }
  }
  if (s === 'running') return { color: 'green', code: 'sending', label: 'Sending', reason: 'Dispatch in progress', accepted }
  if (['scheduled', 'preflight', 'ready'].includes(s)) {
    return { color: 'yellow', code: 'scheduled', label: s === 'ready' ? 'Scheduled · ready' : 'Scheduled', reason: plan.scheduled_at ? `Next check ${new Date(plan.scheduled_at).toISOString()}` : null, nextAt: plan.scheduled_at || null }
  }
  if (s === 'skipped') {
    if (/manual_pause|paused_by_user/.test(plan.outcome_reason || '')) return { color: 'gray', code: 'paused', label: 'Paused', reason: why }
    return { color: 'red', code: 'blocked', label: 'Blocked', reason: why || 'Skipped' }
  }
  if (s === 'failed') return { color: 'red', code: 'failed', label: 'Failed', reason: why || 'Run failed' }
  if (s === 'cancelled') return { color: 'gray', code: 'cancelled', label: 'Cancelled', reason: why }
  if (s === 'paused') return { color: 'gray', code: 'paused', label: 'Paused', reason: why }
  return { color: 'gray', code: 'not_configured', label: s === 'draft' ? 'Draft' : humanize(s) || 'Not configured', reason: why }
}

const FILTERS = { ready: ['green'], scheduled: ['yellow'], blocked: ['red', 'unknown'], paused: ['gray'] }
function matchesFilter(health, filter) { return !filter || filter === 'all' || (FILTERS[filter] || []).includes(health.color) }

module.exports = { accountHealth, runStatus, matchesFilter, maltaMinutes, STALE_MS, HEALTHY, OFFLINE }
