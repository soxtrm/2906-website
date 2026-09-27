'use strict'

// Creates INTERNAL review work for newly listed properties that have spent
// eleven days on the market without a recorded price discussion. It never
// sends an owner message. The rollout watermark prevents historic inventory
// from becoming a backlog on first deploy.
const crypto = require('crypto')
const db = require('../db')
const log = require('../logger')

const ROLLOUT_KEY = 'market_followup_rollout_started_at'
const DAY_11 = 11

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function ensureRolloutWatermark() {
  await db.query(
    `INSERT INTO settings(key,value,description,updated_at)
     VALUES($1,NOW()::text,'Start point for day-11 market review tasks; older inventory is excluded',NOW())
     ON CONFLICT(key) DO NOTHING`, [ROLLOUT_KEY])
  const result = await db.query(`SELECT value::timestamptz AS started_at FROM settings WHERE key=$1`, [ROLLOUT_KEY])
  return result.rows[0]?.started_at
}

async function ensureMarketFollowupTasks({ limit = 200 } = {}) {
  const startedAt = await ensureRolloutWatermark()
  const result = await db.query(
    `SELECT p.id,p.ref,p.town,p.property_type,p.longlet_price,p.created_at,
            o.id AS owner_contact_id,o.name AS owner_name,
            regexp_replace(COALESCE(o.phone_normalized,''),'\\D','','g') AS owner_phone
       FROM properties p
       JOIN owner_contacts o ON o.id=p.owner_id
      WHERE p.archived_at IS NULL
        AND p.published=TRUE
        AND p.created_at >= $1
        AND p.created_at <= NOW()-($2::text||' days')::interval
        AND COALESCE(p.available_status,'available') IN ('available','available_confirmed','soon_available')
        AND p.longlet_price IS NOT NULL
        AND COALESCE(o.do_not_contact,FALSE)=FALSE
        AND NOT EXISTS(SELECT 1 FROM owner_automation_blocks b WHERE b.active=TRUE AND right(regexp_replace(COALESCE(b.phone_normalized,''),'\\D','','g'),9)=right(regexp_replace(COALESCE(o.phone_normalized,''),'\\D','','g'),9))
        AND NOT EXISTS(SELECT 1 FROM property_activities a WHERE a.property_id=p.id AND a.activity_type IN ('price_change_major','price_change_minor','price_flex_followup_sent'))
      ORDER BY p.created_at ASC
      LIMIT $3`, [startedAt, DAY_11, limit])

  let created = 0
  for (const property of result.rows) {
    if (!property.owner_phone) continue
    const context = {
      owner: { id: property.owner_contact_id, name: property.owner_name },
      property: { id: property.id, ref: property.ref, town: property.town, type: property.property_type, price: property.longlet_price },
      market: { listedAt: property.created_at, reviewDay: DAY_11 },
    }
    const inserted = await db.query(
      `INSERT INTO owner_recheck_tasks
        (owner_contact_id,owner_phone,topic,state,decision,reason,property_id,source_type,source_id,
         context_hash,context_snapshot,proposed_action,proposed_message,updated_at)
       VALUES($1,$2,$3,'DECISION_REQUIRED','PRICE_REVIEW_DUE',$4,$5,'market_followup',$6,$7,$8::jsonb,$9,NULL,NOW())
       ON CONFLICT(owner_phone,topic) DO NOTHING
       RETURNING id`, [
        property.owner_contact_id, property.owner_phone, `market_followup:${property.id}`,
        `Property ${property.ref} reached day ${DAY_11} without a recorded price review.`, property.id,
        String(property.id), hash(context), JSON.stringify(context),
        'Review current price, owner context and matching clients. Contact remains REVIEW_ONLY.',
      ])
    created += inserted.rowCount
  }
  if (created) log.info('Day-11 market review tasks created', { candidates: result.rows.length, created })
  return { candidates: result.rows.length, created, mode: 'REVIEW_ONLY', rolloutStartedAt: startedAt }
}

module.exports = { ensureMarketFollowupTasks, ensureRolloutWatermark, DAY_11 }
