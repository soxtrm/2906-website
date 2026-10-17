const db       = require('../db')
const log      = require('../logger')
const config   = require('../config')
const waha     = require('../waha')
const { sendAlert }       = require('../telegram')
const { QUEUES }          = require('../queues')
const replyMonitor        = require('./replyMonitor')
const { isSessionAtDailyLimit } = require('./outreach')
const { cmdSummarizeReminder, cmdSummarizeClients, cmdSummarizeProperties } = require('./summarize')
const warmScanner = require('./warmScanner')
const { postPropertyToFacebook } = require('./fbPost')
const { realSenderJid, phoneFromJid } = require('./senderIdentity')
const { syncClientsFromSheet } = require('./clientSheetSync')
const { getChatMessages } = require('../waha')
const { postPropertyToPropertyMarket, handlePmPostAdminReply, cancelPmPostPending } = require('./pmPost')
const { postPropertyToWebsite } = require('./webPost')
const { markLabel } = require('./chatwootService')
const { outreachStatusUpdate } = require('./googleSheets')
const scraperCmds = require('../scrapers/commands')
const { cmdImportList } = require('./importListCmd')
// Kev, 2026-08-30: !match used to come from matchFromSheet.js (a separate
// Sheet-based engine with its own scoring — see matchEngine.js's own
// handleMatchCommand header note on the swap). That file is left in place,
// unmodified, in case anything else ever needs it back — it's just no
// longer wired to the live !match command.
const { handleMatchReply, handleMatchCommand } = require('./matchEngine')
const { scanAllPropertyGroups, syncSheetApprovals, extractPropertyFromPost, markRowRented } = require('./geminiGroupScanner')
const { buildListForAccount, getListStats } = require('./listBuilder')
const { isAdminAccount } = require('./auth')
const reminderPoster = require('./reminderPoster')
const reminderScheduler = require('./reminderScheduler')
const { tryHandleLabelCommand } = require('../handlers/labelCommands')
const { tryHandleScheduleBoardCommand } = require('../handlers/scheduleBoardCommands')
const { tryHandleHotreachout }  = require('../handlers/hotreachout')
const { tryHandleCreateColdList } = require('../handlers/createcoldlist')
const { tryHandleCreateHotList, tryHandlePendingAnswer: tryHandleHotPendingAnswer } = require('../handlers/createhotlist')
const { incrementNoReplyForPhone } = require('./outreachTracker')
const outreachIdentity = require('./outreachIdentity')
const outreachApproval = require('./outreachApproval')

// ── Running-batch registry (replaces the old global cancel flag) ──────
// Kev, 2026-09-24: one process-wide boolean meant (a) every new batch's
// clearCancelFlag() silently un-cancelled any batch still running, (b) the
// 60s auto-clear could revive a cancelled loop, and (c) !cancel could not name
// or report the batch it stopped ("0 queue jobs" while #124/#125 were both
// sending). Each run now owns its own cancelled flag, keyed by batch id.
const _runningBatches = new Map()   // key → { key, batchId, kind, session, total, sent, cancelled, startedAt }
let _runSeq = 0
function registerRun({ batchId = null, kind, session, total }) {
  const key = batchId ? `b${batchId}` : `m${++_runSeq}`
  const run = { key, batchId, kind, session, total, sent: 0, cancelled: false, state: 'new', startedAt: new Date() }
  _runningBatches.set(key, run)
  return run
}
function unregisterRun(run) { if (run) _runningBatches.delete(run.key) }
// batchId omitted → every running batch; returns the runs that were stopped
function cancelRuns(batchId = null) {
  const hit = []
  for (const run of _runningBatches.values()) {
    if (batchId == null || String(run.batchId) === String(batchId)) { run.cancelled = true; hit.push(run) }
  }
  return hit
}
function listRunningBatches() { return [..._runningBatches.values()].map(r => ({ ...r })) }

// ── One active batch per WhatsApp session (2026-09-24) ─────────────────
// #124 (manual) and #125 (plan 73) both sent from Cedric at the same time —
// double send-rate on one number. A batch now queues behind whatever batch
// already holds its session (FIFO per session, casing-insensitive) and only
// starts sending when that one finished or was cancelled. A batch that is
// cancelled while waiting never sends.
const _sessionTails = new Map()   // lower(session) → promise of the last queued holder
async function acquireSessionSlot(run, notify) {
  const k = String(run.session || '').toLowerCase()
  const ahead = [..._runningBatches.values()].filter(r => r !== run && String(r.session || '').toLowerCase() === k && r.state !== 'done')
  const prev = _sessionTails.get(k) || Promise.resolve()
  let release
  const mine = new Promise(res => { release = res })
  const tail = prev.then(() => mine)
  _sessionTails.set(k, tail)
  if (ahead.length) {
    run.state = 'waiting'
    if (notify) await notify(ahead).catch(() => {})
  }
  await prev
  run.state = 'running'
  return () => {
    run.state = 'done'
    release()
    if (_sessionTails.get(k) === tail) _sessionTails.delete(k)
  }
}

// ── Phone normalisation ────────────────────────────────────────────
function normalizePhone(raw) {
  return String(raw || '').replace(/\+/g, '').replace(/@(?:c\.us|s\.whatsapp\.net|lid)$/i, '').replace(/\s/g, '')
}

function isAdmin(phone) {
  const n = normalizePhone(phone)
  return config.admin.adminNumbers.some(a => normalizePhone(a) === n)
}

function isBot(phone) {
  return normalizePhone(phone) === normalizePhone(config.admin.botNumber)
}

// Super-admins are stored in the `superadmins` DB table (see ./superadmins.js).
// Membership is cached in-memory and invalidated on add/remove.
const superadmins = require('./superadmins')
const isSuperAdmin = superadmins.isSuperAdmin

// ── Admin name personalisation ─────────────────────────────────────
const ADMIN_NAMES = {
  '35679010070': 'Babe',
  '35699270699': 'Kev',
  '35699655034': 'Kev',
}

function getAdminName(phone) {
  return ADMIN_NAMES[normalizePhone(phone)] || null
}

// Append name to a string if known: "What should I write, Kev?"
function withName(text, phone) {
  const name = getAdminName(phone)
  return name ? `${text}, ${name}?` : `${text}?`
}

// ── Messaging helpers ──────────────────────────────────────────────
async function reply(toPhone, text, session) {
  try {
    const sess = session || await waha.getActiveSession()
    await waha.sendText(sess, toPhone, text)
  } catch (err) {
    // If the original session failed, retry on any working session
    if (session) {
      try {
        const fallback = await waha.getActiveSession()
        if (fallback && fallback !== session) {
          await waha.sendText(fallback, toPhone, text)
          return
        }
      } catch {}
    }
    log.error('Admin reply send failed', err)
  }
}

// Post to the bot's own WhatsApp notes chat (bot messages itself)
async function notifyNotes(text, session) {
  const botPhone = normalizePhone(config.admin.botNumber)
  if (!botPhone) return
  try {
    const sess = session || await waha.getActiveSession()
    await waha.sendText(sess, botPhone, text)
  } catch (err) {
    log.debug('Notes chat notify failed (non-fatal)', err.message)
  }
}

// Mirror operational outreach receipts into the WhatsApp account that
// actually sends the batch. Central admin replies remain intact, while every
// outreach identity gets its own start/progress/final audit trail in Notes.
async function notifyOutreachRun(toPhone, replySession, sendingSession, text, { mirror = true } = {}) {
  await reply(toPhone, text, replySession)
  if (!mirror) return
  try {
    const sendingPhone = normalizePhone(await waha.getSessionPhone(sendingSession))
    const centralPhone = normalizePhone(toPhone)
    if (!sendingPhone) return
    if (sendingSession === replySession && sendingPhone === centralPhone) return
    await waha.sendText(sendingSession, sendingPhone, text)
  } catch (err) {
    log.warn('Sending-account Notes audit failed (non-fatal)', { session: sendingSession, err: err.message })
  }
}

// Send command results to: WA reply + notes chat + Telegram
async function notifyAll(toPhone, text, session) {
  await reply(toPhone, text, session)
  await notifyNotes(text, session)
  await sendAlert(text, 'info')
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── !status ───────────────────────────────────────────────────────

// ── !replytest <phone> <text> ────────────────────────────────────
// Simulates an inbound owner reply-quote so the operator can verify
// the captureReplyQuote pipeline end-to-end without waiting for a real
// inbound message. Useful for testing reach-me-at parser + do_not_contact
// detection from a single admin command.
async function cmdReplytest(phone, body, session) {
  const { captureReplyQuote } = require('./replyQuoteCapture')
  const r = await captureReplyQuote({
    phone,
    messageId: `admin-test-${Date.now()}`,
    body,
    timestampMs: Date.now(),
  })
  return r
}

async function cmdStatus(phone, session) {
  // Report all configured sessions, not just session1
  const allSessions = [config.waha.session1, config.waha.session2, config.waha.session3].filter(Boolean)
  const sessionStatuses = await Promise.all(
    allSessions.map(async name => {
      const info = await waha.getSessionStatus(name)
      const ok   = ['WORKING', 'CONNECTED'].includes(info?.status)
      return `${name}: ${ok ? '✅' : '❌'} ${info?.status || 'UNREACHABLE'}`
    })
  )
  const sessionOk = sessionStatuses.some(s => s.includes('✅'))

  let dbOk = false
  try { await db.query('SELECT 1'); dbOk = true } catch {}

  const queueLines = []
  for (const [name, queue] of Object.entries(QUEUES)) {
    try {
      const waiting = await queue.getWaitingCount()
      const active  = await queue.getActiveCount()
      const failed  = await queue.getFailedCount()
      if (waiting || active || failed) {
        queueLines.push(`  • ${name}: ${waiting} waiting, ${active} active, ${failed} failed`)
      }
    } catch {}
  }

  const r = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM owner_properties WHERE is_active = TRUE)           AS active_props,
      (SELECT COUNT(*) FROM clients WHERE status = 'new')                      AS new_clients,
      (SELECT COUNT(*) FROM outreach_log WHERE sent_at > NOW()-INTERVAL '24h') AS outreach_24h
  `)
  const s = r.rows[0]

  const msg = [
    '*2906 System Status*',
    '',
    ...sessionStatuses,
    `Database: ${dbOk ? '✅ OK' : '❌ ERROR'}`,
    `Outreach: ${config.system.outreachActive ? '✅ ON' : '🔴 OFF'}`,
    `System: ${config.system.active ? '✅ Active' : '🔴 Inactive'}`,
    '',
    `🏠 Active listings: ${s.active_props}`,
    `👤 Open clients: ${s.new_clients}`,
    `📤 Outreach (24h): ${s.outreach_24h}`,
    '',
    queueLines.length
      ? 'Queues:\n' + queueLines.join('\n')
      : 'Queues: all clear ✅',
  ].join('\n')

  await notifyAll(phone, msg, session)
}

// ── PLACEHOLDER (removed commands below) ───────────────────────────
// !stats, !match, !rented, !block, !unblock, !cycles, !clients removed.
// ── !cancel ───────────────────────────────────────────────────────
// (defined further below)

// ─────────────────────────────────────────────────────────────────
// MANUAL OUTREACH
// ─────────────────────────────────────────────────────────────────

function randomDelay()  { return Math.floor(Math.random() * (40000 - 25000 + 1)) + 25000 }
function warmDelay()    { return Math.floor(Math.random() * (22000 - 12000 + 1)) + 12000 } // 12–22s
function coldDelay()    { return Math.floor(Math.random() * (60000 - 40000 + 1)) + 40000 } // 40–60s

// Type-aware pacing for the multi-step !outreach flow.
// Returns {min, max} in ms. cold=40-60s, hot=60-90s, mixed=45-70s, unknown=50-70s.
function pacingFor(listType) {
  switch ((listType || '').toLowerCase()) {
    case 'cold':  return { min: 40000, max: 60000 }
    case 'hot':   return { min: 60000, max: 90000 }
    case 'mixed': return { min: 45000, max: 70000 }
    default:      return { min: 50000, max: 70000 }
  }
}
function typedDelay(listType) {
  const { min, max } = pacingFor(listType)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

const WARM_DAILY_LIMIT = 150
const COLD_DAILY_LIMIT = 30

// Count warm and cold messages sent today for a session.
// Uses warm_contacts table to classify each logged number.
async function getWarmColdCountsToday(session) {
  try {
    const r = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE wc.is_warm = TRUE)       AS warm_count,
        COUNT(*) FILTER (WHERE wc.is_warm IS NOT TRUE)  AS cold_count
      FROM outreach_log ol
      LEFT JOIN warm_contacts wc ON wc.phone = ol.phone
      WHERE ol.account_used = $1 AND ol.sent_at > NOW() - INTERVAL '24 hours'
    `, [session])
    return {
      warm: parseInt(r.rows[0]?.warm_count || 0),
      cold: parseInt(r.rows[0]?.cold_count || 0),
    }
  } catch {
    return { warm: 0, cold: 0 }
  }
}

// State per admin: step + data for the current flow
// steps: 'awaiting_message' | 'confirming_positives'
const manualOutreachState = new Map()

// Pending pool-cursor confirmations (!resetcursor, !setcursor) — 30s TTL
// keyed by normalized admin phone → { pool, action, cursorTo?, expiresAt }
const poolConfirmState = new Map()
const POOL_CONFIRM_TTL_MS = 30_000
function _normPhone(p) { return String(p || '').replace(/\+/g, '').replace(/\D/g, '') }
function _setPoolConfirm(adminPhone, entry) {
  poolConfirmState.set(_normPhone(adminPhone), { ...entry, expiresAt: Date.now() + POOL_CONFIRM_TTL_MS })
}
function _getPoolConfirm(adminPhone) {
  const e = poolConfirmState.get(_normPhone(adminPhone))
  if (!e) return null
  if (Date.now() > e.expiresAt) { poolConfirmState.delete(_normPhone(adminPhone)); return null }
  return e
}
function _clearPoolConfirm(adminPhone) { poolConfirmState.delete(_normPhone(adminPhone)) }

// ── Number parsing ─────────────────────────────────────────────────
// Accepts any format: +35679417315 Mariella, +356 7941 7315 Roger,
// 35679417315 John, 79417315 Mike (Malta 8-digit starting 7/9 → auto-add 356),
// bare "+35679417315" or "79417315" (no name).
// Returns { phone: '35679417315', name: '' | 'Mariella' } or null.
// Kev, 2026-08-30: extended to optionally carry owner info beyond phone+name
// — "phone name | location | property_ref | property_type", pipe-delimited
// so a multi-word name never gets misread as the next field. No pipe at all
// (the format every existing list uses) behaves EXACTLY as before: the whole
// remainder is the name, and location/propertyRef/propertyType come back
// null. This is purely additive parsing — see runDirectOutreach for where
// the extra fields get written (only into currently-empty owner_contacts
// columns, never overwriting what's on file).
function parseOwnerLine(line) {
  if (!line || typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed) return null

  const m = trimmed.match(/^\+?([\d\s\-()]{7,25})\s*(.*)$/)
  if (!m) return null

  let phone = m[1].replace(/\D/g, '')
  if (phone.length < 8 || phone.length > 15) return null

  // Maltese auto-prefix for 8-digit numbers starting 7 or 9
  if (phone.length === 8 && /^[79]/.test(phone)) {
    phone = '356' + phone
  }

  const rest = (m[2] || '').trim()
  let name = rest, location = null, propertyRef = null, propertyType = null
  if (rest.includes('|')) {
    const parts = rest.split('|').map(s => s.trim())
    name = parts[0] || ''
    location = parts[1] || null
    propertyRef = parts[2] || null
    propertyType = parts[3] || null
  }
  return { phone, name, location, propertyRef, propertyType }
}

// Back-compat alias — older callers expect parseContactLine and a null name
// when missing. parseOwnerLine returns '' for missing name; convert here.
function parseContactLine(line) {
  const p = parseOwnerLine(line)
  if (!p) return null
  return { phone: p.phone, name: p.name || null }
}

// ── Template application ───────────────────────────────────────────
// Supports {name}, {phone} and legacy [name] placeholders. When the name is
// empty the placeholder is dropped and any "Hello , " / "Hi !" artifacts are
// tightened so the recipient never sees an "Unknown" or an empty greeting comma.
function applyTemplate(template, { name, phone }) {
  if (!template) return ''
  const firstName = (name || '').toString().trim().split(/\s+/)[0] || ''
  let msg = template
  msg = msg.replace(/\{name\}/gi, firstName)
  msg = msg.replace(/\[name\]/gi, firstName)
  msg = msg.replace(/\{phone\}/gi, phone || '')
  if (!firstName) {
    // Greeting cleanup when {name} resolved to empty
    msg = msg.replace(/Hello\s+,/gi, 'Hello,')
    msg = msg.replace(/Hello\s+!/gi, 'Hello!')
    msg = msg.replace(/Hi\s+,/gi, 'Hi,')
    msg = msg.replace(/Hi\s+!/gi, 'Hi!')
    // Strip leftover stand-alone commas next to empty placeholders
    msg = msg.replace(/[, ]+,/g, ',')
  }
  msg = msg.replace(/  +/g, ' ')
  return msg.trim()
}

function parseContacts(text) {
  return text
    .split(/\n/)
    .flatMap(line => line.split(','))         // support comma-separated on same line
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseContactLine)
    .filter(Boolean)
}

// ── Pre-flight: cooldown check ─────────────────────────────────────
const COOLDOWN_DAYS = 25
const KEV_SESSIONS = config.waha.kevinAccounts || ['default', 'Kevsecond', 'kevthirdd']
const KEVIN_COOLDOWN_DAYS = config.timings.kevinCooldownDays || 10

// outreachSession: the WA account that will send. Only two gates apply, and
// they mirror buildPoolBatch exactly (same-account-only policy):
//   1. Global DNC  → never contact
//   2. SAME-account 20-day cooldown → this sending account contacted the owner
//      within 20 days. A DIFFERENT account's prior contact does NOT block.
// No cross-account "customer / active deal / fresh hot / recently angry / any
// Kev account" dedup — that was removed on purpose.
const SAME_ACCOUNT_COOLDOWN_DAYS = 20
async function classifyContacts(contacts, outreachSession) {
  const ready       = []  // never contacted by this account, cooldown expired, or admin number
  const softskipped = []  // DNC, or same-account 20-day cooldown

  for (const contact of contacts) {
    // Admin numbers always bypass cooldown
    if (isAdmin(contact.phone)) {
      ready.push(contact)
      continue
    }

    // ── Global DNC check ──────────────────────────────────────────────────
    // Do-not-contact is global and always blocks. No other cross-account
    // status (customer / active deal / fresh hot / angry) is considered.
    try {
      const suffix = contact.phone.slice(-8)
      const dncR = await db.query(
        `SELECT v.is_dnc
         FROM v_owner_claim_status v
         WHERE v.phone_normalized = $1 OR v.phone_normalized LIKE $2
         LIMIT 1`,
        [contact.phone, `%${suffix}`]
      )
      if (dncR.rows[0]?.is_dnc) {
        softskipped.push({ ...contact, reason: 'DNC' })
        continue
      }
    } catch (err) {
      log.warn('DNC check query failed (non-fatal)', { err: err.message })
    }

    // ── SAME-account 20-day cooldown ──────────────────────────────────────
    // Blocks only when THIS sending account contacted the owner within 20 days.
    // Contact by any other account is ignored (cross-account dedup removed).
    const r = await db.query(
      `SELECT sent_at FROM outreach_log
       WHERE phone = $1 AND account_used = $2
       ORDER BY sent_at DESC LIMIT 1`,
      [contact.phone, outreachSession]
    )
    if (r.rows.length > 0) {
      const daysSince = (Date.now() - new Date(r.rows[0].sent_at).getTime()) / 86_400_000
      if (daysSince < SAME_ACCOUNT_COOLDOWN_DAYS) {
        softskipped.push({ ...contact, reason: `same-account ${SAME_ACCOUNT_COOLDOWN_DAYS}-day cooldown` })
        continue
      }
    }

    ready.push(contact)
  }

  return { ready, softskipped }
}

// ── Real-WA pre-flight — catches manual sends not in outreach_log ──
// Returns { toSend, skipped, summary }: filtered contacts safe to send to,
// list of WAHA-blocked contacts (with reason), and a printable summary.
// Admin numbers always pass through (no cooldown applies to admins).
async function runWAHAPreflight(contacts, sendingSession) {
  const { checkOwnerEligibilityViaWAHA } = require('./cooldownRules')
  const toSend  = []
  const skipped = []
  const unknown = []
  for (const c of contacts) {
    const phone = c.phone || c.phone_normalized || ''
    if (isAdmin(phone)) { toSend.push(c); continue }
    let wa
    try {
      wa = await checkOwnerEligibilityViaWAHA(phone, sendingSession)
    } catch (err) {
      log.warn('WAHA preflight threw, holding contact for recheck', {
        phone: phone.slice(-4), err: err.message
      })
      wa = { eligible: null, unknown: true, reason: 'waha_history_unknown' }
    }
    if (wa.eligible) {
      toSend.push(c)
    } else if (wa.unknown || wa.eligible == null) {
      unknown.push({ phone, name: c.name, reason: wa.reason || 'waha_history_unknown' })
    } else {
      skipped.push({
        phone, name: c.name,
        reason: wa.reason,
        blocker: wa.blocker_session,
        days: wa.days_ago,
      })
    }
  }
  return { toSend, skipped, unknown }
}

function formatWAHAPreflightSummary(toSend, skipped) {
  const lines = [
    '📋 *Pre-flight check complete*',
    `✅ Eligible: ${toSend.length}`,
    `⏭️ Skipped: ${skipped.length}`,
  ]
  for (const s of skipped.slice(0, 10)) {
    const dn = s.name ? s.name.trim().split(/\s+/)[0] : ''
    const days = (typeof s.days === 'number') ? `${s.days}d ago` : s.reason
    lines.push(`   ${s.phone}${dn ? ' ' + dn : ''} — ${s.blocker || 'self'} ${days}`)
  }
  if (skipped.length > 10) lines.push(`   …and ${skipped.length - 10} more`)
  return lines.join('\n')
}

