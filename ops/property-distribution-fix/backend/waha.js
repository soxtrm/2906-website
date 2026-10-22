const fs = require('fs')
const path = require('path')
const config = require('./config')
const log = require('./logger')
const { sendAlert } = require('./telegram')
const sessionRoles = require('./services/sessionRoles')
const { collectMessagePages } = require('./services/wahaMediaPager')

// Legacy owner-facing pool. Internal/admin traffic uses bridgeSessions.
const sessions = [config.waha.session1, config.waha.session2, config.waha.session3].filter(Boolean)
const bridgeSessions = sessionRoles.BRIDGE_PRIORITY

// ─── Canonical session config ─────────────────────────────────────
// One source of truth used by every create/restart path. Sessions created
// without this (e.g. via the WAHA dashboard with empty config:{}) end up
// silent or without history — buildSessionConfig fixes that.
//
// IMPORTANT:
//   • webhook url is singular /webhook/waha (matches routes/webhook.js)
//   • events include inbound messages, message.reaction, and session.status;
//     message.any stays disabled because it causes duplicates
//   • noweb.store.enabled + fullSync required for getChatMessages / summarize
//   • message.any is required for commands typed by the session owner in groups;
//     routes/webhook.js admits only explicit human control messages and rejects echoes
//   • markOnline:false keeps account presence silent
const BACKEND_WEBHOOK_URL = 'http://backend:3001/webhook/waha'

function buildSessionConfig(_sessionName) {
  return {
    webhooks: [{
      url: BACKEND_WEBHOOK_URL,
      events: ['message', 'message.any', 'message.reaction', 'session.status'],
      retries: { policy: 'linear', delaySeconds: 2, attempts: 15 },
    }],
    noweb: {
      store: { enabled: true, fullSync: true },
      markOnline: false,
    },
  }
}

// Reapply the canonical config to a session WITHOUT a stop/delete cycle —
// safe to call on a WORKING session to fix drift (events/retries/markOnline).
// Skips the PUT when the live config already matches canonical, because PUT
// makes WAHA bounce the session through STOPPED→STARTING even when nothing
// changes — which causes thrashing on every 2-minute health pass.
function _configIsCanonical(liveConfig) {
  if (!liveConfig) return false
  const wh = (liveConfig.webhooks || [])[0]
  if (!wh || wh.url !== BACKEND_WEBHOOK_URL) return false
  const events = (wh.events || []).slice().sort()
  if (events.length !== 4 || events[0] !== 'message' || events[1] !== 'message.any' || events[2] !== 'message.reaction' || events[3] !== 'session.status') return false
  const r = wh.retries
  if (!r || r.policy !== 'linear' || r.delaySeconds !== 2 || r.attempts !== 15) return false
  const store = liveConfig.noweb?.store
  if (!store?.enabled || !store?.fullSync) return false
  if (liveConfig.noweb?.markOnline !== false) return false
  return true
}

async function ensureSessionConfig(session, { force = false } = {}) {
  try {
    if (!force) {
      const current = await wahaRequest('GET', `/api/sessions/${session}`).catch(() => null)
      if (current && _configIsCanonical(current.config)) return // already canonical
    }
    await wahaRequest('PUT', `/api/sessions/${session}`, {
      config: buildSessionConfig(session),
    })
    log.info('Canonical config applied to session', { session })
  } catch (err) {
    log.warn('ensureSessionConfig failed', { session, err: err.message })
  }
}
let sessionRoundRobin = 0

// Cache session identities (phone + lid) once they are confirmed WORKING
// so webhook.js can detect self-messages without an async lookup.
const sessionInfoCache = new Map()

function _cacheSessionMe(session, me) {
  if (!me) return
  sessionInfoCache.set(session, {
    phone: (me.id || '').replace(/@.*/, ''),
    lid:   me.lid ? (me.lid || '').replace(/@.*/, '') : null,
  })
}

function getCachedSessionIdentity(session) {
  return sessionInfoCache.get(session) || null
}

// Returns session identity from cache; if missing, fetches live from WAHA and caches.
// Guarantees a result even if the cron hasn't run yet after a cold start.
async function getOrFetchSessionIdentity(session) {
  const cached = sessionInfoCache.get(session)
  if (cached) return cached
  try {
    const info = await wahaRequest('GET', `/api/sessions/${session}`)
    if (info?.me) {
      _cacheSessionMe(session, info.me)
      return sessionInfoCache.get(session) || null
    }
  } catch {}
  return null
}

