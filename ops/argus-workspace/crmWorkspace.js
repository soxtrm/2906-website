'use strict'
// ARGUS unified read layer. The database view joins property, owner, agent,
// client-match and map facts once. This route projects only the fields each
// role may see; private search text is used as a predicate and never returned.
const express = require('express')
const jwt = require('jsonwebtoken')
const db = require('../db')
const log = require('../logger')

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET

async function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(header.slice(7), JWT_SECRET) }
  catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  if (payload.aud && !['crm', 'board'].includes(payload.aud)) return res.status(403).json({ error: 'Invalid workspace session' })
  const live = await db.query('SELECT id, username, name, role, active, board_access FROM agents WHERE id=$1', [payload.id])
  const agent = live.rows[0]
  if (!agent || !agent.active) return res.status(401).json({ error: 'Account inactive' })
  if (payload.aud === 'board' && !agent.board_access) return res.status(403).json({ error: 'Board access revoked' })
  req.agent = agent
  req.sessionAudience = payload.aud || 'crm'
  next()
}

function csv(value, max = 30) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean).slice(0, max)
}
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits ? `•••• ${digits.slice(-4)}` : null
}
function maskEmail(value) {
  const email = String(value || '')
  const at = email.indexOf('@')
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : null
}

router.get('/search', auth, async (req, res) => {
  try {
    const agent = req.agent
    const boardOnly = req.sessionAudience === 'board' || agent.role === 'board'
    const requested = new Set(csv(req.query.domains || 'properties,people,owners,map'))
    const domains = [...requested].filter(domain => ['properties', 'people', 'owners', 'map'].includes(domain))
    const allowed = boardOnly ? domains.filter(domain => ['properties', 'map'].includes(domain)) : domains
    const needle = String(req.query.q || '').trim().slice(0, 120).toLowerCase()
    const like = `%${needle}%`
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50)
    const result = { properties: [], people: [], owners: [], map: [] }

    if (allowed.includes('properties')) {
      const params = [like]
      const where = [boardOnly ? 'aw.board_search_text LIKE $1' : 'aw.private_search_text LIKE $1']
      where.push(`aw.ref IS NOT NULL AND btrim(aw.ref) <> ''`)
      if (req.query.towns) {
        params.push(csv(req.query.towns).map(value => value.toLowerCase()))
        where.push(`(lower(aw.village_key) = ANY($${params.length}) OR lower(aw.town) = ANY($${params.length}))`)
      }
      if (req.query.status) { params.push(String(req.query.status)); where.push(`aw.available_status=$${params.length}`) }
      if (req.query.pets === 'yes' || req.query.pets === 'no') { params.push(req.query.pets === 'yes'); where.push(`aw.pets_allowed=$${params.length}`) }
      if (req.query.sharing === 'yes' || req.query.sharing === 'no') { params.push(req.query.sharing === 'yes'); where.push(`aw.sharing_allowed=$${params.length}`) }
      if (req.query.sublet === '1') where.push('aw.subletting_considered=TRUE')
      params.push(limit)
      const rows = await db.query(`
        SELECT aw.property_id, aw.ref, aw.town, aw.village_key, aw.village_name,
               aw.area_key, aw.area_name, aw.property_type, aw.bedrooms, aw.bathrooms,
               aw.price, aw.available_status, aw.locality_latitude, aw.locality_longitude,
               aw.map_latitude, aw.map_longitude,
               aw.map_precision, aw.agent_name, aw.agent_username,
               aw.pets_allowed, aw.pets_source, aw.sharing_allowed, aw.sharing_source,
               aw.subletting_considered, aw.subletting_source,
               aw.client_match_count, aw.modelled_route_count
          FROM argus_workspace_property_index aw
         WHERE ${where.join(' AND ')}
         ORDER BY GREATEST(aw.updated_at, aw.created_at) DESC NULLS LAST
         LIMIT $${params.length}`, params)
      result.properties = rows.rows.map(row => ({
        id: row.property_id, ref: row.ref, town: row.village_name || row.town,
        villageKey: row.village_key, area: row.area_name, type: row.property_type,
        beds: row.bedrooms, baths: row.bathrooms, price: row.price == null ? null : Number(row.price),
        status: row.available_status, listedBy: row.agent_name || row.agent_username || null,
        filters: {
          pets: row.pets_allowed, petsSource: row.pets_source,
          sharing: row.sharing_allowed, sharingSource: row.sharing_source,
          subletting: row.subletting_considered, sublettingSource: row.subletting_source,
        },
        clientMatches: Number(row.client_match_count) || 0,
        map: (boardOnly ? row.locality_latitude : row.map_latitude) == null ? null : {
          latitude: Number(boardOnly ? row.locality_latitude : row.map_latitude),
          longitude: Number(boardOnly ? row.locality_longitude : row.map_longitude),
          precision: boardOnly ? 'locality' : row.map_precision,
        },
        modelledRouteCoverage: Number(row.modelled_route_count) || 0,
      }))
    }

    if (allowed.includes('owners')) {
      const rows = await db.query(`
        SELECT oc.id, oc.name, oc.phone_normalized, oc.email, oc.status,
               oc.do_not_contact, oc.updated_at,
               COUNT(p.id) FILTER (WHERE p.is_staging IS NOT TRUE)::int AS property_count
          FROM owner_contacts oc
          LEFT JOIN properties p ON p.owner_id=oc.id
         WHERE ($1='' OR lower(concat_ws(' ',oc.name,oc.phone_normalized,oc.email,oc.location)) LIKE $2)
         GROUP BY oc.id
         ORDER BY MAX(oc.updated_at) DESC NULLS LAST
         LIMIT $3`, [needle, like, limit])
      result.owners = rows.rows.map(row => ({
        id: row.id, name: row.name || 'Unnamed owner', phoneMasked: maskPhone(row.phone_normalized),
        emailMasked: maskEmail(row.email), status: row.status, doNotContact: !!row.do_not_contact,
        properties: Number(row.property_count) || 0,
      }))
    }

    if (allowed.includes('people')) {
      const params = [needle, like]
      let visibility = 'TRUE'
      if (agent.role !== 'admin') {
        params.push(agent.id)
        visibility = `(cas.assigned_agent_id=$${params.length} OR $${params.length}=ANY(cas.collaborator_agent_ids))`
      }
      params.push(limit)
      const rows = await db.query(`
        SELECT DISTINCT ON (c.id) c.id, c.name, c.status, c.budget_min, c.budget_max,
               c.bedrooms_wanted, c.locations, c.preferred_locations, c.move_in_date,
               c.lease_type_wanted, c.pets, c.subletting, cas.id AS clientgroup_id,
               ag.name AS agent_name, ag.username AS agent_username
          FROM clients c
          JOIN client_assistant_state cas ON cas.client_id=c.id
          LEFT JOIN agents ag ON ag.id=cas.assigned_agent_id
         WHERE ${visibility}
           AND ($1='' OR lower(concat_ws(' ',c.name,c.phone,c.status,c.profession,
                 array_to_string(c.locations,' '),array_to_string(c.preferred_locations,' '),
                 array_to_string(c.bedrooms_wanted,' '),c.lease_type_wanted)) LIKE $2)
         ORDER BY c.id, cas.updated_at DESC
         LIMIT $${params.length}`, params)
      result.people = rows.rows.map(row => ({
        id: row.id, clientgroupId: row.clientgroup_id, name: row.name || 'Unnamed client',
        status: row.status, budgetMin: row.budget_min == null ? null : Number(row.budget_min),
        budgetMax: row.budget_max == null ? null : Number(row.budget_max),
        bedrooms: row.bedrooms_wanted || [], locations: row.locations || row.preferred_locations || [],
        moveInDate: row.move_in_date, rental: row.lease_type_wanted,
        pets: row.pets, subletting: row.subletting,
        assignedTo: row.agent_name || row.agent_username || null,
      }))
    }

    if (allowed.includes('map')) {
      const rows = await db.query(`
        SELECT v.id, v.code, v.display_name, ar.code AS area_key, ar.display_name AS area_name,
               v.centroid_latitude, v.centroid_longitude,
               COUNT(DISTINCT p.id) FILTER (WHERE p.is_staging IS NOT TRUE)::int AS property_count,
               COUNT(DISTINCT ltt.id)::int AS modelled_route_count
          FROM villages v
          LEFT JOIN areas ar ON ar.id=v.primary_area_id
          LEFT JOIN properties p ON p.locality_id=v.id
          LEFT JOIN locality_travel_times ltt
            ON lower(ltt.from_locality) IN (lower(v.code),lower(v.display_name))
            OR lower(ltt.to_locality) IN (lower(v.code),lower(v.display_name))
         WHERE ($1='' OR lower(concat_ws(' ',v.code,v.display_name,ar.code,ar.display_name)) LIKE $2)
         GROUP BY v.id, ar.code, ar.display_name
         ORDER BY property_count DESC, v.display_name
         LIMIT $3`, [needle, like, limit])
      result.map = rows.rows.map(row => ({
        id: row.id, key: row.code, label: row.display_name, areaKey: row.area_key,
        area: row.area_name, properties: Number(row.property_count) || 0,
        point: row.centroid_latitude == null ? null : {
          latitude: Number(row.centroid_latitude), longitude: Number(row.centroid_longitude), precision: 'locality',
        },
        modelledRoutes: Number(row.modelled_route_count) || 0,
      }))
    }

    const traffic = await db.query(`
      SELECT (SELECT COUNT(*)::int FROM locality_travel_times) AS modelled_routes,
             (SELECT COUNT(*)::int FROM locality_traffic_observations) AS observations,
             (SELECT MAX(observed_at) FROM locality_traffic_observations) AS last_observed_at`)
    res.json({
      query: needle, domains: allowed, groups: result,
      coverage: {
        traffic: {
          modelledRoutes: traffic.rows[0].modelled_routes,
          observations: traffic.rows[0].observations,
          lastObservedAt: traffic.rows[0].last_observed_at,
          source: 'stored locality evidence',
          live: false,
        },
        permissions: boardOnly ? 'board-safe' : 'crm-scoped',
      },
    })
  } catch (error) {
    log.error('crm workspace search failed', { error: error.message })
    res.status(500).json({ error: 'Workspace search failed' })
  }
})

module.exports = router
