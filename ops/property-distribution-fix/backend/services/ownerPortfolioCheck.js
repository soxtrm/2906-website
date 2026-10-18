'use strict'

// One owner can appear in several WhatsApp accounts. A portfolio check is
// therefore a single, persisted conversation with a fixed number -> property
// mapping, preceded by a read across every live account. Owner replies never
// remove listings directly: unselected properties become review tasks for an
// admin, while selected properties are merely reconfirmed as available.

const db = require('/app/db')
const log = require('/app/logger')
const waha = require('/app/waha')
const ownerChatScan = require('/app/services/ownerChatScan')
const shareLinks = require('/app/services/shareLinks')
const humanDelay = require('/app/services/humanDelay')
const ownerSendGate = require('/app/services/ownerSendGate')

const OPEN_STATES = ['awaiting_reply', 'review_required']

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS owner_portfolio_checks (
      id BIGSERIAL PRIMARY KEY,
      owner_contact_id INTEGER NOT NULL REFERENCES owner_contacts(id),
      trigger_session TEXT NOT NULL,
      trigger_chat_id TEXT NOT NULL,
      trigger_message_id TEXT,
      state TEXT NOT NULL DEFAULT 'awaiting_reply',
      prompt_text TEXT NOT NULL,
      property_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      scan_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      reply_text TEXT,
      reply_message_id TEXT,
      selected_property_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
      unselected_property_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
      sent_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS owner_portfolio_events (
      id BIGSERIAL PRIMARY KEY,
      check_id BIGINT NOT NULL REFERENCES owner_portfolio_checks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS owner_portfolio_checks_owner_idx
      ON owner_portfolio_checks(owner_contact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS owner_portfolio_checks_state_idx
      ON owner_portfolio_checks(state, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS owner_portfolio_checks_one_open_idx
      ON owner_portfolio_checks(owner_contact_id)
      WHERE state IN ('awaiting_reply','review_required');
    CREATE INDEX IF NOT EXISTS owner_portfolio_events_check_idx
      ON owner_portfolio_events(check_id, created_at DESC);
  `)
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits || null
}

function maskPhone(value) {
  const digits = normalizePhone(value)
  return digits ? `••••${digits.slice(-4)}` : null
}

function money(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
    ? `€${Math.round(n).toLocaleString('en-GB')}`
    : null
}

async function resolveOwnerContact(senderPhone) {
  const digits = normalizePhone(senderPhone)
  if (!digits) return null
  const suffix = digits.slice(-9)
  return (await db.query(
    `SELECT id, phone_normalized, name
       FROM owner_contacts
      WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 9) = $1
      ORDER BY id DESC LIMIT 1`,
    [suffix],
  )).rows[0] || null
}

async function audit(checkId, eventType, detail = {}, actor = 'system') {
  await db.query(
    `INSERT INTO owner_portfolio_events(check_id,event_type,actor,detail)
     VALUES($1,$2,$3,$4::jsonb)`,
    [checkId, eventType, actor, JSON.stringify(detail)],
  )
}

async function scanAcrossAccounts(ownerPhone, currentSession, currentChatId) {
  const digits = normalizePhone(ownerPhone)
  const sessions = (await waha.getWorkingSessions())
    .map(row => row.name)
    .filter(Boolean)
    .filter(name => String(name).toLowerCase() !== 'jasmine')
  if (currentSession && !sessions.some(name => String(name).toLowerCase() === String(currentSession).toLowerCase())) {
    sessions.unshift(currentSession)
  }

  const rows = []
  for (const session of [...new Set(sessions)]) {
    const chatId = String(session).toLowerCase() === String(currentSession || '').toLowerCase()
      ? currentChatId
      : `${digits}@c.us`
    const scan = await ownerChatScan.scanOwnerChat({ session, chatId, limit: 80 })
    rows.push({
      session,
      ok: scan.ok,
      scanned: scan.scanned,
      ourMessageCount: scan.ourMessageCount,
      lastOutboundAt: scan.lastOutboundAt,
      lastInboundAt: scan.lastInboundAt,
      ownerWroteLast: scan.ownerWroteLast,
      outboundTexts: scan.outboundTexts || [],
      reason: scan.reason || null,
    })
  }

  return {
    attemptedAccounts: rows.length,
    accountsWithHistory: rows.filter(row => row.scanned > 0).length,
    failedAccounts: rows.filter(row => !row.ok).map(row => row.session),
    rows,
  }
}

async function loadPortfolio(ownerContactId) {
  return (await db.query(
    `SELECT p.id, p.ref, p.town, p.sub_location, p.longlet_price, p.sale_price,
            p.property_type, p.bedrooms, p.available_status, p.published,
            p.created_at
       FROM properties p
      WHERE p.owner_id = $1
        AND COALESCE(p.available_status,'available') NOT IN ('rented','archived')
      ORDER BY p.created_at, p.id`,
    [ownerContactId],
  )).rows
}

async function snapshotPortfolio(properties) {
  const included = []
  const excluded = []
  for (const property of properties) {
    if (!property.ref) {
      excluded.push({
        propertyId: property.id,
        reason: 'missing_reference',
        town: property.town || null,
        price: money(property.longlet_price || property.sale_price),
        originalStatus: property.available_status || 'available',
      })
      continue
    }
    let url = null
    try {
      url = (await shareLinks.getOrCreatePropertyLink(property.id))?.url || null
    } catch (error) {
      log.warn('[portfolio-check] property link failed', { propertyId: property.id, err: error.message })
    }
    if (!url) {
      excluded.push({
        propertyId: property.id,
        ref: property.ref,
        reason: 'missing_share_link',
        town: property.town || null,
        price: money(property.longlet_price || property.sale_price),
        originalStatus: property.available_status || 'available',
      })
      continue
    }
    included.push({
      number: included.length + 1,
      propertyId: property.id,
      ref: property.ref,
      town: property.town || property.sub_location || 'Malta',
      price: money(property.longlet_price || property.sale_price),
      propertyType: property.property_type || null,
      bedrooms: property.bedrooms == null ? null : Number(property.bedrooms),
      originalStatus: property.available_status || 'available',
      url,
    })
  }
  return { included, excluded }
}

function buildPrompt(items) {
  const lines = items.map(item => {
    const facts = [`#${item.ref}`, item.town, item.price].filter(Boolean).join(' · ')
    return `${item.number}. ${facts}\n${item.url}`
  })
  return [
    'Could you please clarify which ones are still on the market, so I can amend our records?',
    '',
    ...lines,
    '',
    'Reply ALL if every property is still available, or send the numbers that are still on the market (for example: 1, 3, 6).',
  ].join('\n')
}

