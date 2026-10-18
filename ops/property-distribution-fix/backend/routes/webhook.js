const { Router } = require('express')
const crypto = require('crypto')
const Redis  = require('ioredis')
const router = Router()
const log    = require('../logger')
const db     = require('../db')
const config = require('../config')
const { addJob }              = require('../queues')
const { isRentedMessage }     = require('../services/rented')
const { handleAdminMessage, isBot } = require('../services/adminCommands')
const { getMonitoredCycleId, classifyOwnerReply, stopMonitoring } = require('../services/replyMonitor')
const { markHot } = require('../services/chatwootService')
const { outreachStatusUpdate } = require('../services/googleSheets')
const { handleAutoAdvertise }     = require('../services/autoAdvertise')
const labelEngine             = require('../services/labelEngine')
const { resetNoReplyForPhone } = require('../services/outreachTracker')
const waha                    = require('../waha')
const uploadListing           = require('../handlers/uploadListing')
const uploadHandler           = require('../handlers/upload')
const gptUploadCommand        = require('../services/gptUploadCommand')
const availability            = require('../services/availability')
const fbGroupCommands         = require('../services/fbGroupCommands')
const fbOwnerSave             = require('../services/fbOwnerSave')
const reminderFromMessage     = require('../services/reminderFromMessage')
const { processReaction, processReply } = require('../services/rentedDetector')
const { isRentedReplyText }       = require('../services/rentedPlan')
const { quotedFromPayload }       = require('../lib/quotedMessage')
const { isAdminAccount }      = require('../services/auth')
const { realSenderJid, phoneFromJid, rawDigits } = require('../services/senderIdentity')
const newGroupAlerter         = require('../services/newGroupAlerter')
const sessionRouter           = require('../lib/sessionRouter')

// Kev 2026-08-22: more WAHA event types were enabled per-session (message.ack,
// message.waiting, message.edited, message.revoked, group.v2.join,
// event.response, call.accepted/rejected/received, ...). None of these are
// acted on (yet) — this just keeps them from being silently invisible: each
// unrecognized event type is logged once, not once per message, so enabling
// a chatty type doesn't spam the log forever.
const _loggedUnknownEvents = new Set()

// Kev's own account IS session `default`, so when he answers a !av/!book
// Yes/No prompt in a group from his phone, WAHA reports it fromMe=true —
// same as any other self-typed text. The two fromMe-group gates below used
// to require a leading '!' to let a self-sent group message through, which
// silently dropped these plain replies before they ever reached the
// pending-confirm matchers in handlers/av.js / handlers/book.js (no log line
// at all — see [av] confirm-matcher saw message for the fix on that side).
const CONFIRM_REPLY_RE = /^(yes|y|no|n|cancel|ja)$/i

// Redis client for message deduplication (TTL 10 min)
const redisDedup = new Redis({
  host:     config.redis.host,
  port:     config.redis.port,
  password: config.redis.password || undefined,
  maxRetriesPerRequest: 1,
  enableOfflineQueue:   true,
  lazyConnect:          false,
  // Hang-prevention: when Redis is briefly unreachable, ioredis with
  // enableOfflineQueue=true queues commands indefinitely (maxRetriesPerRequest=1
  // only kicks in after one try). That unbounded queue was the cause of
  // 30+ second webhook hangs. Now: 5s connect timeout, and a hung command
  // fails fast so the handler proceeds (and the message is NOT processed
  // — safer to drop than to hang forever).
  connectTimeout: 5000,
  commandTimeout: 5000,
  retryStrategy: (times) => Math.min(times * 100, 3000),  // 100ms, 200ms, 300ms cap
})
redisDedup.on('error', (err) => log.warn('Redis dedup error', err.message))

// Inbound catch-up after a session comes back (see the session.status branch).
// Waits 60 s first: WAHA itself redelivers part of the backlog on reconnect,
// and those live deliveries must land (and move last_owner_message_at) before
// the recovery decides what was missed.
const _lastCatchUp = new Map()
const CATCH_UP_EVERY_MS = 10 * 60 * 1000
function catchUpAfterReconnect(sessionName) {
  const now = Date.now()
  if (now - (_lastCatchUp.get(sessionName) || 0) < CATCH_UP_EVERY_MS) return false
  _lastCatchUp.set(sessionName, now)
  setTimeout(() => {
    require('../services/historySync').recoverActiveOwnerConversations()
      .then(r => log.info('Reconnect inbound catch-up done', { session: sessionName, ...r }))
      .catch(err => log.warn('Reconnect inbound catch-up failed', { session: sessionName, err: err.message }))
  }, 60_000).unref?.()
  return true
}
router._catchUpAfterReconnect = catchUpAfterReconnect   // test access

// Cache group configs briefly to avoid a DB hit per message
const groupConfigCache = new Map()
const CACHE_TTL_MS = 60_000

async function getGroupConfig(groupId) {
  const cached = groupConfigCache.get(groupId)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  const r = await db.query(
    'SELECT * FROM group_config WHERE group_id = $1 AND is_active = TRUE',
    [groupId]
  )
  const data = r.rows[0] || null
  groupConfigCache.set(groupId, { data, ts: Date.now() })
  return data
}