// ── Batch sender ───────────────────────────────────────────────────
// outreachSession:  the WA account that sends messages to recipients
// session:          the reply channel back to the admin
// softskippedBefore: contacts already classified as softskipped before the batch starts
async function sendManualBatch(adminPhone, session, contacts, messageTemplate, outreachSession, softskippedBefore = []) {
  const sess = outreachSession || session || await waha.getActiveSession()
  // Sender identity is the sending session's persona, full stop (2026-09-24).
  const identity = await outreachIdentity.resolveSenderIdentity(sess)
  const foreign = outreachIdentity.findForeignSignatures(messageTemplate, identity && identity.persona)
  if (!identity || foreign.length) {
    const why = identity ? outreachIdentity.describeMismatch(identity, foreign) : `unknown sending account "${sess}"`
    log.warn('Manual outreach refused: sender identity mismatch', { session: sess, why })
    await reply(adminPhone, `❌ Outreach NOT started — ${why}.\nFix the signature or pick the matching account.`, session)
    return
  }
  let sent = 0
  let failed = 0
  const failedNumbers = []
  const softskipped = Array.isArray(softskippedBefore) ? [...softskippedBefore] : []

  // WhatsApp-history pre-flight: catches owners contacted manually (no log row)
  await reply(adminPhone, `⏳ Checking WhatsApp history for ${contacts.length} contact(s)…`, session)
  const { toSend: contactsToSend, skipped: waSkipped } = await runWAHAPreflight(contacts, sess)
  for (const s of waSkipped) {
    softskipped.push({
      phone: s.phone, name: s.name,
      reason: s.blocker
        ? `WA cooldown — ${s.blocker} ${s.days}d ago`
        : (s.reason || 'wa_cooldown'),
    })
  }
  await reply(adminPhone, `${formatWAHAPreflightSummary(contactsToSend, waSkipped)}\n\nProceeding with ${contactsToSend.length} sends…`, session)

  if (contactsToSend.length === 0) {
    if (softskipped.length > 0) {
      const skipLines = ['⏭️ *Skipped (manual review):*']
      for (const s of softskipped) {
        const displayName = s.name ? s.name.trim().split(/\s+/)[0] : s.phone
        skipLines.push(`- ${displayName} ${s.phone} - ${s.reason}`)
      }
      await reply(adminPhone, skipLines.join('\n'), session)
    }
    return
  }
  contacts = contactsToSend

  log.info('Manual outreach batch starting', { total: contacts.length, admin: adminPhone.slice(-4) })
  const run = registerRun({ kind: 'manual', session: sess, total: contacts.length })
  const releaseSlot = await acquireSessionSlot(run, ahead => reply(adminPhone,
    `⏳ Queued — *${sess}* is still sending ${ahead.map(r => r.batchId ? '#' + r.batchId : 'a manual batch').join(', ')}. Starts by itself when that one is done.`, session))
  try {
  for (let i = 0; i < contacts.length; i++) {
    if (run.cancelled) {
      log.info('Manual outreach batch cancelled', { sentSoFar: sent })
      break
    }

    const { phone, name, is_warm: contactIsWarm } = contacts[i]

    // Per-type daily limits: warm 150/day, cold 30/day
    const counts = await getWarmColdCountsToday(sess)
    if (contactIsWarm && counts.warm >= WARM_DAILY_LIMIT) {
      log.info('Warm daily limit reached', { session: sess, warm: counts.warm })
      softskipped.push({ phone, name, reason: `warm daily limit (${WARM_DAILY_LIMIT}/day)` })
      continue
    }
    if (!contactIsWarm && counts.cold >= COLD_DAILY_LIMIT) {
      log.info('Cold daily limit reached', { session: sess, cold: counts.cold })
      softskipped.push({ phone, name, reason: `cold daily limit (${COLD_DAILY_LIMIT}/day)` })
      continue
    }

    // WA check — no WhatsApp → softskip + post to Calls Only group
    const hasWA = await waha.checkNumberStatus(sess, phone)
    if (!hasWA) {
      log.info('No WhatsApp, skipping in manual batch', { phone: phone.slice(-4) })
      softskipped.push({ phone, name, reason: 'no WhatsApp' })
      const displayName = name ? name.trim().split(/\s+/)[0] : null
      await replyMonitor.sendToOnlyCallsGroup(phone, displayName, null, false, sess)
      continue
    }

    // Smart delay: warm=12–22s, cold=40–60s; first message always 1s
    const delay = i === 0 ? 1000 : (contactIsWarm ? warmDelay() : coldDelay())
    await sleep(delay)
    if (run.cancelled) { log.info('Manual outreach batch cancelled during delay', { sentSoFar: sent }); break }

    // Personalise template — handles both {name}/[name] + cleanup when blank
    let text = applyTemplate(messageTemplate, { name, phone })

    try {
      await waha.sendText(sess, phone, text)

      const ownerId = await getOrCreateOwnerForContact(phone, name)
      const cycleR = await db.query(
        `INSERT INTO owner_outreach_cycles (owner_id, status, sent_at)
         VALUES ($1, 'pending', NOW()) RETURNING id`,
        [ownerId]
      )
      const cycleId = cycleR.rows[0]?.id

      await db.query(
        `INSERT INTO outreach_log
           (owner_id, phone, account_used, message_text, message_type,
            conversation_locked_to, conversation_state, delay_used_ms)
         VALUES ($1, $2, $3, $4, 'manual', $3, 'cold', $5)`,
        [ownerId, phone, sess, text, delay]
      )

      if (cycleId) {
        await replyMonitor.startMonitoring(phone, cycleId)
      }

      // Ghost-counter increment (fire-and-forget; never blocks the send loop)
      incrementNoReplyForPhone(phone, sess).catch(() => {})

      sent++
      log.info('Manual outreach sent', {
        phone: phone.slice(-4),
        type: contactIsWarm ? 'warm' : 'cold',
        delay,
        progress: `${i + 1}/${contacts.length}`,
      })
    } catch (err) {
      failed++
      failedNumbers.push(phone)
      log.error('Manual outreach failed', { phone: phone.slice(-4), err: err.message })
    }
  }
  } finally { releaseSlot(); unregisterRun(run) }

  const lines = ['*Manual outreach complete* ✅', '', `📤 Sent: ${sent}`]
  if (failed > 0) {
    lines.push(`❌ Failed: ${failed}`)
    failedNumbers.forEach(n => lines.push(`  • ${n}`))
  }
  await notifyAll(adminPhone, lines.join('\n'), session)
  log.info('Manual outreach batch done', { sent, failed, admin: adminPhone.slice(-4) })

  // Softskip summary — sent AFTER batch, never before or during
  if (softskipped.length > 0) {
    const skipLines = ['⏭️ *Skipped (manual review):*']
    for (const s of softskipped) {
      const displayName = s.name ? s.name.trim().split(/\s+/)[0] : s.phone
      skipLines.push(`- ${displayName} ${s.phone} - ${s.reason}`)
    }
    await reply(adminPhone, skipLines.join('\n'), session)
  }
}