async function wahaRequest(method, endpoint, body, { timeoutMs = 15000 } = {}) {
  const url = `${config.waha.url}${endpoint}`
  // Client-side timeout. Without this, a malformed chatId (e.g. '+356****0699@c.us')
  // gets accepted by WAHA's HTTP layer but the GOWS worker hangs forever
  // waiting to resolve it. 15s is the upper bound for a TEXT call — observed
  // live sendText roundtrip is ~300ms.
  //
  // Kev, 2026-08-28: that 15s ceiling was applied to EVERY call, including
  // /api/sendImage and /api/sendVideo, whose body embeds the full base64
  // media and can legitimately take longer than 15s for WAHA to upload to
  // WhatsApp — especially into a category group with 15 photos back to
  // back. That is exactly what "❌ ... This operation was aborted" is:
  // this file's OWN AbortController firing, not a real WAHA/WhatsApp
  // failure. sendImage/sendVideo below now pass a longer timeoutMs.
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.waha.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(to)
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WAHA ${method} ${endpoint} → ${res.status}: ${text}`)
  }

  return res.json().catch(() => null)
}

async function getSessionStatus(session) {
  // WAHA's /api/sessions/{name} is CASE-SENSITIVE (verified live 2026-08-08:
  // "/api/sessions/Kevthirdd" → 200, "/api/sessions/kevthirdd" → 404,
  // "/api/sessions/Cedric" → 200, "/api/sessions/cedric" → 404).
  // .env sometimes hands us lowercase ('cedric', 'kevthirdd') while WAHA
  // keeps CapitalCase. Try the requested name first; on 404, retry once
  // with a small bag of case-variants (lowercase, TitleCase). Never
  // re-request when the variant matches the original.
  const variants = (() => {
    const v = String(session || '')
    if (!v) return []
    const set = new Set([v])
    set.add(v.toLowerCase())
    set.add(v.charAt(0).toUpperCase() + v.slice(1).toLowerCase())
    return [...set]
  })()
  let lastErr = null
  for (const candidate of variants) {
    try {
      return await wahaRequest('GET', `/api/sessions/${candidate}`)
    } catch (err) {
      lastErr = err
    }
  }
  return null
}

async function getActiveSession() {
  for (const session of bridgeSessions) {
    const status = await getSessionStatus(session)
    if (status?.status === 'WORKING' || status?.status === 'CONNECTED') {
      return session
    }
  }
  log.warn('No WORKING bridge session found; returning preferred Argus2 for durable queueing')
  return bridgeSessions[0]
}

// Returns primary session (default) only if WORKING — only it sends group reactions.
// Returns null if primary is offline; callers must skip the reaction rather than fall back.
async function getGroupReactionSession() {
  for (const candidate of bridgeSessions) {
    const status = await getSessionStatus(candidate)
    if (status?.status === 'WORKING' || status?.status === 'CONNECTED') {
      return candidate
    }
  }
  return null
}

// ─── Admin fallback chain (FIX 1) ──────────────────────────────────────────
// Picks which of Kev's own three WhatsApp accounts should carry an
// ADMIN-FACING send — an alert/notification aimed at Kev himself (e.g. the
// REMINDER channel, "new group detected" DM, "new property submitted" DM).
// This is NOT for owner-bound or agent-bound sends, which have their own
// account-selection logic elsewhere (getActiveSession, getGroupReactionSession,
// per-thread owner_session, outreach rotation, etc).
//
// `sessions` is already exactly [default, Kevsecond, kevthirdd] in that
// priority order (see top of file), so this just walks it and returns the
// first one whose live WAHA status is WORKING/CONNECTED. No caching, no
// sticky handoff — every call re-checks live status, so a recovered
// `default` is picked again on the very next send with no restart or manual
// step required. Returns null if none of the three are up; callers MUST
// treat that as "nobody available" and skip the send rather than picking a
// dead session.
// WhatsApp-Router 1/5 (Kev, 2026-09-03): this used to be its OWN
// live-status-loop, a second parallel system alongside lib/sessionRouter.js
// that nothing kept in sync -- the exact "two fallback systems, never
// merged" tech debt the router audit called out. Now a thin delegate to
// sessionRouter's cache (fast, restart-durable via session_health, fed by
// real session.status webhook events) instead of re-deriving live status
// itself. Late require -- sessionRouter.js requires this file at load time,
// so a top-level require here would be circular; requiring inside the
// function body only resolves it lazily, after both modules have finished
// loading. Same return shape as before (a session name or null) so no
// caller needs to change for this alone.
async function pickActiveAdminSession() {
  const sessionRouter = require('./lib/sessionRouter')
  const working = await sessionRouter.getWorkingSessionNames()
  for (const session of bridgeSessions) {
    const found = working.find(name => sessionRoles.same(name, session))
    if (found) return found
  }
  return null
}

// Rotate between sessions for load distribution
function getRotatingSession() {
  const session = sessions[sessionRoundRobin % sessions.length]
  sessionRoundRobin++
  return session
}

// Track IDs of messages sent by the backend so webhook echoes can be ignored.
// WAHA NOWEB wraps IDs as "true_<jid>_<shortId>" in message.any events but returns
// just "<shortId>" from /api/sendText. We normalise to the short form for comparison.
//
// Safety: only mark IDs that look like real WAHA short-IDs (alphanumeric, length
// between 8 and 64). The previous `_shortId` would split any underscore-separated
// string and use the last piece — so a freshly crafted test ID ending in a number
// could collide with stale Set entries. The format check kills that risk.
const _sentByBackend = new Set()
const _WAHA_SHORT_RE = /^[A-Za-z0-9_-]{8,64}$/
// WhatsApp-Router 1/5 (Kev, 2026-09-03, real incident): the old version
// naively took "the last underscore-separated piece", which was only ever
// tested against a DM echo ("true_<phone>@<domain>_<shortId>", 3 parts,
// last piece IS the shortId). A GROUP message echo has an EXTRA trailing
// segment -- "true_<groupJid>_<shortId>_<senderJid>", 4 parts -- so "last
// piece" silently returned the SENDER's jid instead of the real shortId.
// wasSentByBackend() then never matched the bot's own group sends, so
// self-echo detection was silently broken for every group flow (found live
// via CLIENTGROUPS: the control-channel activation notice, sent into the
// real "WA Assistance Bot" group, bounced back through the webhook
// unrecognised as our own message and got processed as a fresh incoming
// one -- see services/clientAssistant.js's Point E-equivalent). Fixed by
// stripping a leading "true_" then trimming ONE @-containing segment off
// each end (a JID always contains '@', the real shortId never does) rather
// than assuming a fixed position -- correct for the plain short-id-only
// shape (direct sendText API response), the 3-part DM echo, and the 4-part
// group echo alike, and never mis-splits a shortId that itself happens to
// contain an underscore (only the boundary segments are touched).
function _shortId(id) {
  if (!id) return ''
  let s = String(id)
  if (s.startsWith('true_')) s = s.slice(5)
  const firstSep = s.indexOf('_')
  if (firstSep !== -1 && s.slice(0, firstSep).includes('@')) {
    s = s.slice(firstSep + 1)
  }
  const lastSep = s.lastIndexOf('_')
  if (lastSep !== -1 && s.slice(lastSep + 1).includes('@')) {
    s = s.slice(0, lastSep)
  }
  return s
}
function _markSentByBackend(id) {
  const short = _shortId(id)
  // Only mark if it looks like a real WAHA short-id (no crafted collisions)
  if (!_WAHA_SHORT_RE.test(short)) return
  _sentByBackend.add(short)
  // Kev, 2026-09-10 (Clientgroups auto-sender diagnosis, real incident: a
  // GROUP client_assistant_state -- 120363407815531015@g.us -- sat stuck in
  // HUMAN_ACTIVE for hours, dozens of "human takeover" log lines in short
  // bursts). clientAssistant.js sends multi-message sequences into these
  // group chats (intro, divider, caption, followup -- up to 4 sendText/
  // sendImage calls back to back) and correctly calls markSentByBackend()
  // after each one, but 60s was only ever proven against a DM echo's
  // near-instant round trip. A group's webhook echo can lag well past that
  // under real load (GOWS batches group traffic differently from a 1:1
  // chat), so the EARLIEST message in a burst could have its own mark
  // expire before its echo ever arrived -- misread as a human typing, which
  // silences the whole chat's automation for 3h (clientAssistant.js's
  // HUMAN_SILENCE_QUIET_MS) EVERY time it happens. 10 minutes is still far
  // shorter than that 3h silence window (so a stale mark can never mask a
  // genuinely new human message hours later) and comfortably covers any
  // realistic echo delay, group or DM.
  setTimeout(() => _sentByBackend.delete(short), 600_000)
}
// Exported so modules that deliberately bypass sendText() can still register
// their outbound ids with the echo guard.
//
// services/availability.js owns its own WAHA calls on purpose (it needs
// PUT /api/reaction with a flat body, and reply_to on sendText — see its header),
// which meant every message it sent came back through the webhook as ordinary
// input. Harmless while nothing listened for free text; on 2026-08-16 it stopped
// being harmless: the !book relay listens for the agent's next message in the
// agent's chat, and an availability notify landing in that same chat was
// forwarded to the owner as if the agent had typed it. The owner received
// "The property #2906-9003 is currently available — viewable / rentable."
//
// Registering the id here is the fix at the source: routes/webhook.js:235 then
// drops the echo before ANY handler sees it, for every current and future
// listener rather than one guard per listener.
function markSentByBackend(id) { return _markSentByBackend(id) }

function wasSentByBackend(id) {
  if (!id) return false
  const short = _shortId(id)
  if (!_WAHA_SHORT_RE.test(short)) return false
  return _sentByBackend.has(short)
}

// Kev, 2026-08-29: same class of bug as sendImage/sendVideo above, just
// slower to notice — sendText's roundtrip really is ~300ms normally, but
// GOWS shares one worker per session, so a mass category-group campaign
// (many sendImage calls back to back, each tying up the worker for
// seconds) leaves a plain sendText queued behind them long enough to blow
// the 15s default too ("categoryPublisher: send failed" / "sessionRouter:
// ... This operation was aborted" — the text send, not the images).
// timeoutMs is opt-in so the hundreds of latency-sensitive call sites
// (command replies etc.) keep the tight 15s default; categoryPublisher
// passes a longer one for its group posts.
async function sendText(session, phone, text, { timeoutMs, replyToMessageId } = {}) {
  // phone can be raw number or @c.us JID
  const chatId = phone.includes('@') ? phone : `${phone}@c.us`
  // One sender, one name (2026-09-24): throws on a foreign persona signature.
  await require('./services/outreachIdentity').assertOutboundIdentity(session, chatId, text)
  log.debug('Sending message via WAHA', { session, chatId: chatId.slice(-8) })
  const body = { session, chatId, text }
  // GOWS/WAHA renders this as a native quoted reply. Keep it optional so all
  // existing call sites retain their current plain-message behaviour.
  if (replyToMessageId) body.reply_to = replyToMessageId
  const result = await wahaRequest('POST', '/api/sendText', body,
    timeoutMs ? { timeoutMs } : undefined)
  // Record the sent message ID so its webhook echo is ignored
  const sentId = result?.key?.id || result?.id
  _markSentByBackend(sentId)
  // The software just wrote to this chat: restart the owner's inactivity clock
  // (services/contactTouch.js — 7-9 days of silence before an availability check).
  // Fire-and-forget; groups / LIDs / non-owners are no-ops there.
  try { require('./services/contactTouch').recordOutbound(chatId, session).catch(() => {}) } catch { /* never blocks a send */ }
  return result
}

async function sendSeen(session, chatId) {
  try {
    await wahaRequest('POST', '/api/sendSeen', { session, chatId })
  } catch (err) {
    log.debug('sendSeen failed (non-fatal)', err.message)
  }
}

// Marks a chat as unread client-side, so it looks "fresh" to Kev even though
// the bot already handled it. Confirmed live on GOWS 2026-08-29:
// POST /api/{session}/chats/{chatId}/unread -> 201 {"success":true}.
// (There is no session/chatId in the body for this one — session lives in
// the path, unlike sendSeen/sendText above.)
async function markChatUnread(session, phone) {
  try {
    const chatId = String(phone).includes('@') ? phone : `${phone}@c.us`
    await wahaRequest('POST', `/api/${session}/chats/${chatId}/unread`)
  } catch (err) {
    log.debug('markChatUnread failed (non-fatal)', err.message)
  }
}

// Create a WhatsApp group. WAHA Plus GOWS returns the full group record:
// { JID, OwnerJID, OwnerPN, Name, Participants: [{JID, PhoneNumber, LID, IsAdmin, Error}, ...] }
// The `participants` array reflects the post-create state: every member that
// was added successfully is in there with Error=0; failed members come back
// with non-zero Error and a PhoneNumber or JID.
//
// IMPORTANT: WAHA Plus does not expose update-subject / update-description /
// set-icon via REST. Welcome text, description, and the optional house emoji
// are sent as the first message in the group instead. That is also the better
// place for them: new members see the welcome text on join, not buried in
// the group-info card.
async function createGroup(session, name, participants) {
  // WAHA Plus GOWS expects participants as a list of {id: '<phone>@c.us'}
  // objects on POST /api/default/groups. Strings (with or without +) and
  // strings ending in @s.whatsapp.net return 500 ("Cannot read properties
  // of undefined (reading 'split')") because the engine tries to split on
  // an undefined id field. Probed live on the VPS — only the {id} shape
  // returns 201 Created.
  const list = (Array.isArray(participants) ? participants : [])
    .map(p => {
      if (p && typeof p === 'object' && p.id) return p
      const digits = String(p || '').replace(/[^0-9]/g, '')
      if (!digits || digits.length < 7) return null
      return { id: `${digits}@c.us` }
    })
    .filter(Boolean)
  if (!list.length) throw new Error('createGroup: no usable participants')
  const payload = {
    name: String(name || '').slice(0, 90),
    participants: list,
  }
  // /api/default/groups is the per-session endpoint and the only one
  // POST-creation accepts on this WAHA build (the unscoped /api/groups
  // returns 404 "Cannot POST /api/groups"). Both Kev's session "default"
  // and the per-session scoped endpoint work — we use the per-session
  // path so other sessions could later create their own groups.
  const endpoint = session ? `/api/${encodeURIComponent(session)}/groups` : '/api/default/groups'
  return wahaRequest('POST', endpoint, payload)
}
async function leaveGroup(groupJid) {
  return wahaRequest('POST', `/api/default/groups/${encodeURIComponent(groupJid)}/leave`)
}
async function getGroupInfo(groupJid) {
  return wahaRequest('GET', `/api/default/groups/${encodeURIComponent(groupJid)}`)
}

// CLIENTGROUPS 1/4 (Kev, 2026-09-03) -- join a real WhatsApp group via its
// invite link (used to onboard the WA Assistance Bot control channel onto a
// session we control, same per-session endpoint shape as createGroup
// above). Accepts either the bare invite code or the full
// https://chat.whatsapp.com/<code> link -- extracts the code either way so
// callers can just paste what WhatsApp gives them.
async function joinGroupByInvite(session, inviteLinkOrCode) {
  const m = String(inviteLinkOrCode || '').match(/(?:chat\.whatsapp\.com\/)?([A-Za-z0-9]{15,})/)
  const code = m ? m[1] : null
  if (!code) throw new Error('joinGroupByInvite: could not extract an invite code')
  const endpoint = session ? `/api/${encodeURIComponent(session)}/groups/join` : '/api/default/groups/join'
  return wahaRequest('POST', endpoint, { code })
}

async function isGroupMember(session, groupJid) {
  if (!session || !groupJid) return false
  try {
    await wahaRequest('GET', `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupJid)}`)
    return true
  } catch {
    return false
  }
}

// React to a specific message with an emoji (✅ ❓ 🏠 etc.)
// WAHA endpoint: PUT /api/reactions
async function sendReaction(session, chatId, messageId, reaction) {
  try {
    await wahaRequest('PUT', '/api/reactions', {
      session,
      reaction: { messageId, reaction },
    })
    log.debug('Reaction sent', { session, reaction, messageId: messageId?.slice(-8) })
  } catch (err) {
    log.warn('sendReaction failed (non-fatal)', { err: err.message, reaction })
  }
}

// Delete a specific message (used by cleanup scripts)
// WAHA 2026.x endpoint: DELETE /api/{session}/chats/{chatId}/messages/{messageId}
async function deleteMessage(session, chatId, messageId) {
  const chat = chatId.includes('@') ? chatId : `${chatId}@g.us`
  return wahaRequest('DELETE', `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(messageId)}`)
}

// ── Session management ────────────────────────────────────────────

async function saveQrCode(session) {
  try {
    const res = await fetch(`${config.waha.url}/api/sessions/${session}/auth/qr`, {
      headers: { 'X-Api-Key': config.waha.apiKey },
    })
    if (!res.ok) {
      log.warn('QR fetch failed', { session, status: res.status })
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const filePath = path.join('/app', `qr_${session}.png`)
    fs.writeFileSync(filePath, buf)
    log.info('QR code saved', { session, path: filePath })
  } catch (err) {
    log.warn('saveQrCode error', { session, err: err.message })
  }
}

// ── restart backoff ─────────────────────────────────────────────────────────
// Why this exists (2026-08-16): the health cron runs every 2 minutes and used
// to restart a non-WORKING session on EVERY pass, forever. Measured over 24h:
// 108 restart attempts, 106 of them `default` in FAILED, and exactly 2 that
// ended in "session restored". The log window held 251 stop+start pairs on
// default and 205 on Kevsecond.
//
// A session that cannot come back on its own — logged out, needs a QR — will
// never be fixed by a restart, so retrying it every 2 minutes is pure damage:
// it keeps the account flapping and drags the sequential loop (and therefore
// the other accounts) with it.
//
// So consecutive failures back off 2 → 4 → 5 min (capped), and any success
// clears the counter. The cron keeps ticking; it just stops hammering.
//
// Kev 2026-08-22: cap dropped from 30 min to 5 min. 30 min made sense while
// SCAN_QR_CODE shared this same clock, but that state now bypasses backoff
// entirely (see decideSessionAction — 'qr' returns before the backoff check
// runs), so this clock only ever throttles FAILED/STOPPED/CONFLICT, which DO
// stand a chance of self-healing (WhatsApp-side reconnect, WAHA restart) and
// shouldn't sit dead for half an hour waiting on the timer.
const _restartState = new Map()   // session → { fails, nextAttemptAt }
const RESTART_BASE_MS = 2 * 60_000
const RESTART_MAX_MS  = 5 * 60_000

function _clearBackoff(session) { _restartState.delete(session) }

function _backoffBlocks(session) {
  const s = _restartState.get(session)
  if (!s) return 0
  const wait = s.nextAttemptAt - Date.now()
  return wait > 0 ? wait : 0
}

function _noteRestartFailure(session) {
  const s = _restartState.get(session) || { fails: 0, nextAttemptAt: 0 }
  s.fails += 1
  const delay = Math.min(RESTART_BASE_MS * 2 ** (s.fails - 1), RESTART_MAX_MS)
  s.nextAttemptAt = Date.now() + delay
  _restartState.set(session, s)
  log.info('WAHA restart backoff', { session, fails: s.fails, nextTryInMin: Math.round(delay / 60000) })
}

// ── WhatsApp-side alerting for session health ───────────────────────────────
// Kev 2026-08-22: sendAlert() above is Telegram-only. He wants QR-needed and
// stuck-down sessions mirrored to WhatsApp too, since Telegram gets missed.
// Throttled per (session, kind) so a session stuck for days pages once per
// window, not every 2-minute tick.
const ALERT_THROTTLE_MS = 6 * 60 * 60_000  // 6h
const _lastWaAlertAt = new Map()  // `${session}:${kind}` → timestamp
const _downSince = new Map()      // session → timestamp first seen non-WORKING

function _shouldAlert(session, kind) {
  const key = `${session}:${kind}`
  const last = _lastWaAlertAt.get(key)
  if (last && Date.now() - last < ALERT_THROTTLE_MS) return false
  _lastWaAlertAt.set(key, Date.now())
  return true
}

async function _alertViaWhatsApp(text) {
  try {
    const admin = await pickActiveAdminSession()
    const botNumber = config.admin.botNumber
    if (!admin || !botNumber) {
      log.warn('WhatsApp session alert skipped — no WORKING admin session', { text })
      return
    }
    await sendText(admin, `${botNumber}@c.us`, text)
  } catch (err) {
    log.warn('WhatsApp session alert failed', { err: err.message })
  }
}

// States that mean "WAHA is already working on it — do not touch".
//
// STARTING was the actual bug. The old code positively handled WORKING and
// SCAN_QR_CODE and let EVERYTHING else fall into the restart branch, so a
// session in the middle of booting got stopped and started again. A GOWS boot
// with history sync takes longer than the 90s poll below, so it never reached
// WORKING, went FAILED, and the next tick did it again. Caught in the log at
// 19:08:00 on 2026-08-16: `not active, restarting {"state":"STARTING"}`.
const IN_FLIGHT_STATES = new Set(['STARTING', 'STOPPING'])

// The whole decision, as one pure function, so it can be tested as a table
// instead of by driving a real WhatsApp session into five different states.
//   healthy → nothing to do
//   qr      → refresh the QR, a human has to scan it
//   wait    → WAHA is mid-transition, keep hands off
//   backoff → down, but we restarted too recently to try again
//   restart → down, and it is our turn to act
function decideSessionAction(state, backoffMs = 0) {
  if (state === 'WORKING' || state === 'CONNECTED') return 'healthy'
  if (state === 'SCAN_QR_CODE') return 'qr'
  if (IN_FLIGHT_STATES.has(state)) return 'wait'
  if (backoffMs > 0) return 'backoff'
  return 'restart'
}

async function ensureSessionWorking(session) {
  const status = await getSessionStatus(session)
  const state = status?.status
  const backoffMs = _backoffBlocks(session)
  const action = decideSessionAction(state, backoffMs)

  // Kev 2026-08-22: track how long a session has sat non-WORKING so we can
  // page him once it crosses 15 min, regardless of which of the non-healthy
  // actions below is firing.
  if (action !== 'healthy') {
    if (!_downSince.has(session)) _downSince.set(session, Date.now())
    const downMs = Date.now() - _downSince.get(session)
    if (downMs > 15 * 60_000 && _shouldAlert(session, 'down15')) {
      await _alertViaWhatsApp(`⚠️ Session ${session} has been non-WORKING for over 15 min (state: ${state ?? 'unreachable'}).`)
    }
  }

  // WEBJS reports WORKING before the client is fully ready (me is null during warmup).
  // Wait up to 30s for me to be populated before declaring healthy.
  if (action === 'healthy') {
    _downSince.delete(session)
    _clearBackoff(session)
    await ensureSessionConfig(session)
    if (status.me) {
      _cacheSessionMe(session, status.me)
      log.info('WAHA session healthy', { session, state, me: status.me.id })
      return true
    }
    log.info('WAHA session WORKING but not ready yet, waiting for client warmup', { session })
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const s = await getSessionStatus(session)
      if (s?.me) {
        _cacheSessionMe(session, s.me)
        log.info('WAHA session ready', { session, me: s.me.id })
        return true
      }
    }
    log.warn('WAHA session WORKING but me still null after 30s, proceeding anyway', { session })
    return true
  }

  // Already awaiting scan — refresh QR silently, no restart needed.
  // Backoff is NOT cleared here (2026-08-18 fix). It used to be, on the theory
  // that a session waiting for a human scan "is not broken" — but WhatsApp's
  // QR code expires on its own, and when nobody scans it in time WAHA reports
  // FAILED again a few minutes later. With backoff cleared on every 'qr' pass,
  // the very next 2-min cron tick then restarted immediately — reproducing the
  // exact 4-minute restart thrash the 2026-08-16 backoff fix was written to
  // stop (108 restarts/24h back then), just routed through SCAN_QR_CODE
  // instead of staying in FAILED. Measured live: default cycled
  // STOPPED→STARTING→SCAN_QR_CODE→FAILED every ~4 min for about an hour
  // (10:00–11:47) before a natural WhatsApp-side reconnect ended it — the QR
  // itself was never actually scannable (its own fetch 404s: see saveQrCode).
  // A real scan still wins: the 'healthy' branch above clears backoff on the
  // very next pass regardless of what happened while waiting.
  if (action === 'qr') {
    await saveQrCode(session)
    log.warn('WAHA session awaiting QR scan', { session })
    if (_shouldAlert(session, 'qr')) {
      await _alertViaWhatsApp(`📷 Session ${session} needs a QR rescan — it cannot self-heal by restarting.`)
    }
    return false
  }

  // Mid-transition — WAHA is already doing the thing we would be asking for.
  // Restarting here is what created the loop; see IN_FLIGHT_STATES above.
  if (action === 'wait') {
    log.info('WAHA session is coming up, leaving it alone', { session, state })
    return false
  }

  // STOPPED / FAILED / CONFLICT / null → stop + start, unless we are backing off
  if (action === 'backoff') {
    log.info('WAHA session down but backing off, not restarting',
      { session, state: state ?? 'unreachable', retryInMin: Math.round(backoffMs / 60000) })
    return false
  }

  log.warn('WAHA session not active, restarting', { session, state: state ?? 'unreachable' })
  await sendAlert(`WAHA session ${session} (${state ?? 'unreachable'}) — restarting`, 'warn')

  try { await wahaRequest('POST', `/api/sessions/${session}/stop`) } catch {}
  await new Promise(r => setTimeout(r, 2000))

  // Persist the FULL canonical config BEFORE /start so the session boots with
  // webhooks + NOWEB store correctly. Sessions created via WAHA dashboard land
  // here with empty config:{} and otherwise come back online silent / without
  // history, breaking summarize / reminders / history sync.
  try {
    await wahaRequest('PUT', `/api/sessions/${session}`, { config: buildSessionConfig(session) })
    log.info('Canonical config applied before restart', { session })
  } catch (err) {
    log.warn('PUT canonical config failed (continuing with /start)', { session, err: err.message })
  }

  try {
    await wahaRequest('POST', `/api/sessions/${session}/start`)
  } catch (err) {
    log.error('Failed to start WAHA session', { session, err: err.message })
    await sendAlert(`WAHA session ${session} failed to start: ${err.message}`, 'error')
    _noteRestartFailure(session)
    return false
  }

  // Poll up to 90 seconds for SCAN_QR_CODE or WORKING
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const s = await getSessionStatus(session)
    const st = s?.status

    if (st === 'WORKING' || st === 'CONNECTED') {
      _clearBackoff(session)
      await ensureSessionConfig(session)
      const sInfo = await getSessionStatus(session)
      _cacheSessionMe(session, sInfo?.me)
      log.info('WAHA session restored', { session })
      await sendAlert(`WAHA session ${session} restored ✅`, 'success')
      return true
    }

    if (st === 'SCAN_QR_CODE') {
      // 2026-08-18 fix: this restart has NOT recovered the session yet, so
      // record it as a soft failure (backoff) rather than clearing the
      // counter. See the matching comment on the 'qr' branch above for why —
      // an unscanned code that expires back to FAILED must be met with
      // backoff, not an immediate re-restart. A real scan still wins: the
      // 'healthy' branch above clears backoff on the very next pass.
      _noteRestartFailure(session)
      await saveQrCode(session)
      log.warn('WAHA session needs QR scan', { session })
      await sendAlert(`WAHA QR scan needed for ${session} — saved to qr_${session}.png`, 'warn')
      if (_shouldAlert(session, 'qr')) {
        await _alertViaWhatsApp(`📷 Session ${session} needs a QR rescan — it cannot self-heal by restarting.`)
      }
      return false
    }
  }

  // Still not up after 90s. It may well be mid-boot — GOWS history sync
  // routinely outlasts this poll — so the next pass is deliberately delayed
  // rather than immediate. Letting it finish is the whole point.
  log.error('WAHA session did not reach WORKING state', { session })
  await sendAlert(`WAHA session ${session} failed to reach WORKING after restart`, 'error')
  _noteRestartFailure(session)
  return false
}

// Backwards-compatible alias — every call site now flows through the canonical
// PUT in ensureSessionConfig, so we can't end up with a session missing webhooks
// or NOWEB store after a cron pass.
async function ensureStoreEnabled(sessionName) {
  return ensureSessionConfig(sessionName)
}

// One pass at a time. The cron fires every 2 minutes, this loop is SEQUENTIAL
// over every session, and a single restart can hold the loop for 90s+ — so two
// passes used to overlap and stop/start the same session from two directions.
// That is why Kevsecond racked up 205 stop+start pairs while nothing was
// actually wrong with it: it was collateral from default being stuck.
let _healthPassRunning = false

async function ensureAllSessionsWorking() {
  if (_healthPassRunning) {
    log.info('WAHA health pass already running, skipping this tick')
    return
  }
  _healthPassRunning = true
  try {
    // Only process sessions WAHA knows about — skip deleted/missing ones silently
    let liveNames
    try {
      const data = await wahaRequest('GET', '/api/sessions')
      liveNames = Array.isArray(data) ? data.map(s => s.name) : []
    } catch {
      liveNames = sessions.slice() // fallback: try all configured
    }
    // Kev 2026-08-22: was `for (const configured of sessions)` — the fixed
    // 3-admin-account list (default/Kevsecond/kevthirdd). That silently
    // skipped Olga/Jasmine/Cedric (and any session added later): they never
    // got the canonical webhook config applied or a restart when down —
    // which is exactly why Olga's live WAHA config came back completely
    // empty (no webhooks at all). Health-check every session WAHA actually
    // knows about, using WAHA's own spelling directly (also removes the old
    // casing dance below — `sessions` stays reserved for admin-fallback /
    // round-robin, which intentionally covers only Kev's 3 numbers).
    for (const session of liveNames.filter(name => name && !['default', 'argus1'].includes(String(name).toLowerCase()))) {
      await ensureSessionConfig(session)
      await ensureSessionWorking(session)
    }
  } finally {
    _healthPassRunning = false
  }
}

// Returns all WORKING sessions with their phone numbers.
// Falls back to the configured sessions array if the API call fails.
async function getWorkingSessions() {
  try {
    const data = await wahaRequest('GET', '/api/sessions')
    if (!Array.isArray(data)) throw new Error('unexpected response')
    return data
      .filter(s => s.status === 'WORKING' || s.status === 'CONNECTED')
      .map(s => ({ name: s.name, phone: s.me?.id?.replace('@c.us', '') || null }))
  } catch {
    return sessions.map(s => ({ name: s, phone: null }))
  }
}

async function checkNumberStatus(session, phone) {
  try {
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`
    const data = await wahaRequest('POST', '/api/contacts/check-exists', { session, phone: chatId })
    return data?.numberExists === true
  } catch {
    return true  // fail-safe: never block outreach on check error
  }
}

