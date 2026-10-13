'use strict'

const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const ownerSendGate = require('./ownerSendGate')

const EXPLICIT = 'EXPLICIT_APPROVAL_REQUIRED'
const TRUSTED_TIMEOUT = 'TRUSTED_AGENT_TIMEOUT_CREATE'
const REQUEST_TTL_MS = Number(process.env.OWNER_GROUP_REQUEST_TTL_MS) || 60 * 60_000

const digits = v => String(v || '').replace(/\D/g, '')
const trim = (v, n = 500) => String(v || '').trim().slice(0, n)
const lower = v => String(v || '').trim().toLowerCase()

function canCreateOwnerGroup(agent) {
  return !!agent && (agent.role === 'admin' || agent.can_create_owner_group === true)
}

function classifyOwnerReply(text) {
  const s = lower(text).replace(/[.!?,;:]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return 'UNKNOWN'
  if (/\b(who|what|why|how|which|explain|tell me|chi|xiex|għaliex|kif)\b/.test(s) || s.endsWith('?')) return 'QUESTION'
  if (/^(no problem|not a problem)(\b|$)/.test(s)) return 'APPROVED'
  if (/\b(no|nope|decline|prefer to deal|not now|do not|don't|stop|le|mhux|ma rridx)\b/.test(s)) return 'DECLINED'
  if (/^(yes|yep|yeah|ok|okay|sure|approved|go ahead|fine|no problem|iva|mela)(\b|$)/.test(s)) return 'APPROVED'
  return 'UNKNOWN'
}

async function event(requestId, eventType, actorType = 'system', actorId = null, details = {}) {
  await db.query(
    `INSERT INTO owner_group_request_events(request_id,event_type,actor_type,actor_id,details)
     VALUES($1,$2,$3,$4,$5::jsonb)`,
    [requestId, eventType, actorType, actorId == null ? null : String(actorId), JSON.stringify(details)])
}

async function resolveSourceSession(ownerId) {
  const r = await db.query(
    `SELECT oal.account_session, wa.phone
       FROM owner_account_labels oal
       JOIN whatsapp_accounts wa ON LOWER(wa.session_name)=LOWER(oal.account_session)
      WHERE oal.contact_id=$1 AND wa.is_active=TRUE
      ORDER BY COALESCE(oal.last_reply_at,oal.last_we_sent_at,oal.updated_at,oal.created_at) DESC NULLS LAST,
               wa.priority ASC, oal.id DESC LIMIT 1`, [ownerId])
  if (r.rows[0]) return { session: r.rows[0].account_session, creatorPhone: r.rows[0].phone }
  throw new Error('No verified owner-source WhatsApp session is available.')
}

function ownerMessage({ ownerName, agentName, ref, town, clients, relationship, moveInDate, viewingIntent, note }) {
  const first = trim(ownerName, 80).split(/\s+/)[0] || 'there'
  const clientNames = clients.map(c => trim(c.name, 80)).filter(Boolean)
  const context = []
  if (clientNames.length) context.push(`with ${clientNames.join(' and ')}`)
  if (relationship) context.push(`(${trim(relationship, 80)})`)
  if (moveInDate) context.push(`move-in ${moveInDate}`)
  if (viewingIntent) context.push(trim(viewingIntent, 160))
  const detail = context.length ? ` ${context.join(' · ')}` : ''
  const noteLine = note ? `\nNote from ${trim(agentName, 80)}: ${trim(note, 260)}` : ''
  return `Hi ${first}, ${trim(agentName, 80)} from 2906 would like to open a WhatsApp group for #${trim(ref, 40)}${town ? ` in ${trim(town, 80)}` : ''}${detail}. This would let you coordinate directly while 2906 remains in the group.${noteLine}\n\nIs that okay? Please reply YES or NO. This request expires in 60 minutes.`
}

async function loadContext(propertyRef, agentId) {
  const r = await db.query(
    `SELECT p.id AS property_id,p.ref,p.town,p.street,p.apt,p.public_payload,p.owner_id,
            oc.name AS owner_name,oc.phone_normalized AS owner_phone,oc.owner_group_policy,oc.owner_group_trusted_relationships,
            a.id AS agent_id,a.name AS agent_name,a.username,a.notify_whatsapp,a.whatsapp_phone,
            a.can_create_owner_group,a.role
       FROM properties p JOIN owner_contacts oc ON oc.id=p.owner_id
       JOIN agents a ON a.id=$2 WHERE LOWER(p.ref)=LOWER($1) LIMIT 1`,
    [propertyRef, agentId])
  const row = r.rows[0]
  if (!row) throw Object.assign(new Error('Property or agent not found.'), { statusCode: 404 })
  if (!canCreateOwnerGroup(row)) throw Object.assign(new Error('Create Group ★ is not enabled for this profile.'), { statusCode: 403 })
  return row
}

async function listClientChoices(agentId, query = '') {
  const params = [agentId]
  let where = `c.is_active IS DISTINCT FROM FALSE AND c.status IS DISTINCT FROM 'archived'`
  if (query) { params.push(`%${trim(query, 80)}%`); where += ` AND c.name ILIKE $2` }
  const r = await db.query(
    `SELECT c.id,c.name,c.move_in_date,c.move_in_to,c.relation,c.group_type,c.nationalities,c.profession
       FROM clients c WHERE ${where}
      ORDER BY CASE WHEN LOWER(COALESCE(c.assigned_agent,''))=(SELECT LOWER(COALESCE(name,username,'')) FROM agents WHERE id=$1) THEN 0 ELSE 1 END,
               c.updated_at DESC NULLS LAST LIMIT 40`, params)
  return r.rows.map(c => ({ id:c.id, name:c.name || 'Client', moveInDate:c.move_in_date || c.move_in_to || null,
    relationship:c.relation || c.group_type || null, nationality:Array.isArray(c.nationalities)?c.nationalities.join(', '):null,
    work:c.profession || null }))
}

async function createRequest({ propertyRef, agentId, clientIds = [], relationship = null, moveInDate = null, viewingIntent = null, note = null, viewingId = null }) {
  const ctx = await loadContext(propertyRef, agentId)
  const gate = await ownerSendGate.checkOwnerSend({
    phone: ctx.owner_phone, ownerId: ctx.owner_id, propertyId: ctx.property_id,
    kind: 'viewing', automated: false,
  })
  if (!gate.allow) throw Object.assign(new Error(`Owner request blocked: ${ownerSendGate.describeBlock(gate.reason)}.`), { statusCode: 409, code: gate.reason })

  const ids = [...new Set((Array.isArray(clientIds) ? clientIds : []).map(String).filter(Boolean))].slice(0, 12)
  const cr = ids.length ? await db.query(
    `SELECT id,name,move_in_date,move_in_to,relation,group_type,nationalities,profession
       FROM clients WHERE id = ANY($1::text[])`, [ids]) : { rows: [] }
  const clients = cr.rows.map(c => ({ id:c.id, name:c.name || 'Client', moveInDate:c.move_in_date || c.move_in_to || null,
    relationship:c.relation || c.group_type || null, nationality:Array.isArray(c.nationalities)?c.nationalities.join(', '):null,
    work:c.profession || null }))
  const source = await resolveSourceSession(ctx.owner_id)
  const trustedRelationships = Array.isArray(ctx.owner_group_trusted_relationships) ? ctx.owner_group_trusted_relationships.map(lower) : []
  const relationshipAllowed = trustedRelationships.includes('*') || (!!relationship && trustedRelationships.includes(lower(relationship)))
  const policy = ctx.owner_group_policy === TRUSTED_TIMEOUT && relationshipAllowed ? TRUSTED_TIMEOUT : EXPLICIT
  const message = ownerMessage({ ownerName:ctx.owner_name, agentName:ctx.agent_name || ctx.username, ref:ctx.ref, town:ctx.town,
    clients, relationship, moveInDate, viewingIntent, note })
  const chatId = `${digits(ctx.owner_phone)}@c.us`
  let row
  try {
    const inserted = await db.query(
      `INSERT INTO owner_group_requests(property_id,owner_id,requesting_agent_id,viewing_id,source_session,source_chat_id,
         status,approval_policy,expires_at,linked_client_ids,client_context,relationship,move_in_date,viewing_intent,requester_note,owner_message)
       VALUES($1,$2,$3,$4,$5,$6,'GROUP_REQUEST_DRAFT',$7,NOW()+($8::bigint*INTERVAL '1 millisecond'),$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)
       RETURNING *`, [ctx.property_id,ctx.owner_id,agentId,viewingId||null,source.session,chatId,policy,REQUEST_TTL_MS,
        JSON.stringify(ids),JSON.stringify(clients),trim(relationship,120)||null,moveInDate||null,trim(viewingIntent,240)||null,trim(note,500)||null,message])
    row = inserted.rows[0]
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('An owner group request is already open for this property.'), { statusCode: 409 })
    throw err
  }
  await event(row.request_id, 'GROUP_REQUEST_DRAFTED', 'agent', agentId, { propertyRef:ctx.ref, policy, clientCount:clients.length })
  try {
    const sent = await waha.sendText(source.session, chatId, message, { timeoutMs: 30_000 })
    const messageId = sent?.key?.id || sent?.id || null
    const u = await db.query(
      `UPDATE owner_group_requests SET status='GROUP_REQUEST_PENDING',source_message_id=$2,updated_at=NOW()
        WHERE request_id=$1 AND status='GROUP_REQUEST_DRAFT' RETURNING *`, [row.request_id,messageId])
    row = u.rows[0]
    await event(row.request_id, 'OWNER_REQUEST_SENT', 'system', null, { session:source.session, messageId })
  } catch (err) {
    await db.query(`UPDATE owner_group_requests SET status='GROUP_REQUEST_FAILED',last_error=$2,updated_at=NOW() WHERE request_id=$1`, [row.request_id, trim(err.message,500)])
    await event(row.request_id, 'OWNER_REQUEST_SEND_FAILED', 'system', null, { error:trim(err.message,300) })
    throw Object.assign(new Error(`Owner request could not be sent: ${trim(err.message,180)}`), { statusCode: 502 })
  }
  return publicRequest(row)
}

function publicRequest(r) {
  if (!r) return null
  return { requestId:r.request_id,status:r.status,approvalPolicy:r.approval_policy,expiresAt:r.expires_at,
    groupJid:r.group_jid||null,groupName:r.group_name||null,createdAt:r.created_at,updatedAt:r.updated_at,
    lastError:r.last_error||null,clientCount:Array.isArray(r.client_context)?r.client_context.length:0 }
}

async function createGroupForRequest(requestId, resolutionSource) {
  const client = await db.connect()
  let row
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [String(requestId)])
    const r = await client.query(
      `SELECT ogr.*,p.ref,p.town,p.street,p.apt,p.public_payload,oc.name AS owner_name,oc.phone_normalized AS owner_phone,
              a.name AS agent_name,a.username,a.notify_whatsapp,a.whatsapp_phone,wa.phone AS creator_phone
         FROM owner_group_requests ogr JOIN properties p ON p.id=ogr.property_id JOIN owner_contacts oc ON oc.id=ogr.owner_id
         JOIN agents a ON a.id=ogr.requesting_agent_id LEFT JOIN whatsapp_accounts wa ON LOWER(wa.session_name)=LOWER(ogr.source_session)
        WHERE ogr.request_id=$1 FOR UPDATE OF ogr`, [requestId])
    row = r.rows[0]
    if (!row) throw new Error('Owner group request not found.')
    if (row.group_jid || ['GROUP_CREATED','GROUP_ACTIVE','GROUP_CLOSED'].includes(row.status)) { await client.query('COMMIT'); return publicRequest(row) }
    if (!['GROUP_REQUEST_APPROVED','GROUP_REQUEST_TIMEOUT'].includes(row.status)) { await client.query('COMMIT'); return publicRequest(row) }
    const claimed = await client.query(
      `UPDATE owner_group_requests SET status='GROUP_CREATING',resolution_source=$2,updated_at=NOW()
        WHERE request_id=$1 AND status=$3 RETURNING *`, [requestId,resolutionSource,row.status])
    if (!claimed.rows.length) { await client.query('COMMIT'); return publicRequest(row) }
    await client.query('COMMIT')
  } catch (err) { await client.query('ROLLBACK').catch(()=>{}); throw err } finally { client.release() }

  try {
    const finalGate = await ownerSendGate.checkOwnerSend({ phone:row.owner_phone,ownerId:row.owner_id,propertyId:row.property_id,kind:'viewing',automated:false })
    if (!finalGate.allow) {
      await db.query(`UPDATE owner_group_requests SET status='GROUP_REQUEST_FAILED',last_error=$2,updated_at=NOW() WHERE request_id=$1 AND status='GROUP_CREATING'`,
        [requestId,`Final owner gate blocked creation: ${finalGate.reason}`])
      await event(requestId,'GROUP_CREATION_BLOCKED','system',null,{reason:finalGate.reason})
      return publicRequest((await db.query(`SELECT * FROM owner_group_requests WHERE request_id=$1`,[requestId])).rows[0])
    }
    const upload = require('../handlers/upload')
    const created = await upload.createViewingGroup({
      c:{ propId:row.property_id,ref:row.ref,ownerPhone:row.owner_phone,ownerName:row.owner_name,town:row.town,
        street:row.street,apt:row.apt,publicPayload:row.public_payload,description:row.public_payload?.description_social||null },
      uploaderPhone:row.creator_phone,
      groupOptions:{ requesterPhone:row.notify_whatsapp||row.whatsapp_phone,requesterName:row.agent_name||row.username,
        timeoutCreated:resolutionSource==='timeout' },
    })
    const u = await db.query(
      `UPDATE owner_group_requests SET status='GROUP_CREATED',group_jid=$2,group_name=$3,group_created_at=NOW(),updated_at=NOW()
        WHERE request_id=$1 AND status='GROUP_CREATING' RETURNING *`, [requestId,created.groupId,created.name])
    if (row.viewing_id) await db.query(
      `UPDATE property_viewings SET viewing_group_jid=$2,group_created_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND viewing_group_jid IS NULL`, [row.viewing_id,created.groupId])
    await event(requestId,'GROUP_CREATED','system',null,{ groupJid:created.groupId,resolutionSource,failedParticipants:created.failed||[] })
    return publicRequest(u.rows[0])
  } catch (err) {
    // WAHA may have accepted createGroup before the transport failed. Never retry
    // from this state: an admin must reconcile the WhatsApp group first.
    await db.query(`UPDATE owner_group_requests SET status='GROUP_CREATION_AMBIGUOUS',last_error=$2,updated_at=NOW() WHERE request_id=$1 AND status='GROUP_CREATING'`, [requestId,trim(err.message,500)])
    await event(requestId,'GROUP_CREATION_AMBIGUOUS','system',null,{ error:trim(err.message,300) })
    throw err
  }
}

