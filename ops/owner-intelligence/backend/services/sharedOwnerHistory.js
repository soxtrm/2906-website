'use strict'

// Shared, privacy-safe projection of the canonical relay store.  This module
// never rewrites or deletes the original message.  It authorizes the viewer,
// reads the real persisted rows and redacts the response before it leaves the
// backend.
const { redactBusinessMessage,restrictDiscriminatoryClauses,agencyMatches } = require('./sharedOwnerPrivacy')
let queryOverride = null
function queryImpl(...args) { return queryOverride ? queryOverride(...args) : require('../db').query(...args) }
function setQueryForTests(fn) { queryOverride = fn || null }

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100
const HISTORY_LOOKBACK = 500


function parseCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (!parsed.at || !Number.isInteger(Number(parsed.id))) return null
    return { at: new Date(parsed.at), id: Number(parsed.id) }
  } catch { return null }
}

function makeCursor(row) {
  if (!row) return null
  return Buffer.from(JSON.stringify({ at: row.created_at, id: Number(row.id) }), 'utf8').toString('base64url')
}

async function propertyAccess(ref, viewer) {
  const row = (await queryImpl(
    `SELECT p.id,p.ref,p.owner_id,p.agency_id,p.listed_by_agent_id,p.available_status,p.available_date,
            p.bedrooms,p.longlet_price,p.sale_price,p.last_confirmed_available_at,
            COALESCE(jsonb_array_length(COALESCE(p.public_payload->'images','[]'::jsonb)),0)::int AS photo_count,
            oc.name AS owner_name,oc.phone_normalized AS owner_phone,oc.email AS owner_email,
            oc.location AS owner_private_address,oc.assigned_agent_id
       FROM properties p
       LEFT JOIN owner_contacts oc ON oc.id=p.owner_id
      WHERE LOWER(p.ref)=LOWER($1) LIMIT 1`, [ref])).rows[0]
  if (!row) return { reason: 'not_found' }
  if (!agencyMatches(viewer.agency_id, row.agency_id)) return { reason: 'forbidden' }
  if (viewer.role === 'admin' || row.listed_by_agent_id === viewer.id || row.assigned_agent_id === viewer.id) return { resource: row }
  const linked = (await queryImpl(
    `SELECT 1
       WHERE EXISTS (SELECT 1 FROM book_relay_threads t WHERE t.property_id=$1 AND t.agent_id=$2 AND t.agency_id=$3)
          OR EXISTS (SELECT 1 FROM property_viewings v WHERE v.property_id=$1 AND (v.viewing_agent_id=$2 OR v.user_id=$2))
          OR EXISTS (SELECT 1 FROM owner_group_requests r WHERE r.property_id=$1 AND r.requesting_agent_id=$2)
          OR EXISTS (SELECT 1 FROM availability_checks c WHERE c.property_id=$1 AND c.requester_agent_id=$2)`,
    [row.id, viewer.id, viewer.agency_id])).rows.length > 0
  return linked ? { resource: row } : { reason: 'forbidden' }
}

async function ownerAccess(ownerId, viewer) {
  const row = (await queryImpl(
    `SELECT oc.id AS owner_id,oc.agency_id,oc.name AS owner_name,oc.phone_normalized AS owner_phone,
            oc.email AS owner_email,oc.location AS owner_private_address,oc.assigned_agent_id
       FROM owner_contacts oc WHERE oc.id=$1 LIMIT 1`, [ownerId])).rows[0]
  if (!row) return { reason: 'not_found' }
  if (!agencyMatches(viewer.agency_id, row.agency_id)) return { reason: 'forbidden' }
  if (viewer.role === 'admin' || row.assigned_agent_id === viewer.id) return { resource: row }
  const linked = (await queryImpl(
    `SELECT 1
       WHERE EXISTS (SELECT 1 FROM properties p WHERE p.owner_id=$1 AND p.agency_id=$3 AND p.listed_by_agent_id=$2)
          OR EXISTS (SELECT 1 FROM book_relay_threads t WHERE t.owner_id=$1 AND t.agency_id=$3 AND t.agent_id=$2)
          OR EXISTS (SELECT 1 FROM owner_group_requests r JOIN properties p ON p.id=r.property_id
                      WHERE r.owner_id=$1 AND r.requesting_agent_id=$2 AND p.agency_id=$3)`,
    [row.owner_id, viewer.id, viewer.agency_id])).rows.length > 0
  return linked ? { resource: row } : { reason: 'forbidden' }
}