// WAHA webhook — no auth needed (Docker-internal traffic only)
router.post('/waha', async (req, res) => {
  // Acknowledge immediately so WAHA doesn't retry
  res.status(200).json({ ok: true })

  const { event, session, payload } = req.body || {}

  if (!payload) return

  // ── Early group-config lookup (used by AutoAdvertise self-message bypass) ──
  const _earlyGroupId = (payload.from || '').includes('@g.us') ? payload.from : null
  let _earlyGroupCfg = null
  if (_earlyGroupId) {
    try { _earlyGroupCfg = await getGroupConfig(_earlyGroupId) } catch {}
  }
  const isAutoAdvGroup = _earlyGroupCfg?.group_type === 'autoadvertise'

  // FB Direct From Owner Convert & TODO (Kev, 2026-09-08): Kev personally
  // operates this session's own WhatsApp account, so anything a human types
  // directly into the registered destination group — himself included —
  // arrives as a fromMe `message.any` event, the exact same GOWS quirk this
  // file's own comments already describe for !o/!=. Without this flag, a
  // plain link/photo/text with no leading "!" never reaches
  // services/fbOwnerSave.js's handler further down; it gets silently
  // dropped by the fromMe/notes-chat guard a few lines below, the same way
  // !o once was. Kev's own instruction: "this chat should simply always be
  // scanned whenever HUMANS send something into it" — scoped to the ONE
  // registered group (isTodoGroupChat), never any other chat.
  const _isFbTodoGroupMsg = await fbOwnerSave.isTodoGroupChat(payload.from).catch(() => false)

  // !uploadlisting must work from Notes-to-self / fromMe even when the trigger
  // word isn't at the start of the body — let it past the fromMe guards below.
  // (Bot's own "✅ Listing #" reply never contains !uploadlisting, so it's safe.)
  const _isUploadListing = /!uploadlisting/i.test(payload.body || '')

  // !ca stops the Auto-Owner-Conversation automation for ONE chat only. It is
  // typed directly into the owner's DM thread (Kev takes the chat over
  // manually), so — unlike every other admin command — it must be let past
  // the fromMe/notes-chat guards below even though from!==self.
  //
  // 2026-09-21: `!c` (the relay's "leave it" command) is the same kind of
  // control token and had the same problem — typed by Kev into an owner's DM
  // (fromMe) it was dropped by the guards below, so it neither cancelled anything
  // nor stayed private: it went out as a visible "!c" message in the owner's chat
  // (Pierre, 2026-09-18 16:10). Agent/control commands are now parsed BEFORE the
  // fromMe / sender filtering, consumed locally, and answered with nothing.
  const _isCancelChatAutomation = payload.fromMe === true
    && !(payload.from || '').includes('@g.us')
    && /^(?:!ca?|!s)$/i.test((payload.body || '').trim())
  const _isBareCancel = _isCancelChatAutomation && /^!c$/i.test((payload.body || '').trim())
  const _isPermanentOwnerStop = _isCancelChatAutomation && /^!s$/i.test((payload.body || '').trim())

  // Client Assistant / CLIENTGROUPS (2026-09-03, Prompt 1 + CG-1) —
  // activation toggle. Typed directly into a client chat (DM OR group —
  // clients sometimes come as a couple/group, unlike the owner-only !ca
  // above) by one of our own accounts, so — same reasoning as
  // _isCancelChatAutomation — it must be let past the fromMe/notes-chat
  // guards below even though from!==self. Token is configurable (services/
  // clientAssistant.js TOGGLE_TOKEN), never hardcoded to a literal string
  // here. CG-1: the token is embeddable ANYWHERE in the message (no fixed
  // position/whitespace needed, whole-message-only `^...$` match removed),
  // and authorization stays fromMe + not-our-own-bounced-message (same
  // primitive _isHumanOwnerMessage below already uses) so a client can never
  // trigger this by typing the token themselves.
  //
  // Two SEPARATE parser contexts, never conflated (Kev's explicit CG-1
  // requirement): a bare token anywhere in a normal client chat toggles
  // THAT chat; the SAME token followed by a client short code (`!= C184`),
  // typed specifically in the WA ASSISTANCE AND CO KG control channel,
  // remote-toggles a DIFFERENT chat by id instead — resolved and dispatched
  // further down, never inside this synchronous detection block.
  //
  // MUST be computed before _isHumanOwnerMessage below: unlike the old
  // whole-message '!assist' command (which always started with '!', so it
  // never overlapped with _isHumanOwnerMessage's "plain text, no leading
  // '!'" check), an embedded `!=` can sit inside an ordinary sentence --
  // "I'll keep an eye out for you!=" does NOT start with '!'. Without this
  // ordering + exclusion, that message would be swallowed by the owner-
  // automation override below (a real incident hit in CG-1's own live
  // proof: the toggle silently never fired because _isHumanOwnerMessage's
  // early `return` ran first).
  const _clientAssistant = require('../services/clientAssistant')
  const _isInControlChannel = payload.fromMe === true
    && await _clientAssistant.isControlChannel(payload.from || '')
  const _controlToggleMatch = _isInControlChannel
    ? _clientAssistant.parseControlToggle(payload.body || '')
    : null
  const _isClientAssistantRemoteToggle = !!_controlToggleMatch && !waha.wasSentByBackend(payload.id)
  const _isClientAssistantToggle = payload.fromMe === true
    && !_isInControlChannel
    && _clientAssistant.isToggleTrigger(payload.body || '')
    && !waha.wasSentByBackend(payload.id)

  // CLIENTGROUPS bugfix (2026-09-03), Teil B — `!cadd C<id> <description>`,
  // control-channel-only, explicit alternative to the reply-correlation
  // path below (robust against timing/threading, per Kev's spec).
  const CADD_RE = /^!cadd\s+[Cc](\d+)\s+([\s\S]+)$/i
  const _caddMatch = _isInControlChannel ? CADD_RE.exec((payload.body || '').trim()) : null
  const _isClientAssistantCadd = payload.fromMe === true
    && !!_caddMatch
    && !waha.wasSentByBackend(payload.id)

  // CLIENTGROUPS bugfix, Teil A — the IMPLICIT path the activation notice
  // has always promised ("reply with a title/description to configure")
  // but nothing ever read back. A quoted/replied message in the control
  // channel that is NOT itself a toggle or !cadd command is a configure-
  // reply CANDIDATE; the actual correlation (does this quoted id match a
  // stored control_message_id) happens inside handleControlReply itself —
  // a false candidate here is a harmless no-op there, never a wrong send.
  const _quotedId = quotedFromPayload(payload).id
  const _isSelfRentedGroupReply = payload.fromMe === true
    && (payload.from || '').includes('@g.us')
    && !!_quotedId
    && isRentedReplyText(payload.body || '')
    && !waha.wasSentByBackend(payload.id)
  const _isClientAssistantControlReply = payload.fromMe === true
    && _isInControlChannel
    && !!_quotedId
    && !_controlToggleMatch
    && !_caddMatch
    && !waha.wasSentByBackend(payload.id)

  // OWNERGROUPS (Kev, 2026-09-04, OG-1) — `!o` activation toggle, typed
  // directly into an owner's own DM (owner chats are always 1:1, unlike
  // client chats which can be a group — see services/ownerAssistant.js's
  // own header). MUST be computed here, before _isHumanOwnerMessage below,
  // for the exact same reason CLIENTGROUPS' `!=` toggle is: an embedded
  // `!o` at the end of an ordinary sentence does not start with '!', so
  // without this exclusion _isHumanOwnerMessage's own early `return` would
  // swallow it before it ever reached the toggle handler further down
  // (CG-1 hit this exact bug once already — see that block's own comment).
  const _ownerAssistant = require('../services/ownerAssistant')
  const _isOwnerAssistantToggle = payload.fromMe === true
    && !(payload.from || '').includes('@g.us')
    && _ownerAssistant.isToggleTrigger(payload.body || '')
    && !waha.wasSentByBackend(payload.id)

  // Kev, 2026-08-31: Auto-Owner-Conversation human override (services/
  // autoOwnerConversation.js Point B). Kevin (or any admin account) typing
  // a normal reply directly into an owner's DM thread — NOT the explicit
  // !ca command above — must also pause the automation for that one chat.
  // Before this it was silently dropped by the fromMe/notes-chat guards
  // below with zero effect, so the bot kept auto-asking right past
  // whatever a human had already explained by hand. waha.wasSentByBackend()
  // is what tells a genuine self-typed reply apart from the bot's OWN
  // message bouncing back through this same webhook — both look identical
  // otherwise (fromMe=true, event=message.any, same chat). Only plain text
  // (no leading '!') so it never doubles up with _isCancelChatAutomation or
  // any other admin command. CG-1: also excludes an embedded `!=` toggle --
  // see the ordering note above this block.
  const _isHumanOwnerMessage = payload.fromMe === true
    && !(payload.from || '').includes('@g.us')
    && !/^!/.test((payload.body || '').trim())
    && !_isClientAssistantToggle
    && !_isClientAssistantRemoteToggle
    && !_isClientAssistantCadd
    && !_isClientAssistantControlReply
    && !_isOwnerAssistantToggle
    && !waha.wasSentByBackend(payload.id)

  // Client Assistant human-priority detection — same primitive as
  // _isHumanOwnerMessage (waha.wasSentByBackend tells a genuine human-typed
  // message apart from the bot's own message bouncing back), but NOT
  // restricted to non-group, since a client chat can be a group. Safe to
  // evaluate broadly: clientAssistant.handleHumanMessage() no-ops instantly
  // (one indexed lookup) unless this exact chat has an ENABLED row.
  const _isClientAssistantHumanMessage = payload.fromMe === true
    && !_isClientAssistantToggle
    && !_isClientAssistantRemoteToggle
    && !_isClientAssistantCadd
    && !_isClientAssistantControlReply
    && !/^!/.test((payload.body || '').trim())
    && !waha.wasSentByBackend(payload.id)

  log.debug('Webhook event', { event, session, from: req.body?.payload?.from, to: req.body?.payload?.to, fromMe: req.body?.payload?.fromMe, body: (req.body?.payload?.body||'').slice(0,40) })

  if (!config.system.active) {
    log.debug('System inactive, ignoring webhook')
    return
  }

  try {
    // ── Session status events ──────────────────────────────────────
    if (event === 'session.status') {
      const { name, status } = payload
      log.info('Session status', { session: name || session, status })
      // Kev 2026-08-22: push into the live-state cache immediately instead of
      // waiting for the next 2-min poll (waha.ensureAllSessionsWorking) — see
      // lib/sessionRouter.js. The poller stays as the fallback for a session
      // that hasn't fired an event recently (or at all, e.g. cold start).
      sessionRouter.updateState(name || session, status)
      if (status === 'WORKING' || status === 'CONNECTED') {
        // Reconnect is the wake-up signal for every persisted outbound queue.
        // Each service keeps its own idempotency/pre-send checks.
        require('../services/availability').flushQueuedChecks()
          .catch(err => log.warn('Reconnect availability flush failed', { err: err.message }))
        require('../services/outreachPlanner').reconcileOverdueArmedPlans()
          .catch(err => log.warn('Reconnect outreach-plan reconcile failed', { err: err.message }))
        sessionRouter.flushQueue()
          .catch(err => log.warn('Reconnect file-queue flush failed', { err: err.message }))
        sessionRouter.flushWaitingDeliveries()
          .catch(err => log.warn('Reconnect delivery-queue flush failed', { err: err.message }))
        // 2026-10-18: the reconnect flushed every OUTBOUND queue but nothing
        // read what owners sent while the account was down -- that waited for
        // the 04:00/07:15/22:00 cron. Same recovery the cron runs (only owner
        // messages newer than last_owner_message_at are replayed, so a
        // message already handled live is never answered twice), now also on
        // reconnect, at most once per session per 10 min (QR loops flap).
        catchUpAfterReconnect(name || session)
      }
      return
    }

    // ── New group detection ('group.join' / 'chat.created') ───────
    // When the bot is added to a fresh WhatsApp group, fire a one-shot
    // alert to Kev's admin DM (and Telegram if configured). Deduplicated
    // against category_groups + facebook_groups with a 30s debounce.
    // Fire-and-forget; errors are swallowed within the alerter.
    if (event === 'group.join' || event === 'chat.created') {
      newGroupAlerter.handleNewGroupEvent(event, payload).catch(err =>
        log.warn('newGroupAlerter failed', { err: err.message, event })
      )
      return
    }

    // ── Incoming reaction to a stored category-group listing ────────────────
    if (event === 'message.reaction') {
      const reaction = payload.reaction || {}
      const chatId = payload.from || ''
      if (!reaction.text || !reaction.messageId || !chatId.includes('@g.us')) return
      // Every logged-in session receives the same group event. Mirror the
      // normal-message ownership rule so only the primary session may mutate.
      const primaryReactionSession = await waha.getGroupReactionSession()
      if (!primaryReactionSession || String(session).toLowerCase() !== String(primaryReactionSession).toLowerCase()) return

      // Reuse the same LID-safe identity path as normal group messages. For
      // reactions, payload.reaction.messageId is the target listing message;
      // payload.id identifies the reaction event itself and must not be used.
      const senderJid = realSenderJid(payload, true)
      const senderPhone = phoneFromJid(senderJid) || rawDigits(senderJid) || null
      if (!senderPhone) return

      try {
        return await processReaction({
          senderPhone,
          messageId: reaction.messageId,
          reactionEmoji: reaction.text,
          session,
          chatId,
        })
      } catch (err) {
        log.error('message.reaction handler error', { err: err.message })
        return
      }
    }

    // ── Inbound WhatsApp call (GOLDEN-SCRIPT Fall 3, Kev, 2026-09-06) ───────
    // Routes a genuine inbound call to autoOwnerConversation's Fall-3
    // handler (own scope gate: only fires if this phone has an open
    // outreach/conversation). See services/autoOwnerConversation.js's own
    // header comment on handleOwnerCallEvent for why this is NOT confirmed
    // to actually fire yet -- waha.js's session `events` array does not
    // currently request 'call.received' (deliberately left unchanged here,
    // touching a live WAHA session's event subscription is its own,
    // separate, riskier change). Harmless no-op today if the event never
    // arrives; ready the day it's turned on.
    if (event === 'call.received' || event === 'call.accepted') {
      const senderJid = realSenderJid(payload, false)
      const senderPhone = phoneFromJid(senderJid) || rawDigits(senderJid) || null
      if (senderPhone) {
        require('../services/autoOwnerConversation').handleOwnerCallEvent({ phone: senderPhone, session })
          .catch(err => log.warn('autoOwnerConversation.handleOwnerCallEvent failed', { err: err.message }))
      }
      return
    }

    // ── Inactivity clock (2026-09-22) ────────────────────────────────────
    // Any 1:1 message between us and an owner — the owner writing to us, or Kevin /
    // an agent typing by hand into the chat — restarts the 7-9 day silence timer
    // that gates the automatic availability check (services/contactTouch.js).
    // Software-sent messages are recorded where they are sent (waha.sendText /
    // availability.sendTextAs), so echoes of them are skipped here. Groups, LIDs
    // without a phone and non-owners are no-ops. Fire-and-forget: this can never
    // delay or drop a message.
    if ((event === 'message' || event === 'message.any' || event === 'message.edited') && !String(payload.from || '').includes('@g.us') && !String(payload.to || '').includes('@g.us')) {
      try {
        const _ct = require('../services/contactTouch')
        if (payload.fromMe === true) {
          if (!waha.wasSentByBackend(payload.id)) {
            _ct.recordOutbound(payload.to || '', session).catch(() => {})
            if (payload.from && payload.from !== payload.to) _ct.recordOutbound(payload.from, session).catch(() => {})
          }
        } else {
          // the real phone when the payload carries one; otherwise the chat id, and a
          // @lid is resolved through WAHA (contactTouch.resolvePhone — cached)
          const _real = realSenderJid(payload, false)
          const _p = _ct.phoneOfChat(_real || '')
          if (_p) _ct.recordInbound(_p).catch(() => {})
          else _ct.recordInbound(payload.from || '', session).catch(() => {})
        }
      } catch (_e) { /* never blocks message handling */ }
    }

    // ── Event filter ──────────────────────────────────────────────
    // Accept `message` (incoming from others) and `message.any` ONLY when it is a
    // self-message (notes chat: fromMe + from===to + not a group JID).
    // All other message.any events are outgoing bot messages — skip to prevent loops.
    // For message.any: only allow notes-chat self-messages through.
    // NOWEB never sets payload.to, so we identify self-messages by comparing
    // payload.from against the session's own phone/LID (fetched live on cache-miss).
    if (event !== 'message' && event !== 'message.edited') {
      if (event !== 'message.any') {
        if (!_loggedUnknownEvents.has(event)) {
          _loggedUnknownEvents.add(event)
          log.debug('Webhook: unhandled event type, ignoring', { event })
        }
        return
      }
      const fromStripped = (payload.from || '').replace(/@.*/, '')
      const identity = await waha.getOrFetchSessionIdentity(session)
      // Allow through if fromMe=true + non-group, even if identity is null (session cold start).
      // fromMe=true in a non-group context can only be a self-message (notes chat).
      const isNotesSelf = payload.fromMe === true
        && payload.from
        && !payload.from.includes('@g.us')
        && (!identity || fromStripped === identity.phone || (identity.lid && fromStripped === identity.lid))
      // Allow admin !commands sent from the session's own account inside a group
      const isGroupSelfCmd = payload.fromMe === true
        && (payload.from || '').includes('@g.us')
        && !waha.wasSentByBackend(payload.id)
        && (/^!/i.test((payload.body || '').trim()) || CONFIRM_REPLY_RE.test((payload.body || '').trim()))
      // OWNERGROUPS (OG-1) bugfix (2026-09-04, found live): `!o` — like
      // `!=` right next to it here — is a self-typed (fromMe) command that
      // GOWS delivers as `message.any`, not `message`. Missing from this
      // allowlist meant every `!o` (and the human-priority/inbound-update
      // hooks that live further down this function, all unreachable once
      // this `return` fires first) was silently dropped for every session
      // whose engine only ever sends message.any — i.e. all of them, per
      // live testing. Same class of bug as CG-1's own self-echo incident
      // this file's other comments already describe; this is the second
      // instance of it, not the first.
      if (!isNotesSelf && !isGroupSelfCmd && !_isSelfRentedGroupReply && !isAutoAdvGroup && !_isUploadListing && !_isCancelChatAutomation && !_isHumanOwnerMessage && !_isClientAssistantToggle && !_isClientAssistantRemoteToggle && !_isClientAssistantCadd && !_isClientAssistantControlReply && !_isClientAssistantHumanMessage && !_isOwnerAssistantToggle && !_isFbTodoGroupMsg) return
    }

    // Notes chat: an account messaging itself — admin typing commands in their own WA notes.
    // Works for ALL sessions: default (35699811819) and any additional session (Kevsecond etc.)
    const botNum     = config.admin.botNumber
    const toJid      = payload.to || ''
    // NOWEB uses @s.whatsapp.net; WEBJS uses @c.us — strip suffix for comparison
    const stripJid   = j => String(j || '').replace(/@(?:c\.us|s\.whatsapp\.net|lid)$/i, '')
    // Reuse already-fetched identity (or fetch if only message event reached here)
    const sessionIdentity = await waha.getOrFetchSessionIdentity(session)
    const fromRaw = (payload.from || '').replace(/@.*/, '')
    const isNotesChat = payload.fromMe === true
      && !toJid.includes('@g.us')
      && (
        stripJid(toJid) === stripJid(botNum) ||   // WEBJS default: to=BOT_NUMBER
        (toJid && toJid === payload.from) ||       // WEBJS other: from===to
        (!toJid && sessionIdentity && (            // NOWEB: no to, from=own phone/LID
          fromRaw === sessionIdentity.phone ||
          (sessionIdentity.lid && fromRaw === sessionIdentity.lid)
        ))
      )

    // OWNERGROUPS (OG-1) bugfix, THIRD spot (2026-09-04, found live via a
    // direct HTTP replay against this route — no error, no log, just a
    // silent `return` here): a bare `!o` DM to a non-group chat matched
    // every flag in this catch-all's condition (none of the earlier
    // recognized-command gates claimed it), so it fell into this
    // "unrecognized fromMe chatter" bucket and got dropped at the `return`
    // below before ever reaching the actual toggle handling block further
    // down. `!=` was already safe here for the same reason it was safe at
    // the OTHER two spots -- it's one of the flags already excluded.
    if (payload.fromMe && !isNotesChat && !_isSelfRentedGroupReply && !isAutoAdvGroup && !_isUploadListing && !_isCancelChatAutomation && !_isHumanOwnerMessage && !_isClientAssistantToggle && !_isClientAssistantRemoteToggle && !_isClientAssistantCadd && !_isClientAssistantControlReply && !_isClientAssistantHumanMessage && !_isOwnerAssistantToggle) {
      // Allow admin !commands (and Yes/No/Ja confirm replies) sent from this
      // session inside a group
      const body = (payload.body || '').trim()
      if (!(payload.from || '').includes('@g.us') || !(/^!/i.test(body) || CONFIRM_REPLY_RE.test(body))) return
    }

    if (_isCancelChatAutomation) {
      try {
        let ownerPhone = phoneFromJid(payload.from) || rawDigits(payload.from)
        const ownerSendGate = require('../services/ownerSendGate')
        if (ownerPhone && ownerPhone.length > 13) {
          ownerPhone = (await ownerSendGate.resolveChatPhone(session, payload.from)) || ownerPhone
        }

        if (_isPermanentOwnerStop) {
          const stopped = await ownerSendGate.permanentlyStopOwnerFlow({
            phone: ownerPhone, chatId: payload.from, session,
            reason: '!s permanent owner-flow stop',
          })
          if (!isNotesChat && payload.id) {
            await waha.deleteMessage(session, payload.from, payload.id)
              .catch(e => log.debug('!s: could not delete the typed command', { err: e.message }))
          }
          const notifyNum = config.admin.botNumber
          if (notifyNum) {
            await waha.sendText(session, notifyNum,
              `🛑 Permanent owner-flow stop set for +${ownerPhone}. Conversational AI and reminders are off; explicit agent action buttons remain available.`)
          }
          log.info('!s consumed locally — owner conversational automation permanently disabled', {
            chat: String(payload.from).slice(-8), ...stopped,
          })
          return
        }

        // ONE implementation of "stop everything for this chat", shared with the
        // frustration stand-down (services/ownerSendGate.js:stopAllAutomationForChat).
        // It is the old body of this block, moved verbatim: autoOwnerConversation
        // (cancelChatAutomation), 'awaiting' availability_checks (Kev, 2026-08-31,
        // Elaine Pughe -- !ca must mean "stop bothering this person", not "stop the
        // one system I built") and OWNERGROUPS owner_assistant_state (Kev,
        // 2026-09-07). `!c` additionally closes book_relay threads and drops the
        // queued owner messages (2026-09-21).
        const stopped = await ownerSendGate.stopAllAutomationForChat({
          phone: ownerPhone, chatId: payload.from, session,
          reason: _isBareCancel ? '!c' : '!ca', closeRelays: _isBareCancel,
        })
        const found = stopped.autoConvo
        const avCancelled = stopped.avCancelled
        const ogaDisabled = stopped.ogaDisabled

        if (_isBareCancel) {
          // `!c` = cancel the current flow, consume it locally, SEND NOTHING —
          // no notice to Kev, and above all nothing into the owner's chat. The
          // "!c" Kev just typed is itself already visible to the owner, so take it
          // back (best effort; WhatsApp allows delete-for-everyone for ~2 days).
          if (!isNotesChat && payload.id) {
            await waha.deleteMessage(session, payload.from, payload.id)
              .catch(e => log.debug('!c: could not delete the typed !c', { err: e.message }))
          }
          log.info('!c consumed locally — flow cancelled, nothing sent', {
            chat: String(payload.from).slice(-8), ...stopped,
          })
          return
        }

        const notifyNum = config.admin.botNumber
        if (notifyNum) {
          const lines = []
          lines.push(found
            ? `🛑 Outreach automation stopped for chat +${ownerPhone}.`
            : `ℹ️ No active outreach automation was running for +${ownerPhone || String(payload.from).slice(0, 15)}.`)
          if (avCancelled) lines.push(`🛑 ${avCancelled} pending availability check(s) also cancelled — no more automated replies in this chat.`)
          if (ogaDisabled) lines.push(`🛑 OWNERGROUPS check-in loop also disabled for this chat.`)
          if (found || avCancelled || ogaDisabled) lines.push(`Take it from here — the owner won't notice.`)
          await waha.sendText(session, notifyNum, lines.join(' '))
        }
      } catch (e) {
        log.warn('!ca handler failed', { err: e.message })
      }
      return
    }

    // isNotesChat exclusion: without it, Kevin's own notes-to-self messages
    // (also fromMe=true, non-group, no leading '!') would be intercepted
    // here instead of falling through to the normal admin-command pipeline
    // further down — isNotesSelf/isNotesChat already let those two gates
    // above pass on their own merits, so this block must not re-catch them.
    if (_isHumanOwnerMessage && !isNotesChat) {
      try {
        const ownerPhone = phoneFromJid(payload.from) || rawDigits(payload.from)
        const autoConvo = require('../services/autoOwnerConversation')
        if (ownerPhone) await autoConvo.handleFromMeMessage(ownerPhone, payload.body || '')
      } catch (e) {
        log.warn('autoOwnerConversation human-override hook error', { err: e.message })
      }
      // OWNERGROUPS (OG-1) human-priority: same event, a COMPLETELY separate
      // system (owner_assistant_state, never owner_auto_conversations).
      // Must live inside this exact block — this whole `if` returns below,
      // so an owner-assistant human-message hook placed anywhere later in
      // this function would never be reached for a 1:1 owner DM. No-ops
      // instantly unless this chat has an ENABLED owner_assistant_state row.
      try {
        await _ownerAssistant.handleHumanMessage({ session, chatId: payload.from || '' })
      } catch (e) {
        log.warn('ownerAssistant human-priority hook error', { err: e.message })
      }
      return
    }

    // OWNERGROUPS (OG-1) — `!o` activation toggle. Never replies into the
    // owner's own chat — same "internal confirmation only" rule as
    // CLIENTGROUPS' `!=` — the only visible effect is the WA ASSISTANCE AND
    // CO KG control-channel notification.
    if (_isOwnerAssistantToggle) {
      try {
        await _ownerAssistant.handleToggleCommand({
          session,
          chatId: payload.from || '',
          senderPhone: phoneFromJid(payload.from) || rawDigits(payload.from),
        })
      } catch (e) {
        log.warn('ownerAssistant toggle handler error', { err: e.message })
      }
      return
    }

    // CLIENTGROUPS — local activation toggle (bare `!=` embedded anywhere in
    // a client chat). Never replies into the client's own chat (that's the
    // whole point — the client must never see an "activated" confirmation);
    // the only visible effect is the internal WA ASSISTANCE AND CO KG
    // control-channel notification.
    if (_isClientAssistantToggle) {
      try {
        await _clientAssistant.handleToggleCommand({
          session,
          chatId: payload.from || '',
          isGroup: (payload.from || '').includes('@g.us'),
          senderPhone: phoneFromJid(payload.from) || rawDigits(payload.from),
          payload,
        })
      } catch (e) {
        log.warn('clientAssistant toggle handler error', { err: e.message })
      }
      return
    }

    // CLIENTGROUPS — REMOTE toggle (`!= C184` typed in the WA ASSISTANCE AND
    // CO KG control channel itself). Resolved by client short code, not by
    // this message's own chat — the target chat is somewhere else entirely.
    // Status reply goes only into the control channel (handleRemoteToggleCommand
    // never touches the target client chat).
    if (_isClientAssistantRemoteToggle) {
      try {
        await _clientAssistant.handleRemoteToggleCommand({
          session,
          stateId: _controlToggleMatch.stateId,
        })
      } catch (e) {
        log.warn('clientAssistant remote toggle handler error', { err: e.message })
      }
      return
    }

    // CLIENTGROUPS bugfix, Teil B — explicit `!cadd C<id> <description>`.
    if (_isClientAssistantCadd) {
      try {
        await _clientAssistant.handleCadd({
          session,
          stateId: Number(_caddMatch[1]),
          text: _caddMatch[2],
        })
      } catch (e) {
        log.warn('clientAssistant !cadd handler error', { err: e.message })
      }
      return
    }

    // CLIENTGROUPS bugfix, Teil A — implicit reply-to-activation-notice
    // configuration. A false-positive candidate (no matching
    // control_message_id) is a harmless no-op inside handleControlReply.
    if (_isClientAssistantControlReply) {
      try {
        await _clientAssistant.handleControlReply({
          session,
          quotedMessageId: _quotedId,
          text: payload.body || '',
        })
      } catch (e) {
        log.warn('clientAssistant control-reply handler error', { err: e.message })
      }
      return
    }

    // Client Assistant human-priority: a human (Kevin/Olga/an agent
    // account) typed directly into a client chat this assistant manages —
    // silence the assistant for this chat (resettable, NOT a permanent
    // kill — see services/clientAssistant.js header). No-ops instantly if
    // this chat has no ENABLED row, so safe to call unconditionally.
    if (_isClientAssistantHumanMessage) {
      try {
        await _clientAssistant.handleHumanMessage({ session, chatId: payload.from || '', text: payload.body || '' })
      } catch (e) {
        log.warn('clientAssistant human-priority hook error', { err: e.message })
      }
      // Deliberately NOT `return` here — unlike the owner-automation hook,
      // a plain fromMe message in a client chat may still be something else
      // downstream cares about (e.g. isNotesChat's own handling further
      // below), and handleHumanMessage() is a pure side-effect with nothing
      // further to consume from this message.
    }

    const text = (payload.body || '').trim()
    // AutoAdvertise relies on media-only messages to bundle images that arrive
    // after the text post. AV-capture also needs image-only inbound owner DMs to
    // detect hot-owner property bursts. Let those through; everything else still
    // requires text.
    const _payloadHasMedia = !!(
      payload.media?.url || payload.mediaData?.data || payload._data?.mediaData?.data ||
      payload.hasMedia === true ||
      (typeof payload.mimetype === 'string' && payload.mimetype.startsWith('image/')) ||
      payload.type === 'image'
    )
    // Kev, 2026-08-31: raw mimetype, so autoOwnerConversation.js can tell a
    // photo apart from a PDF/Excel/other document (Point E — a document
    // must hand off to Kevin for manual review, never get silently
    // filed as "photos received").
    const _payloadMimeType = payload.mimetype || payload.media?.mimetype || payload._data?.mimetype || null
    const _isInboundDM = !payload.fromMe && !(payload.from || '').includes('@g.us')
    // Let media-only messages through when an !uploadlisting collection is active for this chat.
    const _activeUpload = (!text && _payloadHasMedia)
      ? await uploadListing.hasActiveSessionForChat(payload.from).catch(() => false)
      : false
    if (!text && !isAutoAdvGroup && !(_isInboundDM && _payloadHasMedia) && !_activeUpload) return // skip media-only that isn't AutoAdvertise, owner-DM image, or active uploadlisting

    // WAHA group message layout:
    //   payload.from        → group JID  (xxxxx@g.us)
    //   payload.participant / payload.author → sender phone (@c.us)
    const isGroup   = !isNotesChat && (payload.from || '').includes('@g.us')
    const groupId   = isGroup ? payload.from : null

    // services/dashboardReport.js — the admin request-dashboard group is
    // OUTPUT ONLY. The bot posts reports into it but must never react to or
    // act on anything posted INTO it (same bug class as the property-groups
    // trigger issue). Short-circuit before any command dispatch below.
    if (groupId && config.groups.dashboardGroupId && groupId === config.groups.dashboardGroupId) return

    // LID addressing: `participant` is often 1417…@lid, not a phone. The real
    // number rides along in key.participantAlt — senderIdentity reads it.
    const senderJid = isNotesChat
      ? toJid  // notes chat — use session's own JID (self-message target)
      : (realSenderJid(payload, isGroup) || (isGroup ? null : payload.from))

    // Normalise to plain digits (no + or @c.us / @s.whatsapp.net / @lid).
    // phoneFromJid() returns '' for a LID — keep the raw digits then, so
    // nothing downstream suddenly receives null where it used to get an id.
    const realPhone = senderJid ? phoneFromJid(senderJid) : ''
    const phone     = senderJid
      ? (realPhone || rawDigits(senderJid) || null)
      : null

    // owner_contacts / owner_account_labels matching must use realPhone, NEVER
    // `phone`'s LID-digit fallback above: a LID shares no numeric structure
    // with a real phone, so an 8-digit-suffix match against it is a
    // coincidence, not a contact — it can silently mislabel some unrelated
    // owner. `phone` (LID fallback included) stays fine for dedup/logging,
    // which only need A stable id, not the RIGHT phone number.
    //
    // #2906-129 / Michael, 2026-08-20: this is the exact gap that made !av
    // report "never_contacted" although the owner was actively replying —
    // WAHA/GOWS gave no real-phone alt field for that message, so `phone`
    // silently became the LID's digits and never matched owner_contacts.
    // We cannot invent a phone number WAHA never sent; what we CAN do is
    // never pretend the LID digits are one, and say so instead of failing
    // silently (see the warn below, and services/availability.js Fix 1 for
    // the first-contact fallback this feeds).
    if (senderJid && !isGroup && !payload.fromMe && !realPhone) {
      log.warn('[webhook] inbound DM sender resolved to a LID only — no real phone in payload, owner-contact matching skipped', {
        chat: String(payload.from || '').slice(0, 20),
        msgId: String(payload.id || '').slice(-16),
        session,
      })
    }

    const messageId = payload.id
    const timestamp = payload.timestamp || Math.floor(Date.now() / 1000)

    // Kev 2026-08-22: one shared, structured log line fired at every point
    // below where a handler is about to ACT on this message (send/queue/
    // mutate), not just "the regex matched". Diagnostic for "bot replies to
    // non-commands" — grep '"actionable"' for every path that fired for a
    // given msgId. Temporary-ish: stays cheap (one log.info call) so there's
    // no reason to rip it back out once the bug is found.
    const logActionable = (trigger, extra) => log.info('[dispatch] actionable', {
      session, chat: String(payload.from || '').slice(0, 24), msgId: String(messageId || '').slice(-16),
      event, trigger, body: text.slice(0, 50), ...extra,
    })

    // ── Skip messages sent by the backend itself (echo guard) ───────────────────
    // When the bot replies to admin notes, WAHA echoes that back as message.any.
    // Without this check the echo would be processed as the admin's next reply.
    if (messageId && waha.wasSentByBackend(messageId)) {
      log.debug('Skipping backend-sent echo', { messageId })
      return
    }

    // ── Group traffic: only the currently-designated session may claim it ────
    // Every logged-in session sits in the same groups, so all of them deliver the
    // SAME group message. Since the GOWS switch AV CENTRAL uses AddressingMode
    // 'lid', so every session now reports an IDENTICAL message id
    // (false_<group>_<msgid>_<participant>@lid). The dedup below therefore lets
    // only the FIRST session through — and when that isn't the winner picked
    // here, handlers guarded the same way (AutoAdvertise below) drop the
    // message silently. That is why !upload in AV CENTRAL worked only ~1 in 4
    // tries when this was hardcoded to 'default'.
    //
    // Kev, 2026-08-28: handlers/upload.js fixed ITS OWN internal gate on
    // 2026-08-27 to use pickUploadSession() (default → Kevsecond → kevthirdd
    // → Cedric → Jasmine, first WORKING wins) instead of a literal 'default'
    // — but this gate, which runs BEFORE upload.js's handler is even called,
    // was never updated to match, so a restricted/SCAN_QR default still
    // discarded the group message right here, before upload.js's fix ever
    // got a chance to run. Resolved ONCE and reused below for AutoAdvertise
    // too, so both gates agree on the same winner.
    //
    // pickUploadSessionSticky(), not pickUploadSession(): the plain resolver
    // re-checks live status on every call, so WAHA redelivering the SAME
    // logical message under a different event type (message, then a later
    // message.any) can resolve to a DIFFERENT winner each time if a session's
    // status flipped in between — observed live 2026-08-27 23:21–23:23,
    // Kevsecond then default both ran !upload2 for one message. Sticky-by-
    // messageId (handlers/upload.js) makes every redelivery agree.
    // Claim the first session that actually observed this group message. A
    // globally preferred healthy session may not belong to this group; using
    // it here silently discarded commands seen by other connected accounts.
    const groupLogicalId = isGroup ? gptUploadCommand.groupCommandDedupKey({
      chatId: groupId || payload.from,
      actorId: senderJid || phone,
      timestamp,
      text,
    }) : null
    const activeGroupSession = isGroup
      ? await uploadHandler.pickUploadSessionSticky(groupLogicalId || messageId, session)
      : null
    if (isGroup && session !== activeGroupSession) {
      log.debug('Group message ignored (not the active group session)', {
        session, activeGroupSession, group: groupId?.slice(0, 15),
      })
      return
    }

    // ── Redis deduplication (TTL 10 min) ─────────────────────────────────────
    // Keyed on messageId + session (not messageId alone): with more event
    // types enabled, the same logical message can now arrive twice for the
    // same session (message + message.any), and this must catch that so
    // commands like !av never fire twice. Safe against the group multi-
    // session case too — non-default sessions' copies are already discarded
    // above, before this claim.
    if (messageId || groupLogicalId) {
      // Group commands use a cross-session logical id. Ordinary traffic keeps
      // the existing provider-id + session behavior.
      const editFingerprint = event === 'message.edited'
        ? `:edit:${crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)}`
        : ''
      const dedupKey = groupLogicalId
        ? `processed:${groupLogicalId}`
        : `processed:${messageId}:${session}${editFingerprint}`
      const claimed = await redisDedup.set(dedupKey, '1', 'EX', 600, 'NX')
      if (claimed === null) {
        log.debug('Duplicate message skipped', { messageId, session })
        return
      }
    }

    log.info('Incoming message', {
      event, notes: isNotesChat || undefined,
      group: groupId?.slice(0, 15), phone: phone?.slice(-4), len: text.length,
    })

    // ── Capture reply-quote on inbound 1:1 messages (owner → us) ──────────
    // Stores the actual reply text + WAHA message_id in owner_contacts so the
    // warm-reply flow can pull the quote instead of just a state transition.
    // Fire-and-forget — never blocks the message handler chain. Skip for
    // group messages (we don't need every group member's text) and for
    // bot-echoes (fromMe=true is already filtered above, double-check).
    // Skip for media-only messages (no quote to capture).
    if (!payload.fromMe && !isGroup && text && text.length > 0 && phone) {
      try {
        const { captureReplyQuote } = require('../services/replyQuoteCapture')
        captureReplyQuote({
          phone,
          messageId: payload.id,
          body: text,
          timestampMs: (payload.timestamp || Math.floor(Date.now() / 1000)) * 1000,
        }).catch(e => log.debug('replyQuoteCapture async err', { err: e.message }))
      } catch (e) {
        log.debug('replyQuoteCapture require failed', { err: e.message })
      }
    }

    // ── RAW !post / !postpm debug logging — writes full payload to file ─────────
    if (text.toUpperCase().startsWith('!POST')) {
      const fs = require('fs')
      const entry = {
        ts: new Date().toISOString(),
        cmd: text.trim(),
        session,
        isNotesChat,
        isGroup,
        chatId: payload.from,
        payload,
      }
      try {
        fs.writeFileSync('/tmp/post_payload.json', JSON.stringify(entry, null, 2))
        log.info('!POST payload written to /tmp/post_payload.json')
      } catch (e) {
        log.warn('!POST payload write failed', { err: e.message })
      }
    }

    // ── CANONICAL STATE FIRST — a frustrated owner stops the automation (2026-09-21) ──
    // "I hate this system", "stop asking", "this is annoying": the owner is
    // complaining about the automation itself. This runs BEFORE every handler below
    // (agent relay, availability, autoconvo) so nothing generated from this message
    // can go out: every queued reply, open check and relay thread for the owner is
    // cancelled, HUMAN_REVIEW_REQUIRED is recorded where every send-gate reads it,
    // and the assigned human is told once. The bot says NOTHING to the owner — no
    // apology, no explanation. Never consumes: the rest of the pipeline (labels,
    // reply capture, DNC classification) still sees the message, it just has nothing
    // left it is allowed to send. Only known owners (not agents/admins/Kev) qualify.
    if (!isGroup && !payload.fromMe && phone && text) {
      try {
        const ownerSendGate = require('../services/ownerSendGate')
        if (ownerSendGate.isFrustratedText(text) || ownerSendGate.isExplicitOptOut(text)) {
          const botTag = require('../services/botTag')
          const ownerPhone = phone.length > 13
            ? (await ownerSendGate.resolveChatPhone(session, payload.from)) || phone
            : phone
          const knownOwner = (await db.query(
            `SELECT 1 FROM owner_contacts
              WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 9)=$1
              LIMIT 1`, [String(ownerPhone).replace(/\D/g, '').slice(-9)])).rows.length > 0
          if (knownOwner || await botTag.isOwnerOnly(ownerPhone)) {
            await ownerSendGate.handleFrustratedOwner({
              phone: ownerPhone, chatId: payload.from, session, text,
            })
          }
        }
      } catch (e) {
        log.warn('owner frustration stand-down failed', { err: e.message })
      }
    }

    // ── !uploadlisting feature (isolated, additive — see handlers/uploadListing.js) ─
    try {
      const consumed = await uploadListing.handleWebhookMessage({
        payload, session, text, isGroup, chatId: payload.from, senderPhone: phone, hasMedia: _payloadHasMedia,
      })
      if (consumed) { logActionable('uploadListing'); return }
    } catch (e) {
      log.warn('uploadListing hook error', { err: e.message })
    }

    // -- !upload / !upload2 / !upload5 / !upload9 --
    try {
      const consumed = await uploadHandler.handleWebhookMessage({
        payload, session, text, isGroup, chatId: payload.from, senderPhone: phone, hasMedia: _payloadHasMedia,
      })
      if (consumed) { logActionable('upload'); return }
    } catch (e) {
      log.warn('upload hook error', { err: e.message })
    }

    // ── !av / !avstatus (isolated, additive — see services/availability.js) ────
    // OPEN commands: anyone, any chat, so this sits BEFORE the admin gate.
    // Returns true only for !av / !avstatus / a Yes-No reping answer. Owner
    // replies are handled inside but never consumed — the owner-DM pipeline
    // below (outreach, labels, avCapture) still runs for them.
    try {
      const consumed = await availability.handleWebhookMessage({
        payload, session, text, isGroup, chatId: payload.from, senderPhone: phone,
      })
      if (consumed) { logActionable('availability'); return }
    } catch (e) {
      log.warn('availability hook error', { err: e.message })
    }

    // Exact quoted RENTED reply in a category/main chat. A plain sentence
    // containing "rented" still cannot mutate inventory: this path requires
    // a real quoted message id and rentedDetector verifies that the id was a
    // stored listing card in this exact chat before changing anything.
    if (isGroup && _quotedId && isRentedReplyText(text) && !/^!rented\b/i.test(text)) {
      try {
        const outcome = await processReply({
          senderPhone: phone,
          parentMessageId: _quotedId,
          replyText: text,
          session,
          chatId: payload.from,
          triggerMessageId: messageId,
        })
        if (outcome?.marked || outcome?.skipped === 'already_rented') {
          logActionable('quoted-rented-reply')
          return
        }
      } catch (e) {
        log.warn('group processReply hook error', { err: e.message })
      }
    }

    // Associate messages in ARGUS-created owner groups with the originating
    // property/request. This adds an audit/activity event and never consumes
    // the message or changes the existing group command pipeline.
    if (isGroup) {
      try {
        await require('../services/ownerGroupRequests').recordGroupEvent({
          groupJid:payload.from,session,messageId,senderPhone:phone,text,fromMe:!!payload.fromMe,
        })
      } catch (e) { log.warn('owner group event link failed',{err:e.message}) }
    }

    // ── !book chat-in-chat relay: owner side (services/bookRelay.js) ──────────
    // An owner answering a brokered viewing request. Their words go back to the
    // agent who asked, up to 5 in a row, without either side seeing the other.
    // Like the availability hook above it NEVER consumes: the owner-DM pipeline
    // further down (outreach marking, labels, avCapture, rented detection) must
    // keep running for these messages exactly as it did before.
    // The agent side of the relay is dispatched from handlers/upload.js, because
    // it has to sit next to the other confirm catch-alls.
    if (!isGroup && !payload.fromMe) {
      try {
        const bookRelay = require('../services/bookRelay')
        await bookRelay.handleOwnerMessage({
          payload, session, text, chatId: payload.from, senderPhone: phone,
        })
      } catch (e) {
        log.warn('bookRelay owner hook error', { err: e.message })
      }
    }

    // ── booking survey: owner's Yes/No/Suggest-time reply (services/
    // bookingSurvey.js) — Phase 2, 2026-08-27. Same never-consumes contract
    // as the two hooks above: this only reacts when a property_viewings row
    // is actually pending on this exact owner chat, and never blocks the
    // rest of the owner-DM pipeline either way.
    if (!isGroup && !payload.fromMe) {
      try {
        const bookingSurvey = require('../services/bookingSurvey')
        await bookingSurvey.handleOwnerViewingReply({
          payload, session, text, chatId: payload.from, senderPhone: phone,
        })
      } catch (e) {
        log.warn('bookingSurvey owner hook error', { err: e.message })
      }
    }

    // Owner consent for a privileged property group. Never consumes the DM:
    // labels, fact extraction and the canonical owner timeline still receive
    // the same message. Atomic status claims in the service decide reply vs
    // timeout races and prevent a second group creation.
    if (!isGroup && !payload.fromMe) {
      try {
        const ownerGroupRequests = require('../services/ownerGroupRequests')
        await ownerGroupRequests.handleOwnerReply({
          payload, session, text, senderPhone: phone,
        })
      } catch (e) {
        log.warn('ownerGroupRequests reply hook error', { err:e.message })
      }
    }

    // Central interpretation runs before any independent reply generator. It
    // persists revisions and constraints, applies terminal property status,
    // and may answer a direct identity question exactly once.
    let intelligenceOutcome = null
    if (!isGroup && !payload.fromMe && phone && text) {
      try {
        intelligenceOutcome = await require('../services/conversationIntelligence').handleInbound({
          phone, chatId: payload.from, session, text, messageId: payload.id,
          timestamp: payload.timestamp, event, payload,
        })
      } catch (e) {
        log.warn('conversationIntelligence hook error', { err: e.message })
      }
    }

    // ── ARGUS dynamic facts (2026-09-23, services/ownerFactEngine.js) ────────
    // Every owner DM is read for every fact the CRM holds — pets, sharing,
    // subletting, price, available-from, contact pause, viewing windows /
    // viewings-from dates — and the newest statement overwrites the older one
    // with provenance. Fire-and-forget; never consumes.
    if (!isGroup && !payload.fromMe && text && !intelligenceOutcome?.suppressAutomation) {
      require('../services/ownerFactEngine').handleOwnerMessage({
        phone, chatId: payload.from, text, timestamp: payload.timestamp, messageId: payload.id,
      }).catch(e => log.warn('ownerFactEngine hook error', { err: e.message }))
    }

    // ── Auto-Owner-Conversation after Outreach/Foutreach (2026-08-29,
    // services/autoOwnerConversation.js). Fake-owner-allowlist gated, scoped
    // to phones with an OPEN outreach_log cycle only. Never consumes — the
    // rest of the owner-DM pipeline below (outreach marking, reminders,
    // labels, avCapture, rented detection) keeps running exactly as before.
    // Kev, 2026-08-31: also fires on a media-only reply (photos/video, no
    // caption) -- previously required non-empty `text`, so 10 photos with
    // no caption never reached this file, and the bot went on to ask "do
    // you have pictures?" right after receiving them.
    if (!isGroup && !payload.fromMe && phone && (text || _payloadHasMedia) && !intelligenceOutcome?.suppressAutomation) {
      try {
        const autoConvo = require('../services/autoOwnerConversation')
        // payload added (Kev, 2026-09-08, Owner-zu-Upload-Vollautomatisierung):
        // handleOwnerReply previously only ever recorded a "[media]" text
        // sentinel for a photo reply -- the actual image was NEVER
        // downloaded or stored anywhere. That was invisible as long as a
        // human always re-opened WhatsApp and re-uploaded manually; it is
        // the actual blocker for handing a complete checklist straight to
        // AV CENTRAL. payload carries the real media so handleOwnerReply
        // can persist it.
        autoConvo.handleOwnerReply({ phone, text, session, hasMedia: _payloadHasMedia, mediaMimeType: _payloadMimeType, payload }).catch(e =>
          log.warn('autoOwnerConversation hook error', { err: e.message })
        )
        // Kev, 2026-09-01 (40h-Lern-Monitoring): purely observational, no-ops
        // unless this phone has a human_paused conversation within its 40h
        // window -- see autoOwnerConversation.js's logLearningIfActive.
        autoConvo.logLearningIfActive(phone, text, 'owner').catch(() => {})
      } catch (e) {
        log.warn('autoOwnerConversation require failed', { err: e.message })
      }
    }

    // OG-4 (Kev, 2026-09-04): "bei ... positiver Nachricht nach Outreach"
    // -- the other half of the third Karteikarte creation trigger (the
    // reminder half is hooked from reminderFromMessage.js itself). A short,
    // unambiguous acknowledgement only -- same explicit-only philosophy as
    // everywhere else. Fire-and-forget, never consumes.
    if (!isGroup && !payload.fromMe && phone && text) {
      try {
        const ownerPreferenceProfile = require('../services/ownerPreferenceProfile')
        ownerPreferenceProfile.captureOwnerMessage({ phone, text, messageId: payload.id })
          .catch(e => log.warn('ownerPreferenceProfile central capture failed', { err: e.message }))
        if (ownerPreferenceProfile.looksClearlyPositive(text)) {
          db.query(`SELECT id FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [phone])
            .then(r => {
              if (r.rows.length) return ownerPreferenceProfile.maybeCreateFromReminderOrPositiveReply(r.rows[0].id, text, 'positive reply after outreach')
            })
            .catch(e => log.warn('ownerPreferenceProfile hook (positive reply) failed', { err: e.message }))
        }
      } catch (e) {
        log.warn('ownerPreferenceProfile require failed', { err: e.message })
      }
    }

    // ── Client Assistant (Prompt 1/5) inbound bookkeeping — fire-and-forget,
    // NEVER consumes. Unlike the owner hook above this is NOT isGroup-gated
    // (client chats can be groups). No-ops instantly unless this exact chat
    // has an ENABLED client_assistant_state row, so safe on every inbound
    // non-bot message. Foundation-only: records last_client_message_at for
    // Prompt 2+'s eligibility/timing logic to read; no reply is generated
    // here.
    if (!payload.fromMe && (text || _payloadHasMedia)) {
      _clientAssistant.handleClientMessage({ session, chatId: payload.from || '', text })
        .catch(e => log.warn('clientAssistant inbound hook error', { err: e.message }))
    }

    // ── OWNERGROUPS (OG-1) inbound bookkeeping — fire-and-forget, NEVER
    // consumes, same shape as the Client Assistant hook directly above.
    // isGroup-gated (owner chats are always 1:1, unlike client chats). No-ops
    // instantly unless this exact chat has an ENABLED owner_assistant_state
    // row. Completely independent of the autoOwnerConversation.js hook a few
    // lines up — this records OG-1's own last_owner_message_at only.
    if (!isGroup && !payload.fromMe && (text || _payloadHasMedia) && !intelligenceOutcome?.suppressAutomation) {
      _ownerAssistant.handleOwnerMessage({ session, chatId: payload.from || '', text })
        .catch(e => log.warn('ownerAssistant inbound hook error', { err: e.message }))
    }

    // ── FB Direct From Owner Convert & TODO — reply correlation, fire-and-
    // forget, NEVER consumes. No-ops instantly unless `phone` matches an
    // open lead this tool itself contacted and is still awaiting a first
    // reply from (services/fbOwnerSave.js's own status='sent' gate), so
    // safe to call unconditionally on every ordinary inbound DM.
    if (!isGroup && !payload.fromMe && phone && text) {
      fbOwnerSave.handleLeadReply(phone, text, session, payload)
        .catch(e => log.warn('fbOwnerSave lead-reply hook error', { err: e.message }))
    }

    // ── !fbgroups* (isolated, additive — see services/fbGroupCommands.js) ──────
    // Admin only: these push real content into real Facebook groups. Notes-chat
    // and group self-commands are the session's own owner, so they count as admin.
    // NOTE: !fbgroup (singular) prefix — !fbgroupon / !fbgroupoff do NOT start
    // with "!fbgroups", so matching the plural here would silently drop them.
    if (/^!fb(group|backlog)/i.test(text)) {
      try {
        const selfCmd = isNotesChat || payload.fromMe === true
        const admin   = selfCmd || (phone ? await isAdminAccount(phone) : false)
        const consumed = await fbGroupCommands.handleCommand({
          text, chatId: payload.from, session, isAdmin: admin,
        })
        if (consumed) { logActionable('fbGroupCommands'); return }
      } catch (e) {
        log.warn('fbGroups hook error', { err: e.message })
      }
    }

    // ── FB Direct From Owner Convert & TODO (isolated, additive — see
    // services/fbOwnerSave.js) ─────────────────────────────────────────────
    // Manual only: Kev/an agent drops something THEY found browsing FB
    // themselves; this never reads a Facebook group on its own. Everything
    // sent into the ONE registered destination group is processed (that is
    // the group's entire purpose — see fbOwnerSave.js's own header);
    // outside it, only the explicit !fbsave(group)/!fbtodo/!fbcontact
    // commands or (Kev's own notes chat only) a bare facebook.com/fb.watch
    // link with no command react at all — never ordinary chatter in any
    // other group. _isFbTodoGroupMsg itself is computed once, early (near
    // the other fromMe-guard exceptions), and reused here.
    if (_isFbTodoGroupMsg || /^!fb(save|todo|contact)/i.test(text) || (isNotesChat && fbOwnerSave.FB_LINK_RE.test(text))) {
      try {
        const selfCmd = isNotesChat || payload.fromMe === true
        const admin   = selfCmd || (phone ? await isAdminAccount(phone) : false)
        const consumed = await fbOwnerSave.handleCommand({
          text, chatId: payload.from, session, isAdmin: admin, payload, isNotesChat,
        })
        if (consumed) { logActionable('fbOwnerSave'); return }
      } catch (e) {
        log.warn('fbOwnerSave hook error', { err: e.message })
      }
    }

    // ── Admin commands (DMs + notes chat + RENTED quoted replies in groups) ─────
    const { handled, isAdmin } = await handleAdminMessage(payload, session, isNotesChat)
    if (handled) { logActionable('adminCommands'); return }
    if (isAdmin && !isGroup) return  // unknown admin command — don't fall through to owner path

    // Notes chat is never anything but admin commands
    if (isNotesChat) return

    // ── Bot number never triggers intake ──────────────────────────────
    if (phone && isBot(phone)) return

    // ── Direct message — non-admin (owner replying to outreach) ────
    // Kev, 2026-08-30: WAHA/GOWS relays contentless events (read receipts /
    // multi-device sync noise, observed 2026-08-30 14:37 as a 7x burst in
    // 1.5s for one phone, all len:0) through this same 'message' path, each
    // with a genuine distinct messageId -- the Redis dedup above is keyed on
    // messageId so it does NOT catch these, they are not retries. Without
    // this guard every one of them ran classifyOwnerReply() (risking a
    // spurious "unclear" -> repeat clarify-question cycle) and re-fired
    // markHot/outreachStatusUpdate. Mirrors the text.length > 0 check the
    // reply-quote-capture block above already uses for the same reason.
    if (!isGroup && phone && text && text.length > 0) {
      // Check 24h reply monitoring
      const cycleId = await getMonitoredCycleId(phone)
      if (cycleId) {
        await classifyOwnerReply(phone, text, cycleId, session)
        await stopMonitoring(phone)
      }

      // Client exit keywords — mark client closed
      const lowerText = text.toLowerCase()
      const exitKeywords = ['found', 'rented', 'sorted', 'got one', 'no longer', 'already rented', 'already found']
      if (exitKeywords.some(kw => lowerText.includes(kw))) {
        const cr = await db.query(
          `UPDATE clients SET status='closed', updated_at=NOW()
           WHERE phone = $1 AND status NOT IN ('closed','rented')
           RETURNING id`,
          [phone]
        )
        if (cr.rows.length > 0) {
          log.info('Client closed via exit keyword', { phone: phone.slice(-4), keyword: lowerText.slice(0, 30) })
          logActionable('exit-keyword-client-close')
        }
      }

      await db.query(
        `UPDATE outreach_log
         SET replied = TRUE, replied_at = NOW(), conversation_state = 'active'
         WHERE phone = $1 AND replied = FALSE`,
        [phone]
      )
      markHot(phone, text) // fire-and-forget, errors logged inside
      outreachStatusUpdate(phone, 'hot') // fire-and-forget
      log.info('Owner DM — outreach marked replied', { phone: phone.slice(-4) })

      // ── Rented-detection on free-text reply ──────────────────────────────
      // Owner writes 'rented', 'schon vermietet', 'letzter tag' on a bot post
      // → mark the corresponding property as rented. Best-effort.
      try {
        await processReply({
          senderPhone: phone,
          parentMessageId: payload.quotedMessageId || payload.quotedMsgId || null,
          replyText: text,
          session,
        })
      } catch (e) {
        log.warn('processReply hook error', { err: e.message })
      }

      // ── Reminder-from-message bridge ──────────────────────────────────────────
      // Owner DM containing "in September I should have", "end August", or
      // "schreib mir … wieder/nochmal" auto-creates a reminders row.
      // Best-effort, fire-and-forget; a failure here MUST NOT abort the webhook.
      // The contact param is optional — the helper falls back to the agent's
      // name field if the contact object isn't supplied. Look it up by phone
      // here so the reminder row gets the real owner name when we have it.
      ;(async () => {
        let contactObj = null
        try {
          // realPhone, not phone: an owner_contacts match must never run on
          // the LID-digit fallback (see comment above phone/realPhone).
          const contactId = await labelEngine.getContactIdByPhone(realPhone)
          if (contactId) contactObj = { id: contactId, phone: realPhone }
        } catch (e) { /* best-effort, fall through */ }
        reminderFromMessage.captureFromReply(phone, text, {
          session, messageId, contact: contactObj,
        }).catch((e) => log.warn('reminderFromMessage: hook error', { err: e.message }))
        if (contactObj?.id) {
          const ownerRecheck = require('../services/ownerRecheck')
          ownerRecheck.invalidateApprovals(contactObj.id, 'new owner reply requires a fresh context review')
            .catch((e) => log.warn('ownerRecheck: approval invalidation error', { err: e.message }))
          ownerRecheck.reconcileAvailabilityReply({
            ownerContactId: contactObj.id,
            text,
            sourceMessageId: messageId,
            sourceSession: session,
            sourceMessageAt: new Date(Number(timestamp) * 1000),
          }).catch((e) => log.warn('ownerRecheck: availability reconciliation error', { err: e.message }))
          ownerRecheck.recordTemporalFacts({
            ownerContactId: contactObj.id,
            text,
            sourceMessageId: messageId,
            sourceSession: session,
            sourceMessageAt: new Date(Number(timestamp) * 1000),
          }).catch((e) => log.warn('ownerRecheck: temporal fact hook error', { err: e.message }))
        }
      })()

      // ── Event-driven labeling (5-min debounce per contact/session) ───────
      ;(async () => {
        try {
          // realPhone, not phone — see comment above phone/realPhone.
          const contactId = await labelEngine.getContactIdByPhone(realPhone)
          if (!contactId) return
          const dr = await db.query(
            `SELECT updated_at FROM owner_account_labels
             WHERE contact_id = $1 AND account_session = $2`,
            [contactId, session]
          )
          const last = dr.rows[0]?.updated_at
          const fresh = last && (Date.now() - new Date(last).getTime()) < 5 * 60_000
          if (fresh) {
            await labelEngine.bumpCounters(contactId, session, { incrementIn: 1, lastReplyAt: new Date() })
            return
          }
          const result = await labelEngine.analyzeOwnerChat(session, phone)
          if (result?.label) {
            await labelEngine.applyLabel(contactId, session, result.label, {
              source: 'auto',
              triggeredBy: 'webhook',
              lastReplyAt: result.lastReplyAt || new Date(),
              incrementIn: 1,
              notes: result.reason,
            })
            log.info('label updated via webhook', { contactId, session, label: result.label, reason: result.reason })
          } else {
            await labelEngine.bumpCounters(contactId, session, { incrementIn: 1, lastReplyAt: new Date() })
          }

          // ── Ghost-counter reset on any owner reply ───────────────
          // realPhone, not phone — see comment above phone/realPhone.
          try { await resetNoReplyForPhone(realPhone, session) } catch {}

          // ── AV Capture (hot owners only — internal check) ──────────
          try {
            const { checkAVCaptureNeeded } = require('../services/avCapture')
            await checkAVCaptureNeeded(contactId, session, payload)
          } catch (err) {
            log.warn('AV capture check failed', { err: err.message, phone: phone.slice(-4) })
          }
        } catch (err) {
          log.warn('label engine webhook error', { err: err.message, phone: phone.slice(-4) })
        }
      })()

      return
    }

    if (!groupId) return

    // ── Look up group config ───────────────────────────────────────
    const groupCfg = await getGroupConfig(groupId)
    if (!groupCfg) {
      log.debug('Unknown group, ignoring', { groupId: groupId.slice(0, 15) })
      return
    }

    // Tag requirement check (for todo-style groups)
    if (groupCfg.requires_tag && groupCfg.tag_name) {
      if (!text.includes(groupCfg.tag_name)) return
    }

    const quotedStanzaID = payload._data?.quotedStanzaID || null
    const jobData = { messageId, phone, text, timestamp, groupId, session, quotedStanzaID }

    // ── Route by group type ────────────────────────────────────────
    if (groupCfg.group_type === 'property') {
      if (isRentedMessage(text)) {
        // P0 status firewall (2026-09-26): a plain group sentence containing
        // "rented" is discussion, not an authorized lifecycle command. The
        // legacy worker guessed the latest listing in the group (and even had
        // a group-only fallback), so an operator quote or unrelated message
        // could archive the wrong property. Explicit !rented is handled by the
        // authenticated admin-command path above; everything else stays read-
        // only and is logged for review.
        log.info('[webhook] plain rented keyword in property group ignored — explicit authorized command required', {
          session, group: String(groupId).slice(0, 20), msgId: String(messageId || '').slice(-16),
        })
      } else {
        logActionable('property-intake-queue', { groupType: groupCfg.group_type })
        await addJob('property-intake', jobData, { priority: 8 })
      }
    } else if (groupCfg.group_type === 'client') {
      logActionable('client-intake-queue', { groupType: groupCfg.group_type })
      await addJob('client-intake', jobData, { priority: 8 })
    } else if (groupCfg.group_type === 'autoadvertise') {
      // Only the active group session (activeGroupSession, resolved above)
      // handles AutoAdvertise — was a literal 'default' check, now the same
      // winner the top-of-function group gate already agreed on, so this is
      // a second line of defense rather than a second, independent gate that
      // could disagree with it.
      if (session === activeGroupSession) {
        const hasMedia = !!(payload.media?.url || payload.mediaData?.data || payload._data?.mediaData?.data)
        log.info('webhook: routing to AutoAdvertise', { from: payload.from, chars: text.length, hasMedia })
        logActionable('autoadvertise')
        handleAutoAdvertise(payload, session).catch(err =>
          log.error('AutoAdvertise crashed', { err: err.message })
        )
      } else {
        log.debug('webhook: AutoAdvertise message ignored (not the active group session)', { session, activeGroupSession })
      }
    }

  } catch (err) {
    log.error('Webhook handler error', err)
  }
})

module.exports = router