// Returns the plain phone number for a session (strips @c.us etc.)
async function getSessionPhone(session) {
  try {
    const s = await getSessionStatus(session)
    return s?.me?.id?.replace(/@.*/, '') || null
  } catch { return null }
}

// Fetch recent messages from a chat (notes, group, DM).
// Returns array of message objects (newest first from WAHA).
async function getChatMessages(session, chatId, limit = 200) {
  try {
    return await getChatMessagesStrict(session, chatId, limit)
  } catch (err) {
    log.warn('getChatMessages failed', { session, chatId: String(chatId).slice(-12), err: err.message })
    return []
  }
}

// Kev, 2026-09-01: same fetch, but THROWS instead of swallowing into `[]`.
// getChatMessages()'s empty-array-on-failure is fine for callers where "no
// history" and "couldn't check" are equally safe to treat as nothing found
// (summaries, etc). It is NOT safe for a caller using the result to decide
// whether it is safe to let automation speak — a fetch failure there must
// never look identical to a genuinely empty chat. Root-caused a real
// incident: services/autoOwnerConversation.js's isFirstReplyToOutreach()
// used getChatMessages() to check "did we already send something after the
// outreach pitch" and treated a failed fetch as "no, we didn't" (permissive)
// — so when the `default` session was mid-restart-loop (SCAN_QR_CODE/FAILED,
// see the 2026-08-31 19:2x-19:4x logs), a fetch failure during that window
// let the bot ask an owner a checklist question right after Kevin had
// already called and voice-noted them by hand in the same chat.
async function getChatMessagesStrict(session, chatId, limit = 200) {
  const encoded = encodeURIComponent(chatId)
  const data = await wahaRequest('GET', `/api/${session}/chats/${encoded}/messages?limit=${limit}&downloadMedia=false`)
  if (!Array.isArray(data)) throw new TypeError('WAHA history response is not an array')
  return data
}

