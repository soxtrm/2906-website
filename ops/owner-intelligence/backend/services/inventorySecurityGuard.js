'use strict'

let database = null
let logger = null
function getDatabase() { if (!database) database = require('../db'); return database }
function getLogger() { if (!logger) logger = require('../logger'); return logger }

const SUSPENSION_REASON = 'suspected_inventory_moves'
const SUSPENDED_MESSAGE = 'Account temporarily suspended pending security review.'
const LOCK_NAMESPACE = 29061106

function isSuspended(agent) {
  return Boolean(agent && agent.security_suspended_at && !agent.security_suspension_cleared_at)
}

async function withLockedAgent(agentId, work) {
  const client = await getDatabase().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [LOCK_NAMESPACE, Number(agentId)])
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
    throw err
  } finally {
    client.release()
  }
}

async function policyFor(client, agentId) {
  const r = await client.query(
    `SELECT p.*,a.username,a.name,a.role,a.active,a.security_suspended_at,
            a.security_suspension_reason,a.security_suspension_cleared_at
       FROM agent_inventory_security_policies p
       JOIN agents a ON a.id=p.agent_id
      WHERE p.agent_id=$1 AND p.enabled=TRUE`, [agentId])
  return r.rows[0] || null
}

async function suspend(client, policy, evidence) {
  const update = await client.query(
    `UPDATE agents
        SET security_suspended_at=COALESCE(security_suspended_at,NOW()),
            security_suspension_reason=$2,
            security_suspended_by='inventory_security_guard',
            security_suspension_cleared_at=NULL,
            security_suspension_cleared_by=NULL
      WHERE id=$1
      RETURNING security_suspended_at`,
    [policy.agent_id, SUSPENSION_REASON])
  await client.query(
    `INSERT INTO agent_inventory_security_events
       (agent_id,event_type,property_id,property_ref,route,details)
     VALUES($1,'INVENTORY_SECURITY_SUSPENDED',$2,$3,$4,$5::jsonb)`,
    [policy.agent_id, evidence.propertyId || null, evidence.ref || null,
      evidence.route || null, JSON.stringify(evidence)])
  await client.query(
    `INSERT INTO agent_activity_log
       (actor_agent_id,actor_role,actor_display_name,action_type,target_property_id,target_ref,details)
     VALUES($1,$2,$3,'INVENTORY_SECURITY_SUSPENDED',$4,$5,$6::jsonb)`,
    [policy.agent_id, policy.role, policy.name || policy.username,
      evidence.propertyId || null, evidence.ref || null,
      JSON.stringify({ reason:SUSPENSION_REASON, ...evidence })])
  getLogger().warn('inventory security suspension', {
    agentId:policy.agent_id, username:policy.username, trigger:evidence.trigger,
  })
  return { guarded:true, allowed:false, suspended:true,
    reason:SUSPENSION_REASON, suspendedAt:update.rows[0]?.security_suspended_at || null }
}

async function recordDeleteAttempt({ agentId, propertyId=null, ref=null, route=null }) {
  return withLockedAgent(agentId, async client => {
    const policy = await policyFor(client, agentId)
    if (!policy) return { guarded:false, allowed:true, suspended:false }
    if (isSuspended(policy)) return { guarded:true, allowed:false, suspended:true, reason:SUSPENSION_REASON }

    await client.query(
      `INSERT INTO agent_inventory_security_events
         (agent_id,event_type,property_id,property_ref,route)
       VALUES($1,'LISTING_DELETE_ATTEMPTED',$2,$3,$4)`,
      [agentId, propertyId, ref, route])
    const count = await client.query(
      `SELECT COUNT(DISTINCT property_id)::int AS listings
         FROM agent_inventory_security_events
        WHERE agent_id=$1 AND event_type='LISTING_DELETE_ATTEMPTED'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')`,
      [agentId, policy.delete_window_minutes])
    const listings = count.rows[0]?.listings || 0
    if (listings > policy.delete_attempt_limit) {
      return suspend(client, policy, {
        trigger:'delete_listing_limit', listings,
        limit:policy.delete_attempt_limit, windowMinutes:policy.delete_window_minutes,
        propertyId, ref, route,
      })
    }
    return { guarded:true, allowed:true, suspended:false, listings,
      remaining:Math.max(0, policy.delete_attempt_limit - listings) }
  })
}

