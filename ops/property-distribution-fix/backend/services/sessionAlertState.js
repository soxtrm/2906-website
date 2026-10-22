'use strict'
// ============================================================================
// services/sessionAlertState.js — persisted WhatsApp session health episodes.
//
// Kev, 2026-10-22 (P1): operators received the same
//   "📷 Session Gabriela needs a QR rescan — it cannot self-heal by restarting."
// again and again. Causes, all in waha.js:
//   - the throttle lived in an in-memory Map, and index.js runs the health
//     pass on every backend start -> every deploy/restart re-sent the alert;
//   - a QR code that nobody scans expires to FAILED, the 5-minute backoff then
//     restarts the session, WAHA shows a new QR -> the session flapped
//     QR -> FAILED -> restart -> QR forever, each lap a fresh "event".
//
// Model now: one FAILURE EPISODE per session, persisted in Redis so a backend
// restart never forgets it. Inside an episode the QR alert is sent once, one
// reminder may follow after ESCALATE_AFTER_MS, and nothing else. Only a real
// recovery (CONNECTED) closes the episode and sends one "connected again".
// ============================================================================

const STATES = Object.freeze(['CONNECTED', 'DISCONNECTED', 'RECONNECTING', 'QR_REQUIRED', 'AUTH_FAILED', 'RECOVERED'])
const DOWN_ALERT_AFTER_MS = 15 * 60_000          // a plain outage is reported once it lasts 15 min
const ESCALATE_AFTER_MS = 6 * 60 * 60_000        // one reminder if still unresolved after 6 h
const MAX_REMINDERS = 1
const QR_RESTART_MIN_INTERVAL_MS = 60 * 60_000   // refresh an expired QR at most hourly, never every few minutes
const KEY = session => `wa:session-alert:${session}`

function classify(wahaStatus) {
  const s = String(wahaStatus || '').toUpperCase()
  if (s === 'WORKING' || s === 'CONNECTED') return 'CONNECTED'
  if (s === 'SCAN_QR_CODE') return 'QR_REQUIRED'
  if (s === 'STARTING' || s === 'STOPPING') return 'RECONNECTING'
  if (s === 'AUTH_FAILED' || s === 'LOGGED_OUT') return 'AUTH_FAILED'
  return 'DISCONNECTED'   // FAILED, STOPPED, unreachable
}

function fmt(ts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(ts))
}

function operatorAction(session) {
  return `Action: open the WAHA dashboard → Sessions → ${session} → scan the QR with the ${session} phone (WhatsApp → Linked devices).`
}

// Pure: (previous record, observed WAHA status, now) -> { record, messages, allowRestart }
function step(prev, wahaStatus, now = Date.now(), session = 'session') {
  const observed = classify(wahaStatus)
  const rec = prev ? { ...prev } : { state: 'CONNECTED', since: now, episode: null }
  const messages = []

  if (observed === 'CONNECTED') {
    if (rec.episode && (rec.episode.qrNotifiedAt || rec.episode.downNotifiedAt)) {
      messages.push(`✅ Session ${session} is connected again (problem since ${fmt(rec.episode.startedAt)}).`)
    }
    return { record: { state: rec.episode ? 'RECOVERED' : 'CONNECTED', since: now, episode: null }, messages, allowRestart: false }
  }

  const ep = rec.episode ? { ...rec.episode } : { startedAt: now, qrSeen: false, qrNotifiedAt: null, downNotifiedAt: null, reminders: 0, lastRestartAt: null }
  if (observed === 'QR_REQUIRED' || observed === 'AUTH_FAILED') ep.qrSeen = true

  if (ep.qrSeen && !ep.qrNotifiedAt) {
    messages.push(`📷 Session ${session} needs a QR scan — it cannot reconnect on its own. ${operatorAction(session)}`)
    ep.qrNotifiedAt = now
  } else if (!ep.qrSeen && !ep.downNotifiedAt && now - ep.startedAt >= DOWN_ALERT_AFTER_MS) {
    messages.push(`⚠️ Session ${session} has been offline since ${fmt(ep.startedAt)} (state: ${wahaStatus || 'unreachable'}). Automatic restarts continue.`)
    ep.downNotifiedAt = now
  } else {
    const firstAlert = ep.qrNotifiedAt || ep.downNotifiedAt
    if (firstAlert && ep.reminders < MAX_REMINDERS && now - firstAlert >= ESCALATE_AFTER_MS) {
      messages.push(`⏰ Still unresolved: session ${session} has been down since ${fmt(ep.startedAt)}${ep.qrSeen ? ` and needs a QR scan. ${operatorAction(session)}` : '.'}`)
      ep.reminders += 1
    }
  }

  // A session waiting for a human scan is not restarted every few minutes:
  // at most once an hour, only to replace an expired QR for the operator.
  let allowRestart = true
  if (ep.qrSeen) {
    allowRestart = !ep.lastRestartAt || now - ep.lastRestartAt >= QR_RESTART_MIN_INTERVAL_MS
  }
  return { record: { state: observed, since: rec.state === observed ? rec.since : now, episode: ep }, messages, allowRestart }
}

function noteRestart(record, now = Date.now()) {
  if (!record || !record.episode) return record
  return { ...record, episode: { ...record.episode, lastRestartAt: now } }
}

async function load(redis, session) {
  try {
    const raw = await redis.get(KEY(session))
    return raw ? JSON.parse(raw) : null
  } catch (_) {
    return null
  }
}

async function save(redis, session, record) {
  try {
    await redis.set(KEY(session), JSON.stringify(record), 'EX', 30 * 24 * 3600)
  } catch (_) { /* best effort: worst case one duplicate alert, never a lost session */ }
}

module.exports = {
  STATES, DOWN_ALERT_AFTER_MS, ESCALATE_AFTER_MS, QR_RESTART_MIN_INTERVAL_MS,
  classify, step, noteRestart, load, save, KEY,
}