// List all chats for a session (private + groups).
// Returns array of chat objects; use chat.id to identify private (@c.us) vs group (@g.us).
async function getChats(session, limit = 500) {
  try {
    const data = await wahaRequest('GET', `/api/${session}/chats?limit=${limit}`)
    return Array.isArray(data) ? data : []
  } catch (err) {
    log.warn('getChats failed', { session, err: err.message })
    return []
  }
}

// Send an image to a chat using base64-encoded data.
async function sendImage(session, chatId, base64Data, mimeType, caption) {
  const cid = chatId.includes('@') ? chatId : `${chatId}@c.us`
  await require('./services/outreachIdentity').assertOutboundIdentity(session, cid, caption)
  // 45s, not the 15s default — this call's body carries the full image, and
  // WAHA has to upload that to WhatsApp before it responds, not just answer
  // an API roundtrip.
  const result = await wahaRequest('POST', '/api/sendImage', {
    session,
    chatId: cid,
    caption: caption || '',
    file: {
      mimetype: mimeType || 'image/png',
      filename: 'screenshot.png',
      data: base64Data,
    },
  }, { timeoutMs: 45000 })
  const sentId = result?.key?.id || result?.id
  _markSentByBackend(sentId)
  return result
}

// Send a document or other binary file to a chat.
async function sendFile(session, chatId, base64Data, mimeType, filename, caption) {
  const cid = chatId.includes('@') ? chatId : `${chatId}@c.us`
  await require('./services/outreachIdentity').assertOutboundIdentity(session, cid, caption || filename)
  const result = await wahaRequest('POST', '/api/sendFile', {
    session,
    chatId: cid,
    caption: caption || '',
    file: {
      mimetype: mimeType || 'application/octet-stream',
      filename: filename || 'attachment',
      data: base64Data,
    },
  }, { timeoutMs: 60000 })
  const sentId = result?.key?.id || result?.id
  _markSentByBackend(sentId)
  return result
}