// ── Direct outreach — sends EXACTLY the pasted list, no DB pool ────
// contacts: [{ phone, name }] from parseOutreachListAndMessage()
// messageTemplate: text with [name] placeholder (replaced with first name)
async function runDirectOutreach(adminPhone, replySession, sendingSession, contacts, messageTemplate, opts = {}) {
  const { canContact } = require('./cooldownRules')
  const pacingType = opts.pacingType || null
  const startedAt = Date.now()
  let sent = 0
  let skipped = 0
  let failed = 0
  let ambiguous = 0
  let held = 0
  let noWhatsApp = 0
  let consecutiveNoWhatsApp = 0
  const NO_WHATSAPP_STOP_AFTER = 5
  const lifecycle = opts.lifecycle || {}
  const progressReply = opts.suppressMirroredProgress ? async () => {} : reply
  const notifyRun = (text) => notifyOutreachRun(adminPhone, replySession, sendingSession, text, { mirror: !opts.suppressMirroredProgress })
  const skippedDetails = []

  // ── Frozen sender identity (Kev, 2026-09-24) ─────────────────────────
  // Batch #125 (plan 73) sent 12 messages from Cedric signed "Kevin Eich
  // Agent" because nothing compared the template's sign-off with the account
  // sending it. Session, persona and template are fixed HERE, once, and every
  // send below uses exactly these values. Owner/contact data never feeds into
  // who the message is from.
  const resolvedIdentity = await outreachIdentity.resolveSenderIdentity(sendingSession)
  const identity = opts.frozenIdentity || resolvedIdentity
  if (identity && resolvedIdentity && (Number(identity.accountId) !== Number(resolvedIdentity.accountId) || String(identity.persona || '') !== String(resolvedIdentity.persona || ''))) {
    return { refused: 'sender_identity_changed', why: 'sender identity changed after enqueue' }
  }
  if (!identity) {
    await progressReply(adminPhone, `❌ Account "${sendingSession}" not found`, replySession)
    return
  }
  const accountId = identity.accountId
  let volumePercent = 100
  try {
    const volume = (await db.query(
      `SELECT outreach_volume_percent, outreach_volume_until
         FROM whatsapp_accounts WHERE id = $1`,
      [accountId]
    )).rows[0]
    const active = !volume?.outreach_volume_until || new Date(volume.outreach_volume_until) > new Date()
    volumePercent = active ? Math.max(10, Math.min(100, Number(volume?.outreach_volume_percent || 100))) : 100
  } catch (err) {
    log.warn('Direct outreach: volume setting unavailable, using 100%', { session: sendingSession, err: err.message })
  }
  const paceMultiplier = 100 / volumePercent
  const FROZEN = Object.freeze({ session: sendingSession, persona: identity.persona, template: messageTemplate })
  const templateForeign = outreachIdentity.findForeignSignatures(FROZEN.template, FROZEN.persona)
  if (templateForeign.length) {
    const why = outreachIdentity.describeMismatch(identity, templateForeign)
    log.warn('Direct outreach refused: sender identity mismatch', { session: FROZEN.session, planId: opts.planId || null, why })
    await progressReply(adminPhone, `❌ Outreach NOT started${opts.planId ? ` (plan #${opts.planId})` : ''} — ${why}.\nNothing was sent. Fix the signature or pick the matching account.`, replySession)
    return { refused: 'identity_mismatch', why }
  }

  // ── Foutreach (!outreach force): contacts tagged .force=true skip both the
  // WhatsApp-history preflight and the DB cooldown below — Kev's explicit
  // call to re-contact regardless. A previously declined/done owner is still
  // never re-pitched; a previously-contacted-but-unresolved owner gets a
  // short nudge instead of the full template (set below as .overrideMessage).
  const forceContacts = contacts.filter(c => c.force)
  const normalContacts = contacts.filter(c => !c.force)
  let forceToSend = []
  if (forceContacts.length) {
    const autoConvo = require('./autoOwnerConversation')
    const { toSend, toSkip } = await autoConvo.classifyForceOverrides(forceContacts)
    forceToSend = toSend
    for (const s of toSkip) {
      skipped++
      await lifecycle.skipped?.(s.phone, `force skip — ${s.reason}`)
      skippedDetails.push({ phone: s.phone, name: s.name, reason: `force skip — ${s.reason}` })
    }
    await progressReply(adminPhone, `⚡ Force mode: ${toSend.length} to send (${toSend.filter(x => x.overrideMessage).length} as a nudge), ${toSkip.length} skipped.`, replySession)
  }

  // WhatsApp-history pre-flight (manual sends not in outreach_log) — normal contacts only.
  await progressReply(adminPhone, `⏳ Checking WhatsApp history for ${normalContacts.length} contact(s)…`, replySession)
  const { toSend: contactsToSend, skipped: waSkipped, unknown: waUnknown } = normalContacts.length
    ? await runWAHAPreflight(normalContacts, sendingSession)
    : { toSend: [], skipped: [], unknown: [] }
  for (const s of waUnknown) {
    held++
    await lifecycle.held?.(s.phone, s.reason)
    skippedDetails.push({ phone: s.phone, name: s.name, reason: 'history unavailable — held for recheck' })
  }
  for (const s of waSkipped) {
    skipped++
    await lifecycle.skipped?.(s.phone, s.reason)
    skippedDetails.push({
      phone: s.phone, name: s.name,
      reason: s.blocker
        ? `WA cooldown — ${s.blocker} ${s.days}d ago`
        : (s.reason || 'wa_cooldown'),
    })
  }
  if (normalContacts.length) await progressReply(adminPhone, formatWAHAPreflightSummary(contactsToSend, waSkipped), replySession)

  contacts = [...contactsToSend, ...forceToSend]
  if (contacts.length === 0) {
    await notifyRun('⚠️ No eligible contacts after WhatsApp-history check. Nothing to send.')
    return { sent, skipped, failed, ambiguous, held, refused: held ? 'history_unknown' : null }
  }

  const est = 1 + (contacts.length - 1) * 50 * paceMultiplier  // rough avg jitter, adjusted by account volume

  // ── Durability checkpoint (Kev, 2026-08-30) ────────────────────────────
  // 2026-08-29: !foutreach sent 1/17, then the shared backend container got
  // restarted by an unrelated concurrent deploy and this loop — which held
  // its entire progress in the Node process's memory — vanished without a
  // trace. Reuses outreach_batches/outreach_batch_items (already in the
  // schema, unused until now — a concurrent agent appears to have been
  // building this exact fix when the collision happened). A batch_item row
  // per contact means a restart mid-loop leaves an accurate, queryable
  // "what's still pending" — see the boot-time recovery check in index.js
  // and !resumeoutreach below, which both read this same table.
  // planId (Phase 4, 2026-09-17): only set when outreachPlanner.js's
  // runScheduledPlan() is the caller — NULL for every manual !outreach/
  // !foutreach call, unchanged behaviour there. Lets ANY path this batch
  // can complete through (below, or outreachRecovery.js resuming it after
  // a restart) reconcile the owning plan's own status/entries instead of
  // leaving it stuck in 'running' forever — the exact plan-40 incident.
  const planId = opts.planId || null
  let batchId = null
  const itemIdByPhone = new Map()
  try {
    const batchRes = await db.query(
      `INSERT INTO outreach_batches
         (initiated_by, session_name, reply_session, message_template, pacing_type,
          force_mode, status, total_contacts, plan_id, sender_identity, volume_percent_snapshot, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10,$11) RETURNING id`,
      [adminPhone, FROZEN.session, replySession, FROZEN.template, pacingType,
       contacts.some(c => c.force), contacts.length, planId,
       JSON.stringify({ account_id: accountId, session: FROZEN.session, persona: FROZEN.persona, names: identity.names }),
       volumePercent, opts.runId || null])
    batchId = batchRes.rows[0].id
    for (const c of contacts) {
      const itemRes = await db.query(
        `INSERT INTO outreach_batch_items (batch_id, phone, name, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
        [batchId, c.phone, c.name || null])
      itemIdByPhone.set(c.phone, itemRes.rows[0].id)
    }
  } catch (err) {
    // Never let checkpointing itself block a real send — worst case on
    // failure here is back to 2026-08-29's behaviour (in-memory only), not
    // a broken outreach run.
    log.error('outreach batch checkpoint create failed — continuing without durability', { err: err.message })
  }
  async function checkpoint(phone, status, extra = {}) {
    if (!batchId) return
    try {
      const itemId = itemIdByPhone.get(phone)
      if (itemId) {
        await db.query(
          `UPDATE outreach_batch_items SET status=$1, sent_at=$2, skip_reason=$3, message_text=$4 WHERE id=$5`,
          [status, status === 'sent' ? new Date() : null, extra.skipReason || null, extra.messageText || null, itemId])
      }
      await db.query(
        `UPDATE outreach_batches SET sent_count=$1, skip_count=$2, updated_at=NOW() WHERE id=$3`,
        [sent, skipped, batchId])
    } catch (err) {
      log.warn('outreach batch checkpoint update failed', { err: err.message })
    }
  }

  const run = registerRun({ batchId, kind: planId ? 'plan' : 'direct', session: FROZEN.session, total: contacts.length })
  const releaseSlot = opts.sessionLockHeld ? (() => {}) : await acquireSessionSlot(run, ahead => notifyOutreachRun(
    adminPhone,
    replySession,
    sendingSession,
    `⏳ Batch${batchId ? ` *#${batchId}*` : ''} queued — *${FROZEN.session}* is still sending ${ahead.map(r => r.batchId ? '#' + r.batchId : 'a manual batch').join(', ')}. ` +
      `It starts by itself when that one is done (one batch per account).${batchId ? `\nCancel it: *!cancel ${batchId}*` : ''}`))
  if (!run.cancelled && !opts.suppressMirroredProgress) await notifyOutreachRun(
    adminPhone,
    replySession,
    sendingSession,
    `Sending via *${FROZEN.session}* to *${contacts.length}* contact(s)${batchId ? ` — batch *#${batchId}*${planId ? ` (plan #${planId})` : ''}` : ''}. Est. ~${Math.round(est / 60)}m.` +
      (volumePercent < 100 ? ` Volume *${volumePercent}%* (${paceMultiplier.toFixed(1)}× slower).` : '') +
      (batchId ? `\nStop only this batch: *!cancel ${batchId}*` : '')
  )
  const markCancelled = async () => {
    if (!batchId) return
    await db.query(`UPDATE outreach_batches SET status='cancelled', cancelled_at=COALESCE(cancelled_at, NOW()) WHERE id=$1`, [batchId])
      .catch(err => log.warn('outreach batch cancel-mark failed', { err: err.message }))
    await db.query(`UPDATE outreach_batch_items SET status='cancelled', skip_reason='cancelled_by_admin' WHERE batch_id=$1 AND status='pending'`, [batchId])
      .catch(err => log.warn('outreach batch item cancel-mark failed', { err: err.message }))
  }

  try {
  for (let i = 0; i < contacts.length; i++) {
    if (run.cancelled) {
      log.info('Direct outreach cancelled', { batchId, sentSoFar: sent })
      await markCancelled()
      break
    }
    const { phone, name, overrideMessage, location, propertyRef, propertyType } = contacts[i]
    const adminBypass = isAdmin(phone) || contacts[i].force === true

    // Look up owner_contacts (optional — !outreach works even when the phone
    // isn't in the DB. The DB is NOT a pre-requisite for sending. The only
    // thing we check is the WhatsApp-history cooldown (runWAHAPreflight at the
    // top of this function) — has the bot written to this phone in the last
    // 22 days from the SENDING account? If yes, skip. No DB roundtrip needed
    // for that check.)
    let ownerContactId = null, status = null
    try {
      const ocRes = await db.query(
        'SELECT id, status FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1',
        [phone]
      )
      ownerContactId = ocRes.rows[0]?.id || null
      status = ocRes.rows[0]?.status || null
    } catch (err) {
      // A transient DB hiccup here used to kill the whole loop uncaught —
      // the exact "!foutreach stopped, nobody was told" failure mode this
      // guard closes. Treat "lookup failed" the same as "not in the DB":
      // sending itself never depended on this row (see comment below).
      log.warn('owner_contacts lookup failed mid-outreach, continuing without it', { err: err.message })
    }
    // Phone can be sent to EVEN IF not in owner_contacts — that's the
    // explicit user requirement (2026-08-06): "add other numbers", "store
    // either with name or without name, then just numeric ID". The DB is just
    // for stats; it is NOT a gating factor.

    // Kev, 2026-08-30: the list paste can carry more than phone+name (see
    // parseOwnerLine's pipe-delimited extension) — fill it into whichever
    // owner_contacts row already exists, but ONLY the columns that are
    // still empty. Never overwrites what's already on file, never creates
    // a new row (this list is not the source of truth for who's a known
    // owner — contactClassifier.js is), and never blocks a real send.
    if (ownerContactId && (location || propertyRef || propertyType)) {
      db.query(
        `UPDATE owner_contacts
            SET location = COALESCE(location, $1),
                last_property_mention = COALESCE(last_property_mention, $2),
                property_type = COALESCE(property_type, $3)
          WHERE id = $4`,
        [location || null, propertyRef || null, propertyType || null, ownerContactId]
      ).catch(err => log.warn('owner_contacts info fill-in failed', { err: err.message }))
    }

    // Same-account cooldown via outreach_log — only when the contact row
    // exists. Without a contact row, the WAHA pre-flight above is the
    // sole timing gate.
    if (ownerContactId && !adminBypass) {
      try {
        const chk = await canContact(ownerContactId, accountId)
        if (!chk.allowed) {
          skipped++
          skippedDetails.push({ phone, name, reason: chk.reason || 'cooldown' })
          await checkpoint(phone, 'skipped', { skipReason: chk.reason || 'cooldown' })
          await lifecycle.skipped?.(phone, chk.reason || 'cooldown')
          continue
        }
      } catch (err) {
        log.warn('canContact failed, allowing send', { err: err.message })
      }
    }

    // Pacing: caller-supplied pacingType wins (cold/hot/mixed/unknown);
    // otherwise fall back to per-contact status (warm vs cold).
    let delay
    if (i === 0) {
      delay = 1000
    } else if (pacingType) {
      delay = typedDelay(pacingType)
    } else {
      const isWarm = status === 'hot' || status === 'softwarm'
      delay = isWarm ? randomDelay() : coldDelay()
    }
    if (i > 0 && paceMultiplier !== 1) delay = Math.round(delay * paceMultiplier)
    await sleep(delay)
    // Re-check AFTER the delay: 2026-09-24 #125 sent once more 30s after
    // !cancel because the only check sat before a 45s sleep.
    if (run.cancelled) {
      log.info('Direct outreach cancelled during delay', { batchId, sentSoFar: sent })
      await markCancelled()
      break
    }

    // Personalise template — handles both {name}/[name] + cleanup when blank.
    // overrideMessage wins for force-nudge contacts (ghosted prior contact).
    const text = overrideMessage || applyTemplate(FROZEN.template, { name, phone })

    // Last gate before the wire: the rendered text must not sign as anyone
    // but the frozen persona (the recipient's own name is not a signature).
    const foreign = outreachIdentity.findForeignSignatures(text, FROZEN.persona, { recipientName: name })
    if (foreign.length) {
      const why = outreachIdentity.describeMismatch(identity, foreign)
      skipped++
      skippedDetails.push({ phone, name, reason: `identity mismatch — ${why}` })
      await checkpoint(phone, 'skipped', { skipReason: `identity_mismatch: ${why}` })
      await lifecycle.skipped?.(phone, `identity_mismatch: ${why}`)
      log.warn('Direct outreach: message skipped, identity mismatch', { batchId, phone: phone.slice(-4), why })
      continue
    }

    let transportAccepted = false
    try {
      await lifecycle.beforeSend?.(phone, text)
      await waha.sendText(FROZEN.session, phone, text)
      transportAccepted = true
      await lifecycle.sent?.(phone)

      // outreach_log uses owners.id (uuid) — upsert the owner row
      const ownerRowId = await getOrCreateOwnerForContact(phone, name)
      await db.query(
        `INSERT INTO outreach_log
           (owner_id, phone, account_used, message_text, message_type,
            conversation_locked_to, conversation_state, delay_used_ms)
         VALUES ($1, $2, $3, $4, 'manual', $3, 'cold', $5)`,
        [ownerRowId, phone, FROZEN.session, text, delay]
      )

      // Update owner_contacts last_contact_at (and last_known_account_id)
      if (ownerContactId) {
        await db.query(
          'UPDATE owner_contacts SET last_contact_at = NOW(), last_known_account_id = $1 WHERE id = $2',
          [accountId, ownerContactId]
        )
      }

      // Ghost-counter increment for the requesting account
      incrementNoReplyForPhone(phone, FROZEN.session).catch(() => {})

      sent++
      run.sent = sent
      await checkpoint(phone, 'sent', { messageText: text })
      log.info('Direct outreach sent', {
        phone: phone.slice(-4),
        session: sendingSession,
        progress: `${i + 1}/${contacts.length}`,
      })

      if (!opts.suppressMirroredProgress && sent > 0 && sent % 10 === 0 && i < contacts.length - 1) {
        await notifyRun(`Sent ${sent}/${contacts.length}, skipped ${skipped}…`)
      }
    } catch (err) {
      if (transportAccepted) {
        log.error('Direct outreach post-send bookkeeping failed; transport remains sent', { phone: phone.slice(-4), err: err.message })
        continue
      }
      const unknown = lifecycle.transportOutcomeUnknown?.(err) === true
      // GOWS answers "no LID found for <n>@s.whatsapp.net from server" when
      // the number has no WhatsApp. That is not a transport fault: count it as
      // skipped, remember it, and stop a batch whose first numbers all fail
      // this way (batch 276 spent 50 minutes on 40 such numbers).
      if (!unknown && /no LID found/i.test(String(err?.message || ''))) {
        skipped++
        noWhatsApp++
        consecutiveNoWhatsApp++
        skippedDetails.push({ phone, name, reason: 'not on WhatsApp' })
        await checkpoint(phone, 'skipped', { skipReason: 'not_on_whatsapp', messageText: text })
        await lifecycle.skipped?.(phone, 'not_on_whatsapp')
        require('./outreachUnreachable').markUnreachable({ phone, reason: 'no_lid', notes: `batch ${batchId || '?'} via ${FROZEN.session}` })
          .catch(markErr => log.warn('outreach: markUnreachable failed', { err: markErr.message }))
        log.warn('Direct outreach skipped: not on WhatsApp', { batchId, phone: phone.slice(-4), session: FROZEN.session })
        if (sent === 0 && consecutiveNoWhatsApp >= NO_WHATSAPP_STOP_AFTER && i < contacts.length - 1) {
          log.error('Direct outreach stopped: first numbers are not on WhatsApp', { batchId, session: FROZEN.session, checked: i + 1 })
          await notifyRun(`⚠️ Batch${batchId ? ` *#${batchId}*` : ''} stopped — the first ${consecutiveNoWhatsApp} numbers are not on WhatsApp and nothing could be delivered. ` +
            `The rest of this list (${contacts.length - i - 1}) was not attempted. Check the list source.`)
          await markCancelled()
          break
        }
        continue
      }
      consecutiveNoWhatsApp = 0
      if (unknown) {
        ambiguous++
        skippedDetails.push({ phone, name, reason: `ambiguous transport result: ${err.message}` })
        await checkpoint(phone, 'ambiguous', { skipReason: `ambiguous: ${err.message}`, messageText: text })
        await lifecycle.ambiguous?.(phone, err)
      } else {
        failed++
        skippedDetails.push({ phone, name, reason: `send error: ${err.message}` })
        await checkpoint(phone, 'failed', { skipReason: `send error: ${err.message}`, messageText: text })
        await lifecycle.failed?.(phone, err)
      }
      log.error('Direct outreach send failed', { phone: phone.slice(-4), ambiguous: unknown, err: err.message })
    }
  }
  } finally { releaseSlot(); unregisterRun(run) }

  if (batchId) {
    const batchStatus = (ambiguous > 0 || held > 0) ? 'ambiguous' : 'completed'
    db.query(`UPDATE outreach_batches SET status=$2, completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END WHERE id=$1 AND status='running'`, [batchId, batchStatus])
      .catch(err => log.warn('outreach batch complete-mark failed', { err: err.message }))
  }
  if (planId && !opts.runId) {
    require('./outreachPlanner').reconcilePlanFromBatch(planId)
      .catch(err => log.error('outreach batch complete: plan reconcile failed', { planId, err: err.message }))
  }

  const durationMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000))
  const lines = [
    sent > 0 ? '✅ *Outreach complete:*' : '⚠️ *Outreach finished — nothing was delivered:*',
    `- Sent: ${sent}`,
    `- Skipped: ${skipped}${noWhatsApp ? ` (${noWhatsApp} not on WhatsApp)` : ''}`,
    failed ? `- Failed: ${failed} (send errors)` : null,
    ambiguous ? `- Unclear: ${ambiguous} (transport result unknown)` : null,
    `- Duration: ${durationMin}m`,
  ]
  const reportLines = lines.filter(line => line !== null)
  lines.length = 0
  lines.push(...reportLines)
  if (skippedDetails.length > 0) {
    lines.push('')
    lines.push('*Skipped detail:*')
    for (const s of skippedDetails.slice(0, 30)) {
      const dn = s.name ? s.name.trim().split(/\s+/)[0] : s.phone
      lines.push(`- ${dn} ${s.phone} - ${s.reason}`)
    }
    if (skippedDetails.length > 30) lines.push(`…and ${skippedDetails.length - 30} more`)
  }
  await notifyRun(lines.join('\n'))
  return { sent, skipped, failed, ambiguous, held, batchId }
}

// Both Notes/!outreach and the website planner persist the same immutable
// execution envelope before a worker may touch WAHA. runDirectOutreach stays
// the transport implementation; this is the only public entry into it.
async function enqueueDirectOutreach(adminPhone, replySession, sendingSession, contacts, messageTemplate, opts = {}) {
  const { randomUUID } = require('crypto')
  const { enqueueOutreachRun, DEFAULT_PACING_MODE } = require('./outreachRunEngine')
  return enqueueOutreachRun({
    triggerId: opts.triggerId || randomUUID(),
    source: opts.source || 'notes_outreach',
    session: sendingSession,
    replySession,
    initiatedBy: adminPhone,
    template: messageTemplate,
    contacts,
    // Parity rollout: Notes and Website deliberately use one configured
    // pacing profile. Per-trigger implicit defaults cannot drift again.
    pacingMode: DEFAULT_PACING_MODE,
    planId: opts.planId || null,
    runAfter: opts.runAfter || new Date(),
  })
}

// ── Owner upsert (manual outreach contacts) ────────────────────────
async function getOrCreateOwnerForContact(phone, name) {
  const existing = await db.query('SELECT id FROM owners WHERE phone = $1', [phone])
  if (existing.rows.length > 0) {
    // Preserve existing name; only fill in if currently null
    if (name) {
      await db.query(
        'UPDATE owners SET last_seen_at = NOW(), name = COALESCE(name, $2) WHERE phone = $1',
        [phone, name]
      )
    } else {
      await db.query('UPDATE owners SET last_seen_at = NOW() WHERE phone = $1', [phone])
    }
    return existing.rows[0].id
  }
  const r = await db.query(
    `INSERT INTO owners (phone, name, source_account, source_group)
     VALUES ($1, $2, 'manual_outreach', 'admin') RETURNING id`,
    [phone, name || null]
  )
  return r.rows[0].id
}

// ── Couple detection (consecutive same-last-name) ─────────────────
// Iterates the ordered contact list and links pairs at positions i / i+1
// that share the same last name. Never links non-adjacent contacts.
async function detectAndLinkCouples(contacts, adminPhone, session) {
  for (let i = 0; i < contacts.length - 1; i++) {
    const a = contacts[i]
    const b = contacts[i + 1]

    // Both must have a full name (at least two words) to extract a last name
    if (!a.name || !b.name) continue
    const partsA = a.name.trim().split(/\s+/)
    const partsB = b.name.trim().split(/\s+/)
    if (partsA.length < 2 || partsB.length < 2) continue

    const lastA = partsA[partsA.length - 1].toLowerCase()
    const lastB = partsB[partsB.length - 1].toLowerCase()
    if (lastA !== lastB) continue

    // Same last name + consecutive → link as partners
    const ownerIdA = await getOrCreateOwnerForContact(a.phone, a.name)
    const ownerIdB = await getOrCreateOwnerForContact(b.phone, b.name)

    // Avoid duplicate links (check both directions)
    const existing = await db.query(
      `SELECT id FROM owner_links
       WHERE (owner_id_1 = $1 AND owner_id_2 = $2)
          OR (owner_id_1 = $2 AND owner_id_2 = $1)`,
      [ownerIdA, ownerIdB]
    )
    if (existing.rows.length > 0) continue

    await db.query(
      `INSERT INTO owner_links (owner_id_1, owner_id_2, relationship, confirmed)
       VALUES ($1, $2, 'partner', false)`,
      [ownerIdA, ownerIdB]
    )

    const firstA = partsA[0]
    const firstB = partsB[0]
    const lastName = partsA[partsA.length - 1]
    const note = `👫 Linked ${firstA} & ${firstB} ${lastName} as partners`
    log.info('Couple linked', { phones: [a.phone.slice(-4), b.phone.slice(-4)], lastName })
    await notifyNotes(note, session)
  }
}

// ── Parse !outreach combined input: list + blank line + message ───
// Format:
//   {phone} {name}
//   {phone} {name} | {location} | {property ref} | {property type}
//
//   Hi [name], your message here
//
// The pipe-delimited extras are optional per line — see parseOwnerLine.
// Returns { contacts: [{phone, name, location, propertyRef, propertyType}], messageText, error }.
function parseOutreachListAndMessage(body) {
  if (!body || !body.trim()) {
    return { contacts: [], messageText: null, error: '❌ No phone numbers detected. Format: phone name per line, blank line, then message.' }
  }
  const lines = body.replace(/\r/g, '').split('\n')
  const contacts = []
  let i = 0
  // Skip leading blanks
  while (i < lines.length && lines[i].trim() === '') i++
  // Parse list lines until blank or non-matching
  for (; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (ln === '') break
    // Use the canonical parseOwnerLine — accepts "+" prefix, any country code,
    // and auto-prefixes 8-digit Maltese numbers (7x/9x → 356).
    const p = parseOwnerLine(ln)
    if (p) {
      contacts.push({
        phone: p.phone, name: p.name || null,
        location: p.location || null, propertyRef: p.propertyRef || null, propertyType: p.propertyType || null,
      })
      continue
    }
    // Stop on first non-matching line — rest treated as message
    break
  }
  // Skip blank separator(s)
  while (i < lines.length && lines[i].trim() === '') i++
  const messageText = lines.slice(i).join('\n').trim()

  if (contacts.length === 0) {
    return { contacts: [], messageText: null, error: '❌ No phone numbers detected. Format: phone name per line.' }
  }
  // No message text is OK — caller can prompt via two-step flow
  return { contacts, messageText: messageText || null, error: null }
}

// Look up status for each phone; returns { warm, cold, missing }.
// warm = hot/softwarm, cold = cold/new, missing = not in owner_contacts.
async function classifyOutreachContactList(contacts) {
  if (!contacts.length) return { warm: 0, cold: 0, missing: 0 }
  const phones = contacts.map(c => c.phone)
  const r = await db.query(
    'SELECT phone_normalized, status FROM owner_contacts WHERE phone_normalized = ANY($1::text[])',
    [phones]
  )
  const statusByPhone = new Map(r.rows.map(row => [row.phone_normalized, row.status]))
  let warm = 0, cold = 0, missing = 0
  for (const c of contacts) {
    const s = statusByPhone.get(c.phone)
    if (!s) { missing++; continue }
    if (s === 'hot' || s === 'softwarm') warm++
    else if (s === 'cold' || s === 'new') cold++
    else cold++ // ghosted/never/unknown → cold bucket
  }
  return { warm, cold, missing }
}

// State TTL for the two-step !outreach flow
const OUTREACH_TEXT_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Shared confirm prompt (Kev 2026-08-29) ──────────────────────────
// Both the two-step flow (Path A, after the admin types the message) and
// !foutreach's one-paste Path B land here — this is the ONE place that
// arms the YES/EDIT/STOP gate, so nothing can send without it. Builds the
// same preview + pacing estimate either way and never sends anything itself.
// Which of these numbers can WhatsApp actually deliver to? Batch 276
// (2026-10-17) armed 40 numbers none of which had WhatsApp; every send then
// failed with "no LID found" for 50 minutes. Checked once here, at preview
// time, so the operator approves what can really be sent. checkNumberStatus
// is fail-open (an API error counts as reachable) — it never blocks a batch
// because of a lookup problem.
async function splitByWhatsApp(session, contacts) {
  const results = new Array(contacts.length)
  let next = 0
  const worker = async () => {
    while (next < contacts.length) {
      const index = next++
      results[index] = await waha.checkNumberStatus(session, contacts[index].phone)
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, contacts.length) }, worker))
  return {
    reachable: contacts.filter((_, index) => results[index] !== false),
    noWhatsApp: contacts.filter((_, index) => results[index] === false),
  }
}

async function presentOutreachConfirm(adminPhone, replySession, outreachSession, contacts, messageText, listType = 'unknown', fromNotesChat = true) {
  const checkSession = outreachSession || replySession
  if (contacts.length > 3) await reply(adminPhone, `⏳ Checking which of the ${contacts.length} numbers are on WhatsApp…`, replySession)
  const { reachable, noWhatsApp } = await splitByWhatsApp(checkSession, contacts)
  const noWaList = noWhatsApp.slice(0, 10).map(c => `+${c.phone}${c.name ? ` ${c.name}` : ''}`).join(', ') + (noWhatsApp.length > 10 ? `, …+${noWhatsApp.length - 10}` : '')
  if (!reachable.length) {
    manualOutreachState.delete(adminPhone)
    const why = `none of the ${contacts.length} numbers is on WhatsApp`
    outreachApproval.remember(adminPhone, { outcome: 'refused', why })
    log.warn('Outreach approval refused: no recipient on WhatsApp', { admin: String(adminPhone).slice(-4), session: checkSession, total: contacts.length })
    await reply(adminPhone, `📵 Not armed — ${why}. Nothing will be sent.
${noWaList}`, replySession)
    return
  }
  contacts = reachable
  const firstName = (contacts[0]?.name || '').trim().split(/\s+/)[0]
  const preview = firstName
    ? messageText.replace(/\[name\]/gi, firstName)
    : messageText.replace(/[, ]*\[name\][, ]*/gi, '').replace(/\s{2,}/g, ' ').trim()
  const pace = pacingFor(listType)
  const minSec = Math.round(pace.min / 1000)
  const maxSec = Math.round(pace.max / 1000)
  const avgSec = Math.round((pace.min + pace.max) / 2000)
  const estMin = Math.max(1, Math.ceil((contacts.length * avgSec) / 60))

  // approvalId doubles as the run's triggerId: enqueueOutreachRun is
  // ON CONFLICT (source, trigger_id) DO NOTHING, so one preview can never
  // become two runs, however many YES messages arrive.
  const approvalId = require('crypto').randomUUID()
  manualOutreachState.set(adminPhone, {
    step: 'awaiting_outreach_confirm',
    contacts,
    listType,
    messageText,
    session: replySession,
    outreachSession,
    fromNotesChat,
    approvalId,
    setAt: Date.now(),
    expiresAt: Date.now() + OUTREACH_TEXT_TTL_MS,
  })
  log.info('Outreach approval armed', { approvalId, admin: String(adminPhone).slice(-4), session: checkSession, contacts: contacts.length, noWhatsApp: noWhatsApp.length })
  const forceCount = contacts.filter(c => c.force).length
  const lines = [
    `📨 Ready to send *${contacts.length}* ${listType !== 'unknown' ? listType : ''} outreach${contacts.length === 1 ? '' : 'es'}`.replace(/  +/g, ' '),
    forceCount ? `⚡ FORCE mode — ${forceCount} contact(s), cooldowns overridden` : null,
    noWhatsApp.length ? `📵 ${noWhatsApp.length} number(s) without WhatsApp removed: ${noWaList}` : null,
    `Pacing: ${minSec}-${maxSec}s · est ~${estMin}m total`,
    '',
    'Preview (first owner):',
    '> ' + preview.split('\n').slice(0, 5).join('\n> '),
    '',
    'Reply *YES* to send, *EDIT* to change text, *STOP* to cancel (*!cancel* also works).',
  ].filter(Boolean)
  await reply(adminPhone, lines.join('\n'), replySession)
}

// ── cmdOutreach — entry point ──────────────────────────────────────
// Two paths:
//   A) Two-step: !outreach + list (no text) → prompt "What should I write?"
//      → next admin message becomes the template, then send.
//   B) One-step: !outreach + list + blank line + text → send immediately.
//      NOT for force batches — see below, force always confirms.
// Notes chat → uses that session as sender. DM → asks which Kev account.
//
// opts.forceMode: set by the !FOUTREACH dispatcher (super-admin gated there).
// The legacy "force" leading-line trick inside plain !outreach still works
// too — kept for whoever has it muscle-memoried — but !foutreach is now the
// documented entry point.
async function cmdOutreach(adminPhone, session, bodyAfterCommand, fromNotesChat = true, opts = {}) {
  if (!bodyAfterCommand || !bodyAfterCommand.trim()) {
    await reply(
      adminPhone,
      [
        withName(opts.forceMode ? '*Force Outreach* — paste list (text optional)' : '*Manual Outreach* — paste list (text optional)', adminPhone),
        '',
        opts.forceMode ? '`!foutreach`' : '`!outreach`',
        '`35679341755 Brigitte`',
        '`35679538390 Mark`',
        '',
        'Add a blank line + message in the same paste, or send the message in your next reply.',
        opts.forceMode ? 'Force always asks YES/EDIT/STOP before anything sends — no one-paste shortcut.' : '',
        '',
        '*!cancel* to abort.',
      ].filter(Boolean).join('\n'),
      session
    )
    return
  }

  // "force" as its own leading line still works for back-compat; opts.forceMode
  // (set by !FOUTREACH) is the same switch and does not require the line.
  let forceMode = !!opts.forceMode
  const forceLineMatch = bodyAfterCommand.match(/^\s*force\s*\n([\s\S]*)$/i)
  if (forceLineMatch) {
    forceMode = true
    bodyAfterCommand = forceLineMatch[1]
  }

  const parsed = parseOutreachListAndMessage(bodyAfterCommand)
  if (parsed.error) {
    await reply(adminPhone, parsed.error, session)
    return
  }

  const { messageText } = parsed
  const contacts = forceMode ? parsed.contacts.map(c => ({ ...c, force: true })) : parsed.contacts

  // Path B: list + text in same paste → execute now.
  //
  // NEVER for force: "GARANTIERTE Textabfrage... nichts geht ohne Kevs
  // Bestätigung raus" (Kev, 2026-08-29) — force ignores our own cooldowns, so
  // the one thing standing between a paste and 50 owners getting messaged has
  // to be an explicit human YES every time, not "well they included a blank
  // line and text so I assumed go". Notes-chat and DM both land in the same
  // confirm gate; DM additionally needs the sending account chosen first.
  if (messageText && !forceMode) {
    if (fromNotesChat) {
      await enqueueDirectOutreach(adminPhone, session, session, contacts, messageText, {
        source: 'notes_outreach', pacingType: require('./outreachRunEngine').DEFAULT_PACING_MODE,
      })
      return
    }
    manualOutreachState.set(adminPhone, {
      step: 'awaiting_direct_session_choice',
      contacts,
      messageText,
      session,
      setAt: Date.now(),
    })
    const kevList = KEV_SESSIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
    await reply(adminPhone, `Which account sends?\n\n${kevList}\n\n*!cancel* to abort.`, session)
    return
  }
  if (messageText && forceMode) {
    if (fromNotesChat) {
      await presentOutreachConfirm(adminPhone, session, session, contacts, messageText, 'unknown')
      return
    }
    // DM: still need to know which account sends before a preview makes
    // sense (pacing/estimate below is account-agnostic, but "which account"
    // is a separate question from "is this ok to send") — ask, then confirm.
    manualOutreachState.set(adminPhone, {
      step: 'awaiting_direct_session_choice',
      contacts,
      messageText,
      session,
      setAt: Date.now(),
    })
    const kevList = KEV_SESSIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
    await reply(adminPhone, `Which account sends?\n\n${kevList}\n\n*!cancel* to abort.`, session)
    return
  }

  // Path A: list only → prompt for text and remember the list (5min TTL)
  const counts = await classifyOutreachContactList(contacts).catch(() => ({ warm: 0, cold: 0, missing: 0 }))

  // Detect listType by intersecting parsed phones with the latest listCache entry
  let listType = 'unknown'
  try {
    const { getCreatedList } = require('./listCache')
    const cached = getCreatedList(adminPhone)
    if (cached?.list?.length) {
      const cachedPhones = new Set(cached.list.map(c => String(c.phone).replace(/\D/g, '')))
      const pastedPhones = contacts.map(c => String(c.phone).replace(/\D/g, ''))
      const overlap = pastedPhones.filter(p => cachedPhones.has(p)).length
      if (overlap / pastedPhones.length >= 0.7) {
        listType = cached.meta?.listType || cached.meta?.source?.replace(/^create/, '') || 'unknown'
      }
    }
  } catch {}

  manualOutreachState.set(adminPhone, {
    step: 'awaiting_outreach_text',
    contacts,
    fromNotesChat,
    session,
    listType,
    setAt: Date.now(),
    expiresAt: Date.now() + OUTREACH_TEXT_TTL_MS,
  })
  const lines = [withName('📝 What should I write', adminPhone)]
  if (listType !== 'unknown') lines.push(`✅ *${listType}* list recognized: ${contacts.length} owners`)
  lines.push(`🔥 Warm: ${counts.warm} | ❄️ Cold: ${counts.cold}`)
  lines.push('Use *[name]* to personalise per recipient.')
  if (counts.missing > 0) lines.push(`_${counts.missing} number(s) skipped — you'll see a summary after._`)
  lines.push('\n*!cancel* to abort.')
  await reply(adminPhone, lines.join('\n'), session)
}

// ── Session choice step ────────────────────────────────────────────
// Notes chat → outreach from the same session (self-message).
// DM (non-notes-chat) → ask which Kev account to send from.
async function startSessionChoiceStep(adminPhone, session, contacts, fromNotesChat = true) {
  if (fromNotesChat) {
    await startMessageStep(adminPhone, session, contacts, session)
    return
  }
  // DM between accounts — ask which Kev account sends
  manualOutreachState.set(adminPhone, { step: 'awaiting_session_choice', contacts, session, setAt: Date.now() })
  const kevList = KEV_SESSIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
  await reply(adminPhone, `Which account sends?\n\n${kevList}\n\n*!cancel* to abort.`, session)
}

async function startMessageStep(adminPhone, session, contacts, outreachSession) {
  // Couple detection runs first on the full ordered list, before cooldown checks
  await detectAndLinkCouples(contacts, adminPhone, session).catch(err =>
    log.warn('detectAndLinkCouples error (non-fatal)', { err: err.message })
  )

  // Admin's contacts are treated as "cold" — classify against cooldowns
  const { ready: coldReady, softskipped } = await classifyContacts(contacts, outreachSession)

  // Tag cold contacts
  const coldContacts = coldReady.map(c => ({ ...c, is_warm: false }))

  // Auto-pull warm contacts from DB (80–90% of batch)
  // Warm quota: 4× cold count, minimum 20, capped at WARM_DAILY_LIMIT minus already sent today
  const counts = await getWarmColdCountsToday(outreachSession).catch(() => ({ warm: 0, cold: 0 }))
  const warmAvailable = Math.max(0, WARM_DAILY_LIMIT - counts.warm)
  const warmQuota = Math.min(
    Math.max(coldContacts.length * 4, 20),
    warmAvailable
  )

  // Exclude phones already in admin's list to avoid duplicates
  const adminPhones = new Set(contacts.map(c => c.phone))
  const rawWarm = warmQuota > 0
    ? await warmScanner.getWarmBatchContacts(warmQuota + adminPhones.size, outreachSession).catch(() => [])
    : []
  const warmContacts = rawWarm.filter(w => !adminPhones.has(w.phone))

  const mixedBatch = [...warmContacts, ...coldContacts]

  if (mixedBatch.length === 0) {
    if (softskipped.length > 0) {
      const lines = ['⏭️ *Skipped (manual review):*']
      for (const s of softskipped) {
        const displayName = s.name ? s.name.trim().split(/\s+/)[0] : s.phone
        lines.push(`- ${displayName} ${s.phone} - ${s.reason}`)
      }
      await reply(adminPhone, lines.join('\n'), session)
    } else {
      await reply(adminPhone, '⚠️ No contacts to send to.', session)
    }
    return
  }

  // Ask for the message
  manualOutreachState.set(adminPhone, {
    step: 'awaiting_message',
    ready: mixedBatch,
    softskipped,
    outreachSession,
    session,
    setAt: Date.now(),
  })

  const lines = [withName('What should I write', adminPhone)]
  lines.push(`🔥 Warm: ${warmContacts.length} | ❄️ Cold: ${coldContacts.length}`)
  lines.push('Use *[name]* to personalise per recipient.')
  if (softskipped.length) lines.push(`_${softskipped.length} number(s) skipped — you'll see a summary after._`)
  lines.push('\n*!cancel* to abort.')

  await reply(adminPhone, lines.join('\n'), session)
}

// ── handleOutreachStep — called for every admin DM mid-flow ────────
async function handleOutreachStep(adminPhone, text, session) {
  const state = manualOutreachState.get(adminPhone)
  const decision = outreachApproval.decisionOf(text)
  if (!state) {
    // Nothing pending. "!yes"/"!no" are not commands — answer them instead of
    // "Unknown command". A plain YES only gets an answer right after an
    // approval this operator just made (repeated YES); otherwise plain words
    // keep flowing to the other YES handlers (match replies etc.).
    const memo = outreachApproval.recall(adminPhone)
    if (decision && String(text).trim().startsWith('!')) {
      await reply(adminPhone, outreachApproval.noPendingMessage(memo), session)
      return true
    }
    if (decision === 'yes' && memo && memo.outcome === 'approved' && Date.now() - memo.at < 2 * 60 * 1000) {
      log.info('Outreach approval: repeated YES ignored', { admin: String(adminPhone).slice(-4), runId: memo.runId || null })
      await reply(adminPhone, outreachApproval.noPendingMessage(memo), session)
      return true
    }
    return false
  }

  // Expiry: say so when the operator answers a dead preview — it used to be
  // dropped silently, so a late YES looked like ARGUS ignoring the operator.
  if (state.expiresAt && Date.now() > state.expiresAt) {
    manualOutreachState.delete(adminPhone)
    const wasApproval = /_confirm$/.test(state.step)
    log.info('Outreach approval expired', { step: state.step, approvalId: state.approvalId || null, admin: String(adminPhone).slice(-4), ageMs: Date.now() - (state.setAt || 0) })
    if (wasApproval) {
      outreachApproval.remember(adminPhone, { outcome: 'expired' }, state.setAt || Date.now())
      if (decision) {
        await reply(adminPhone, outreachApproval.noPendingMessage(outreachApproval.recall(adminPhone)), session)
        return true
      }
    }
    return false
  }

  // Suppress echo: bot reply fires a message.any webhook within ~4s. A bare
  // YES/EDIT/STOP is never an echo (the bot never sends one), so a fast human
  // answer is no longer swallowed — the 2026-10-17 "Yes" 2 s after preview.
  if (outreachApproval.isLikelyEcho(state, text)) {
    log.debug('Outreach echo suppressed', { step: state.step, ms: Date.now() - state.setAt })
    return true
  }

  let cmd = text.toUpperCase()

  // ── Two-step flow: waiting for the message text after !outreach + list
  if (state.step === 'awaiting_outreach_text') {
    // Don't swallow other commands — let them route normally
    if (text.startsWith('!')) {
      manualOutreachState.delete(adminPhone)
      return false
    }
    const { contacts, fromNotesChat, listType = 'unknown' } = state

    // Note: previous behaviour fired the batch as soon as text arrived. We now
    // transition to a YES/EDIT/STOP confirmation step (notes-chat path).
    if (fromNotesChat) {
      await presentOutreachConfirm(adminPhone, session, session, contacts, text, listType)
      return true
    }

    // DM → still need session selection before sending (legacy path)
    manualOutreachState.set(adminPhone, {
      step: 'awaiting_direct_session_choice',
      contacts,
      messageText: text,
      listType,
      session,
      setAt: Date.now(),
    })
    const kevList = KEV_SESSIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
    await reply(adminPhone, `Which account sends?\n\n${kevList}\n\n*!cancel* to abort.`, session)
    return true
  }

  // ── Confirm step (notes-chat YES/EDIT/STOP) ──────────────────────
  if (state.step === 'awaiting_outreach_confirm') {
    if (decision === 'yes') {
      const { contacts, messageText, listType, outreachSession, approvalId } = state
      // Deleted before any await: a second YES arriving meanwhile finds no
      // pending state and gets the "already approved" answer, never a 2nd run.
      manualOutreachState.delete(adminPhone)
      const sendingSession = outreachSession || session
      log.info('Outreach approval accepted', { approvalId: approvalId || null, admin: String(adminPhone).slice(-4), session: sendingSession, contacts: contacts.length })
      let run = null
      try {
        run = await enqueueDirectOutreach(adminPhone, session, sendingSession, contacts, messageText, { pacingType: listType, source: 'notes_outreach', triggerId: approvalId })
      } catch (err) {
        log.error('Outreach approval: enqueue failed', { approvalId: approvalId || null, err: err.message })
        outreachApproval.remember(adminPhone, { outcome: 'refused', why: err.message })
        await reply(adminPhone, `❌ Outreach NOT started — ${err.message}
Nothing was sent.`, session)
        return true
      }
      outreachApproval.remember(adminPhone, { outcome: 'approved', count: contacts.length, session: sendingSession, runId: run?.run_id || null })
      log.info('Outreach approval: run enqueued', { approvalId: approvalId || null, runId: run?.run_id || null, status: run?.status || null })
      await reply(adminPhone,
        `✅ Approved — ${contacts.length} message(s) will go out via *${sendingSession}*${run?.run_id ? ` (run ${String(run.run_id).slice(0, 8)})` : ''}. ` +
        'The first one leaves within about a minute; you get the report when it finishes. *!cancel* stops it.', session)
      return true
    }
    if (decision === 'edit') {
      manualOutreachState.set(adminPhone, {
        step: 'awaiting_outreach_text',
        contacts: state.contacts,
        fromNotesChat: state.fromNotesChat,
        listType: state.listType,
        session,
        setAt: Date.now(),
        expiresAt: Date.now() + OUTREACH_TEXT_TTL_MS,
      })
      await reply(adminPhone, '✏️ What should I send instead?', session)
      return true
    }
    if (decision === 'stop') {
      manualOutreachState.delete(adminPhone)
      outreachApproval.remember(adminPhone, { outcome: 'cancelled' })
      log.info('Outreach approval cancelled', { approvalId: state.approvalId || null, admin: String(adminPhone).slice(-4) })
      await reply(adminPhone, '❌ Outreach cancelled.', session)
      return true
    }
    // Allow other commands (! prefix) to pass through; keep state
    if (text.startsWith('!')) return false
    await reply(adminPhone, 'Reply *YES* to send, *EDIT* to change text, or *STOP* to cancel.', session)
    return true
  }

  // ── !REACHOUTBATCH confirm — Kev, 2026-08-30. The one and only place a
  // real reachout batch can be sent: an explicit YES here, nothing else.
  if (state.step === 'awaiting_reachout_batch_confirm') {
    if (decision === 'yes') {
      manualOutreachState.delete(adminPhone)
      const availabilityReachout = require('./availabilityReachout')
      try {
        const result = await availabilityReachout.runManualBatch(state.limit)
        if (result.refusedWindow) {
          await reply(adminPhone, '❌ Now outside the contact window — nothing sent. Run !reachoutbatch again inside 08:00-20:00 Malta.', session)
          return true
        }
        const lines = [`✅ Reachout batch sent: ${result.sent.length}/${result.candidates}.`]
        if (result.sent.length) lines.push(result.sent.map(s => `#${s.ref}`).join(', '))
        if (result.skipped.length) lines.push(`Skipped: ${result.skipped.map(s => `#${s.ref} (${s.why})`).join(', ')}`)
        await reply(adminPhone, lines.join('\n'), session)
      } catch (err) {
        log.error('Reachout batch crashed', err)
        await reply(adminPhone, `❌ Reachout batch error: ${err.message}`, session)
      }
      return true
    }
    if (decision === 'stop') {
      manualOutreachState.delete(adminPhone)
      await reply(adminPhone, '🛑 Reachout batch cancelled — nothing sent.', session)
      return true
    }
    if (text.startsWith('!')) return false
    await reply(adminPhone, 'Reply *YES* to send this reachout batch, or *STOP* to cancel.', session)
    return true
  }

  // ── !OUTREMINDER confirm — Kev, 2026-09-02. Same one-and-only-place-a-
  // real-send-happens shape as !reachoutbatch just above.
  if (state.step === 'awaiting_outreminder_confirm') {
    if (decision === 'yes') {
      manualOutreachState.delete(adminPhone)
      const reminderOutreach = require('./reminderOutreach')
      try {
        const result = await reminderOutreach.runOutreminderBatch(state.reminderIds)
        const lines = [`✅ Reminder follow-up sent: ${result.sent.length}/${result.total}.`]
        if (result.sent.length) lines.push(result.sent.map(s => `#${s.id} via ${s.session}`).join(', '))
        if (result.skipped.length) lines.push(`Skipped: ${result.skipped.map(s => `#${s.id} (${s.reason})`).join(', ')}`)
        await reply(adminPhone, lines.join('\n'), session)
      } catch (err) {
        log.error('Outreminder batch crashed', err)
        await reply(adminPhone, `❌ Outreminder error: ${err.message}`, session)
      }
      return true
    }
    if (decision === 'stop') {
      manualOutreachState.delete(adminPhone)
      await reply(adminPhone, '🛑 Reminder follow-up cancelled — nothing sent.', session)
      return true
    }
    if (text.startsWith('!')) return false
    await reply(adminPhone, 'Reply *YES* to send this reminder follow-up, or *STOP* to cancel.', session)
    return true
  }

  // ── Step 1: waiting for the number list ───────────────────────────
  if (state.step === 'awaiting_numbers') {
    const contacts = parseContacts(text)
    if (contacts.length === 0) {
      await reply(
        adminPhone,
        '⚠️ No valid numbers found. Format: `99123456 Name` or `35699123456 Name`.\n\n*!cancel* to abort.',
        session
      )
      return true
    }
    await startSessionChoiceStep(adminPhone, session, contacts, state.fromNotesChat ?? true)
    return true
  }

  // ── Step 1b: DM flow — waiting for session choice ─────────────────
  // Supports ANY number of KEV_SESSIONS (1..N). After adding Cedric /
  // Jasmine / Kevthirdd to KEVIN_ACCOUNTS the picker shows all of them.
  // The reply line uses the INDEX → session-name mapping so the operator
  // sees "Sending via *Cedric*" in the next step (the role-gate output).
  // Accepts EITHER the numeric index (1..N) OR the literal session name
  // (case-insensitive) — the name fallback is the live-verify path:
  // `!outreach cedric` resolves to Cedric via the name even when no
  // number was issued.
  if (state.step === 'awaiting_session_choice') {
    const { contacts } = state
    const idx = parseInt(cmd, 10)
    let outreachSession = null
    if (Number.isInteger(idx) && idx >= 1 && idx <= KEV_SESSIONS.length) {
      outreachSession = KEV_SESSIONS[idx - 1]
    } else {
      const match = KEV_SESSIONS.find(s => String(s).toLowerCase() === String(cmd || '').toLowerCase())
      if (match) outreachSession = match
    }
    if (!outreachSession) {
      manualOutreachState.set(adminPhone, { ...state, setAt: Date.now() })
      const kevList = KEV_SESSIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
      await reply(adminPhone, `Reply 1-${KEV_SESSIONS.length} (or the session name).\n\n${kevList}`, session)
      return true
    }
    manualOutreachState.delete(adminPhone)
    await startMessageStep(adminPhone, session, contacts, outreachSession)
    return true
  }

  // ── Direct flow: DM session choice for !outreach combined input ──
  if (state.step === 'awaiting_direct_session_choice') {
    const { contacts, messageText, listType } = state
    const idx = parseInt(cmd, 10)
    let outreachSession = null
    if (Number.isInteger(idx) && idx >= 1 && idx <= KEV_SESSIONS.length) {
      outreachSession = KEV_SESSIONS[idx - 1]
    } else {
      const match = KEV_SESSIONS.find(s => String(s).toLowerCase() === String(cmd || '').toLowerCase())
      if (match) outreachSession = match
    }
    if (!outreachSession) {
      manualOutreachState.set(adminPhone, { ...state, setAt: Date.now() })
      const kevList = KEV_SESSIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
      await reply(adminPhone, `Reply 1-${KEV_SESSIONS.length} (or the session name).\n\n${kevList}`, session)
      return true
    }
    manualOutreachState.delete(adminPhone)
    // Force from a DM: the account is now known, but the send itself still
    // has to clear the same YES/EDIT/STOP gate — choosing an account is not
    // the confirmation. Derived from the contacts themselves (not a state
    // flag threaded through) so an EDIT round-trip can never lose it.
    if (contacts.some(c => c.force)) {
      await presentOutreachConfirm(adminPhone, session, outreachSession, contacts, messageText, listType || 'unknown', false)
      return true
    }
    enqueueDirectOutreach(adminPhone, session, outreachSession, contacts, messageText, { pacingType: listType, source: 'notes_outreach' }).catch(err => {
      log.error('Direct outreach crashed', err)
      reply(adminPhone, `❌ Outreach error: ${err.message}`, session)
    })
    return true
  }

  // ── Step 2: message text ───────────────────────────────────────────
  if (state.step === 'awaiting_message') {
    const { ready, softskipped, outreachSession } = state
    manualOutreachState.delete(adminPhone)

    const est = 1 + (ready.length - 1) * 33
    await reply(adminPhone, `Sending via *${outreachSession}* to *${ready.length}* contact(s). Est. ~${est}s.`, session)

    sendManualBatch(adminPhone, session, ready, text, outreachSession, softskipped).catch(err => {
      log.error('Manual outreach batch crashed', err)
      reply(adminPhone, `❌ Batch error: ${err.message}`, session)
    })

    return true
  }

  return false
}

// ── !cancel ────────────────────────────────────────────────────────
// `!cancel`       → stop every running outreach batch (+ queue/cycles, as before)
// `!cancel <id>`  → stop ONLY batch #id; nothing else is touched
// The reply names each stopped batch with its sent/pending counts — never a
// bare "0 jobs" while a batch loop is sending in-process (2026-09-24).
async function batchCounts(batchId) {
  const r = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='sent')::int AS sent,
            COUNT(*) FILTER (WHERE status IN ('pending','cancelled'))::int AS pending
       FROM outreach_batch_items WHERE batch_id=$1`, [batchId])
  return r.rows[0] || { sent: 0, pending: 0 }
}
async function cmdCancel(phone, session, args = '') {
  const target = (String(args).match(/^#?(\d+)$/) || [])[1] || null
  if (String(args).trim() && !target) {
    await reply(phone, '❓ Usage: *!cancel* (all running batches) or *!cancel <batchId>*', session)
    return
  }
  const stopped = cancelRuns(target)
  // Rows still 'running' in the DB with no live loop (process restarted, or
  // queued for outreachRecovery) are cancelled too, so recovery can't revive them.
  const orphan = await db.query(
    `UPDATE outreach_batches SET status='cancelled', cancelled_at=NOW()
      WHERE status IN ('running','interrupted') AND ($1::int IS NULL OR id=$1::int)
        AND NOT (id = ANY($2::int[])) RETURNING id, session_name`,
    [target, stopped.filter(r => r.batchId).map(r => r.batchId)]).catch(() => ({ rows: [] }))
  for (const o of orphan.rows) {
    await db.query(`UPDATE outreach_batch_items SET status='cancelled', skip_reason='cancelled_by_admin' WHERE batch_id=$1 AND status='pending'`, [o.id]).catch(() => {})
  }
  const lines = []
  for (const run of stopped) {
    if (run.batchId) {
      await db.query(`UPDATE outreach_batch_items SET status='cancelled', skip_reason='cancelled_by_admin' WHERE batch_id=$1 AND status='pending'`, [run.batchId]).catch(() => {})
      await db.query(`UPDATE outreach_batches SET status='cancelled', cancelled_at=COALESCE(cancelled_at, NOW()) WHERE id=$1`, [run.batchId]).catch(() => {})
      const c = await batchCounts(run.batchId).catch(() => ({ sent: run.sent, pending: run.total - run.sent }))
      lines.push(`• Batch #${run.batchId} (${run.session}${run.kind === 'plan' ? ', plan' : ''}): ${c.sent} sent, ${c.pending} stopped`)
    } else {
      lines.push(`• Manual batch (${run.session}): ${run.sent} sent, ${run.total - run.sent} stopped`)
    }
  }
  for (const o of orphan.rows) {
    const c = await batchCounts(o.id).catch(() => ({ sent: '?', pending: '?' }))
    lines.push(`• Batch #${o.id} (${o.session_name}, not running in this process): ${c.sent} sent, ${c.pending} stopped`)
  }

  if (target) {
    await reply(phone, lines.length
      ? `🛑 Outreach cancelled:\n${lines.join('\n')}`
      : `⚠️ No running batch #${target}. Running now: ${listRunningBatches().map(r => r.batchId ? '#' + r.batchId : 'manual').join(', ') || 'none'}.`, session)
    return
  }

  manualOutreachState.delete(phone)
  cancelPmPostPending(phone)
  let waiting = 0
  try {
    waiting = await QUEUES['outreach'].getWaitingCount()
    await QUEUES['outreach'].drain()
  } catch {}
  const r = await db.query(
    `UPDATE owner_outreach_cycles SET status='cancelled', updated_at=NOW()
     WHERE status='pending' RETURNING id`
  )
  // Also stop the Auto-Owner-Conversation state for any phone whose outreach
  // never got past 'cold' (i.e. the automation, if any, never truly engaged)
  // — !cancel means "the outreach itself is off", so nothing tied to it
  // should keep running either.
  let autoStopped = 0
  try {
    const autoConvo = require('./autoOwnerConversation')
    const stale = await db.query(
      `SELECT DISTINCT oac.phone FROM owner_auto_conversations oac
       JOIN outreach_log ol ON ol.id = oac.outreach_log_id
       WHERE oac.status = 'active_collecting' AND ol.conversation_state = 'cold'`
    )
    for (const row of stale.rows) {
      if (await autoConvo.cancelChatAutomation(row.phone)) autoStopped++
    }
  } catch (e) {
    log.warn('!cancel: auto-conversation cleanup failed', { err: e.message })
  }
  const batchPart = lines.length ? `\n${lines.join('\n')}` : '\nNo outreach batch was running.'
  await reply(phone, `🛑 Outreach cancelled.${batchPart}\n${waiting} queue jobs + ${r.rows.length} cycles stopped.${autoStopped ? ` + ${autoStopped} automation(s) stopped.` : ''}`, session)
}

// ── !cancela — global kill-switch for the Auto-Owner-Conversation
// automation (NOT the outreach itself). Notes-chat only. `!cancela off`
// resumes it again.
async function cmdCancelAllAutomation(phone, session, args) {
  const autoConvo = require('./autoOwnerConversation')
  if (/^off$/i.test((args || '').trim())) {
    await autoConvo.resumeAllAutomations(phone)
    await reply(phone, '✅ Auto-Owner-Conversation automation resumed.', session)
    return
  }
  const n = await autoConvo.cancelAllAutomations(phone)
  await reply(phone, `🛑 Auto-Owner-Conversation automation stopped GLOBALLY. ${n} active conversation(s) halted. Send *!cancela off* to resume.`, session)
}

// ── Main entry — called from webhook ──────────────────────────────

async function handleAdminMessage(payload, session, fromNotesChat = false) {
  // realSenderJid first: under LID addressing payload.from/participant is an
  // opaque @lid, and matching an admin against that always fails. It returns a
  // real phone JID when the engine sends one (GOWS _data.Info.SenderAlt,
  // NOWEB _data.key.*) and the LID only as a last resort.
  const senderJid = fromNotesChat
    ? (payload.to || `${config.admin.botNumber}@c.us`)
    : (realSenderJid(payload) || payload.participant || payload.author || payload.from)
  // phoneFromJid also strips the ':<device>' suffix that normalizePhone leaves
  // behind ('49177...:5@s.whatsapp.net'); it yields '' for a LID, so the
  // normalizePhone fallback keeps the old behaviour when no real number exists.
  let phone  = phoneFromJid(senderJid) || normalizePhone(senderJid)
  let text   = (payload.body || '').trim()
  const isGroup = !fromNotesChat && (payload.from || '').includes('@g.us')

  // GOWS frequently exposes a group participant only as an opaque @lid and
  // omits SenderAlt.  Treating those LID digits as a phone makes a genuine
  // admin fail isAdminAccount(), so commands such as !rented are silently
  // ignored. Resolve the LID through WAHA first and keep the existing
  // fail-closed admin check below when no verified phone mapping exists.
  if (!fromNotesChat && isGroup && /@lid$/i.test(String(senderJid || ''))) {
    const resolvedPhone = await require('./contactTouch').resolvePhone(session, senderJid)
    if (resolvedPhone) phone = resolvedPhone
  }

  // Group self-command: the session's own phone sent a !command inside a group (fromMe=true).
  // Treat same as notes-chat — bypass isBot/isAdmin checks and reply to own notes.
  const isGroupSelfCmd = !fromNotesChat && isGroup && payload.fromMe === true

  // !match: any user, any chat — matchEngine.js (Kev, 2026-08-30: swapped
  // off the old Sheet-based engine, see matchEngine.js's own note)
  if (text.toLowerCase().startsWith('!match')) {
    // Kev, 2026-09-02: `phone` above is already the CORRECTLY-resolved
    // sender (handles the group case via .participant/.author -- payload.from
    // in a group is the GROUP id, not the sender). matchEngine.js used to
    // re-derive its own from payload.from directly, which is wrong for
    // every group invocation and silently dropped the swipe-link's agent
    // attribution every time (caught only by running it end-to-end, not by
    // reading the code — see match-any-post-proof.js).
    handleMatchCommand(payload, session, phone).catch(err => log.error('[!match] error', err))
    return { handled: true, isAdmin: false }
  }

  // Notes chat and group self-commands bypass admin checks (sender IS the session owner)
  if (!fromNotesChat && !isGroupSelfCmd) {
    if (isBot(phone)) return { handled: false, isAdmin: false }
    if (!await isAdminAccount(phone)) return { handled: false, isAdmin: false }
  }

  // For notes chat and group self-commands, resolve reply target to the session's real phone.
  let cmdPhone = phone
  if (fromNotesChat || isGroupSelfCmd) {
    const ownPhone = await waha.getSessionPhone(session).catch(() => null)
    if (ownPhone) cmdPhone = ownPhone
  }

  // ── Notes-chat chatId normalisation ────────────────────────────────
  // payload.from in notes-chats is a per-session LID (e.g. '141743198588966@lid')
  // which is meaningless on other sessions. Replace with the canonical session
  // phone JID so post handlers fetch the right chat, and set _isNotesChat so
  // they skip the cross-session fallback (which can otherwise read another
  // account's notes chat by accident — "unsauber" bug).
  if (fromNotesChat && cmdPhone) {
    const normalisedFrom = String(cmdPhone).includes('@') ? String(cmdPhone) : `${cmdPhone}@c.us`
    if (normalisedFrom !== payload.from) {
      log.debug('handleAdminMessage: normalising notes-chat from', {
        was: String(payload.from || '').slice(0, 25), to: normalisedFrom, session,
      })
      payload.from = normalisedFrom
    }
    payload._isNotesChat = true
  }

  let cmd = text.toUpperCase()

  // !help / !commands — list available commands (works for any sender)
  if (cmd === '!HELP' || cmd === '!COMMANDS') {
    try {
      const { cmdHelp } = require('../handlers/help')
      await cmdHelp(session, phone, text)
    } catch (e) {
      try { await reply(cmdPhone, '❓ Help unavailable.', session) } catch (_) {}
    }
    return { handled: true, isAdmin: true }
  }

  // !CANCEL always wins — intercept before mid-flow steps
  if (!isGroup && (cmd === '!CANCEL' || /^!CANCEL\s+#?\d+$/.test(cmd))) {
    await cmdCancel(cmdPhone, session, cmd.replace(/^!CANCEL/, '').trim())
    return { handled: true, isAdmin: true }
  }

  // !cancela — global Auto-Owner-Conversation kill-switch (notes-chat only).
  // Distinct from !cancel: this stops the AUTOMATION, not the outreach.
  if (!isGroup && (cmd === '!CANCELA' || cmd.startsWith('!CANCELA '))) {
    const args = text.slice('!cancela'.length).trim()
    await cmdCancelAllAutomation(cmdPhone, session, args)
    return { handled: true, isAdmin: true }
  }

  // Mid-flow steps take priority — checked before command matching
  if (!isGroup) {
    // Pool-cursor admin confirmations (!resetcursor / !setcursor → YES within 30s)
    const poolPending = _getPoolConfirm(cmdPhone)
    if (poolPending) {
      const t = (text || '').trim().toUpperCase()
      if (t === 'YES' || t === 'Y') {
        _clearPoolConfirm(cmdPhone)
        await applyPoolConfirm(cmdPhone, session, poolPending)
        return { handled: true, isAdmin: true }
      }
      if (t === 'NO' || t === 'N' || t === '!CANCEL') {
        _clearPoolConfirm(cmdPhone)
        await reply(cmdPhone, '↩️ Pool cursor change cancelled.', session)
        return { handled: true, isAdmin: true }
      }
      // Fall through: not a YES/NO — let normal routing run (next command etc.)
    }

    const stepped = await handleOutreachStep(cmdPhone, text, session)
    if (stepped) return { handled: true, isAdmin: true }
    // pmPost admin Q&A (villa subtype / unrecognised location)
    const pmHandled = handlePmPostAdminReply(cmdPhone, text)
    if (pmHandled) return { handled: true, isAdmin: true }
    // Match reply handler (YES / NO / SKIP)
    const matchHandled = await handleMatchReply(cmdPhone, text)
    if (matchHandled) return { handled: true, isAdmin: true }
  }

  // ── Label system commands (DM/notes only) ─────────────────────────
  if (!isGroup) {
    const sessionByPhone = {
      '35699811819': 'default',
      '35699270699': 'Kevsecond',
      '35699655034': 'kevthirdd',
      '35679010070': 'Olga',
    }
    const requestingSession = (fromNotesChat || isGroupSelfCmd)
      ? session
      : (sessionByPhone[normalizePhone(phone)] || session)
    const labelHandled = await tryHandleLabelCommand({
      cmd, text, adminPhone: cmdPhone, session, requestingSession, sendFn: reply,
    }).catch(err => {
      log.error('label command error', err)
      reply(cmdPhone, `❌ Label command failed: ${err.message}`, session)
      return true
    })
    if (labelHandled) return { handled: true, isAdmin: true }

    // Pending bare-number answer for !createhotlist interactive mode
    if (!text.startsWith('!')) {
      const answered = await tryHandleHotPendingAnswer({
        text, adminPhone: cmdPhone, session, sendFn: reply,
      }).catch(err => {
        log.error('!createhotlist pending-answer error', err)
        return false
      })
      if (answered) return { handled: true, isAdmin: true }
    }

    const coldListHandled = await tryHandleCreateColdList({
      cmd, text, adminPhone: cmdPhone, session, requestingSession, sendFn: reply,
    }).catch(err => {
      log.error('!createcoldlist error', err)
      reply(cmdPhone, `❌ !createcoldlist failed: ${err.message}`, session)
      return true
    })
    if (coldListHandled) return { handled: true, isAdmin: true }

    const hotListHandled = await tryHandleCreateHotList({
      cmd, text, adminPhone: cmdPhone, session, requestingSession, sendFn: reply,
    }).catch(err => {
      log.error('!createhotlist/!hotreachout error', err)
      reply(cmdPhone, `❌ Hot list failed: ${err.message}`, session)
      return true
    })
    if (hotListHandled) return { handled: true, isAdmin: true }

    // Schedule-Board: !schedule-board-login / !schedule_board_invite
    // Alias: !scheduleboard_invite (no separator between schedule and board)
    if (cmd.startsWith('!SCHEDULEBOARD_INVITE ') || cmd.startsWith('!SCHEDULEBOARD-INVITE ')) {
      // normalise to the canonical form. text is `const` here so we use
      // a new `aliasedText` var; the dispatcher below will pick the
      // updated `cmd` and read `text` directly (which already starts with
      // the alias prefix, so the schedule-board dispatcher sees '!schedule_board_invite ...').
      text = '!schedule_board_invite ' + text.replace(/^!scheduleboard[_-]?invite\s+/i, '')
      cmd = '!SCHEDULE_BOARD_INVITE'
    }
    if (cmd.startsWith('!SCHEDULEBOARD_LOGIN ') || cmd === '!SCHEDULEBOARD_LOGIN' ||
        cmd.startsWith('!SCHEDULEBOARD-LOGIN ') || cmd === '!SCHEDULEBOARD-LOGIN') {
      text = '!schedule-board-login' + text.replace(/^!scheduleboard[_-]?login\s*/i, '')
      cmd = '!SCHEDULE-BOARD-LOGIN'
    }
    const sbHandled = await tryHandleScheduleBoardCommand({
      cmdPhone, cmd, text, session, sendFn: reply,
    }).catch(err => {
      log.error('schedule-board command error', err)
      return false
    })
    if (sbHandled) return { handled: true, isAdmin: true }
  }

  // !SUPERADMINS — list current super admins. Any admin account may view.
  if (cmd === '!SUPERADMINS') {
    try {
      const rows = await superadmins.listSuperAdmins()
      if (rows.length === 0) {
        await reply(cmdPhone, '⚠️ No super admins configured. Run `!superadmin +<your-number>` to bootstrap.', session)
      } else {
        const lines = ['👑 *Super admins:*']
        for (const r of rows) {
          const added = r.added_at ? new Date(r.added_at).toLocaleDateString('en-GB') : '?'
          lines.push(`  • +${r.phone} (by ${r.added_by || 'unknown'}, ${added})`)
        }
        await reply(cmdPhone, lines.join('\n'), session)
      }
    } catch (err) {
      log.error('!superadmins failed', err)
      await reply(cmdPhone, `❌ Error: ${err.message}`, session)
    }
    return { handled: true, isAdmin: true }
  }

  // !SUPERADMIN +<phone> | !SUPERADMIN remove +<phone>
  //  - Only existing super admins may run this.
  //  - If the table is empty, the first caller self-bootstraps (must match their own phone).
  if (cmd.startsWith('!SUPERADMIN ') || cmd === '!SUPERADMIN') {
    try {
      const argText = text.slice('!superadmin'.length).trim()
      if (!argText) {
        await reply(
          cmdPhone,
          '❓ Usage:\n  !superadmin +<phone>         — add\n  !superadmin remove +<phone>  — remove\n  !superadmins                 — list',
          session,
        )
        return { handled: true, isAdmin: true }
      }

      const removeMatch = argText.match(/^remove\s+(.+)$/i)
      const action = removeMatch ? 'remove' : 'add'
      const rawTarget = removeMatch ? removeMatch[1] : argText
      const targetPhone = superadmins.normalizePhone(rawTarget)
      if (!targetPhone || !/^\d{6,15}$/.test(targetPhone)) {
        await reply(cmdPhone, '❌ Invalid phone. Use international format, e.g. +35699811819', session)
        return { handled: true, isAdmin: true }
      }

      const callerPhone = superadmins.normalizePhone(cmdPhone)
      const callerIsSuper = await superadmins.isSuperAdmin(callerPhone)
      const total = await superadmins.countSuperAdmins()

      if (!callerIsSuper) {
        if (total === 0 && action === 'add' && targetPhone === callerPhone) {
          // Bootstrap: empty list, caller self-assigns
          await superadmins.addSuperAdmin(targetPhone, callerPhone)
          await reply(cmdPhone, `✅ Bootstrap: +${targetPhone} is now super admin.`, session)
          return { handled: true, isAdmin: true }
        }
        await reply(cmdPhone, '⛔ Only existing super admins can run !superadmin.', session)
        return { handled: true, isAdmin: true }
      }

      if (action === 'remove') {
        const result = await superadmins.removeSuperAdmin(targetPhone)
        if (!result.removed) {
          await reply(cmdPhone, `ℹ️ +${targetPhone} was not a super admin.`, session)
        } else {
          await reply(cmdPhone, `✅ Removed +${targetPhone} from super admins.`, session)
        }
      } else {
        const result = await superadmins.addSuperAdmin(targetPhone, callerPhone)
        if (!result.added) {
          await reply(cmdPhone, `ℹ️ +${targetPhone} is already a super admin.`, session)
        } else {
          await reply(cmdPhone, `✅ Added +${targetPhone} as super admin.`, session)
        }
      }
    } catch (err) {
      log.error('!superadmin failed', err)
      await reply(cmdPhone, `❌ Error: ${err.message}`, session)
    }
    return { handled: true, isAdmin: true }
  }

  // !RESETWA / !WARESET [sessionname] — super admin only. Delete + recreate session, send QR screenshot.
  if (cmd.startsWith('!RESETWA') || cmd.startsWith('!WARESET')) {
    if (!(await isSuperAdmin(cmdPhone))) {
      await reply(cmdPhone, '⛔ !resetwa is restricted to super admins.', session)
      return { handled: true, isAdmin: true }
    }
    const aliasLen = cmd.startsWith('!WARESET') ? '!wareset'.length : '!resetwa'.length
    const sessionArg = text.slice(aliasLen).trim().toLowerCase()
    // Map case-insensitive arg → real session_name (DB-cased)
    const knownSessions = {
      default:   config.waha.session1 || 'default',
      kevsecond: config.waha.session2 || 'Kevsecond',
      kevthirdd: config.waha.session3 || 'kevthirdd',
      olga:      'Olga',
      jasmine:   'Jasmine',
      cedric:    'Cedric',
    }
    const targetSession = knownSessions[sessionArg]
    if (!targetSession) {
      await reply(cmdPhone, '❓ Usage: !resetwa default | kevsecond | kevthirdd | olga | jasmine | cedric', session)
      return { handled: true, isAdmin: true }
    }
    await reply(cmdPhone, `🔄 Resetting *${targetSession}*...`, session)
    waha.resetWahaSession(targetSession)
      .then(async () => {
        await reply(
          cmdPhone,
          `Session ${targetSession} reset with full config. Scan QR in dashboard when ready.`,
          session,
        )
        log.info('!resetwa complete', { target: targetSession, admin: cmdPhone.slice(-4) })
      })
      .catch(async (err) => {
        log.error('!resetwa failed', { err: err.message })
        await reply(cmdPhone, `❌ Reset failed: ${err.message}`, session)
      })
    return { handled: true, isAdmin: true }
  }

  // !POST — quote a property message and reply with !post to publish to Facebook.
  // Works from any chat (group, DM, notes). Confirmation reply goes to admin DM only.
  if (cmd === '!POST') {
    postPropertyToFacebook(session, payload)
      .then(postId => {
        log.info('FB post published', { postId, admin: cmdPhone.slice(-4) })
        return reply(cmdPhone, '✅ Posted to Facebook', session)
      })
      .catch(err => {
        log.error('!post failed', { err: err.message })
        reply(cmdPhone, `❌ Post failed: ${err.message}`, session)
      })
    return { handled: true, isAdmin: true }
  }

  // !POSTPM — post as "To Rent" on PropertyMarket.com.mt
  if (cmd === '!POSTPM') {
    postPropertyToPropertyMarket(session, payload, 'To Rent')
      .then(result => {
        log.info('PM post published', { ref: result.ref, admin: cmdPhone.slice(-4) })
        return reply(cmdPhone, result.message, session)
      })
      .catch(err => {
        log.error('!postpm failed', { err: err.message })
        reply(cmdPhone, `❌ Post failed: ${err.message}`, session)
      })
    return { handled: true, isAdmin: true }
  }

  // !POSTPMSALE — post as "For Sale" on PropertyMarket.com.mt
  if (cmd === '!POSTPMSALE') {
    postPropertyToPropertyMarket(session, payload, 'For Sale')
      .then(result => {
        log.info('PM sale post published', { ref: result.ref, admin: cmdPhone.slice(-4) })
        return reply(cmdPhone, result.message, session)
      })
      .catch(err => {
        log.error('!postpmsale failed', { err: err.message })
        reply(cmdPhone, `❌ Post failed: ${err.message}`, session)
      })
    return { handled: true, isAdmin: true }
  }

  // !POSTWEB — post as "To Rent" on 2906 website
  if (cmd === '!POSTWEB') {
    postPropertyToWebsite(session, payload, 'To Rent', (statusMsg) => reply(cmdPhone, statusMsg, session))
      .then(result => {
        log.info('webPost: published', { ref: result.ref, admin: cmdPhone.slice(-4) })
        reply(cmdPhone, result.message, session)
        if (result.cloudinaryError && result.imageCount === 0) {
          reply(cmdPhone, '⚠️ Images not uploaded — ' + result.cloudinaryError, session)
        }
      })
      .catch(err => {
        log.error('!postweb failed', { err: err.message })
        reply(cmdPhone, '❌ Web post failed: ' + err.message, session)
      })
    return { handled: true, isAdmin: true }
  }

  // !POSTWEBSALE — post as "For Sale" on 2906 website
  if (cmd === '!POSTWEBSALE') {
    postPropertyToWebsite(session, payload, 'For Sale', (statusMsg) => reply(cmdPhone, statusMsg, session))
      .then(result => {
        log.info('webPost: sale published', { ref: result.ref, admin: cmdPhone.slice(-4) })
        reply(cmdPhone, result.message, session)
        if (result.cloudinaryError && result.imageCount === 0) {
          reply(cmdPhone, '⚠️ Images not uploaded — ' + result.cloudinaryError, session)
        }
      })
      .catch(err => {
        log.error('!postwebsale failed', { err: err.message })
        reply(cmdPhone, '❌ Web post failed: ' + err.message, session)
      })
    return { handled: true, isAdmin: true }
  }

  // !POSTALL — run !postweb → !postpm → !post sequentially with 5–10 s delays
  if (cmd === '!POSTALL') {
    ;(async () => {
      const postDelay = () => Math.floor(Math.random() * 5000) + 5000 // 5–10 s

      // Step 1: website
      try {
        const webResult = await postPropertyToWebsite(session, payload, 'To Rent', (s) => reply(cmdPhone, s, session))
        log.info('postall: webPost done', { ref: webResult.ref, admin: cmdPhone.slice(-4) })
        await reply(cmdPhone, webResult.message, session)
        if (webResult.cloudinaryError && webResult.imageCount === 0) {
          await reply(cmdPhone, '⚠️ Images not uploaded — ' + webResult.cloudinaryError, session)
        }
      } catch (err) {
        log.error('postall: webPost failed', { err: err.message })
        await reply(cmdPhone, '❌ Web post failed: ' + err.message, session)
      }

      await sleep(postDelay())

      // Step 2: PropertyMarket
      try {
        const pmResult = await postPropertyToPropertyMarket(session, payload, 'To Rent')
        log.info('postall: pmPost done', { ref: pmResult.ref, admin: cmdPhone.slice(-4) })
        await reply(cmdPhone, pmResult.message, session)
      } catch (err) {
        log.error('postall: pmPost failed', { err: err.message })
        await reply(cmdPhone, '❌ PM post failed: ' + err.message, session)
      }

      await sleep(postDelay())

      // Step 3: Facebook
      try {
        const postId = await postPropertyToFacebook(session, payload)
        log.info('postall: fbPost done', { postId, admin: cmdPhone.slice(-4) })
        await reply(cmdPhone, '✅ Posted to Facebook', session)
      } catch (err) {
        log.error('postall: fbPost failed', { err: err.message })
        await reply(cmdPhone, '❌ FB post failed: ' + err.message, session)
      }
    })().catch(err => log.error('!postall crashed', { err: err.message }))
    return { handled: true, isAdmin: true }
  }

  // Summarize commands work from both DM/notes and their respective group chats
  if (cmd === '!SUMMARIZEREMINDER') {
    cmdSummarizeReminder(cmdPhone, session).catch(err => {
      log.error('SummarizeReminder failed', err)
      reply(cmdPhone, 'SummarizeReminder error: ' + err.message, session)
    })
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!SUMMARIZECLIENTS') {
    cmdSummarizeClients(cmdPhone, session).catch(err => {
      log.error('SummarizeClients failed', err)
      reply(cmdPhone, 'SummarizeClients error: ' + err.message, session)
    })
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!SUMMARIZEPROPERTIES') {
    const srcGroupId = isGroup ? (payload.from || null) : null
    cmdSummarizeProperties(cmdPhone, session, srcGroupId).catch(err => {
      log.error('SummarizeProperties failed', err)
      reply(cmdPhone, 'SummarizeProperties error: ' + err.message, session)
    })
    return { handled: true, isAdmin: true }
  }

  // ── Reminder commands ──────────────────────────────────────────────────────
  // !remindernow                  → trigger daily upcoming-reminders post now
  // !reminders                    → DM next-30-days list to caller
  // !done #ID                     → mark reminder contacted
  // !cancelreminder #ID           → cancel a reminder

  if (cmd === '!REMINDERNOW') {
    ;(async () => {
      try {
        // Run the sweep right now with the per-reminder poster. Same surface
        // as the cron tick — fire3w + fire1d windows, post each to the channel.
        const result = await reminderScheduler.runReminderSweep(new Date(), {
          postToReminderChannel: reminderPoster.postReminder,
        })
        await reply(cmdPhone, `✅ Reminder sweep fired (${result.count} due, ${result.posted} posted)`, session)
      } catch (err) {
        log.error('!remindernow failed', { err: err.message })
        await reply(cmdPhone, `❌ Reminder post failed: ${err.message}`, session)
      }
    })().catch(err => log.error('!remindernow crashed', { err: err.message }))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!REMINDERS') {
    ;(async () => {
      try {
        // T-1MONTH (per Kev's spec) — past 30 days + next 30 days, newest first.
        const rows = await reminderPoster.listRecent({ windowDays: 30 })
        const msg = reminderPoster.formatListForDm(rows, 30)
        await reply(cmdPhone, msg, session)
      } catch (err) {
        log.error('!reminders failed', { err: err.message })
        await reply(cmdPhone, `❌ Reminder list failed: ${err.message}`, session)
      }
    })().catch(err => log.error('!reminders crashed', { err: err.message }))
    return { handled: true, isAdmin: true }
  }

  if (cmd.startsWith('!DONE')) {
    const idMatch = text.match(/#?(\d+)/)
    if (!idMatch) {
      await reply(cmdPhone, '❓ Usage: !done #ID', session)
      return { handled: true, isAdmin: true }
    }
    const id = parseInt(idMatch[1], 10)
    ;(async () => {
      try {
        const row = await reminderPoster.markReminderDone(id, session)
        if (!row) {
          await reply(cmdPhone, `⚠️ Reminder #${id} not found or already closed`, session)
        } else {
          const owner = row.owner_name || `+${row.owner_phone}`
          await reply(cmdPhone, `✅ Reminder #${id} (${owner}) marked done`, session)
        }
      } catch (err) {
        log.error('!done failed', { err: err.message, id })
        await reply(cmdPhone, `❌ !done failed: ${err.message}`, session)
      }
    })().catch(err => log.error('!done crashed', { err: err.message }))
    return { handled: true, isAdmin: true }
  }

  if (cmd.startsWith('!CANCELREMINDER')) {
    const idMatch = text.match(/#?(\d+)/)
    if (!idMatch) {
      await reply(cmdPhone, '❓ Usage: !cancelreminder #ID', session)
      return { handled: true, isAdmin: true }
    }
    const id = parseInt(idMatch[1], 10)
    ;(async () => {
      try {
        const row = await reminderPoster.cancelReminder(id)
        if (!row) {
          await reply(cmdPhone, `⚠️ Reminder #${id} not found or already closed`, session)
        } else {
          const owner = row.owner_name || `+${row.owner_phone}`
          await reply(cmdPhone, `🚫 Reminder #${id} (${owner}) cancelled`, session)
        }
      } catch (err) {
        log.error('!cancelreminder failed', { err: err.message, id })
        await reply(cmdPhone, `❌ !cancelreminder failed: ${err.message}`, session)
      }
    })().catch(err => log.error('!cancelreminder crashed', { err: err.message }))
    return { handled: true, isAdmin: true }
  }

  // DM-only commands
  if (!isGroup) {
    if (cmd === '!STATUS') { await cmdStatus(cmdPhone, session); return { handled: true, isAdmin: true } }
    if (cmd.startsWith('!REPLYTEST')) {
      const match = text.match(/^!replytest\s+(\+?\d[\d\s]+)\s+(.+)$/i)
      if (!match) {
        await reply(phone, 'Usage: !replytest <phone> <text>', session)
        return { handled: true, isAdmin: true }
      }
      const testPhone = match[1].replace(/\D/g, '')
      const testBody = match[2].trim()
      const r = await cmdReplytest(testPhone, testBody, session)
      await reply(phone, `📥 Reply-test result:\n${JSON.stringify(r, null, 2)}`, session)
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!CALENDAR')) {
      handleCalendarCommand(cmdPhone, text, session).catch(err => log.error('!calendar crash', err))
      return { handled: true, isAdmin: true }
    }


    if (cmd.startsWith('!IMPORTLIST')) {
      cmdImportList(cmdPhone, text, session, reply, log.error).catch(err => log.error('!importlist crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!IMPORTCSV')) {
      cmdImportCsv(cmdPhone, payload, session).catch(err => log.error('!importcsv crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!WASCANALL') || cmd.startsWith('!WASCAN')) {
      const sessionArg = cmd.startsWith('!WASCANALL') ? null : (text.trim().split(/\s+/)[1] || null)
      handleWaScan(cmdPhone, sessionArg, session).catch(err => log.error('!wascan crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd === '!LISTSTATS') {
      handleListStats(cmdPhone, session).catch(err => log.error('!liststats crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!BUILDLIST')) {
      const parts = text.trim().split(/\s+/)
      const arg1 = parts[1] || null
      const hotArg = parts[2] ? parseInt(parts[2]) : null
      const coldArg = parts[3] ? parseInt(parts[3]) : null
      handleBuildList(cmdPhone, session, arg1, hotArg, coldArg).catch(err => log.error('!buildlist crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!CREATELIST')) {
      // Usage: !createlist [count]               → list for current session
      //        !createlist <Account> [count]     → list for that account
      //        !createlist [count] <Account>     → same, args reversed
      const parts = text.trim().split(/\s+/).slice(1)
      let targetSession = session
      let count = 45
      for (const p of parts) {
        const n = parseInt(p)
        if (!isNaN(n)) count = n
        else if (p) targetSession = p
      }
      handleCreateList(cmdPhone, session, count, targetSession).catch(err => log.error('!createlist crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!ADDCOLD')) {
      handleAddCold(cmdPhone, session, text).catch(err => log.error('!addcold crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd === '!POOLSTATUS') {
      handlePoolStatus(cmdPhone, session).catch(err => log.error('!poolstatus crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd === '!POOLCOUNTS') {
      handlePoolCounts(cmdPhone, session).catch(err => log.error('!poolcounts crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!RESETCURSOR')) {
      handleResetCursor(cmdPhone, session, text).catch(err => log.error('!resetcursor crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!SETCURSOR')) {
      handleSetCursor(cmdPhone, session, text).catch(err => log.error('!setcursor crash', err))
      return { handled: true, isAdmin: true }
    }

    if (cmd.startsWith('!OUTREACH')) {
      const body = text.slice('!outreach'.length).trim() || null
      await cmdOutreach(cmdPhone, session, body, fromNotesChat)
      return { handled: true, isAdmin: true }
    }


    // !FOUTREACH — Force Outreach. Super-admin only (Kev, 2026-08-29): ignores
    // our own "already contacted" cooldown for this batch. Always routes
    // through cmdOutreach with forceMode on, which in turn always lands in
    // the YES/EDIT/STOP confirm gate before anything sends — see
    // presentOutreachConfirm and the "never for force" Path B guard above.
    if (cmd.startsWith('!FOUTREACH')) {
      if (!(await isSuperAdmin(cmdPhone))) {
        await reply(cmdPhone, '⛔ !foutreach is restricted to super admins.', session)
        return { handled: true, isAdmin: true }
      }
      const body = text.slice('!foutreach'.length).trim() || null
      await cmdOutreach(cmdPhone, session, body, fromNotesChat, { forceMode: true })
      return { handled: true, isAdmin: true }
    }

    // !REACHOUTBATCH [N] — Kev, 2026-08-30. Replaces the always-on cron
    // version of the availability auto-reachout, removed after an incident
    // where an already-armed env flag plus newly-armed properties sent real
    // checks to 15 owners unattended. This is now the ONLY way a real
    // reachout batch goes out: one explicit command, one preview, one YES
    // — never a timer, never a loop, never re-arms itself. N defaults to
    // 10, capped at 20 (see availabilityReachout.js's own constants).
    if (cmd.startsWith('!REACHOUTBATCH')) {
      if (!(await isSuperAdmin(cmdPhone))) {
        await reply(cmdPhone, '⛔ !reachoutbatch is restricted to super admins.', session)
        return { handled: true, isAdmin: true }
      }
      const availabilityReachout = require('./availabilityReachout')
      const arg = text.slice('!reachoutbatch'.length).trim()
      const requested = parseInt(arg, 10)
      const limit = Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), availabilityReachout.MANUAL_BATCH_MAX_LIMIT)
        : availabilityReachout.MANUAL_BATCH_DEFAULT_LIMIT

      const preview = await availabilityReachout.previewManualBatch(limit)
      if (preview.skipped) {
        await reply(cmdPhone, `❌ ${preview.note}`, session)
        return { handled: true, isAdmin: true }
      }
      if (!preview.candidates.length) {
        await reply(cmdPhone, '📭 No stale listings need a reconfirm right now.', session)
        return { handled: true, isAdmin: true }
      }

      manualOutreachState.set(cmdPhone, {
        step: 'awaiting_reachout_batch_confirm',
        limit,
        session,
        setAt: Date.now(),
        expiresAt: Date.now() + OUTREACH_TEXT_TTL_MS,
      })
      const lines = [
        `📋 *Reachout batch ready — ${preview.candidates.length} listing(s):*`,
        preview.candidates
          .map(c => `• #${c.ref}${c.neverConfirmed ? ' (never confirmed)' : ` (${c.ageHours}h stale)`}`)
          .join('\n'),
        '',
        'Reply *YES* to send these real availability checks now, *STOP* to cancel.',
      ]
      await reply(cmdPhone, lines.join('\n'), session)
      return { handled: true, isAdmin: true }
    }

    // !OUTREMINDER — Kev, 2026-09-02. Follows up every currently-open
    // reminder (status='pending', any due date — "open" is the filter, not a
    // date window) with a warm, reminder-specific message. Same preview→YES
    // gate as !reachoutbatch just above (manualOutreachState, not the heavier
    // outreach_batches/outreach_batch_items durability machinery !foutreach
    // uses — this list is small and ad-hoc, that machinery would be
    // over-building for it). Kev's spec frames step 2 as "reply !outreminder
    // to the !reminders list" — no outreach command in this file actually
    // gates on a literal WhatsApp quote-reply (they all use this same
    // admin-phone-keyed confirm flow instead), so this follows that existing
    // convention: run !outreminder any time after !reminders, same outcome,
    // no new quote-detection mechanism invented for one command. Super-admin
    // only, same gate as !foutreach/!reachoutbatch: this sends real messages
    // to real owners.
    if (cmd.startsWith('!OUTREMINDER')) {
      if (!(await isSuperAdmin(cmdPhone))) {
        await reply(cmdPhone, '⛔ !outreminder is restricted to super admins.', session)
        return { handled: true, isAdmin: true }
      }
      const reminderOutreach = require('./reminderOutreach')
      const rows = await reminderOutreach.openReminders()
      if (!rows.length) {
        await reply(cmdPhone, '📭 No open reminders to follow up.', session)
        return { handled: true, isAdmin: true }
      }
      manualOutreachState.set(cmdPhone, {
        step: 'awaiting_outreminder_confirm',
        reminderIds: rows.map(r => r.id),
        session,
        setAt: Date.now(),
        expiresAt: Date.now() + OUTREACH_TEXT_TTL_MS,
      })
      const lines = [
        `📋 *Reminder follow-up ready — ${rows.length} contact(s):*`,
        rows.map(r => `• #${r.id} ${r.owner_name ? r.owner_name.trim() : '+' + r.owner_phone} — via ${r.source_session || 'unknown'}${r.parsed_timing ? ` (${r.parsed_timing})` : ''}`).join('\n'),
        '',
        `Outreach an die ${rows.length} Reminder-Kontakte schicken? Reply *YES* to send, *STOP* to cancel.`,
      ]
      await reply(cmdPhone, lines.join('\n'), session)
      return { handled: true, isAdmin: true }
    }

    // !RESUMEOUTREACH [id] — Kev, 2026-08-30. 2026-08-29's !foutreach sent
    // 1/17 then a concurrent deploy restarted the shared backend and the
    // rest vanished silently — runDirectOutreach's progress lived only in
    // that process's memory. No id → lists batches with real pending
    // contacts left (running/interrupted). With an id → re-sends to
    // whatever in outreach_batch_items is still 'pending', going through
    // the SAME runDirectOutreach (and therefore the same WhatsApp-history
    // preflight — re-checking cooldowns after time has passed is correct,
    // not a shortcut). Super-admin only, same gate as !foutreach: this can
    // send real messages to real owners.
    if (cmd.startsWith('!RESUMEOUTREACH')) {
      if (!(await isSuperAdmin(cmdPhone))) {
        await reply(cmdPhone, '⛔ !resumeoutreach is restricted to super admins.', session)
        return { handled: true, isAdmin: true }
      }
      const arg = text.slice('!resumeoutreach'.length).trim()
      const batchId = parseInt(arg, 10)

      if (!Number.isInteger(batchId)) {
        const pending = await db.query(
          `SELECT b.id, b.session_name, b.total_contacts, b.sent_count, b.skip_count, b.status,
                  COUNT(i.id) FILTER (WHERE i.status = 'pending') AS remaining
             FROM outreach_batches b JOIN outreach_batch_items i ON i.batch_id = b.id
            WHERE b.status IN ('running', 'interrupted')
            GROUP BY b.id
           HAVING COUNT(i.id) FILTER (WHERE i.status = 'pending') > 0
            ORDER BY b.id DESC LIMIT 10`)
        if (!pending.rows.length) {
          await reply(cmdPhone, '📭 No interrupted outreach batches with contacts still pending.', session)
          return { handled: true, isAdmin: true }
        }
        const lines = ['📋 *Interrupted outreach batches:*', '']
        for (const r of pending.rows) {
          lines.push(`#${r.id} via ${r.session_name} — sent ${r.sent_count}/${r.total_contacts}, *${r.remaining} still pending* (${r.status})`)
        }
        lines.push('', 'Reply `!resumeoutreach <id>` to send to the remaining contacts.')
        await reply(cmdPhone, lines.join('\n'), session)
        return { handled: true, isAdmin: true }
      }

      const batchRes = await db.query('SELECT * FROM outreach_batches WHERE id = $1', [batchId])
      const batch = batchRes.rows[0]
      if (!batch) {
        await reply(cmdPhone, `❌ No outreach batch #${batchId}.`, session)
        return { handled: true, isAdmin: true }
      }
      const itemsRes = await db.query(
        `SELECT phone, name FROM outreach_batch_items WHERE batch_id = $1 AND status = 'pending'`, [batchId])
      if (!itemsRes.rows.length) {
        await reply(cmdPhone, `✅ Batch #${batchId} has nothing pending — nothing to resume.`, session)
        return { handled: true, isAdmin: true }
      }
      const contacts = itemsRes.rows.map(r => ({ phone: r.phone, name: r.name, force: batch.force_mode }))
      await reply(cmdPhone, `▶️ Resuming batch #${batchId}: ${contacts.length} contact(s) still pending.`, session)
      enqueueDirectOutreach(batch.initiated_by, batch.reply_session || session, batch.session_name, contacts,
        batch.message_template, { pacingType: batch.pacing_type, source: 'notes_resume', triggerId: `legacy-batch-${batch.id}` }).catch(err => {
        log.error('Resume outreach crashed', err)
        reply(cmdPhone, `❌ Resume error: ${err.message}`, session)
      })
      return { handled: true, isAdmin: true }
    }

    // !FILLFIELDS [n] — on-demand batch pass, admin-only. Fills EMPTY
    // structured CRM/board fields (location, petfriendly, floor, balconies,
    // ...) from each active-listing owner's chat. Never touches !upload's
    // own fields and never overwrites anything already set — see
    // services/ownerChatFieldFill.js's own header for the firewall reasoning.
    // Deliberately NOT a cron (see that file) — triggered by hand.
    if (cmd.startsWith('!FILLFIELDS')) {
      const nArg = parseInt(text.slice('!fillfields'.length).trim(), 10)
      const limit = Number.isInteger(nArg) && nArg > 0 ? Math.min(nArg, 100) : 20
      await reply(cmdPhone, `⏳ Scanning up to ${limit} active listing(s) for missing chat-derivable fields…`, session)
      const fieldFill = require('./ownerChatFieldFill')
      fieldFill.scanActiveOwners({ limit }).then(async (result) => {
        const lines = [
          `✅ *Field fill complete:*`,
          `- Scanned: ${result.scanned}`,
          `- Filled: ${result.filled}`,
          `- Skipped: ${result.skipped}`,
        ]
        if (result.details?.length) {
          lines.push('', '*Filled:*')
          for (const d of result.details.slice(0, 20)) lines.push(`- #${d.ref || d.propertyId}: ${d.filled.join(', ')}`)
        }
        await reply(cmdPhone, lines.join('\n'), session)
      }).catch(err => {
        log.error('!fillfields crashed', err)
        reply(cmdPhone, `❌ Field fill error: ${err.message}`, session)
      })
      return { handled: true, isAdmin: true }
    }

    if (cmd === '!WARM') {
      const stats = await warmScanner.getWarmStats()
      const msg = `🔥 Warm: ${stats.warm} | 🏠 Has property: ${stats.has_property} | 📅 Upcoming: ${stats.upcoming} | ❄️ Cold: ${stats.cold}`
      await reply(cmdPhone, msg, session)
      return { handled: true, isAdmin: true }
    }

    if (cmd === '!REFRESHWARM') {
      await reply(cmdPhone, '🔄 Scanning all chats for warm contacts…', session)
      warmScanner.scanAllChats()
        .then(async (total) => {
          const stats = await warmScanner.getWarmStats()
          const msg = `✅ Warm scan done. ${total} new/updated.\n🔥 Warm: ${stats.warm} | 🏠 Has property: ${stats.has_property} | 📅 Upcoming: ${stats.upcoming} | ❄️ Cold: ${stats.cold}`
          await reply(cmdPhone, msg, session)
        })
        .catch(err => {
          log.error('!refreshwarm scan failed', err)
          reply(cmdPhone, `❌ Warm scan error: ${err.message}`, session)
        })
      return { handled: true, isAdmin: true }
    }
  }

  // ── Chatwoot label commands — !positive / !negative / !ghosted <phone> ───────
  // Usage: !positive 35699123456  or reply with command (phone extracted from text)
  const labelCmds = { '!POSITIVE': 'positive', '!NEGATIVE': 'negative', '!GHOSTED': 'ghosted' }
  if (labelCmds[cmd]) {
    const label     = labelCmds[cmd]
    const rawTarget = text.slice(cmd.length).trim()
    const target    = rawTarget.replace(/\D/g, '') || null
    if (!target) {
      await reply(cmdPhone, `❌ Usage: ${cmd.toLowerCase()} <phone number>`, session)
      return { handled: true, isAdmin: true }
    }
    const ok = await markLabel(target, label)
    outreachStatusUpdate(target, label) // fire-and-forget
    if (ok) {
      await reply(cmdPhone, `✅ Marked ${label.toUpperCase()} in Chatwoot for ${target.slice(-4)}`, session)
    } else {
      await reply(cmdPhone, `⚠️ No open Chatwoot conversation found for ${target.slice(-4)}`, session)
    }
    return { handled: true, isAdmin: true }
  }

  // !upload / !upload2 / !upload5 / !upload9 are handled by handlers/upload.js,
  // dispatched from routes/webhook.js BEFORE this function runs. The legacy
  // catch-all that used to live here required './upload' — a path that
  // resolves to services/services/upload and does not exist, so every !upload*
  // that reached this point threw "Cannot find module" and the command died
  // silently with no reply. Removed; do not re-add a !UPLOAD branch here.

  // ── !POSTALLDAY — post all today's property listings from this group ────────────
  if (cmd === '!POSTALLDAY') {
    if (!isGroup) {
      await reply(cmdPhone, '❌ !postallday only works in property groups', session)
      return { handled: true, isAdmin: true }
    }
    const groupId = payload.from
    ;(async () => {
      await reply(cmdPhone, '🔄 Scanning today\'s posts...', session)
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      // Malta is UTC+2; shift midnight back 2h to get UTC equivalent
      const midnightUTC = new Date(midnight.getTime() - 2 * 60 * 60 * 1000)
      const msgs = await getChatMessages(session, groupId, 500).catch(() => [])
      const SKIP_PHRASES = ['looking for', 'client wants', 'wir suchen', 'sucht', 'searching for', 'need a', 'needed', 'wanted', 'is looking', 'cherche']
      const seen = new Set()
      const toPost = []
      for (const msg of msgs) {
        const ts = msg.timestamp ? new Date(msg.timestamp * 1000) : null
        if (!ts || ts < midnightUTC) continue
        const body = (msg.body || msg.text || '').trim()
        if (body.length < 30) continue
        if (/^[!\/]/.test(body)) continue
        const bodyLower = body.toLowerCase()
        if (SKIP_PHRASES.some(p => bodyLower.includes(p))) continue
        const key = body.substring(0, 80)
        if (seen.has(key)) continue
        seen.add(key)
        toPost.push({ msg, body })
      }
      if (toPost.length === 0) {
        await reply(cmdPhone, '📭 No qualifying property posts found today.', session)
        return
      }
      await reply(cmdPhone, `📋 Found ${toPost.length} post(s) to process. Starting...`, session)
      let done = 0
      let failed = 0
      for (let i = 0; i < toPost.length; i++) {
        const { body } = toPost[i]
        const syntheticPayload = { ...payload, body, hasMedia: false }
        try {
          const webResult = await postPropertyToWebsite(session, syntheticPayload, 'To Rent', () => {})
          await reply(cmdPhone, `[${i + 1}/${toPost.length}] ${webResult.message}`, session)
          done++
        } catch (err) {
          await reply(cmdPhone, `[${i + 1}/${toPost.length}] ❌ ${err.message}`, session)
          failed++
        }
        if (i < toPost.length - 1) {
          const delay = Math.floor(Math.random() * 120000) + 60000
          await sleep(delay)
        }
      }
      await reply(cmdPhone, `✅ !postallday done. ${done} posted, ${failed} failed.`, session)
    })().catch(err => {
      log.error('!postallday crashed', { err: err.message })
      reply(cmdPhone, `❌ !postallday error: ${err.message}`, session)
    })
    return { handled: true, isAdmin: true }
  }

  // ── !CLIENTS — list active clients (last 30 days) ─────────────────────────
  if (cmd === '!CLIENTS') {
    try {
      const r = await db.query(`
        SELECT name, nationalities, group_size, pets,
               budget_min, budget_max, bedrooms_wanted,
               preferred_locations, locations, wishes,
               move_in_date, lead_agent, assigned_agent,
               created_at
        FROM clients
        WHERE status = 'active' AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
        LIMIT 30
      `)
      if (r.rows.length === 0) {
        await reply(cmdPhone, '📋 No active clients in the last 30 days.', session)
        return { handled: true, isAdmin: true }
      }
      const lines = [`📋 Active Clients (${r.rows.length}):
`]
      for (const c of r.rows) {
        const flag = c.nationalities && c.nationalities.length
          ? c.nationalities.map(n => {
              try {
                return n.toUpperCase().split('').map(ch => String.fromCodePoint(ch.codePointAt(0) + 0x1F1A5)).join('')
              } catch { return '' }
            }).join('') + ' '
          : ''
        const nameStr = c.name || '(no name)'
        const groupStr = c.group_size > 1 ? ` + Group (${c.group_size} ppl${c.pets ? ', ' + c.pets : ''})` : c.pets ? ` (${c.pets})` : ''
        const budgetStr = c.budget_min && c.budget_max ? `€${c.budget_min}-${c.budget_max}` : c.budget_min ? `€${c.budget_min}+` : ''
        const bedrooms = (c.bedrooms_wanted && c.bedrooms_wanted.length) ? c.bedrooms_wanted.join('/') + 'BR' : ''
        const locArr = c.preferred_locations || c.locations || []
        const locStr = locArr.slice(0, 3).join('/')
        const moveIn = c.move_in_date ? new Date(c.move_in_date).toLocaleString('en-GB', { month: 'short', year: '2-digit' }) : ''
        const agent = c.lead_agent || c.assigned_agent || ''
        const agentStr = agent ? '@' + agent.split(' ')[0] : ''
        const parts = [flag + nameStr + groupStr, budgetStr, bedrooms, locStr, moveIn ? 'move ' + moveIn : '', agentStr].filter(Boolean)
        lines.push('• ' + parts.join(' - '))
      }
      await reply(cmdPhone, lines.join('\n'), session)
    } catch (err) {
      log.error('!clients failed', err)
      await reply(cmdPhone, '❌ Error: ' + err.message, session)
    }
    return { handled: true, isAdmin: true }
  }

  // ── !CLIENT [name or phone] — show full client details ────────────────────
  if (cmd.startsWith('!CLIENT ') || cmd === '!CLIENT') {
    const query = text.slice('!client'.length).trim()
    if (!query) {
      await reply(cmdPhone, '❌ Usage: !client [name or phone]', session)
      return { handled: true, isAdmin: true }
    }
    try {
      const r = await db.query(`
        SELECT * FROM clients
        WHERE name ILIKE $1 OR phone LIKE $2
        ORDER BY created_at DESC LIMIT 1
      `, ['%' + query + '%', '%' + query.replace(/\D/g, '') + '%'])
      if (r.rows.length === 0) {
        await reply(cmdPhone, `❌ No client found matching "${query}"`, session)
        return { handled: true, isAdmin: true }
      }
      const c = r.rows[0]
      const lines = [
        `👤 ${c.name || '(no name)'}`,
        c.phone ? `📱 ${c.phone}` : '',
        c.nationalities ? `🌍 ${c.nationalities.join(', ')}` : '',
        c.profession ? `💼 ${c.profession}` : '',
        c.group_size ? `👥 Group size: ${c.group_size}${c.pets ? ', pets: ' + c.pets : ''}` : '',
        (c.budget_min || c.budget_max) ? `💶 Budget: €${c.budget_min || '?'} – €${c.budget_max || '?'}` : '',
        c.bedrooms_wanted ? `🛏 Beds: ${c.bedrooms_wanted.join(', ')}` : '',
        (c.preferred_locations || c.locations) ? `📍 Locations: ${(c.preferred_locations || c.locations).join(', ')}` : '',
        c.wishes ? `✨ Wishes: ${c.wishes}` : '',
        c.move_in_date ? `📅 Move in: ${new Date(c.move_in_date).toLocaleDateString('en-GB')}` : '',
        c.viewings_available_from ? `📆 Viewings from: ${new Date(c.viewings_available_from).toLocaleDateString('en-GB')}` : '',
        (c.lead_agent || c.assigned_agent) ? `🤝 Agent: ${c.lead_agent || c.assigned_agent}` : '',
        c.notes ? `📝 Notes: ${c.notes}` : '',
        `📊 Status: ${c.status} | Source: ${c.source_account || 'sheet'}`,
        `🕒 Added: ${new Date(c.created_at).toLocaleDateString('en-GB')}`,
      ].filter(Boolean)
      await reply(cmdPhone, lines.join('\n'), session)
    } catch (err) {
      log.error('!client failed', err)
      await reply(cmdPhone, '❌ Error: ' + err.message, session)
    }
    return { handled: true, isAdmin: true }
  }

  // ── !SYNCCLIENTS — manual trigger Google Sheet → DB sync ─────────────────
  if (cmd === '!SYNCCLIENTS') {
    if (!(await isSuperAdmin(phone))) {
      await reply(cmdPhone, '❌ Super admin only.', session)
      return { handled: true, isAdmin: true }
    }
    reply(cmdPhone, '🔄 Syncing clients from Google Sheet...', session)
    syncClientsFromSheet()
      .then(result => reply(cmdPhone, `✅ Sync done: ${result.inserted} new, ${result.updated} updated.`, session))
      .catch(err => reply(cmdPhone, '❌ Sync error: ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  // ── !sheet <phone> — show all stored info about a number ────────────────────
  if (cmd.startsWith('!SHEET')) {
    const rawTarget = text.slice('!sheet'.length).trim()
    const parsed    = parseContactLine(rawTarget)
    const target    = parsed?.phone || rawTarget.replace(/\D/g, '') || null
    if (!target) {
      await reply(cmdPhone, '❌ Usage: !sheet <phone number>', session)
      return { handled: true, isAdmin: true }
    }

    const suffix = target.slice(-8)
    const lines  = [`📋 Info for ...${target.slice(-4)}`]

    // Owner
    const ownerR = await db.query(
      `SELECT name, source_account, created_at FROM owners
       WHERE phone = $1 OR phone LIKE $2 LIMIT 1`,
      [target, `%${suffix}`]
    )
    if (ownerR.rows[0]) {
      const o = ownerR.rows[0]
      const added = new Date(o.created_at).toLocaleDateString('en-GB')
      lines.push(`\n👤 ${o.name || '(no name)'} | source: ${o.source_account || '?'} | added: ${added}`)
    } else {
      lines.push('\n👤 Not found in owners table')
    }

    // Outreach history
    const logR = await db.query(
      `SELECT account_used, message_type, conversation_state, sent_at, replied_at
       FROM outreach_log
       WHERE phone = $1 OR phone LIKE $2
       ORDER BY sent_at DESC LIMIT 5`,
      [target, `%${suffix}`]
    )
    if (logR.rows.length > 0) {
      lines.push(`\n📤 Outreach (last ${logR.rows.length}):`)
      for (const r of logR.rows) {
        const d = new Date(r.sent_at).toLocaleDateString('en-GB')
        const rep = r.replied_at ? ` → replied ${new Date(r.replied_at).toLocaleDateString('en-GB')}` : ''
        lines.push(`  • ${d} via ${r.account_used} [${r.conversation_state}]${rep}`)
      }
    } else {
      lines.push('\n📤 No outreach history')
    }

    // Active properties
    const propR = await db.query(
      `SELECT p.property_type, p.bedrooms, p.location, p.price, p.currency
       FROM v_active_properties p
       WHERE p.owner_id IN (
         SELECT id FROM owners WHERE phone = $1 OR phone LIKE $2
       )`,
      [target, `%${suffix}`]
    ).catch(() => ({ rows: [] }))
    if (propR.rows.length > 0) {
      lines.push('\n🏠 Active properties:')
      for (const p of propR.rows) {
        const parts = [p.property_type, p.bedrooms ? `${p.bedrooms}BR` : null, p.location, p.price ? `€${p.price}` : null]
        lines.push(`  • ${parts.filter(Boolean).join(' | ')}`)
      }
    }

    await reply(cmdPhone, lines.join('\n'), session)
    return { handled: true, isAdmin: true }
  }


  // ── Scraper commands ────────────────────────────────────────────────────────
  if (cmd.startsWith('!SCRAPESTART')) {
    const srcArg = text.slice('!scrapestart'.length).trim()
    await scraperCmds.cmdScrapeStart(srcArg || 'homesinmalta', msg => reply(cmdPhone, msg, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!SCRAPEALL') {
    await scraperCmds.cmdScrapeAll(msg => reply(cmdPhone, msg, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!SCRAPESTOP') {
    await scraperCmds.cmdScrapeStop(msg => reply(cmdPhone, msg, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!LEADS') {
    await scraperCmds.cmdLeads(msg => reply(cmdPhone, msg, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!EXPORTLEADS') {
    await scraperCmds.cmdExportLeads(msg => reply(cmdPhone, msg, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd.startsWith('!BLACKLIST ')) {
    const emailArg = text.slice('!blacklist '.length).trim()
    await scraperCmds.cmdBlacklist(emailArg, msg => reply(cmdPhone, msg, session))
    return { handled: true, isAdmin: true }
  }

  // !GEMINITEST [text] - run Gemini extraction on text
  if (cmd.startsWith('!GEMINITEST')) {
    const testText = text.slice('!geminitest'.length).trim()
    if (!testText) {
      await reply(cmdPhone, '? Usage: !geminitest <property listing text>', session)
      return { handled: true, isAdmin: true }
    }
    reply(cmdPhone, '? Running Gemini extraction...', session)
    extractPropertyFromPost(testText, 'TEST')
      .then(result => {
        if (!result) return reply(cmdPhone, '? Gemini extraction returned null', session)
        if (result.dry_mode) return reply(cmdPhone, '? DRY MODE - GEMINI_API_KEY not set yet', session)
        const lines = [
          '*Gemini Result*',
          'Is property: ' + result.is_property,
          'Confidence: ' + result.confidence + '%',
          'Template: ' + (result.template_detected || 'unknown'),
          'Type: ' + (result.property_type || '-'),
          'Listing: ' + (result.listing_type || '-'),
          'Location: ' + (result.location || '-'),
          'Beds: ' + (result.bedrooms != null ? result.bedrooms : '-') + '  Baths: ' + (result.bathrooms != null ? result.bathrooms : '-'),
          'Price: ' + (result.price ? 'EUR' + result.price : '-'),
          'Available: ' + (result.available_from || '-'),
          'Furnished: ' + (result.furnished || '-'),
          'Features: ' + ((result.features || []).join(', ') || '-'),
          'Phone: ' + (result.contact_phone || '-'),
          'Summary: ' + (result.summary || '-'),
        ]
        reply(cmdPhone, lines.join('\n'), session)
      })
      .catch(err => reply(cmdPhone, '? Gemini error: ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  // !GEMINISCANRUN - manually trigger full group scan
  if (cmd === '!GEMINISCANRUN') {
    reply(cmdPhone, '? Gemini scan started across 6 property groups...', session)
    scanAllPropertyGroups()
      .then(r => reply(cmdPhone, r.summary || ('Done - ' + r.totalExtracted + ' new, ' + r.totalDuplicates + ' dupes, ' + r.totalErrors + ' errors'), session))
      .catch(err => reply(cmdPhone, '? Scan error: ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  // !GEMINISYNC - sync sheet approvals to DB
  if (cmd === '!GEMINISYNC') {
    reply(cmdPhone, '? Syncing sheet approvals...', session)
    const fs2 = require('fs')
    const cfg2 = require('../config')
    if (!fs2.existsSync(cfg2.sheets.credentialsPath)) {
      await reply(cmdPhone, '? Google credentials not configured - sync skipped', session)
      return { handled: true, isAdmin: true }
    }
    const { google: google2 } = require('googleapis')
    const creds2 = JSON.parse(fs2.readFileSync(cfg2.sheets.credentialsPath, 'utf8'))
    const auth2 = new google2.auth.GoogleAuth({ credentials: creds2, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
    const sheets2 = google2.sheets({ version: 'v4', auth: auth2 })
    syncSheetApprovals(sheets2)
      .then(r => reply(cmdPhone, 'Sync done - ' + r.approvedCount + ' approved, ' + r.rejectedCount + ' rejected', session))
      .catch(err => reply(cmdPhone, '? Sync error: ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  // !rented [ref] — manually mark property as rented (Kev's 2026-09-15
  // hotfix, spec items 4+16). Replaces the old !RENTED block, which wrote
  // to `properties_submitted`/`owner_properties` — schema matchEngine.js's
  // own header comment already documented as dead/pre-Prompt-B, so against
  // a real "2906-XXXX" ref it always replied "not found". Reuses
  // services/rentedDetector.js's markRented() — the SAME atomic status
  // flip + match invalidation + FB/website/AV-check cancellation + sheet
  // sync the emoji-reaction and quoted-reply auto-detection paths already
  // run, not a second implementation. Case-insensitive for free — `cmd` is
  // already uppercased text.toUpperCase() above, same as every other
  // command in this dispatch.
  if (cmd.startsWith('!RENTED')) {
    const rentedDetector = require('./rentedDetector')
    await rentedDetector.handleRentedCommand(payload, session, cmdPhone)
    return { handled: true, isAdmin: true }
  }

  // !available [ref] — restore-to-active, the !rented counterpart (Phase E,
  // 2026-09-17). killSwitch.reactivate() previously existed with zero
  // callers anywhere — this is the missing command surface for it.
  if (cmd.startsWith('!AVAILABLE')) {
    const rentedDetector = require('./rentedDetector')
    await rentedDetector.handleAvailableCommand(payload, session, cmdPhone)
    return { handled: true, isAdmin: true }
  }

  // !categorize REF <seafront|villa|luxury|1|2|3> — manual publishing-
  // category override (Phase 1, 2026-09-17). A ROUTING decision only; never
  // touches canonical bedrooms/price/type. Same dispatch shape as !RENTED
  // just above — case-insensitive for free via the already-uppercased cmd.
  if (cmd.startsWith('!CATEGORIZE')) {
    const categoryPublisher = require('./categoryPublisher')
    await categoryPublisher.handleCategorizeCommand(payload, session, cmdPhone)
    return { handled: true, isAdmin: true }
  }

  // ── Facebook campaign commands ──────────────────────────────────
  if (cmd === '!FBSTATUS') {
    const { cmdFbStatus } = require('./facebookCampaign')
    cmdFbStatus(cmdPhone, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd.startsWith('!FBSTATUS ') || cmd.startsWith('!fbstatus ')) {
    const { cmdFbStatusDetail } = require('./facebookCampaign')
    const refId = text.slice('!fbstatus'.length).trim().toUpperCase()
    if (!refId) {
      const { cmdFbStatus } = require('./facebookCampaign')
      cmdFbStatus(cmdPhone, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    } else {
      cmdFbStatusDetail(cmdPhone, refId, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    }
    return { handled: true, isAdmin: true }
  }

  if (cmd.startsWith('!FBSTOP ') || cmd.startsWith('!fbstop ')) {
    const { cmdFbStop } = require('./facebookCampaign')
    const refId = text.slice('!fbstop'.length).trim().toUpperCase()
    if (!refId) {
      await reply(cmdPhone, '❌ Usage: !fbstop <ref_id>  e.g. !fbstop 2B-014', session)
    } else {
      cmdFbStop(cmdPhone, refId, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    }
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!FBPAUSE') {
    const { cmdFbPause } = require('./facebookCampaign')
    cmdFbPause(session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!FBRESUME') {
    const { cmdFbResume } = require('./facebookCampaign')
    cmdFbResume(session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!FBCANCELLALL') {
    const { cmdFbCancelAll } = require('./facebookCampaign')
    cmdFbCancelAll(cmdPhone, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd.startsWith('!FBTEST ') || cmd.startsWith('!fbtest ')) {
    const { cmdFbTest } = require('./facebookCampaign')
    const refId = text.slice('!fbtest'.length).trim().toUpperCase()
    if (!refId) {
      await reply(cmdPhone, '❌ Usage: !fbtest <ref_id>  e.g. !fbtest 2B-014', session)
    } else {
      cmdFbTest(cmdPhone, refId, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    }
    return { handled: true, isAdmin: true }
  }

  // ── Agent sheet commands ────────────────────────────────────────
  if (cmd === '!SHEETSYNC') {
    const { fullResync } = require('./googleAgentSheet')
    fullResync().then(r => reply(cmdPhone, '✅ Sheet sync triggered', session)).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  if (cmd === '!SHEETURL') {
    const { cmdSheetUrl } = require('./googleAgentSheet')
    cmdSheetUrl(cmdPhone, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  // ── Platform connectors ─────────────────────────────────────────
  if (cmd === '!CONNECTORS') {
    const { cmdConnectors } = require('./platformConnectors')
    cmdConnectors(cmdPhone, session).catch(err => reply(cmdPhone, '❌ ' + err.message, session))
    return { handled: true, isAdmin: true }
  }

  // Unknown command — reply with help pointer instead of silent no-op
  if (text && text.startsWith('!')) {
    try {
      await reply(cmdPhone, `❓ Unknown command: ${cmd.slice(0, 60)}\nType *!help* for the full list.`, session)
    } catch (e) { /* best-effort */ }
  }
  return { handled: false, isAdmin: true }
}


// !importcsv handler
async function cmdImportCsv(cmdPhone, payload, session) {
  const { importOwnerCsv } = require("./csvImporter")
  const wahaBase = (config.waha && config.waha.url ? config.waha.url : "http://2906_waha:3000").replace(/\/$/, "")
  const apiKey = config.waha && config.waha.apiKey ? config.waha.apiKey : "Waha2906!"

  const mediaUrl = payload.media && payload.media.url ? payload.media.url : null
  if (!mediaUrl) {
    await reply(cmdPhone, "Attach a .csv file to the !importcsv message", session)
    return
  }

  const fixedUrl = mediaUrl
    .replace(/^https?:\/\/localhost(:\d+)?/, wahaBase)
    .replace(/^https?:\/\/127\.0\.0\.1(:\d+)?/, wahaBase)

  await reply(cmdPhone, "Downloading CSV...", session)

  const tmpPath = "/tmp/wa_import_" + Date.now() + ".csv"
  try {
    const fileRes = await fetch(fixedUrl, { headers: { "X-Api-Key": apiKey } })
    if (!fileRes.ok) throw new Error("Download failed: " + fileRes.status)
    const buf = Buffer.from(await fileRes.arrayBuffer())
    await require("fs").promises.writeFile(tmpPath, buf)

    const bodyArgs = (payload.body || '').trim().toLowerCase().split(/\s+/)
    const defaultStatus = bodyArgs.includes('softwarm') ? 'softwarm' : null
    const result = await importOwnerCsv(tmpPath, cmdPhone, defaultStatus)
    await require("fs").promises.unlink(tmpPath).catch(() => {})

    const lines = [
      "CSV Imported: " + result.filename,
      "",
      "Stats:",
      "CSV rows: " + result.total_csv_rows,
      "Parsed: " + result.parsed_rows,
      "Invalid: " + result.invalid_rows,
      "New owners: " + result.new_owners,
      "Merged: " + result.merged_owners,
      "New phone variants: " + result.new_phone_variants,
      "Duplicate phones skipped: " + result.duplicate_phones,
      "",
      "List ID: " + result.list_id,
    ]
    await reply(cmdPhone, lines.join("\n"), session)
  } catch (err) {
    await require("fs").promises.unlink(tmpPath).catch(() => {})
    log.error("!importcsv error", err)
    await reply(cmdPhone, "Import failed: " + err.message, session)
  }
}


// !calendar command - any registered agent
async function handleCalendarCommand(cmdPhone, text, session) {
  const db = require('../db')
  const args = text.trim().split(/\s+/)
  const param = (args[1] || '').toLowerCase()

  const agentRes = await db.query('SELECT * FROM agents WHERE whatsapp_phone = $1', [cmdPhone])

  if (agentRes.rows.length === 0) {
    await reply(cmdPhone, '❌ Your number is not registered as an agent. Ask Kev.', session)
    return
  }

  const agent = agentRes.rows[0]

  let from = new Date()
  let to = new Date()
  let title = ''

  if (param === 'today') {
    from.setHours(0, 0, 0, 0)
    to.setHours(23, 59, 59, 999)
    title = 'Today'
  } else if (param === 'tomorrow') {
    from = new Date(from.getTime() + 86400000)
    from.setHours(0, 0, 0, 0)
    to = new Date(from.getTime())
    to.setHours(23, 59, 59, 999)
    title = 'Tomorrow'
  } else {
    from.setHours(0, 0, 0, 0)
    to = new Date(from.getTime() + 7 * 86400000)
    to.setHours(23, 59, 59, 999)
    title = 'Next 7 Days'
  }

  const eventsRes = await db.query(`
    SELECT ce.*, c.name as client_name, c.nationality as client_nationality, c.contact_phone as client_phone
    FROM calendar_events ce
    LEFT JOIN clients c ON ce.client_id = c.id
    WHERE ce.agent_id = $1 AND ce.scheduled_at >= $2 AND ce.scheduled_at <= $3
    ORDER BY ce.scheduled_at
  `, [agent.id, from, to])

  if (eventsRes.rows.length === 0) {
    await reply(cmdPhone, `📅 *${agent.display_name} - ${title}*\n\nNo events scheduled.`, session)
    return
  }

  const byDay = {}
  for (const ev of eventsRes.rows) {
    const day = new Date(ev.scheduled_at).toDateString()
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(ev)
  }

  let report = `📅 *${agent.display_name}'s Calendar - ${title}*\n\n`

  for (const day of Object.keys(byDay)) {
    const dayDate = new Date(day)
    const dayName = dayDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    report += `*${dayName}*\n`

    for (const ev of byDay[day]) {
      const time = new Date(ev.scheduled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      const flag = ev.client_nationality || ''
      const client = ev.client_name || ev.title || ev.event_type
      const dur = ev.duration_minutes ? `${ev.duration_minutes}min` : ''

      report += `• ${time} (${dur}) ${client} ${flag}\n`
      if (ev.address) report += `  📍 ${ev.address}\n`
      if (ev.maps_link) report += `  🗺️ ${ev.maps_link}\n`
      if (ev.comment) report += `  💬 ${ev.comment}\n`
      if (ev.client_phone) report += `  📞 ${ev.client_phone}\n`
    }
    report += '\n'
  }

  report += `📊 ${eventsRes.rows.length} events total`
  await reply(cmdPhone, report, session)
}


// !liststats / !buildlist handlers
async function handleListStats(cmdPhone, session) {
  if (!await isAdminAccount(cmdPhone)) {
    await reply(cmdPhone, '❌ Not authorized', session)
    return
  }
  try {
    const accs = await db.query(
      'SELECT session_name, account_persona, cold_daily_min, cold_daily_max, warm_daily_max FROM whatsapp_accounts WHERE is_active = TRUE AND outreach_enabled = TRUE ORDER BY priority, id'
    )
    const hotR  = await db.query("SELECT COUNT(*) FROM owner_contacts WHERE status = 'hot'")
    const coldR = await db.query("SELECT COUNT(*) FROM owner_contacts WHERE status IN ('cold','new','never','ghosted') OR status IS NULL")
    const swR   = await db.query("SELECT COUNT(*) FROM owner_contacts WHERE status = 'softwarm'")
    const hotN  = parseInt(hotR.rows[0].count)
    const coldN = parseInt(coldR.rows[0].count)
    const swN   = parseInt(swR.rows[0].count)

    let msg = '📊 *Outreach Capacity*\n'
    msg += `Pool: ${hotN} hot | ${coldN} cold | ${swN} softwarm\n\n`
    for (const a of accs.rows) {
      msg += `*${a.session_name}* (${a.account_persona})\n`
      msg += `  Cold: ${a.cold_daily_min}–${a.cold_daily_max}/day | Warm: ${a.warm_daily_max}/day\n`
    }
    msg += '\nUse: !createlist [count]'
    await reply(cmdPhone, msg.trim(), session)
  } catch (err) {
    await reply(cmdPhone, `❌ liststats error: ${err.message}`, session)
  }
}

async function handleBuildList(cmdPhone, session, arg1, hotOverride, coldOverride) {
  if (!await isAdminAccount(cmdPhone)) {
    await reply(cmdPhone, '❌ Not authorized', session)
    return
  }

  const isAuto = !arg1 || arg1 === 'auto'
  let targetSessions
  if (isAuto) {
    const r = await db.query("SELECT session_name FROM whatsapp_accounts WHERE is_active = TRUE AND outreach_enabled = TRUE ORDER BY priority, id")
    targetSessions = r.rows.map(row => row.session_name)
  } else {
    targetSessions = [arg1]
  }

  await reply(cmdPhone, `⏳ Building list(s) for: ${targetSessions.join(', ')}. Posting to saved messages…`, session)

  for (const sess of targetSessions) {
    try {
      const { hotList, coldList } = await buildListForAccount(sess, hotOverride, coldOverride)
      const today = new Date().toISOString().split('T')[0]

      let msg = `🎯 *Outreach List ${today}*\n*Account: ${sess}*\n\n`

      if (hotList.length > 0) {
        msg += `*HOT (preferred): ${hotList.length}*\n`
        hotList.forEach((c, i) => {
          const prop = c.last_property_mention ? ` - last: ${String(c.last_property_mention).substring(0, 40)}` : ''
          msg += `${i + 1}. ${c.name || c.phone} [${c.phone}]${prop}\n`
        })
        msg += '\n'
      } else {
        msg += '*HOT (preferred): 0*\n\n'
      }

      if (coldList.length > 0) {
        msg += `*COLD/NEVER: ${coldList.length}*\n`
        coldList.forEach((c, i) => {
          const prop = c.last_property_mention ? ` - last: ${String(c.last_property_mention).substring(0, 40)}` : ''
          msg += `${i + 1}. ${c.name || c.phone} [${c.phone}]${prop}\n`
        })
        msg += '\n'
      } else {
        msg += '*COLD/NEVER: 0*\n\n'
      }

      msg += `*Total: ${hotList.length + coldList.length}*`

      // Post to this session's own saved messages (self-message)
      const rawPhone = await waha.getSessionPhone(sess).catch(() => null)
      const sessPhone = rawPhone ? normalizePhone(rawPhone) : null
      if (sessPhone) {
        // Split at 3500 chars on newline boundaries
        const lines = msg.split('\n')
        const chunks = []
        let current = ''
        for (const line of lines) {
          if (current && (current + '\n' + line).length > 3500) {
            chunks.push(current)
            current = line
          } else {
            current += (current ? '\n' : '') + line
          }
        }
        if (current) chunks.push(current)
        for (const chunk of chunks) {
          await waha.sendText(sess, sessPhone, chunk)
          await new Promise(r => setTimeout(r, 500))
        }
      }

      const summary = `✅ ${sess}: ${hotList.length} HOT + ${coldList.length} COLD = ${hotList.length + coldList.length} total. List posted to ${sess} saved messages.`
      await reply(cmdPhone, summary, session)
    } catch (err) {
      log.error(`!buildlist error for ${sess}`, err)
      await reply(cmdPhone, `❌ ${sess}: ${err.message}`, session)
    }
  }
}

// !wascan / !wascanall handler
const KEV_PHONES_SCAN = ['35699811819', '35699270699', '35699655034']

async function handleWaScan(cmdPhone, sessionArg, session) {
  if (!await isAdminAccount(cmdPhone)) {
    await reply(cmdPhone, '❌ Not authorized', session)
    return
  }

  const target = sessionArg ? `session ${sessionArg}` : 'ALL active sessions'
  await reply(cmdPhone, `⏳ Starting WAHA scan for ${target}. May take 15-60 min. Will report back.`, session)

  ;(async () => {
    try {
      const { syncSession, syncAllSessions, autoPromoteRepliedToHot } = require('./historySync')
      let results
      if (sessionArg) {
        results = [await syncSession(sessionArg)]
      } else {
        results = await syncAllSessions()
      }

      // Final auto-fix: any owner with reply history → 'hot' (never downgrade)
      const promoted = await autoPromoteRepliedToHot().catch(err => {
        log.error('autoPromoteRepliedToHot failed', err)
        return 0
      })
      log.info(`Auto-promoted ${promoted} owners to hot based on reply history`)

      let report = '📊 *WAHA Scan Complete*\n\n'
      for (const r of results) {
        if (r.error) {
          report += `❌ ${r.sessionName}: ${r.error}\n`
        } else {
          report += `✅ ${r.sessionName}\n   Chats: ${r.processed} | Matched: ${r.matched} | Classified: ${r.classified} | Errors: ${r.errors}\n\n`
        }
      }
      report += `\n🔁 Auto-promoted ${promoted} owners to hot (reply history)\n`

      const stats = await require('../db').query(
        'SELECT status, COUNT(*) FROM owner_contacts GROUP BY status ORDER BY status'
      )
      report += '\n*Status Distribution:*\n'
      for (const row of stats.rows) report += `   ${row.status}: ${row.count}\n`

      const perAccount = await require('../db').query(
        'SELECT wa.session_name, COUNT(DISTINCT cah.contact_id) as total_chats, COUNT(DISTINCT cah.contact_id) FILTER (WHERE cah.has_replies = true) as with_replies FROM whatsapp_accounts wa LEFT JOIN contact_account_history cah ON wa.id = cah.account_id WHERE wa.is_active = true GROUP BY wa.id, wa.session_name ORDER BY wa.id'
      )
      report += '\n*Per Account:*\n'
      for (const row of perAccount.rows) {
        report += `   ${row.session_name}: ${row.total_chats} chats, ${row.with_replies} with replies\n`
      }

      await reply(cmdPhone, report, session)
    } catch (err) {
      await reply(cmdPhone, `❌ Scan failed: ${err.message}`, session)
    }
  })()
}

// !createlist handler — sequential pool-cursor walk via buildPoolBatch.
// targetSession defaults to the calling session, but can be any account
// (e.g. "!createlist Argus4 20" from a Kev account).
async function handleCreateList(cmdPhone, session, requestedCount, targetSession) {
  const { buildPoolBatch } = require('./listBuilder')
  const target = targetSession || session
  const safeCount = Math.max(1, Math.min(45, Math.round(Number(requestedCount) || 45)))
  // Validate that the target account actually exists in DB
  const accCheck = await db.query(
    'SELECT 1 FROM whatsapp_accounts WHERE session_name = $1',
    [target]
  )
  if (accCheck.rows.length === 0) {
    const active = await db.query(
      `SELECT session_name FROM whatsapp_accounts
        WHERE is_active = TRUE AND outreach_enabled = TRUE
        ORDER BY priority, id`
    )
    await reply(cmdPhone, `❌ Account "${target}" not found. Active outreach sessions: ${active.rows.map(row => row.session_name).join(', ') || 'none'}.`, session)
    return
  }
  const forLabel = target === session ? target : `*${target}* (built on ${session})`
  await reply(
    cmdPhone,
    `⏳ Building list of ${safeCount} for ${forLabel}…`,
    session
  )
  try {
    const result = await buildPoolBatch(target, safeCount)
    const list = result.list || []

    if (list.length === 0) {
      await reply(
        cmdPhone,
        `⏰ No eligible owners — all in 20-day cooldown for ${target}. ` +
        `Try again in a few hours or use different account.`,
        session
      )
      return
    }

    const header = `📋 ${list.length} owners ready (pool: ${result.pool}, cycle #${(result.cycle_count || 0) + 1})`
    await reply(cmdPhone, header, session)

    await sleep(1000)

    const listLines = list.map(o => {
      const firstName = o.name ? o.name.trim().split(/\s+/)[0] : ''
      return `+${o.phone_normalized}${firstName ? ' ' + firstName : ''}`
    })
    const chunks = []
    let cur = ''
    for (const ln of listLines) {
      if (cur && (cur + '\n' + ln).length > 3500) { chunks.push(cur); cur = ln }
      else cur += (cur ? '\n' : '') + ln
    }
    if (cur) chunks.push(cur)
    for (let i = 0; i < chunks.length; i++) {
      await reply(cmdPhone, chunks[i], session)
      if (i < chunks.length - 1) await sleep(1000)
    }
  } catch (err) {
    log.error('createlist crash', err)
    await reply(cmdPhone, `❌ createlist error: ${err.message}`, session)
  }
}

// !addcold handler — usage: !addcold +10 [AccountName]
async function handleAddCold(cmdPhone, session, text) {
  const parts = text.trim().split(/\s+/)
  const delta = parseInt(parts[1])
  if (isNaN(delta)) {
    await reply(cmdPhone, '❌ Usage: !addcold +10 [AccountName]', session)
    return
  }
  const targetSession = parts[2] || session
  const accRes = await db.query('SELECT * FROM whatsapp_accounts WHERE session_name = $1', [targetSession])
  if (!accRes.rows.length) {
    await reply(cmdPhone, `❌ Account "${targetSession}" not found`, session)
    return
  }
  const acc = accRes.rows[0]
  const newMax = Math.max(0, (acc.cold_daily_max || 30) + delta)
  const newMin = Math.min(acc.cold_daily_min || 30, newMax)
  await db.query(
    'UPDATE whatsapp_accounts SET cold_daily_max = $1, cold_daily_min = $2 WHERE session_name = $3',
    [newMax, newMin, targetSession]
  )
  await reply(cmdPhone, `✅ ${targetSession} cold cap: ${acc.cold_daily_max} → ${newMax}/day`, session)
}

// ── Pool admin commands ──────────────────────────────────────────────
function _ago(ts) {
  if (!ts) return 'never'
  const d = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 86_400_000))
  if (d === 0) return 'today'
  if (d === 1) return '1 day ago'
  return `${d} days ago`
}

async function _poolMembers(pool) {
  const r = await db.query(
    `SELECT session_name FROM whatsapp_accounts WHERE pool = $1 ORDER BY id`,
    [pool]
  )
  return r.rows.map(x => x.session_name)
}

async function handlePoolStatus(cmdPhone, session) {
  try {
    const cursors = await db.query(`SELECT * FROM pool_cursors ORDER BY pool`)
    const owners  = await db.query(
      `SELECT COALESCE(MIN(id), 0) AS min_id, COALESCE(MAX(id), 0) AS max_id, COUNT(*)::int AS n
       FROM owner_contacts`
    )
    const minId = owners.rows[0].min_id || 0
    const maxId = owners.rows[0].max_id || 0
    const total = owners.rows[0].n || 0

    const byPool = Object.fromEntries(cursors.rows.map(r => [r.pool, r]))
    const top    = byPool.top
    const bottom = byPool.bottom
    const topMembers    = (await _poolMembers('top')).join(', ')    || '(none)'
    const bottomMembers = (await _poolMembers('bottom')).join(', ') || '(none)'

    const topCursor    = top ? Number(top.cursor_id) : 0
    const bottomCursor = bottom ? Number(bottom.cursor_id) : (maxId + 1)
    const topProgress    = maxId > 0 ? Math.min(100, Math.round((Math.max(0, topCursor) / maxId) * 100)) : 0
    const bottomDone     = Math.max(0, (maxId + 1) - bottomCursor)
    const bottomProgress = maxId > 0 ? Math.min(100, Math.round((bottomDone / maxId) * 100)) : 0

    // Gap = how many ids fall strictly between the two cursors (untouched in middle)
    const gapRes = await db.query(
      `SELECT COUNT(*)::int AS n FROM owner_contacts
       WHERE id > $1 AND id < $2 AND COALESCE(do_not_contact, FALSE) = FALSE`,
      [topCursor, bottomCursor]
    )
    const gap = gapRes.rows[0].n || 0

    const lines = [
      '📊 Pool Status',
      '',
      `🔼 TOP (${topMembers})`,
      `Cursor: id ${topCursor} / max ${maxId}`,
      `Cycle: #${(top?.cycle_count || 0) + 1} (started ${_ago(top?.cycle_started_at)})`,
      `Progress: ${topProgress}% through current cycle`,
      '',
      `🔽 BOTTOM (${bottomMembers})`,
      `Cursor: id ${bottomCursor} / min ${minId}`,
      `Cycle: #${(bottom?.cycle_count || 0) + 1} (started ${_ago(bottom?.cycle_started_at)})`,
      `Progress: ${bottomProgress}% through current cycle`,
      '',
      `Gap between cursors: ${gap} owners untouched in middle`,
      `Total owners in pool: ${total}`,
    ]
    await reply(cmdPhone, lines.join('\n'), session)
  } catch (err) {
    log.error('!poolstatus crash', err)
    await reply(cmdPhone, `❌ poolstatus error: ${err.message}`, session)
  }
}

async function handleResetCursor(cmdPhone, session, text) {
  const parts = (text || '').trim().split(/\s+/).slice(1)
  const pool = (parts[0] || '').toLowerCase()
  if (!['top', 'bottom'].includes(pool)) {
    await reply(cmdPhone, '❌ Usage: *!resetcursor top* or *!resetcursor bottom*', session)
    return
  }
  _setPoolConfirm(cmdPhone, { action: 'reset', pool })
  await reply(cmdPhone, `⚠️ Reset *${pool}* cursor to start? Reply *YES* within 30s to confirm.`, session)
}

async function handleSetCursor(cmdPhone, session, text) {
  const parts = (text || '').trim().split(/\s+/).slice(1)
  const pool = (parts[0] || '').toLowerCase()
  const id   = parseInt(parts[1])
  if (!['top', 'bottom'].includes(pool) || !Number.isFinite(id) || id < 0) {
    await reply(cmdPhone, '❌ Usage: *!setcursor top 500* or *!setcursor bottom 3000*', session)
    return
  }
  _setPoolConfirm(cmdPhone, { action: 'set', pool, cursorTo: id })
  await reply(cmdPhone, `⚠️ Set *${pool}* cursor to *${id}*? Reply *YES* within 30s to confirm.`, session)
}

async function applyPoolConfirm(adminPhone, session, entry) {
  try {
    if (entry.action === 'reset') {
      if (entry.pool === 'top') {
        await db.query(
          `UPDATE pool_cursors
             SET cursor_id = 0,
                 cycle_count = cycle_count + 1,
                 cycle_started_at = NOW(),
                 updated_at = NOW()
           WHERE pool = 'top'`
        )
      } else {
        const m = await db.query('SELECT COALESCE(MAX(id), 0) + 1 AS m FROM owner_contacts')
        await db.query(
          `UPDATE pool_cursors
             SET cursor_id = $1,
                 cycle_count = cycle_count + 1,
                 cycle_started_at = NOW(),
                 updated_at = NOW()
           WHERE pool = 'bottom'`,
          [m.rows[0].m]
        )
      }
      await reply(adminPhone, `✅ ${entry.pool} cursor reset. Next list will start from beginning.`, session)
      return
    }
    if (entry.action === 'set') {
      await db.query(
        `UPDATE pool_cursors SET cursor_id = $1, updated_at = NOW() WHERE pool = $2`,
        [entry.cursorTo, entry.pool]
      )
      await reply(adminPhone, `✅ ${entry.pool} cursor set to ${entry.cursorTo}. Next list will start from there.`, session)
      return
    }
  } catch (err) {
    log.error('pool confirm apply crash', err)
    await reply(adminPhone, `❌ pool apply error: ${err.message}`, session)
  }
}

async function handlePoolCounts(cmdPhone, session) {
  try {
    // Approximate: count owners not DNC + with no recent label OR last_outreach_at > 20d
    // For TOP forward: id > top.cursor_id. For BOTTOM backward: id < bottom.cursor_id.
    const c = await db.query(
      `SELECT pool, cursor_id FROM pool_cursors WHERE pool IN ('top','bottom')`
    )
    const cur = Object.fromEntries(c.rows.map(r => [r.pool, Number(r.cursor_id)]))
    const m = await db.query('SELECT COALESCE(MAX(id),0)+1 AS m FROM owner_contacts')
    const topCursor    = cur.top ?? 0
    const bottomCursor = cur.bottom ?? m.rows[0].m

    // "Available" = id ahead of cursor, not DNC, no label within 20d for ANY account.
    const topR = await db.query(`
      SELECT COUNT(*)::int AS n FROM owner_contacts oc
      WHERE oc.id > $1
        AND COALESCE(oc.do_not_contact, FALSE) = FALSE
        AND NOT EXISTS (SELECT 1 FROM owner_account_labels oal
                        WHERE oal.contact_id = oc.id AND oal.label = 'dnc')
        AND NOT EXISTS (SELECT 1 FROM owner_account_labels oal
                        WHERE oal.contact_id = oc.id
                          AND oal.last_outreach_at > NOW() - INTERVAL '20 days')
    `, [topCursor])
    const botR = await db.query(`
      SELECT COUNT(*)::int AS n FROM owner_contacts oc
      WHERE oc.id < $1
        AND COALESCE(oc.do_not_contact, FALSE) = FALSE
        AND NOT EXISTS (SELECT 1 FROM owner_account_labels oal
                        WHERE oal.contact_id = oc.id AND oal.label = 'dnc')
        AND NOT EXISTS (SELECT 1 FROM owner_account_labels oal
                        WHERE oal.contact_id = oc.id
                          AND oal.last_outreach_at > NOW() - INTERVAL '20 days')
    `, [bottomCursor])

    const lines = [
      'Available now (not in cooldown for anyone):',
      `TOP forward: ~${topR.rows[0].n} owners`,
      `BOTTOM backward: ~${botR.rows[0].n} owners`,
    ]
    await reply(cmdPhone, lines.join('\n'), session)
  } catch (err) {
    log.error('!poolcounts crash', err)
    await reply(cmdPhone, `❌ poolcounts error: ${err.message}`, session)
  }
}

module.exports = {
  handleAdminMessage, isAdmin, isBot, normalizePhone, parseContacts, sendManualBatch, classifyContacts,
  _runningBatchesForTest: listRunningBatches,
  // FB-Owner-Save-Tool (Kev, 2026-09-08): first contact for a phone that
  // tool surfaces goes through this SAME manual-outreach wizard, not a
  // second contact mechanism — see services/fbOwnerSave.js's own header.
  cmdOutreach,
  runDirectOutreach, enqueueDirectOutreach,
  // FB Direct From Owner Convert & TODO (v2): registers each auto-contacted
  // lead in the SAME owners identity table sendManualBatch already writes
  // to, instead of a second, disconnected contact record.
  getOrCreateOwnerForContact,
  // Kev, 2026-09-09: services/outreachRecovery.js's boot-time recovery calls
  // this directly to auto-resume an interrupted batch (the exact same call
  // !RESUMEOUTREACH already makes by hand) instead of only alerting Kev and
  // waiting on him to type the command.
  runDirectOutreach,
  // ARGUS / NEON outreach planner (Kev, 2026-09-11): reuses the exact same
  // phone+name paste-line parser and {name}/[name]/{phone} template
  // substitution manual !outreach already uses, rather than a second,
  // drifting copy for the planner's paste box / message preview.
  parseOwnerLine,
  applyTemplate,
}
