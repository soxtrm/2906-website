'use strict'

const crypto = require('crypto')
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const { interpretInbound, planDirectReply, validateDraft, OPERATIONAL_STATUS } = require('./conversationPolicy')
const { resolveAgentIdentity } = require('./agentIdentityRegistry')

const normalizePhone = value => String(value || '').replace(/\D/g, '').slice(-12)
const sourceTimestamp = value => {
  if (!value) return new Date()
  const n = Number(value)
  return Number.isFinite(n) ? new Date(n < 10_000_000_000 ? n * 1000 : n) : new Date(value)
}
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex')
const outboundIdempotencyKey = (stateId, messageId, reply) => digest(`${stateId}:${messageId}:${reply}`)

async function ownerFor(phone, chatId) {
  const p = normalizePhone(phone)
  const r = await db.query(
    `SELECT id, phone_normalized FROM owner_contacts
      WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 8)=right($1,8)
      ORDER BY id DESC LIMIT 1`, [p])
  if (r.rows[0]) return r.rows[0]
  if (!chatId) return null
  const fallback = await db.query(
    `SELECT oc.id, oc.phone_normalized FROM owner_contacts oc
       JOIN owner_assistant_state s ON s.owner_contact_id=oc.id
      WHERE s.chat_id=$1 ORDER BY s.updated_at DESC LIMIT 1`, [chatId]).catch(() => ({ rows: [] }))
  return fallback.rows[0] || null
}