// Send a video to a chat using base64-encoded data.
//
// POST /api/sendVideo differs from /api/sendImage in two ways that both fail
// silently-ish if you copy the image call:
//   • `convert` is REQUIRED (MessageVideoRequest.required = chatId, file,
//     convert, session). WAHA 400s without it.
//   • `file.filename` is REQUIRED too (VideoBinaryFile), where the image
//     endpoint treats it as optional.
// convert:true makes WAHA re-encode via ffmpeg to the H.264/AAC MP4 WhatsApp
// actually accepts — a stock phone .mov or a high-profile mp4 is delivered as
// an undownloadable grey box otherwise.
async function sendVideo(session, chatId, base64Data, mimeType, caption, filename) {
  const cid = chatId.includes('@') ? chatId : `${chatId}@c.us`
  await require('./services/outreachIdentity').assertOutboundIdentity(session, cid, caption)
  const mime = (mimeType || 'video/mp4').split(';')[0].trim()
  // 120s — WAHA re-encodes via ffmpeg (convert:true) on top of the upload
  // itself, so this needs more headroom than sendImage's 45s, not less.
  const result = await wahaRequest('POST', '/api/sendVideo', {
    session,
    chatId: cid,
    caption: caption || '',
    convert: true,
    file: {
      mimetype: mime,
      filename: filename || `video.${mime.split('/')[1] === 'quicktime' ? 'mov' : (mime.split('/')[1] || 'mp4')}`,
      data: base64Data,
    },
  }, { timeoutMs: 120000 })
  const sentId = result?.key?.id || result?.id
  _markSentByBackend(sentId)
  return result
}

