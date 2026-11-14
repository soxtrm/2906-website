'use strict'
// ============================================================================
// services/facebookPages/autoPublish.js — OPTIONAL automatic publishing of
// newly verified listings. Off by default at three levels:
//   1. server flag ARGUS_FB_AUTOPUBLISH_SCAN=1 (staged rollout / kill switch),
//   2. the agent's own "Automatically publish newly verified properties" switch,
//   3. each Page's own "may receive automatic posts" switch.
// Only listings the agent lists, verified AFTER the agent switched it on, are
// considered. One publication per Page + listing + verification event
// (UNIQUE idempotency key), a daily cap per Page and at least 45 minutes
// between automatic posts on the same Page. Unsharing or editing a listing
// never deletes or reposts anything automatically.
// ============================================================================
const store = require('./store')
const propertySvc = require('./property')
const content = require('./content')
const secrets = require('./secrets')

const { db } = store
const SPACING_MIN = 45

async function scan({ enqueue = async () => {}, now = new Date() } = {}) {
  const { rows: candidates } = await db.query(
    `SELECT p.id AS property_id, p.verified_at, pg.id AS page_row_id, pg.page_id, pg.page_name, pr.agent_id, pr.language,
            pr.use_emojis, pr.include_contact, pr.include_link, pr.call_to_action, pr.default_template_id, pr.auto_daily_limit
       FROM agent_facebook_preferences pr
       JOIN agent_facebook_pages pg ON pg.agent_id = pr.agent_id AND pg.auto_publish AND pg.enabled AND pg.can_publish AND pg.status = 'active'
       JOIN agent_facebook_connections c ON c.id = pg.connection_id AND c.state = 'active'
       JOIN agents a ON a.id = pr.agent_id AND a.active
       JOIN properties p ON p.listed_by_agent_id = pr.agent_id AND p.verification_status = 'verified'
                        AND p.verified_at IS NOT NULL AND p.verified_at >= pr.auto_publish_enabled_at
                        AND p.verified_at > $1::timestamptz - INTERVAL '3 days'
      WHERE pr.auto_publish_enabled
        AND NOT EXISTS (SELECT 1 FROM agent_facebook_publications x
                         WHERE x.page_row_id = pg.id AND x.property_id = p.id AND x.state NOT IN ('cancelled','failed','removed'))
      ORDER BY p.verified_at
      LIMIT 100`, [now])
  const out = { considered: candidates.length, queued: 0, skipped: [] }
  for (const c of candidates) {
    const key = `auto:${c.page_row_id}:${c.property_id}:verified:${Math.floor(new Date(c.verified_at).getTime() / 1000)}`
    const { rows: [{ n: today }] } = await db.query(
      `SELECT COUNT(*)::int n FROM agent_facebook_publications WHERE page_row_id=$1 AND trigger='auto_verified' AND created_at > $2::timestamptz - INTERVAL '24 hours' AND state <> 'cancelled'`,
      [c.page_row_id, now])
    if (today >= c.auto_daily_limit) { out.skipped.push({ propertyId: c.property_id, reason: 'daily_limit' }); continue }
    const { rows: [agent] } = await db.query(`SELECT id, role, name, username, display_name, public_phone, whatsapp_phone, email FROM agents WHERE id=$1`, [c.agent_id])
    let p
    try { p = await propertySvc.load(agent, c.property_id) } catch { out.skipped.push({ propertyId: c.property_id, reason: 'not_loadable' }); continue }
    if (p.blockers.length) { out.skipped.push({ propertyId: c.property_id, reason: p.blockers[0].code }); continue }
    let custom = null, templateId = 'classic'
    if (c.default_template_id) {
      const { rows: [t] } = await db.query(`SELECT body FROM agent_facebook_templates WHERE id=$1 AND agent_id=$2`, [c.default_template_id, c.agent_id])
      if (t) { custom = t.body; templateId = String(c.default_template_id) }
    }
    const token = secrets.randomToken(9)
    const link = c.include_link && p.link ? propertySvc.withAttribution(p.link.url, token) : null
    const images = p.imagesAllowed ? p.images.slice(0, propertySvc.MAX_IMAGES).map(i => i.url) : []
    const message = content.render({ template: templateId, custom, facts: p.facts, link, language: c.language, emojis: c.use_emojis, cta: c.call_to_action, includeContact: c.include_contact, agent })
    const v = content.validateMessage(message, { agent })
    if (!v.ok) { out.skipped.push({ propertyId: c.property_id, reason: 'content_check' }); continue }
    const { rows: [last] } = await db.query(
      `SELECT MAX(COALESCE(next_attempt_at, created_at)) AS t FROM agent_facebook_publications WHERE page_row_id=$1 AND trigger='auto_verified' AND state <> 'cancelled'`, [c.page_row_id])
    const earliest = last && last.t ? new Date(new Date(last.t).getTime() + SPACING_MIN * 60000) : now
    const due = earliest > now ? earliest : now
    const type = images.length > 1 ? 'multi_photo' : images.length === 1 ? 'photo' : link ? 'link' : 'text'
    const { rows: [row] } = await db.query(
      `INSERT INTO agent_facebook_publications (property_id, property_ref, agent_id, page_row_id, page_id, page_name, publication_type, state, trigger,
              idempotency_key, content, attribution_token, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','auto_verified',$8,$9::jsonb,$10,$11)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [c.property_id, p.facts.ref, c.agent_id, c.page_row_id, c.page_id, c.page_name, type, key,
       JSON.stringify({ message, images, link, link_kind: p.link ? p.link.kind : null, language: c.language, template: templateId, property: { ref: p.facts.ref, town: p.facts.town } }),
       token, due])
    if (!row) continue
    out.queued++
    await store.audit({ id: c.agent_id, role: 'system', name: 'ARGUS automation' }, 'auto:facebook_page:queued', { propertyId: c.property_id, ref: p.facts.ref, details: { publication_id: Number(row.id), page_row_id: Number(c.page_row_id), due: due.toISOString() } })
    await enqueue(row, Math.max(0, due.getTime() - Date.now()))
  }
  return out
}

module.exports = { scan, SPACING_MIN }