async function handleOwnerReply({ session, text, senderPhone, payload }) {
  const phone = digits(senderPhone || payload?.from)
  if (!phone || !session) return { handled:false }
  const r = await db.query(
    `SELECT ogr.request_id FROM owner_group_requests ogr JOIN owner_contacts oc ON oc.id=ogr.owner_id
      WHERE ogr.status='GROUP_REQUEST_PENDING' AND LOWER(ogr.source_session)=LOWER($1)
        AND RIGHT(regexp_replace(COALESCE(oc.phone_normalized,''),'\\D','','g'),9)=RIGHT($2,9)
      ORDER BY ogr.created_at DESC LIMIT 1`, [session,phone])
  if (!r.rows[0]) return { handled:false }
  const requestId = r.rows[0].request_id
  const decision = classifyOwnerReply(text)
  const messageId = payload?.id || payload?.key?.id || null
  if (decision === 'QUESTION' || decision === 'UNKNOWN') {
    await event(requestId,decision === 'QUESTION'?'OWNER_QUESTION':'OWNER_REPLY_UNCLEAR','owner',phone.slice(-4),{ text:trim(text,500),messageId })
    return { handled:true,decision }
  }
  const next = decision === 'APPROVED' ? 'GROUP_REQUEST_APPROVED' : 'GROUP_REQUEST_DECLINED'
  const u = await db.query(
    `UPDATE owner_group_requests SET status=$2,owner_reply_text=$3,owner_reply_message_id=$4,owner_replied_at=NOW(),resolution_source='owner_reply',updated_at=NOW()
      WHERE request_id=$1 AND status='GROUP_REQUEST_PENDING' RETURNING *`, [requestId,next,trim(text,1000),messageId])
  if (!u.rows.length) return { handled:true,decision:'LOST_RACE' }
  await event(requestId,next,'owner',phone.slice(-4),{ text:trim(text,500),messageId })
  if (decision === 'APPROVED') await createGroupForRequest(requestId,'owner_reply')
  return { handled:true,decision }
}