// ARGUS Agent Layer, self-serve WhatsApp connect (Kev, 2026-09-16):
// DISCONNECT action — logs the session out without deleting it, so
// reconnecting later reuses the same session/QR flow rather than minting a
// new one.
async function stopSession(session) {
  return wahaRequest('POST', `/api/sessions/${session}/stop`)
}

// ARGUS Agent Layer, self-serve WhatsApp connect (Kev, 2026-09-16): returns
// the QR as a data URI the Agent Profile frontend can put straight into an
// <img src>, instead of saveQrCode()'s file-on-disk (that one exists for
// Kev's own admin-side !waqr command, this is the same WAHA endpoint for a
// browser caller).
async function getQrImage(session) {
  const res = await fetch(`${config.waha.url}/api/sessions/${session}/auth/qr`, {
    headers: { 'X-Api-Key': config.waha.apiKey },
  })
  if (!res.ok) throw new Error(`QR fetch failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') || 'image/png'
  return `data:${contentType};base64,${buf.toString('base64')}`
}

// Idempotent create-or-resume for a deterministic per-Agent session name
// (agent_<id>). Deliberately NOT resetWahaSession()'s stop->delete->recreate
// -- that would tear down an already-WORKING connection every time an agent
// reopens their profile. This only:
//   - creates the session (canonical config, start:true) if WAHA has never
//     heard of it,
//   - (re)starts it if it exists but is STOPPED/FAILED,
//   - leaves it alone if it's already WORKING or mid-handshake
//     (SCAN_QR_CODE/STARTING) -- calling /start again on those is a no-op on
//     WAHA's side but pointless.
async function ensureAgentSession(session) {
  let current = null
  try { current = await wahaRequest('GET', `/api/sessions/${session}`) } catch { /* doesn't exist yet */ }

  if (!current) {
    log.info('ensureAgentSession: creating new session', { session })
    return wahaRequest('POST', '/api/sessions', { name: session, start: true, config: buildSessionConfig(session) })
  }
  if (current.status === 'STOPPED' || current.status === 'FAILED') {
    log.info('ensureAgentSession: restarting existing session', { session, was: current.status })
    await wahaRequest('POST', `/api/sessions/${session}/start`)
    return wahaRequest('GET', `/api/sessions/${session}`)
  }
  return current
}

// Stop → delete → recreate a session with the canonical full config.
// Does NOT fetch or return a QR/screenshot — Kev scans QR in the WAHA dashboard.
// Returns the WAHA create response so the caller can confirm the new session.
async function resetWahaSession(name) {
  try { await wahaRequest('POST', `/api/sessions/${name}/stop`) }
  catch (err) { log.warn('resetWahaSession: stop failed (may already be stopped)', { name, err: err.message }) }

  try {
    await wahaRequest('DELETE', `/api/sessions/${name}`)
    log.info('resetWahaSession: deleted', { name })
  } catch (err) {
    log.warn('resetWahaSession: DELETE failed (may not exist)', { name, err: err.message })
  }

  await new Promise(r => setTimeout(r, 1000))

  // Recreate with the canonical config (webhooks + NOWEB store + markOnline).
  // start:true tells WAHA to boot the session immediately so it advances to
  // SCAN_QR_CODE for the user to scan in the dashboard.
  const created = await wahaRequest('POST', '/api/sessions', {
    name,
    start: true,
    config: buildSessionConfig(name),
  })
  log.info('resetWahaSession: session recreated with canonical config', { name })

  return created
}

// ── WhatsApp Labels (WAHA Plus, Business sessions) ────────────────
// Endpoints discovered via probing:
//   GET    /api/{session}/labels                          → list
//   POST   /api/{session}/labels  body {name,color}       → create
//   DELETE /api/{session}/labels/{id}                     → delete
//   GET    /api/{session}/labels/chats/{chatId}           → labels on a chat
//   PUT    /api/{session}/labels/chats/{chatId}  body {labels:[id...]}
//   GET    /api/{session}/labels/{id}/chats               → chats with this label

async function listLabels(session) {
  try { return (await wahaRequest('GET', `/api/${session}/labels`)) || [] }
  catch (err) { log.warn('listLabels failed', { session, err: err.message }); return [] }
}

async function createLabel(session, { name, color }) {
  return wahaRequest('POST', `/api/${session}/labels`, { name, color })
}

async function deleteLabel(session, labelId) {
  return wahaRequest('DELETE', `/api/${session}/labels/${encodeURIComponent(labelId)}`)
}

async function getChatLabels(session, chatId) {
  try {
    const cid = chatId.includes('@') ? chatId : `${chatId}@c.us`
    const data = await wahaRequest('GET', `/api/${session}/labels/chats/${encodeURIComponent(cid)}`)
    return Array.isArray(data) ? data : []
  } catch (err) {
    log.warn('getChatLabels failed', { session, err: err.message })
    return []
  }
}

async function setChatLabels(session, chatId, labelIds) {
  const cid = chatId.includes('@') ? chatId : `${chatId}@c.us`
  return wahaRequest('PUT', `/api/${session}/labels/chats/${encodeURIComponent(cid)}`, { labels: labelIds })
}

async function getLabelChats(session, labelId) {
  try {
    const data = await wahaRequest('GET', `/api/${session}/labels/${encodeURIComponent(labelId)}/chats`)
    return Array.isArray(data) ? data : []
  } catch (err) {
    log.warn('getLabelChats failed', { session, labelId, err: err.message })
    return []
  }
}

// Fetch recent messages WITH media download enabled.
// Used by upload intake, !picup and fbPost to extract complete galleries.
async function getChatMessagesWithMedia(session, chatId, limit = 50) {
  const encoded = encodeURIComponent(chatId)
  // The old safety fallback requested min(limit, 10) and returned immediately,
  // so an 80-message !upload history silently became only the newest ten
  // messages. In a busy Available group those ten include commands and bot
  // replies, which is why only the last bathroom/hallway photos survived.
  //
  // Keep WAHA's proven-safe ten-message request size, but paginate through the
  // full caller limit. If one page hangs on an expired attachment, recursively
  // split only that page down to the single bad message. Its text is preserved
  // without media while every other image in the gallery still comes through.
  return collectMessagePages({
    limit,
    pageSize: 10,
    fetchMediaPage: async ({ offset, limit: pageLimit }) => {
      const data = await wahaRequest(
        'GET',
        `/api/${session}/chats/${encoded}/messages?limit=${pageLimit}&offset=${offset}&downloadMedia=true`,
        undefined,
        { timeoutMs: 20000 },
      )
      if (!Array.isArray(data)) throw new TypeError('WAHA media page is not an array')
      return data
    },
    fetchTextPage: async ({ offset, limit: pageLimit }) => {
      const data = await wahaRequest(
        'GET',
        `/api/${session}/chats/${encoded}/messages?limit=${pageLimit}&offset=${offset}&downloadMedia=false`,
        undefined,
        { timeoutMs: 15000 },
      )
      if (!Array.isArray(data)) throw new TypeError('WAHA text page is not an array')
      return data
    },
    onMediaError: ({ offset, limit: pageLimit, error }) => {
      log.warn('getChatMessagesWithMedia: media page failed, narrowing range', {
        session, chatId: String(chatId).slice(-12), offset, limit: pageLimit, err: error.message,
      })
    },
    onTextError: ({ offset, error }) => {
      log.warn('getChatMessagesWithMedia: single-message fallback failed', {
        session, chatId: String(chatId).slice(-12), offset, err: error.message,
      })
    },
  })
}

module.exports = { sendText, sendImage, sendVideo, sendFile, sendReaction, deleteMessage, sendSeen, markChatUnread, getSessionStatus, getActiveSession, getGroupReactionSession, pickActiveAdminSession, getRotatingSession, getWorkingSessions, getSessionPhone, getCachedSessionIdentity, getOrFetchSessionIdentity, wasSentByBackend, markSentByBackend, sessions, bridgeSessions, ensureAllSessionsWorking, ensureSessionConfig, buildSessionConfig, checkNumberStatus, getChatMessages, getChatMessagesStrict, getChats, getChatMessagesWithMedia, resetWahaSession, listLabels, createLabel, deleteLabel, getChatLabels, setChatLabels, getLabelChats, createGroup, leaveGroup, getGroupInfo, joinGroupByInvite, isGroupMember,
  // ARGUS Agent Layer, self-serve WhatsApp connect (2026-09-16):
  getQrImage, ensureAgentSession, stopSession,
  // CLIENTGROUPS bugfix (2026-09-03): _shortId()'s bare/DM/group-echo
  // normalisation is the SAME id-shape ambiguity a quoted-reply id can have
  // (WAHA reports a quoted/target message id in whichever of those shapes
  // the engine felt like that day) -- exported as normalizeMessageId so
  // clientAssistant.js's reply-correlation can compare like-for-like
  // instead of re-deriving its own (and risking the exact bug this file
  // just fixed happening a second time, in a second place).
  normalizeMessageId: _shortId,
  // Exported for test/waha-session-health.test.js. The restart decision is the
  // one piece of this file that can take every account offline at once, so it
  // is tested as a table rather than by driving a real session into five states.
  decideSessionAction,
  __backoff: { note: _noteRestartFailure, clear: _clearBackoff, blocks: _backoffBlocks,
               BASE_MS: RESTART_BASE_MS, MAX_MS: RESTART_MAX_MS } }