// 2026-10-18: every one of the first 5 live checks stayed 'awaiting_reply'.
// Owners answer in sentences, not in the "1, 3, 6" the prompt suggests, and
// all 12 replies were dropped as not_a_selection: "Nr 3 available only",
// "Both are rented", "Nothing is available now", "it has been rented". The
// strict shapes still parse exactly as before; these add the natural ones.
// Anything still unclear is NOT guessed -- the caller hands it to Kev.
const ALL_RE = /^(?:yes[,! ]*)?(?:all|both|every(?:one| one)?|alle|beide)(?:\s+(?:of them|are|is|still|available|free|on (?:the )?market|verfügbar|frei|noch|sind)){0,4}[.!]*$/i
const NONE_RE = /^(?:(?:no|sorry|unfortunately|hello|hi)[,.! ]*)*(?:none|nothing|neither|keine?s?|nichts)(?:\s+(?:of them|is|are|available|left|free|now|anymore|any more|on (?:the )?market|mehr|frei|verfügbar)){0,5}[.!]*$/i
const ALL_GONE_RE = /^(?:(?:no|sorry|unfortunately|hello|hi)[,.! ]*)*(?:all|both|they|everything|alle|beide)(?:\s+(?:of them|are|have|has|been|were|got|is|sind))*\s+(?:rented|taken|let|gone|sold|vermietet|weg)(?:\s+(?:out|already|now|unfortunately))*[.!]*$/i
const ONE_GONE_RE = /^(?:(?:no|sorry|unfortunately|hello|hi)[,.! ]*)*(?:(?:it|it's|its|this|this one|that one|the (?:flat|apartment|property))\s+)?(?:(?:is|has|have|was|been|got|already)\s+)*(?:rented|taken|let|gone|sold|vermietet|weg)(?:\s+(?:out|already|now|unfortunately))*[.!]*$/i
const FILLER = /\b(?:and|und|or|still|available|free|frei|verfügbar|on|the|market|numbers?|nr|nos?|only|just|nur|noch|ist|sind|is|are|left|one|ones|property|properties|flat|flats|apartments?|yes|ja|thanks|thank you|danke|please)\b/g

function parseSelection(text, itemCount) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, reason: 'empty' }
  const all = Array.from({ length: itemCount }, (_, index) => index + 1)
  // Judge the last non-empty line: "The links have expired\nBoth are rented".
  const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean)
  for (const line of [raw, lines[lines.length - 1]]) {
    if (ALL_RE.test(line)) return { ok: true, numbers: all, kind: 'all' }
    if (NONE_RE.test(line) || ALL_GONE_RE.test(line)) return { ok: true, numbers: [], kind: 'none' }
    // "it has been rented" names no number: only unambiguous with one listing.
    if (ONE_GONE_RE.test(line)) {
      return itemCount === 1 ? { ok: true, numbers: [], kind: 'none' } : { ok: false, reason: 'ambiguous_which' }
    }
  }
  const cleaned = raw
    .toLowerCase()
    .replace(/#/g, ' ')
    .replace(FILLER, ' ')
    .replace(/[.,;:+/&!?()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!/^\d+(?:\s+\d+)*$/.test(cleaned)) return { ok: false, reason: 'not_a_selection' }
  const numbers = [...new Set(cleaned.split(/\s+/).map(Number))]
  if (numbers.some(number => number < 1 || number > itemCount)) {
    return { ok: false, reason: 'out_of_range', numbers }
  }
  return { ok: true, numbers: numbers.sort((a, b) => a - b), kind: 'numbers' }
}

async function startFromRentedStatement({ ownerContactId, ownerPhone, session, chatId, messageId = null }) {
  await ensureSchema()

  const existing = (await db.query(
    `SELECT id,state FROM owner_portfolio_checks
      WHERE owner_contact_id=$1 AND state = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [ownerContactId, OPEN_STATES],
  )).rows[0]
  if (existing) {
    await audit(existing.id, 'DUPLICATE_TRIGGER_SUPPRESSED', { session, messageId })
    return { handled: true, duplicate: true, checkId: existing.id }
  }

  const portfolio = await loadPortfolio(ownerContactId)
  if (portfolio.length <= 1) return { handled: false, reason: 'single_or_empty_portfolio' }

  const scan = await scanAcrossAccounts(ownerPhone, session, chatId)
  if (scan.failedAccounts.length) {
    log.warn('[portfolio-check] account scan incomplete; owner prompt blocked', {
      ownerContactId, failed: scan.failedAccounts,
    })
    return { handled: true, blocked: true, reason: 'scan_incomplete', scan }
  }

  const snapshot = await snapshotPortfolio(portfolio)
  if (!snapshot.included.length) {
    return { handled: true, blocked: true, reason: 'no_linkable_properties', scan, snapshot }
  }
  const prompt = buildPrompt(snapshot.included)
  const alreadySent = scan.rows.some(row => ownerChatScan.alreadySaid(row, prompt))
  if (alreadySent) {
    return { handled: true, duplicate: true, reason: 'already_sent_in_scanned_chat', scan }
  }

  let row
  try {
    row = (await db.query(
      `INSERT INTO owner_portfolio_checks
         (owner_contact_id,trigger_session,trigger_chat_id,trigger_message_id,state,
          prompt_text,property_snapshot,scan_summary)
       VALUES($1,$2,$3,$4,'awaiting_reply',$5,$6::jsonb,$7::jsonb)
       RETURNING *`,
      [ownerContactId, session, chatId, messageId, prompt,
       JSON.stringify(snapshot), JSON.stringify({
         attemptedAccounts: scan.attemptedAccounts,
         accountsWithHistory: scan.accountsWithHistory,
         failedAccounts: scan.failedAccounts,
         rows: scan.rows.map(({ outboundTexts, ...safe }) => safe),
       })],
    )).rows[0]
  } catch (error) {
    if (error.code === '23505') {
      const raceWinner = (await db.query(
        `SELECT id,state FROM owner_portfolio_checks
          WHERE owner_contact_id=$1 AND state = ANY($2::text[])
          ORDER BY created_at DESC LIMIT 1`,
        [ownerContactId, OPEN_STATES],
      )).rows[0]
      if (raceWinner) {
        await audit(raceWinner.id, 'CONCURRENT_TRIGGER_SUPPRESSED', { session, messageId })
        return { handled: true, duplicate: true, checkId: raceWinner.id }
      }
    }
    throw error
  }

  await audit(row.id, 'CHATS_SCANNED', {
    attemptedAccounts: scan.attemptedAccounts,
    accountsWithHistory: scan.accountsWithHistory,
    excludedProperties: snapshot.excluded,
  })
  const queued = await humanDelay.queueOwnerMessage({
    session,
    chatId,
    text: prompt,
    reactTo: messageId,
    reactEmoji: null,
    label: 'owner_portfolio_clarification',
    jobId: `owner-portfolio-${ownerContactId}-${row.id}`,
  })
  if (!queued?.queued) {
    await db.query(
      `UPDATE owner_portfolio_checks SET state='delivery_failed',updated_at=NOW() WHERE id=$1`,
      [row.id],
    )
    await audit(row.id, 'PROMPT_QUEUE_FAILED', { reason: queued?.reason || 'unknown' })
    return { handled: true, blocked: true, reason: 'prompt_queue_failed', checkId: row.id, scan }
  }
  await require('./conversationIntelligence').recordQuestionContext({
    chatId,
    session,
    questionType: 'numbered_availability',
    propertyIds: snapshot.included.map(item => Number(item.propertyId)),
  }).catch(err => log.warn('[portfolio-check] conversation context write failed', { checkId: row.id, err: err.message }))
  await db.query(`UPDATE owner_portfolio_checks SET sent_at=NOW(),updated_at=NOW() WHERE id=$1`, [row.id])
  await audit(row.id, 'PROMPT_QUEUED', {
    session,
    itemCount: snapshot.included.length,
    excludedCount: snapshot.excluded.length,
  })
  return { handled: true, checkId: row.id, itemCount: snapshot.included.length, scan }
}

async function createReviewTask(check, item, replyText) {
  const sourceId = `portfolio:${check.id}:${item.propertyId}`
  const existing = await db.query(
    `SELECT id FROM owner_recheck_tasks WHERE source_type='owner_portfolio_check' AND source_id=$1 LIMIT 1`,
    [sourceId],
  )
  if (existing.rows.length) return existing.rows[0].id
  const task = (await db.query(
    `INSERT INTO owner_recheck_tasks
       (owner_contact_id,owner_phone,topic,state,decision,reason,property_id,
        source_type,source_id,context_snapshot,proposed_action)
     SELECT $1,phone_normalized,'portfolio_availability','DECISION_REQUIRED',
            'OWNER_DID_NOT_CONFIRM','Owner omitted this property from the still-on-market selection',
            $2,'owner_portfolio_check',$3,$4::jsonb,'REVIEW_REMOVE_FROM_ACTIVE'
       FROM owner_contacts WHERE id=$1
     RETURNING id`,
    [check.owner_contact_id, item.propertyId, sourceId, JSON.stringify({
      checkId: check.id,
      item,
      replyText: String(replyText || '').slice(0, 500),
    })],
  )).rows[0]
  if (task) {
    await db.query(
      `INSERT INTO owner_recheck_events(task_id,event_type,detail)
       VALUES($1,'PORTFOLIO_UNCONFIRMED',$2::jsonb)`,
      [task.id, JSON.stringify({ checkId: check.id, propertyId: item.propertyId })],
    )
  }
  return task?.id || null
}

async function handleOwnerReply({ senderPhone, text, session, chatId = null, messageId = null }) {
  await ensureSchema()
  let owner = await resolveOwnerContact(senderPhone)
  if (!owner && chatId) {
    const resolvedPhone = await ownerSendGate.resolveChatPhone(session, chatId).catch(() => null)
    owner = await resolveOwnerContact(resolvedPhone)
  }
  if (!owner) return { handled: false }
  const check = (await db.query(
    `SELECT * FROM owner_portfolio_checks
      WHERE owner_contact_id=$1 AND state='awaiting_reply'
      ORDER BY created_at DESC LIMIT 1`,
    [owner.id],
  )).rows[0]
  if (!check) return { handled: false }

  const snapshot = check.property_snapshot || {}
  const items = Array.isArray(snapshot.included) ? snapshot.included : []
  const parsed = parseSelection(text, items.length)
  if (!parsed.ok) {
    await audit(check.id, 'REPLY_NOT_UNDERSTOOD', {
      session,
      messageId,
      reason: parsed.reason,
      textPreview: String(text || '').slice(0, 160),
    }, 'owner')
    // An unclear owner answer used to vanish into this audit row -- nobody was
    // told, the check sat 'awaiting_reply' forever. Hand it to Kev with the
    // numbered list so a human makes the call (never a guess here).
    if (parsed.reason !== 'empty') {
      const list = items.map(item => `${item.number}. #${item.ref}${item.town ? ` · ${item.town}` : ''}`).join('\n')
      await require('/app/handlers/uploadListing').alertKev(
        `❓ Portfolio check ${check.id} — owner ${owner.name || maskPhone(owner.phone_normalized)} replied, not understood (${parsed.reason}):\n` +
        `"${String(text).slice(0, 300)}"\n\n${list}\n\nDecide in the CRM portfolio check, or ask the owner which numbers are still available.`
      ).catch(err => log.warn('[portfolio-check] review alert failed', { checkId: check.id, err: err.message }))
    }
    return { handled: true, understood: false, checkId: check.id }
  }

  const chosen = new Set(parsed.numbers)
  const selected = items.filter(item => chosen.has(item.number))
  const unselected = items.filter(item => !chosen.has(item.number))
  const selectedIds = selected.map(item => Number(item.propertyId))
  const unselectedIds = unselected.map(item => Number(item.propertyId))

  if (selectedIds.length) {
    await db.query(
      `UPDATE properties
          SET available_status='available_confirmed',last_confirmed_available_at=NOW(),
              status_change_reason='Owner confirmed in portfolio check',updated_at=NOW()
        WHERE id=ANY($1::int[])
          AND COALESCE(available_status,'available') NOT IN ('rented','archived')`,
      [selectedIds],
    )
    for (const item of selected) {
      await db.query(
        `INSERT INTO property_activities(property_id,agent_id,activity_type,details,is_significant,created_at)
         VALUES($1,NULL,'owner_portfolio_confirmed',$2::jsonb,TRUE,NOW())`,
        [item.propertyId, JSON.stringify({ checkId: check.id, replyKind: parsed.kind, source: 'owner_reply' })],
      )
    }
  }

  // The question explicitly asks which of this fixed snapshot remain on the
  // market. Anything not selected is therefore unavailable within this
  // snapshot's scope. Apply immediately; do not wait for an aging timer or
  // accidentally remove properties outside this numbered list.
  if (unselectedIds.length) {
    await db.query(
      `UPDATE properties
          SET available_status='not_available',operational_status='WITHDRAWN',published=FALSE,
              status_change_reason='Owner marked unavailable in numbered portfolio check',updated_at=NOW()
        WHERE id=ANY($1::int[])
          AND COALESCE(available_status,'available') NOT IN ('rented','sold','archived')`,
      [unselectedIds],
    )
    for (const item of unselected) {
      await db.query(
        `INSERT INTO property_activities(property_id,agent_id,activity_type,details,is_significant,created_at)
         VALUES($1,NULL,'owner_portfolio_unavailable',$2::jsonb,TRUE,NOW())`,
        [item.propertyId, JSON.stringify({ checkId: check.id, replyKind: parsed.kind, source: 'owner_reply' })],
      )
      try { await require('./matchEngine').invalidateMatchesForProperty(item.propertyId, 'owner_portfolio_unavailable') }
      catch (err) { log.warn('[portfolio-check] match invalidation failed', { propertyId:item.propertyId, err:err.message }) }
    }
    if (parsed.kind === 'none') {
      await require('./autoOwnerConversation').cancelChatAutomation(owner.phone_normalized).catch(() => {})
    }
  }

  const taskIds = []
  for (const item of unselected) {
    const taskId = await createReviewTask(check, item, text)
    if (taskId) taskIds.push(taskId)
  }
  for (const item of Array.isArray(snapshot.excluded) ? snapshot.excluded : []) {
    const taskId = await createReviewTask(check, item, text)
    if (taskId) taskIds.push(taskId)
  }

  const state = taskIds.length ? 'review_required' : 'completed'
  await db.query(
    `UPDATE owner_portfolio_checks
        SET state=$2,reply_text=$3,reply_message_id=$4,selected_property_ids=$5,
            unselected_property_ids=$6,replied_at=NOW(),resolved_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END,
            updated_at=NOW()
      WHERE id=$1`,
    [check.id, state, String(text).slice(0, 2000), messageId, selectedIds, unselectedIds],
  )
  await audit(check.id, 'OWNER_SELECTION_APPLIED', {
    kind: parsed.kind,
    selectedNumbers: parsed.numbers,
    selectedPropertyIds: selectedIds,
    unselectedPropertyIds: unselectedIds,
    reviewTaskIds: taskIds,
    canonicalStatusChangedForUnselected: unselectedIds.length > 0,
  }, 'owner')

  return {
    handled: true,
    understood: true,
    checkId: check.id,
    state,
    selected: selectedIds.length,
    reviewRequired: taskIds.length,
  }
}

async function listChecks({ state = null, limit = 100 } = {}) {
  await ensureSchema()
  const params = []
  let where = ''
  if (state && state !== 'all') {
    params.push(state)
    where = `WHERE opc.state=$${params.length}`
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 250))
  const result = await db.query(
    `SELECT opc.*,oc.name AS owner_name,oc.phone_normalized,
            (SELECT COUNT(*)::int FROM owner_portfolio_events e WHERE e.check_id=opc.id) AS event_count
       FROM owner_portfolio_checks opc
       JOIN owner_contacts oc ON oc.id=opc.owner_contact_id
       ${where}
      ORDER BY opc.updated_at DESC
      LIMIT $${params.length}`,
    params,
  )
  return result.rows.map(row => ({ ...row, owner_phone: maskPhone(row.phone_normalized), phone_normalized: undefined }))
}