async function reconcileExpired() {
  const r = await db.query(
    `UPDATE owner_group_requests SET status='GROUP_REQUEST_TIMEOUT',resolution_source='timeout',updated_at=NOW()
      WHERE request_id IN (
        SELECT request_id FROM owner_group_requests WHERE status='GROUP_REQUEST_PENDING' AND expires_at<=NOW()
        ORDER BY expires_at ASC FOR UPDATE SKIP LOCKED LIMIT 25
      ) AND status='GROUP_REQUEST_PENDING' RETURNING request_id,approval_policy`)
  for (const row of r.rows) {
    await event(row.request_id,'GROUP_REQUEST_TIMEOUT','system',null,{ policy:row.approval_policy })
    if (row.approval_policy === TRUSTED_TIMEOUT) {
      try { await createGroupForRequest(row.request_id,'timeout') }
      catch (err) { log.error('owner group timeout create failed',{ requestId:row.request_id,err:err.message }) }
    }
  }
  return r.rows.length
}

async function getLatestForProperty(propertyId, agentId = null) {
  const params=[propertyId]
  let agent=` `
  if(agentId){params.push(agentId);agent=` AND requesting_agent_id=$2`}
  const r=await db.query(`SELECT * FROM owner_group_requests WHERE property_id=$1${agent} ORDER BY created_at DESC LIMIT 1`,params)
  return publicRequest(r.rows[0])
}