function privateValues(resource) {
  return {
    names: [resource.owner_name],
    phones: [resource.owner_phone],
    emails: [resource.owner_email],
    addresses: [resource.owner_private_address],
  }
}

function propertyFacts(resource) {
  const status = String(resource.available_status || 'unknown').replaceAll('_', ' ')
  return [
    { key:'availability', label:status, source:{ type:'property', id:resource.id, field:'available_status', at:resource.last_confirmed_available_at } },
    resource.bedrooms == null ? null : { key:'bedrooms', label:`${resource.bedrooms} Bedroom${Number(resource.bedrooms) === 1 ? '' : 's'}`, source:{ type:'property', id:resource.id, field:'bedrooms' } },
    (resource.longlet_price || resource.sale_price) == null ? null : { key:'price', label:`€${Number(resource.longlet_price || resource.sale_price).toLocaleString('en-GB')}${resource.longlet_price ? '/mo' : ''}`, source:{ type:'property', id:resource.id, field:resource.longlet_price ? 'longlet_price' : 'sale_price' } },
    { key:'photos', label:Number(resource.photo_count) > 0 ? `${resource.photo_count} Photo${Number(resource.photo_count) === 1 ? '' : 's'}` : 'Photos Pending', source:{ type:'property', id:resource.id, field:'public_payload.images' } },
    resource.available_date ? { key:'availableFrom', label:`From ${String(resource.available_date).slice(0,10)}`, source:{ type:'property', id:resource.id, field:'available_date' } } : null,
  ].filter(Boolean)
}

function safeAttachment(meta, messageId) {
  if (!meta || typeof meta !== 'object') return null
  const sensitivity = String(meta.sensitivity || 'business').toLowerCase()
  if (['identity','banking','payment','private','sensitive'].includes(sensitivity)) {
    return { id:`message-${messageId}`, filename:'Restricted attachment', restricted:true, label:'SENSITIVE ATTACHMENT REDACTED' }
  }
  const url = typeof meta.url === 'string' && /^https:\/\//i.test(meta.url) ? meta.url : null
  return {
    id:`message-${messageId}`, filename:String(meta.filename || 'Attachment').slice(0,180),
    mimeType:String(meta.mimeType || meta.mime_type || 'application/octet-stream').slice(0,100),
    url, restricted:false, unavailable:!url,
  }
}

function projectMessage(row, pii) {
  const redacted = redactBusinessMessage(row.body, pii)
  const direction = row.direction === 'owner_to_agent' ? 'incoming' : 'outgoing'
  const storedRole = String(row.sender_role || '').toUpperCase()
  const senderRole = direction === 'incoming' ? 'OWNER'
    : storedRole === 'AI' || row.is_ai === true ? 'ARGUS_AI'
    : storedRole === 'AGENT' || row.actor_agent_id ? 'AGENT'
    : '2906_SYSTEM'
  return {
    id:Number(row.id), stableId:row.source_message_id || `relay:${row.thread_id}:${row.id}`,
    threadId:Number(row.thread_id), propertyId:row.property_id, propertyRef:row.ref || null,
    direction, senderRole, text:redacted.text, redactions:redacted.labels,
    restricted:redacted.restricted, at:row.created_at, deliveryStatus:row.delivery_status || null,
    provenance:{ source:row.provenance_source || 'BOOK_RELAY', sourceMessageId:row.source_message_id || null, originalPreserved:true },
    attachment:safeAttachment(row.attachment_metadata, row.id),
  }
}

