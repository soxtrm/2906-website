'use strict'

const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const ownerAssistant = require('./ownerAssistant')
const ownerSendGate = require('./ownerSendGate')
const { UI_STATUS, statusText, deriveAutomationStatus } = require('./automationStatus')

async function latestAssistantState({ ownerId, chatId, session }) {
  const values = []
  const where = []
  if (ownerId) { values.push(ownerId); where.push(`owner_contact_id=$${values.length}`) }
  if (chatId) { values.push(chatId); where.push(`chat_id=$${values.length}`) }
  if (session) { values.push(session); where.push(`lower(session)=lower($${values.length})`) }
  if (!where.length) return null
  const r = await db.query(
    `SELECT * FROM owner_assistant_state WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT 1`, values)
  return r.rows[0] || null
}

async function automationSnapshot({ ownerId, chatId, session, ownerPhone }) {
  const assistant = await latestAssistantState({ ownerId, chatId, session })
  const effectiveSession = assistant?.session || session || 'default'
  const intelligence = (await db.query(
    `SELECT * FROM conversation_intelligence_state
      WHERE ($1::int IS NULL OR owner_contact_id=$1)
        AND ($2::text IS NULL OR chat_id=$2)
      ORDER BY updated_at DESC,id DESC LIMIT 1`, [ownerId || null, chatId || null]).catch(() => ({ rows: [] }))).rows[0] || null
  const processing = intelligence ? (await db.query(
    `SELECT processing_status,reason_code,reason_detail,created_at
       FROM conversation_processing_events WHERE state_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [intelligence.id]).catch(() => ({ rows: [] }))).rows[0] || null : null

  let connection = 'UNKNOWN'
  try { connection = statusText(await waha.getSessionStatus(effectiveSession)) || 'UNKNOWN' }
  catch (err) { connection = 'ERROR'; log.debug('conversationRecovery WAHA status failed', { session: effectiveSession, err: err.message }) }

  const phone = ownerPhone || assistant?.owner_phone || null
  const standDown = phone ? await ownerSendGate.getStandDownReason(phone).catch(() => null) : null
  const derived = deriveAutomationStatus({ connection,assistant,intelligence,standDown,describeBlock:ownerSendGate.describeBlock })
  const status = derived.status
  const reason = derived.reason && derived.status === UI_STATUS.CONNECTION_ERROR
    ? derived.reason.replace('WhatsApp session is', `WhatsApp session ${effectiveSession} is`)
    : derived.reason

  return {
    status, reason, connection, session: effectiveSession,
    assistantState: assistant?.status || null,
    lastInbound: processing ? {
      status: processing.processing_status,
      reasonCode: processing.reason_code,
      reason: processing.reason_detail,
      at: processing.created_at,
    } : null,
    canPause: status === UI_STATUS.ACTIVE,
    canResume: status === UI_STATUS.PAUSED || status === UI_STATUS.TAKEOVER,
  }
}

async function setAutomationStatus({ ownerId, chatId, session, ownerPhone, agentId, action, reason }) {
  const state = await latestAssistantState({ ownerId, chatId, session })
  if (!state) return { ok: false, reason: 'no_assistant_state' }
  if (action === 'pause') {
    await ownerAssistant.cancelPendingJob(state.pending_job_id)
    await db.query(
      `UPDATE owner_assistant_state SET status='PAUSED',pending_job_id=NULL,updated_at=NOW() WHERE id=$1`, [state.id])
    await db.query(
      `UPDATE conversation_intelligence_state SET automation_status=$4,automation_reason=$5,
              automation_changed_by_agent_id=$3,automation_changed_at=NOW(),updated_at=NOW()
        WHERE ($1::int IS NULL OR owner_contact_id=$1) AND ($2::text IS NULL OR chat_id=$2)`,
      [ownerId || null,chatId || null,agentId || null,UI_STATUS.PAUSED,String(reason || 'Paused by an authorized agent').slice(0,300)])
    await ownerAssistant.logEvent(state.id, 'crm_ai_paused', { agentId, reason: reason || null })
    return { ok: true, status: UI_STATUS.PAUSED }
  }
  if (action === 'resume') {
    const phone = ownerPhone || state.owner_phone
    if (phone) {
      const gate = await ownerSendGate.checkOwnerSend({ phone, ownerId, automated: true, kind: 'followup' })
      if (!gate.allow && ['do_not_contact','blacklisted','contact_opt_out'].some(code => String(gate.reason || '').includes(code))) {
        return { ok: false, reason: gate.reason }
      }
      await ownerSendGate.resumeOwnerFlow({ phone, session: state.session, reason: `CRM explicit resume by agent ${agentId}` })
    }
    const enabled = await ownerAssistant.enable(state)
    if (!enabled.ok) return enabled
    await db.query(
      `UPDATE conversation_intelligence_state SET human_active=FALSE,automation_status=$4,automation_reason=$5,
              automation_changed_by_agent_id=$3,automation_changed_at=NOW(),updated_at=NOW()
        WHERE ($1::int IS NULL OR owner_contact_id=$1) AND ($2::text IS NULL OR chat_id=$2)`,
      [ownerId || null,chatId || null,agentId || null,UI_STATUS.ACTIVE,String(reason || 'Resumed explicitly by an authorized agent').slice(0,300)])
    await ownerAssistant.logEvent(state.id, 'crm_ai_resumed', { agentId, reason: reason || null })
    return { ok: true, status: UI_STATUS.ACTIVE }
  }
  return { ok: false, reason: 'invalid_action' }
}

async function ownerFacts({ ownerId, propertyId, includeRestricted = false }) {
  if (!ownerId) return { facts: [], pendingReview: [] }
  const r = await db.query(
    `SELECT f.id,f.property_id,f.field_name,f.field_value,f.fact_status,f.confidence,
            f.source_message_id,f.source_timestamp,f.last_confirmed_at,f.evidence,f.access_scope,
            p.ref
       FROM conversation_facts f
       JOIN conversation_intelligence_state s ON s.id=f.state_id
       LEFT JOIN properties p ON p.id=f.property_id
      WHERE s.owner_contact_id=$1 AND f.fact_status<>'SUPERSEDED' AND f.dismissed_at IS NULL
        AND ($2::int IS NULL OR f.property_id=$2 OR f.property_id IS NULL)
        AND ($3::boolean OR f.access_scope<>'COMPLIANCE_RESTRICTED')
      ORDER BY COALESCE(f.last_confirmed_at,f.source_timestamp) DESC,f.id DESC`,
    [ownerId,propertyId || null,!!includeRestricted])
  const review = await db.query(
    `SELECT id,review_type,reason,evidence,candidate_property_ids,created_at
       FROM conversation_review_tasks WHERE owner_contact_id=$1 AND status='OPEN'
       ORDER BY created_at DESC LIMIT 10`, [ownerId]).catch(() => ({ rows: [] }))
  return {
    facts: r.rows.map(row => ({
      id: row.id, propertyId: row.property_id, ref: row.ref || null,
      field: row.field_name, value: row.field_value, status: row.fact_status,
      confidence: Number(row.confidence), sourceMessageId: row.source_message_id,
      sourceTimestamp: row.source_timestamp, lastConfirmedAt: row.last_confirmed_at,
      evidence: row.evidence, restricted: row.access_scope === 'COMPLIANCE_RESTRICTED',
    })),
    pendingReview: review.rows.map(row => ({
      id: row.id, type: row.review_type, reason: row.reason, evidence: row.evidence,
      candidatePropertyIds: row.candidate_property_ids, createdAt: row.created_at,
    })),
  }
}

async function updateFact({ factId, agentId, action, value, note }) {
  const client = await db.connect()
  let projection = null
  try {
    await client.query('BEGIN')
    const current = (await client.query(
      `SELECT f.*,s.owner_contact_id FROM conversation_facts f
         JOIN conversation_intelligence_state s ON s.id=f.state_id WHERE f.id=$1 FOR UPDATE`, [factId])).rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'not_found' }
    }
    if (action === 'dismiss') {
      await client.query(
        `UPDATE conversation_facts SET fact_status='SUPERSEDED',dismissed_at=NOW(),dismissed_by_agent_id=$2,
                correction_note=$3,updated_at=NOW() WHERE id=$1`,
        [factId,agentId || null,String(note || 'Dismissed in Owner Facts').slice(0,300)])
      await client.query('COMMIT')
      return { ok: true, dismissed: true }
    }
    if (action !== 'correct') {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'invalid_action' }
    }
    const source = `agent-correction:${agentId}:${Date.now()}`
    const inserted = await client.query(
      `INSERT INTO conversation_facts
         (state_id,entity_id,property_id,sender_account_id,field_name,field_value,fact_status,source_message_id,
          source_type,source_timestamp,confidence,effective_timestamp,last_confirmed_at,evidence,access_scope,correction_note)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,'KNOWN',$7,'agent_correction',NOW(),1,NOW(),NOW(),$8,$9,$10) RETURNING id`,
      [current.state_id,current.entity_id,current.property_id,current.sender_account_id,current.field_name,
       JSON.stringify(value),source,String(note || 'Corrected by authorized agent').slice(0,500),current.access_scope || 'AUTHORIZED_AGENT',
       String(note || '').slice(0,300)])
    await client.query(
      `UPDATE conversation_facts SET fact_status='SUPERSEDED',superseded_by=$2,updated_at=NOW() WHERE id=$1`,
      [factId,source])

    if (current.property_id && current.field_name === 'availabilityStatus') {
      const normalized = String(value || '').toUpperCase()
      const available = normalized === 'AVAILABLE'
      await client.query(
        `UPDATE properties SET available_status=$2,operational_status=$3,
                published=CASE WHEN $4 THEN published ELSE FALSE END,updated_at=NOW() WHERE id=$1`,
        [current.property_id,available ? 'available' : normalized.toLowerCase(),normalized,available])
      await client.query(
        `INSERT INTO property_operational_status_history(property_id,status,source_message_id,source_timestamp,reason)
         VALUES($1,$2,$3,NOW(),$4)`,
        [current.property_id,normalized,source,String(note || 'Agent corrected an extracted Owner Fact').slice(0,500)])
    } else if (current.property_id) {
      const map = { askingPrice:'price', availabilityFrom:'available_from', petsAllowed:'pets', sharingAllowed:'sharing', companySubletting:'subletting' }
      if (map[current.field_name]) projection = {
        propertyId:current.property_id,field:map[current.field_name],source,
      }
    }
    await client.query('COMMIT')
    if (projection) await require('./ownerFactEngine').applyFacts(projection.propertyId, [{
      field:projection.field,value,confidence:1,evidence:note || 'Agent correction',
    }], { observedAt:new Date(),sourceType:'agent_correction',reference:projection.source })
    return { ok: true, corrected: true, factId: inserted.rows[0].id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { UI_STATUS, automationSnapshot, setAutomationStatus, ownerFacts, updateFact, latestAssistantState }