async function getAgentHistory(agentId) {
  const r=await db.query(
    `SELECT ogr.*,p.ref,p.town FROM owner_group_requests ogr JOIN properties p ON p.id=ogr.property_id
      WHERE ogr.requesting_agent_id=$1 ORDER BY ogr.created_at DESC LIMIT 100`,[agentId])
  return r.rows.map(x=>({...publicRequest(x),propertyRef:x.ref,town:x.town,clients:(x.client_context||[]).map(c=>({id:c.id,name:c.name}))}))
}

async function recordGroupEvent({ groupJid, session, messageId, senderPhone, text, fromMe = false }) {
  const r=await db.query(`SELECT request_id FROM owner_group_requests WHERE group_jid=$1 AND status IN ('GROUP_CREATED','GROUP_ACTIVE') LIMIT 1`,[groupJid])
  if(!r.rows[0]) return false
  await db.query(`UPDATE owner_group_requests SET status='GROUP_ACTIVE',updated_at=NOW() WHERE request_id=$1 AND status='GROUP_CREATED'`,[r.rows[0].request_id])
  await event(r.rows[0].request_id,'GROUP_MESSAGE',fromMe?'agent':'participant',senderPhone?digits(senderPhone).slice(-4):null,
    {session,messageId:messageId||null,text:trim(text,1000)})
  return true
}

module.exports={EXPLICIT,TRUSTED_TIMEOUT,canCreateOwnerGroup,classifyOwnerReply,ownerMessage,listClientChoices,
  createRequest,handleOwnerReply,reconcileExpired,createGroupForRequest,getLatestForProperty,getAgentHistory,recordGroupEvent,publicRequest}