async function getCheck(id) {
  await ensureSchema()
  const check = (await db.query(
    `SELECT opc.*,oc.name AS owner_name,oc.phone_normalized
       FROM owner_portfolio_checks opc
       JOIN owner_contacts oc ON oc.id=opc.owner_contact_id
      WHERE opc.id=$1`,
    [id],
  )).rows[0]
  if (!check) return null
  check.owner_phone = maskPhone(check.phone_normalized)
  delete check.phone_normalized
  check.events = (await db.query(
    `SELECT id,event_type,actor,detail,created_at
       FROM owner_portfolio_events WHERE check_id=$1 ORDER BY created_at DESC`,
    [id],
  )).rows
  check.review_tasks = (await db.query(
    `SELECT id,property_id,state,decision,reason,proposed_action,resolution,created_at,updated_at
       FROM owner_recheck_tasks
      WHERE source_type='owner_portfolio_check' AND source_id LIKE $1
      ORDER BY created_at`,
    [`portfolio:${id}:%`],
  )).rows
  return check
}

async function adminAction(id, action, actor) {
  await ensureSchema()
  const check = await getCheck(id)
  if (!check) throw new Error('portfolio check not found')
  if (action === 'dismiss') {
    await db.query(
      `UPDATE owner_portfolio_checks SET state='dismissed',resolved_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [id],
    )
    await audit(id, 'ADMIN_DISMISSED', {}, actor)
    return getCheck(id)
  }
  if (action === 'confirm_all_available') {
    const items = Array.isArray(check.property_snapshot?.included) ? check.property_snapshot.included : []
    const ids = items.map(item => Number(item.propertyId)).filter(Boolean)
    if (ids.length) {
      await db.query(
        `UPDATE properties SET available_status='available_confirmed',last_confirmed_available_at=NOW(),
               status_change_reason='Admin confirmed after portfolio review',updated_at=NOW()
          WHERE id=ANY($1::int[]) AND COALESCE(available_status,'available') NOT IN ('rented','archived')`,
        [ids],
      )
    }
    await db.query(
      `UPDATE owner_recheck_tasks SET state='MANUALLY_RESOLVED',decision='ADMIN_CONFIRMED_AVAILABLE',
              resolution=$2,resolved_at=NOW(),updated_at=NOW()
        WHERE source_type='owner_portfolio_check' AND source_id LIKE $1 AND state <> 'MANUALLY_RESOLVED'`,
      [`portfolio:${id}:%`, `confirmed available by ${actor}`],
    )
    await db.query(
      `UPDATE owner_portfolio_checks SET state='completed',resolved_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [id],
    )
    await audit(id, 'ADMIN_CONFIRMED_ALL_AVAILABLE', { propertyIds: ids }, actor)
    return getCheck(id)
  }
  throw new Error('unknown action')
}

module.exports = {
  ensureSchema,
  buildPrompt,
  parseSelection,
  scanAcrossAccounts,
  startFromRentedStatement,
  handleOwnerReply,
  listChecks,
  getCheck,
  adminAction,
}