async function resolveProperties(ownerId, text, chatId) {
  if (!ownerId) return []
  const all = (await db.query(
    `SELECT id, ref, town, sub_location, available_status FROM properties
      WHERE owner_id=$1 AND ref IS NOT NULL ORDER BY updated_at DESC`, [ownerId])).rows
  const explicit = all.filter(p => {
    if (!p.ref) return false
    const escaped = String(p.ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const suffix = String(p.ref).replace(/^2906-/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b(?:${escaped}|${suffix})\\b`, 'i').test(String(text || ''))
  })
  if (explicit.length) return explicit
  const live = all.filter(p => !['rented', 'sold', 'archived', 'not_available'].includes(String(p.available_status || '').toLowerCase()))
  if (live.length === 1) return live
  const ctx = await db.query(
    `SELECT property_ids FROM conversation_intelligence_state WHERE chat_id=$1 LIMIT 1`, [chatId]).catch(() => ({ rows: [] }))
  const ids = Array.isArray(ctx.rows[0]?.property_ids) ? ctx.rows[0].property_ids.map(Number) : []
  return live.filter(p => ids.includes(Number(p.id)))
}

async function loadState(client, chatId, senderAccountId, ownerId) {
  const r = await client.query(
    `INSERT INTO conversation_intelligence_state
       (chat_id,sender_account_id,owner_contact_id,conversation_version,created_at,updated_at)
     VALUES ($1,$2,$3,0,NOW(),NOW())
     ON CONFLICT (chat_id,sender_account_id) DO UPDATE SET owner_contact_id=COALESCE(EXCLUDED.owner_contact_id,conversation_intelligence_state.owner_contact_id),updated_at=NOW()
     RETURNING *`, [chatId, senderAccountId, ownerId])
  await client.query(`SELECT id FROM conversation_intelligence_state WHERE id=$1 FOR UPDATE`, [r.rows[0].id])
  return r.rows[0]
}

async function activeFacts(client, stateId) {
  const r = await client.query(
    `SELECT entity_id AS "entityId",property_id AS "propertyId",sender_account_id AS "senderAccountId",
            field_name AS "fieldName",field_value AS "fieldValue",fact_status AS "factStatus",
            source_message_id AS "sourceMessageId",source_timestamp AS "sourceTimestamp",confidence,
            effective_timestamp AS "effectiveTimestamp",superseded_by AS "supersededBy",last_confirmed_at AS "lastConfirmedAt"
       FROM conversation_facts WHERE state_id=$1 AND fact_status<>'SUPERSEDED' ORDER BY effective_timestamp`, [stateId])
  return r.rows
}

async function persistFacts(client, state, decision, properties, meta) {
  if (meta.edited) {
    await client.query(
      `UPDATE conversation_facts SET fact_status='SUPERSEDED',superseded_by=$2,updated_at=NOW()
        WHERE state_id=$1 AND source_message_id=$2 AND fact_status<>'SUPERSEDED'`, [state.id, meta.messageId])
  }
  const propertyId = properties.length === 1 ? properties[0].id : null
  for (const fact of decision.facts) {
    await client.query(
      `UPDATE conversation_facts SET fact_status='SUPERSEDED',superseded_by=$3,updated_at=NOW()
        WHERE state_id=$1 AND field_name=$2 AND fact_status<>'SUPERSEDED'`, [state.id, fact.fieldName, meta.messageId])
    await client.query(
      `INSERT INTO conversation_facts
       (state_id,entity_id,property_id,sender_account_id,field_name,field_value,fact_status,
        source_message_id,source_type,source_timestamp,confidence,effective_timestamp,last_confirmed_at,evidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'owner_reported',$9,$10,$9,CASE WHEN $7='KNOWN' THEN $9 ELSE NULL END,$11)`,
      [state.id, state.owner_contact_id, propertyId, meta.senderAccountId, fact.fieldName,
       JSON.stringify(fact.fieldValue), fact.factStatus, meta.messageId, meta.timestamp, fact.confidence, fact.evidence])
  }
}

async function applyActions(client, state, decision, properties, meta) {
  const pendingJobs = []
  for (const action of decision.actions) {
    if (action.type === 'CONTACT_OPT_OUT') {
      await client.query(`UPDATE owner_contacts SET do_not_contact=TRUE,updated_at=NOW() WHERE id=$1`, [state.owner_contact_id])
      await client.query(`UPDATE conversation_intelligence_state SET contact_opt_out=TRUE WHERE id=$1`, [state.id])
    }
    if (action.type === 'HUMAN_COMPLIANCE_REVIEW') {
      await client.query(`UPDATE conversation_intelligence_state SET compliance_review_required=TRUE,human_active=TRUE WHERE id=$1`, [state.id])
    }
    if (action.type === 'HUMAN_REVIEW') {
      await client.query(`UPDATE conversation_intelligence_state SET human_active=TRUE WHERE id=$1`, [state.id])
    }
    if (action.type === 'PROPERTY_STATUS') {
      const ids = action.propertyIds?.length ? action.propertyIds : properties.map(p => p.id)
      if (!ids.length) continue
      const dbStatus = action.status === OPERATIONAL_STATUS.RENTED ? 'rented'
        : action.status === OPERATIONAL_STATUS.SOLD ? 'sold' : 'archived'
      const queued = await client.query(
        `SELECT pending_job_id,checklist FROM owner_auto_conversations
          WHERE regexp_replace(COALESCE(phone,''), '\\D', '', 'g')=regexp_replace($1, '\\D', '', 'g')
            AND status IN ('active_collecting','awaiting_auto_publish')`, [meta.phone]).catch(() => ({rows:[]}))
      for (const row of queued.rows) {
        if (row.pending_job_id) pendingJobs.push({ queue:'auto-conversation', id:row.pending_job_id })
        if (row.checklist?._publish_job_id) pendingJobs.push({ queue:'owner-auto-publish', id:row.checklist._publish_job_id })
      }
      await client.query(
        `UPDATE properties SET available_status=$2,operational_status=$3,published=FALSE,updated_at=NOW() WHERE id=ANY($1::int[])`, [ids, dbStatus, action.status])
      await client.query(
        `UPDATE owner_auto_conversations SET status='cancelled_property_status',automation_disabled=TRUE,
                cancelled_reason=$2,pending_job_id=NULL,updated_at=NOW()
          WHERE regexp_replace(COALESCE(phone,''), '\\D', '', 'g')=regexp_replace($1, '\\D', '', 'g')
            AND status IN ('active_collecting','awaiting_auto_publish')`,
        [meta.phone, `conversation_intelligence:${action.status}`]).catch(() => {})
      for (const id of ids) {
        await client.query(
          `INSERT INTO property_operational_status_history(property_id,status,source_message_id,source_timestamp,reason)
           VALUES ($1,$2,$3,$4,$5)`, [id, action.status, meta.messageId, meta.timestamp, action.reason])
      }
    }
  }
  return pendingJobs
}

async function removePendingJobs(jobs) {
  if (!jobs?.length) return
  const { QUEUES } = require('../queues')
  for (const item of jobs) {
    try {
      const job = await QUEUES[item.queue]?.getJob(item.id)
      if (job) await job.remove()
    } catch (err) {
      log.debug('conversationIntelligence queued job already running or absent', { queue:item.queue, err:err.message })
    }
  }
}

async function claimReply(client, stateId, messageId, reply) {
  const key = outboundIdempotencyKey(stateId, messageId, reply)
  const r = await client.query(
    `INSERT INTO conversation_outbound_guard(state_id,source_message_id,idempotency_key,draft,status,created_at)
     VALUES($1,$2,$3,$4,'CLAIMED',NOW()) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [stateId, messageId, key, reply])
  return r.rows[0]?.id || null
}

async function applyCanonicalPropertyFacts(properties, decision, meta) {
  if (properties.length !== 1) return
  const propertyId = properties[0].id
  const mapped = []
  for (const fact of decision.facts) {
    if (fact.fieldName === 'petsAllowed') mapped.push({ field:'pets', value:fact.fieldValue ? 'yes' : 'no', confidence:fact.confidence, evidence:fact.evidence })
    if (fact.fieldName === 'sharingAllowed') mapped.push({ field:'sharing', value:fact.fieldValue, confidence:fact.confidence, evidence:fact.evidence })
    if (fact.fieldName === 'companySubletting') mapped.push({ field:'subletting', value:fact.fieldValue, confidence:fact.confidence, evidence:fact.evidence })
    if (fact.fieldName === 'askingPrice') mapped.push({ field:'price', value:fact.fieldValue, confidence:fact.confidence, evidence:fact.evidence })
    if (fact.fieldName === 'availabilityFrom' && fact.factStatus === 'KNOWN') mapped.push({ field:'available_from', value:fact.fieldValue, confidence:fact.confidence, evidence:fact.evidence })
    if (fact.fieldName === 'address' && fact.fieldValue) {
      await db.query(`UPDATE properties SET street=$2,updated_at=NOW() WHERE id=$1`, [propertyId, String(fact.fieldValue)])
    }
    if (fact.fieldName === 'locality' && fact.fieldValue) {
      await db.query(`UPDATE properties SET town=$2,updated_at=NOW() WHERE id=$1`, [propertyId, String(fact.fieldValue)])
    }
  }
  const compliance = decision.facts.find(f => f.fieldName === 'complianceStatus' && f.fieldValue === OPERATIONAL_STATUS.COMPLIANCE_PENDING)
  const notReady = decision.facts.find(f => f.fieldName === 'availabilityStatus' && f.fieldValue === OPERATIONAL_STATUS.NOT_READY)
  const upcoming = decision.facts.find(f => f.fieldName === 'availabilityFrom' && f.factStatus === 'CONDITIONAL')
  const operationalStatus = compliance ? OPERATIONAL_STATUS.COMPLIANCE_PENDING
    : notReady ? OPERATIONAL_STATUS.NOT_READY : upcoming ? OPERATIONAL_STATUS.UPCOMING : null
  if (operationalStatus) {
    await db.query(`UPDATE properties SET operational_status=$2,updated_at=NOW() WHERE id=$1`, [propertyId, operationalStatus])
  }
  if (mapped.length) {
    await require('./ownerFactEngine').applyFacts(propertyId, mapped, {
      observedAt: meta.timestamp, sourceType: 'conversation_intelligence', reference: meta.messageId,
    })
  }
}

async function handleInbound({ phone, chatId, session='default', text, messageId, timestamp, event, payload } = {}) {
  if (!chatId || !messageId || !String(text || '').trim()) return { suppressAutomation: false, skipped: 'missing_identity_or_text' }
  const owner = await ownerFor(phone, chatId)
  if (!owner) return { suppressAutomation: false, skipped: 'unknown_owner' }
  const properties = await resolveProperties(owner.id, text, chatId)
  const edited = event === 'message.edited' || !!payload?.edited
  const senderAccountId = String(session || 'default').toLowerCase()
  const client = await db.connect()
  let state
  let decision
  let reply = null
  let guardId = null
  let pendingJobs = []
  try {
    await client.query('BEGIN')
    state = await loadState(client, chatId, senderAccountId, owner.id)
    const revision = await client.query(
      `INSERT INTO conversation_message_revisions(state_id,source_message_id,revision_no,event_type,body,body_hash,source_timestamp,received_at)
       VALUES($1,$2,COALESCE((SELECT MAX(revision_no)+1 FROM conversation_message_revisions WHERE state_id=$1 AND source_message_id=$2),1),$3,$4,$5,$6,NOW())
       ON CONFLICT(state_id,source_message_id,body_hash) DO NOTHING RETURNING id`,
      [state.id,messageId,edited?'EDITED':'ORIGINAL',text,digest(text),sourceTimestamp(timestamp)])
    if (!revision.rows.length) { await client.query('ROLLBACK'); return { suppressAutomation: true, duplicate: true } }
    decision = interpretInbound({ text, edited, context: {
      referencedPropertyIds: properties.map(p => p.id), lastQuestionType: state.last_question_type,
      lastAskedField: state.last_asked_field,
    } })
    const ts = sourceTimestamp(timestamp)
    await persistFacts(client, state, decision, properties, { edited, messageId, timestamp: ts, senderAccountId })
    pendingJobs = await applyActions(client, state, decision, properties, { messageId, timestamp: ts, phone })
    await client.query(
      `UPDATE conversation_intelligence_state SET conversation_version=conversation_version+1,
       property_ids=$2::jsonb,last_inbound_message_id=$3,last_inbound_at=$4,updated_at=NOW() WHERE id=$1`,
      [state.id,JSON.stringify(properties.map(p=>p.id)),messageId,ts])
    state.conversation_version = Number(state.conversation_version || 0) + 1
    state.facts = await activeFacts(client, state.id)
    const identity = resolveAgentIdentity(senderAccountId)
    if (!identity && decision.questions.some(q => q === 'agency_identity' || q === 'client_types')) {
      await client.query(`UPDATE conversation_intelligence_state SET human_active=TRUE WHERE id=$1`, [state.id])
      decision.suppressAutomation = true
      log.warn('conversationIntelligence sender identity missing; automated identity reply blocked', { senderAccountId, chatId })
    }
    reply = planDirectReply(decision, identity, state)
    if (reply) {
      const check = validateDraft({ draft: reply, state: {
        conversationVersion: state.conversation_version, contactOptOut: !!state.contact_opt_out,
        humanActive: !!state.human_active, humanComplianceReview: decision.complianceReview || !!state.compliance_review_required,
        facts: state.facts,
      }, identity, expectedConversationVersion: state.conversation_version })
      if (check.allow) guardId = await claimReply(client, state.id, messageId, reply)
      else reply = null
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log.warn('conversationIntelligence inbound failed', { err: err.message, chatId })
    return { suppressAutomation: false, error: err.message }
  } finally { client.release() }

  await removePendingJobs(pendingJobs)

  try {
    await applyCanonicalPropertyFacts(properties, decision, { messageId, timestamp: sourceTimestamp(timestamp) })
  } catch (err) {
    log.warn('conversationIntelligence canonical property sync failed', { err: err.message, chatId })
  }
  if (decision.actions.some(action => action.type === 'PROPERTY_STATUS')) {
    for (const property of properties) {
      try { await require('./matchEngine').invalidateMatchesForProperty(property.id, 'conversation_intelligence_status') }
      catch (err) { log.warn('conversationIntelligence match invalidation failed', { propertyId:property.id, err:err.message }) }
    }
  }

  let replySent = false
  if (reply && guardId) {
    const preflight = await preflightOutbound({ phone, session, chatId, draft: reply,
      expectedConversationVersion: state.conversation_version, kind: 'direct_answer' })
    if (preflight.allow) {
      try {
        const sent = await waha.sendText(session, chatId, reply)
        await db.query(`UPDATE conversation_outbound_guard SET status='SENT',sent_message_id=$2,sent_at=NOW() WHERE id=$1`, [guardId, sent?.key?.id || sent?.id || null])
        replySent = true
      } catch (err) {
        await db.query(`UPDATE conversation_outbound_guard SET status='FAILED',failure_reason=$2 WHERE id=$1`, [guardId, String(err.message || err).slice(0,500)]).catch(()=>{})
      }
    } else await db.query(`UPDATE conversation_outbound_guard SET status='BLOCKED',failure_reason=$2 WHERE id=$1`, [guardId, preflight.reason]).catch(()=>{})
  }
  return { suppressAutomation: decision.suppressAutomation || !!reply, replySent, decision }
}

async function preflightOutbound({ phone, session='default', chatId, draft, expectedConversationVersion=null, kind=null } = {}) {
  const r = await db.query(
    `SELECT s.*, COALESCE(json_agg(json_build_object('fieldName',f.field_name,'fieldValue',f.field_value,'factStatus',f.fact_status)) FILTER (WHERE f.id IS NOT NULL),'[]') AS facts
       FROM conversation_intelligence_state s LEFT JOIN conversation_facts f ON f.state_id=s.id AND f.fact_status<>'SUPERSEDED'
      WHERE s.chat_id=$1 AND s.sender_account_id=$2 GROUP BY s.id`, [chatId || `${normalizePhone(phone)}@c.us`, String(session).toLowerCase()]).catch(() => ({rows:[]}))
  if (!r.rows[0]) return { allow: true, reason: null }
  const row = r.rows[0]
  if (row.contact_opt_out && kind === 'direct_answer' && /^Understood\. I will not contact you again\.$/.test(String(draft || ''))
      && (expectedConversationVersion == null || Number(expectedConversationVersion) === Number(row.conversation_version))) {
    return { allow: true, reason: null }
  }
  return validateDraft({ draft, state: {
    conversationVersion: row.conversation_version, contactOptOut: row.contact_opt_out,
    humanActive: row.human_active, humanComplianceReview: row.compliance_review_required, facts: row.facts,
  }, identity: resolveAgentIdentity(session), expectedConversationVersion })
}

async function markHumanActive({ chatId, session='default', active=true } = {}) {
  await db.query(`UPDATE conversation_intelligence_state SET human_active=$3,updated_at=NOW() WHERE chat_id=$1 AND sender_account_id=$2`, [chatId,String(session).toLowerCase(),!!active])
}

async function recordQuestionContext({ chatId, session='default', questionType=null, askedField=null, propertyIds=[] } = {}) {
  if (!chatId) throw new Error('chatId_required')
  await db.query(
    `INSERT INTO conversation_intelligence_state
       (chat_id,sender_account_id,conversation_version,property_ids,last_question_type,last_asked_field,created_at,updated_at)
     VALUES($1,$2,0,$3::jsonb,$4,$5,NOW(),NOW())
     ON CONFLICT(chat_id,sender_account_id) DO UPDATE SET
       property_ids=EXCLUDED.property_ids,last_question_type=EXCLUDED.last_question_type,
       last_asked_field=EXCLUDED.last_asked_field,updated_at=NOW()`,
    [chatId,String(session).toLowerCase(),JSON.stringify(propertyIds),questionType,askedField])
}

module.exports = { handleInbound, preflightOutbound, markHumanActive, recordQuestionContext, normalizePhone, sourceTimestamp, outboundIdempotencyKey }