async function recordDetailOpen({ agentId, propertyId, ref=null, route=null }) {
  return withLockedAgent(agentId, async client => {
    const policy = await policyFor(client, agentId)
    if (!policy) return { guarded:false, allowed:true, suspended:false }
    if (isSuspended(policy)) return { guarded:true, allowed:false, suspended:true, reason:SUSPENSION_REASON }

    await client.query(
      `INSERT INTO agent_inventory_security_events
         (agent_id,event_type,property_id,property_ref,route)
       VALUES($1,'LISTING_DETAIL_OPENED',$2,$3,$4)`,
      [agentId, propertyId, ref, route])
    const counts = await client.query(
      `SELECT
         COUNT(DISTINCT property_id) FILTER (
           WHERE created_at >= NOW() - ($2::int * INTERVAL '1 minute')
         )::int AS burst_count,
         COUNT(DISTINCT property_id) FILTER (
           WHERE created_at >= NOW() - INTERVAL '60 minutes'
         )::int AS hour_count
       FROM agent_inventory_security_events
      WHERE agent_id=$1 AND event_type='LISTING_DETAIL_OPENED'`,
      [agentId, policy.detail_burst_window_minutes])
    const burstCount = counts.rows[0]?.burst_count || 0
    const hourCount = counts.rows[0]?.hour_count || 0
    if (burstCount >= policy.detail_burst_limit || hourCount >= policy.detail_hour_limit) {
      return suspend(client, policy, {
        trigger:'distinct_inventory_detail_burst', burstCount, hourCount,
        burstLimit:policy.detail_burst_limit,
        burstWindowMinutes:policy.detail_burst_window_minutes,
        hourLimit:policy.detail_hour_limit, propertyId, ref, route,
      })
    }
    return { guarded:true, allowed:true, suspended:false, burstCount, hourCount }
  })
}

async function clearSuspension({ agentId, clearedByAgentId }) {
  return withLockedAgent(agentId, async client => {
    const before = await client.query(
      `SELECT id,username,name,role,security_suspended_at,security_suspension_reason
         FROM agents WHERE id=$1 FOR UPDATE`, [agentId])
    const agent = before.rows[0]
    if (!agent) return { found:false, cleared:false }
    if (!agent.security_suspended_at) return { found:true, cleared:false }
    await client.query(
      `UPDATE agents
          SET security_suspended_at=NULL,security_suspension_reason=NULL,
              security_suspended_by=NULL,security_suspension_cleared_at=NOW(),
              security_suspension_cleared_by=$2
        WHERE id=$1`, [agentId, clearedByAgentId])
    await client.query(
      `INSERT INTO agent_inventory_security_events(agent_id,event_type,details)
       VALUES($1,'INVENTORY_SECURITY_CLEARED',$2::jsonb)`,
      [agentId, JSON.stringify({ clearedByAgentId })])
    await client.query(
      `INSERT INTO agent_activity_log
         (actor_agent_id,actor_role,actor_display_name,action_type,details)
       VALUES($1,$2,$3,'INVENTORY_SECURITY_CLEARED',$4::jsonb)`,
      [clearedByAgentId, 'admin', 'Admin',
        JSON.stringify({ targetAgentId:agentId, previousReason:agent.security_suspension_reason })])
    return { found:true, cleared:true }
  })
}

function setDatabaseForTests(value) {
  database = value || null
}

function setLoggerForTests(value) {
  logger = value || null
}

module.exports = {
  SUSPENSION_REASON,
  SUSPENDED_MESSAGE,
  isSuspended,
  recordDeleteAttempt,
  recordDetailOpen,
  clearSuspension,
  setDatabaseForTests,
  setLoggerForTests,
}