async function loadMessages({ whereSql, params, cursor, limit, search, pii }) {
  const parsedCursor = parseCursor(cursor)
  const capped = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT))
  const values = [...params]
  let cursorSql = ''
  if (parsedCursor) {
    values.push(parsedCursor.at, parsedCursor.id)
    cursorSql = `AND (m.created_at,m.id) < ($${values.length - 1},$${values.length})`
  }
  values.push(search ? HISTORY_LOOKBACK : capped + 1)
  const rows = (await queryImpl(
    `SELECT m.id,m.thread_id,m.direction,m.body,m.created_at,m.source_message_id,m.delivery_status,
            m.sender_role,m.actor_agent_id,m.is_ai,m.provenance_source,m.attachment_metadata,
            t.property_id,t.ref,t.status AS conversation_status
       FROM book_relay_messages m
       JOIN book_relay_threads t ON t.id=m.thread_id
      WHERE ${whereSql} ${cursorSql}
      ORDER BY m.created_at DESC,m.id DESC LIMIT $${values.length}`, values)).rows
  let projected = rows.map(row => projectMessage(row, pii))
  const query = String(search || '').trim().toLocaleLowerCase()
  if (query) projected = projected.filter(message => message.text.toLocaleLowerCase().includes(query))
  const hasMore = projected.length > capped || (!query && rows.length > capped)
  const page = projected.slice(0, capped)
  const oldest = page[page.length - 1]
  return { messages:page.reverse(), nextCursor:hasMore && oldest ? makeCursor({ created_at:oldest.at, id:oldest.id }) : null }
}

async function getPropertyHistory({ ref, viewer, cursor, limit, search }) {
  const access = await propertyAccess(ref, viewer)
  if (!access.resource) return access
  const resource = access.resource
  const page = await loadMessages({
    whereSql:'t.property_id=$1 AND t.agency_id=$2', params:[resource.id,viewer.agency_id], cursor,limit,search,
    pii:privateValues(resource),
  })
  const states = (await queryImpl(
    `SELECT status,COUNT(*)::int AS count FROM book_relay_threads
      WHERE property_id=$1 AND agency_id=$2 GROUP BY status ORDER BY status`, [resource.id,viewer.agency_id])).rows
  return {
    resource, result:{ scope:'property', property:{ id:resource.id, ref:resource.ref }, ownerLabel:`Owner #${resource.ref}`,
      facts:propertyFacts(resource), conversationStates:states, ...page },
  }
}

async function getOwnerHistory({ ownerId, viewer, cursor, limit, search }) {
  const access = await ownerAccess(ownerId, viewer)
  if (!access.resource) return access
  const resource = access.resource
  const page = await loadMessages({
    whereSql:'t.owner_id=$1 AND t.agency_id=$2', params:[resource.owner_id,viewer.agency_id], cursor,limit,search,
    pii:privateValues(resource),
  })
  return { resource, result:{ scope:'owner', owner:{ id:resource.owner_id }, ownerLabel:`Owner ${1000 + (Number(resource.owner_id) * 47) % 8999}`,
    facts:[], conversationStates:[], ...page } }
}

async function createFollowUpAction({ ref, viewer, action, dueAt, note, assignedAgentId }) {
  const access = await propertyAccess(ref, viewer)
  if (!access.resource) return access
  const allowed = new Set(['AWAITING_RESPONSE','FOLLOW_UP_REMINDER','REQUEST_CALLBACK','ESCALATE'])
  const normalized = String(action || '').toUpperCase()
  if (!allowed.has(normalized)) return { reason:'invalid_action' }
  const target = normalized === 'ESCALATE' && Number(assignedAgentId) > 0 ? Number(assignedAgentId) : viewer.id
  const row = (await queryImpl(
    `INSERT INTO owner_conversation_tasks
      (agency_id,owner_id,property_id,created_by_agent_id,assigned_agent_id,action,status,due_at,note)
     VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,$8) RETURNING id,action,status,due_at,created_at`,
    [viewer.agency_id,access.resource.owner_id,access.resource.id,viewer.id,target,normalized,dueAt || null,String(note || '').slice(0,500) || null])).rows[0]
  return { resource:access.resource, result:{ ok:true, task:row, messageSent:false, callStarted:false } }
}

module.exports = {
  redactBusinessMessage, restrictDiscriminatoryClauses, parseCursor, agencyMatches,
  propertyAccess, ownerAccess, getPropertyHistory, getOwnerHistory, createFollowUpAction,
  setQueryForTests,
}
