'use strict'
const db = require('../db')
const { recomputeAllAffinity } = require('./affinityCalculator')

const KEV_SESSIONS = ['default', 'Kevsecond', 'kevthirdd']

async function buildListForAccount(sessionName, hotOverride, coldOverride) {
  await recomputeAllAffinity()

  const accRes = await db.query(
    'SELECT id, daily_hot_target, daily_cold_target FROM whatsapp_accounts WHERE session_name = $1',
    [sessionName]
  )
  if (accRes.rows.length === 0) throw new Error(`Account "${sessionName}" not found`)
  const { id: accountId, daily_hot_target, daily_cold_target } = accRes.rows[0]

  const hotTarget  = hotOverride  ?? daily_hot_target  ?? 30
  const coldTarget = coldOverride ?? daily_cold_target ?? 20
  const isKev = KEV_SESSIONS.includes(sessionName)

  // Cross-cooldown exclusion subquery
  const kevExclusion = `
    NOT EXISTS (
      SELECT 1 FROM outreach_log ol
      WHERE ol.phone = oc.phone_normalized
        AND ol.sent_at > NOW() - INTERVAL '7 days'
        AND ol.account_used = ANY(ARRAY['default','Kevsecond','kevthirdd'])
    )
    AND NOT EXISTS (
      SELECT 1 FROM outreach_log ol
      WHERE ol.phone = oc.phone_normalized
        AND ol.sent_at > NOW() - INTERVAL '10 days'
        AND ol.account_used = ANY(ARRAY['Olga','Jasmine'])
    )
  `
  const nonKevExclusion = (sess) => `
    NOT EXISTS (
      SELECT 1 FROM outreach_log ol
      WHERE ol.phone = oc.phone_normalized
        AND ol.sent_at > NOW() - INTERVAL '25 days'
        AND ol.account_used = '${sess}'
    )
    AND NOT EXISTS (
      SELECT 1 FROM outreach_log ol
      WHERE ol.phone = oc.phone_normalized
        AND ol.sent_at > NOW() - INTERVAL '10 days'
        AND ol.account_used = ANY(ARRAY['default','Kevsecond','kevthirdd'])
    )
  `

  const crossExclusion = isKev ? kevExclusion : nonKevExclusion(sessionName)

  // HOT tier
  const hotRes = await db.query(`
    SELECT oc.id, oc.name, oc.phone_normalized AS phone, oc.status,
           oc.last_property_mention, oaa.custom_cooldown_days, oaa.affinity_score
    FROM owner_contacts oc
    JOIN owner_account_affinity oaa ON oaa.contact_id = oc.id AND oaa.account_id = $1
    WHERE oc.status = 'hot'
      AND oaa.is_preferred = TRUE
      AND oaa.is_annoyed = FALSE
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
      AND (oc.last_contact_at IS NULL
           OR oc.last_contact_at < NOW() - (oaa.custom_cooldown_days || ' days')::INTERVAL)
      AND ${crossExclusion}
    ORDER BY oaa.affinity_score DESC
    LIMIT $2
  `, [accountId, hotTarget])

  const hotList = hotRes.rows.map(r => ({ ...r, tier: 'HOT' }))
  const fillCount = Math.max(0, hotTarget - hotList.length)

  // COLD/NEVER tier — fill up to coldTarget + any hot shortfall
  const coldRes = await db.query(`
    SELECT oc.id, oc.name, oc.phone_normalized AS phone, oc.status,
           oc.last_property_mention
    FROM owner_contacts oc
    LEFT JOIN owner_account_affinity oaa ON oaa.contact_id = oc.id AND oaa.account_id = $1
    WHERE (oc.status IN ('cold','ghosted') OR oc.status IS NULL)
      AND (oaa.is_annoyed IS NULL OR oaa.is_annoyed = FALSE)
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
      AND (oc.last_contact_at IS NULL
           OR oc.last_contact_at < NOW() - INTERVAL '25 days')
      AND ${crossExclusion}
    ORDER BY oc.last_contact_at ASC NULLS FIRST
    LIMIT $2
  `, [accountId, coldTarget + fillCount])

  const coldList = coldRes.rows.map(r => ({ ...r, tier: r.status === 'hot' ? 'HOT' : 'COLD' }))

  return { hotList, coldList, accountId, sessionName }
}

async function getListStats() {
  const accounts = await db.query(
    'SELECT id, session_name, daily_hot_target, daily_cold_target FROM whatsapp_accounts WHERE is_active = TRUE AND outreach_enabled = TRUE ORDER BY priority, id'
  )

  const stats = []
  for (const acc of accounts.rows) {
    const isKev = KEV_SESSIONS.includes(acc.session_name)

    const hotRes = await db.query(`
      SELECT COUNT(*) FROM owner_contacts oc
      JOIN owner_account_affinity oaa ON oaa.contact_id = oc.id AND oaa.account_id = $1
      WHERE oc.status = 'hot'
        AND oaa.is_preferred = TRUE AND oaa.is_annoyed = FALSE
        AND (oc.last_contact_at IS NULL
             OR oc.last_contact_at < NOW() - (oaa.custom_cooldown_days || ' days')::INTERVAL)
    `, [acc.id])

    const coldRes = await db.query(`
      SELECT COUNT(*) FROM owner_contacts oc
      WHERE (oc.status IN ('cold','ghosted') OR oc.status IS NULL)
        AND (oc.last_contact_at IS NULL OR oc.last_contact_at < NOW() - INTERVAL '25 days')
    `)

    stats.push({
      session: acc.session_name,
      hotEligible:  parseInt(hotRes.rows[0].count),
      coldEligible: parseInt(coldRes.rows[0].count),
      hotTarget:    acc.daily_hot_target,
      coldTarget:   acc.daily_cold_target
    })
  }
  return stats
}

module.exports = { buildListForAccount, getListStats }

// ── buildListCapped: per-account caps + all status tiers ─────────────────────
// Uses cold_daily_max / warm_daily_max from whatsapp_accounts.
// Status tiers: hot=warm, softwarm=warm(Olga), new/cold/never/ghosted=cold.
const { canContact, findPreferredKevAccount, checkOwnerEligibilityViaWAHA } = require('./cooldownRules')
const log = require('../logger')

// For Kev personas: which Kev account "owns" this contact based on conversation
// history (replies). Returns null when there is no engagement yet — meaning any
// Kev account is free to take this owner. Used for both hot and cold tiers.
async function preferredKevByEngagement(contactId) {
  const r = await db.query(`
    SELECT wa.id
    FROM contact_account_history cah
    JOIN whatsapp_accounts wa ON wa.id = cah.account_id
    WHERE cah.contact_id = $1
      AND wa.account_persona = 'kev'
      AND cah.total_messages_they_sent > 0
    ORDER BY cah.total_messages_they_sent DESC,
             cah.last_message_they_sent_at DESC NULLS LAST
    LIMIT 1
  `, [contactId])
  return r.rows[0] || null
}

// Eligible-candidate query for the COLD tier (cold/new/never/ghosted/softwarm).
// ALWAYS sort by id DESC — newest imports first (fresh untouched leads).
// (Hot/softwarm-Olga tiers have their own queries inline below.)
async function getEligibleByStatus(accountId, statuses, limit) {
  const statusArray = Array.isArray(statuses) ? statuses : [statuses]
  const res = await db.query(`
    SELECT oc.id, oc.name, oc.phone_normalized AS phone, oc.status, oc.last_property_mention
    FROM owner_contacts oc
    LEFT JOIN owner_account_affinity oaa ON oaa.contact_id = oc.id AND oaa.account_id = $1
    WHERE (oc.status = ANY($2::text[]) OR oc.status IS NULL)
      AND (oaa.is_annoyed IS NULL OR oaa.is_annoyed = FALSE)
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
      AND COALESCE(oc.do_not_contact, FALSE) = FALSE AND COALESCE(oc.status, '') <> 'do_not_contact'
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
    ORDER BY oc.id DESC
    LIMIT $3
  `, [accountId, statusArray, limit])
  return res.rows
}

// Run WAHA eligibility for many candidates in parallel and split into
// eligible / softskipped, preserving order. canContact + preferred-kev gates
// run first (DB-only, fast).
async function parallelEligibility(candidates, sessionName, accountId, isKev, tier) {
  if (candidates.length === 0) return { eligible: [], softskipped: [] }

  // Pre-filter via DB gates (sequential but cheap)
  const prefiltered = []
  const softskipped = []
  for (const c of candidates) {
    if (isKev) {
      const pref = await preferredKevByEngagement(c.id)
      if (pref && pref.id !== accountId) continue
    }
    const chk = await canContact(c.id, accountId)
    if (!chk.allowed) continue
    prefiltered.push(c)
  }

  // Parallel WAHA check
  const checkResults = await Promise.all(
    prefiltered.map(async (cand) => {
      let wa
      try {
        wa = await checkOwnerEligibilityViaWAHA(cand.phone, sessionName)
      } catch (err) {
        wa = { eligible: false, reason: 'wa_check_error' }
      }
      return { cand, wa }
    })
  )

  const eligible = []
  for (const { cand, wa } of checkResults) {
    if (wa.eligible) {
      eligible.push({ ...cand, tier })
    } else {
      softskipped.push({
        owner: cand, tier, reason: wa.reason,
        blocker: wa.blocker_session, days_ago: wa.days_ago,
      })
    }
  }
  return { eligible, softskipped }
}

async function buildListCapped(sessionName, requestedCount, opts = {}) {
  const accRes = await db.query('SELECT * FROM whatsapp_accounts WHERE session_name = $1', [sessionName])
  const account = accRes.rows[0]
  if (!account) throw new Error(`Account "${sessionName}" not found`)

  const coldMax = account.cold_daily_max || 30
  const warmMax = account.warm_daily_max || 120
  const isKev   = account.account_persona === 'kev'

  // Fixed composition: always 20-30 cold + rest warm (up to requestedCount).
  const COLD_MIN = 20
  const COLD_MAX = 30
  const accountColdCap = Math.min(coldMax, COLD_MAX)

  let coldTarget, warmTarget
  if (requestedCount <= accountColdCap) {
    coldTarget = Math.min(requestedCount, accountColdCap)
    warmTarget = Math.max(0, requestedCount - coldTarget)
  } else {
    coldTarget = accountColdCap
    warmTarget = requestedCount - coldTarget
  }
  // Ensure at least COLD_MIN cold when possible
  if (coldTarget < COLD_MIN && requestedCount >= COLD_MIN) {
    coldTarget = Math.min(COLD_MIN, requestedCount, accountColdCap)
    warmTarget = Math.max(0, requestedCount - coldTarget)
  }
  // warm cap
  warmTarget = Math.min(warmTarget, warmMax)

  // ── Candidate pools ──────────────────────────────────────────────
  // Big buffers: WAHA + canContact + Kev-engagement filter out many, so we
  // over-fetch and slice down to target afterwards.
  const hotBufferLimit = Math.max(warmTarget * 5, 50)
  const hotCands = await db.query(`
    SELECT oc.id, oc.name, oc.phone_normalized AS phone, oc.status, oc.last_property_mention
    FROM owner_contacts oc
    LEFT JOIN owner_account_affinity oaa ON oaa.contact_id = oc.id AND oaa.account_id = $1
    WHERE oc.status = 'hot'
      AND (oaa.is_annoyed IS NULL OR oaa.is_annoyed = FALSE)
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
      AND COALESCE(oc.do_not_contact, FALSE) = FALSE AND COALESCE(oc.status, '') <> 'do_not_contact'
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
    ORDER BY COALESCE(oaa.affinity_score, 0) DESC, oc.last_contact_at ASC NULLS FIRST
    LIMIT $2
  `, [account.id, hotBufferLimit])

  // Progress estimate before the (parallel) WAHA blast
  const totalCands = hotCands.rows.length
  const estimatedSec = Math.max(5, Math.ceil(totalCands * 0.3))
  if (opts.progressCallback) {
    try { await opts.progressCallback(`⏳ Checking ${totalCands} hot owners (~${estimatedSec}s)…`) } catch {}
  }

  const hot = await parallelEligibility(hotCands.rows, sessionName, account.id, isKev, 'hot')
  const hotList = hot.eligible.slice(0, warmTarget)
  const softskipped = [...hot.softskipped]

  // ── SOFTWARM tier (Olga only) ──────────────────────────────────
  const softwarmList = []
  if (account.session_name === 'Olga') {
    const swMax = Math.floor(coldMax / 2)
    const swCands = await db.query(`
      SELECT oc.id, oc.name, oc.phone_normalized AS phone, oc.status, oc.last_property_mention
      FROM owner_contacts oc
      WHERE oc.status = 'softwarm'
        AND COALESCE(oc.do_not_contact, FALSE) = FALSE AND COALESCE(oc.status, '') <> 'do_not_contact'
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
      ORDER BY oc.last_contact_at ASC NULLS FIRST
      LIMIT $1
    `, [Math.max(swMax * 5, 20)])
    const sw = await parallelEligibility(swCands.rows, sessionName, account.id, false, 'softwarm')
    softwarmList.push(...sw.eligible.slice(0, swMax))
    softskipped.push(...sw.softskipped)
  }

  // ── COLD tier ──────────────────────────────────────────────────
  // Cold target stays fixed (20-30) — newest imports come first via id DESC.
  // Kev/Jasmine also pick up softwarm contacts as cold; Olga has its own tier.
  const coldStatuses = account.session_name === 'Olga'
    ? ['cold', 'new', 'never', 'ghosted']
    : ['cold', 'new', 'never', 'ghosted', 'softwarm']

  // Top-up loop: keep enlarging the buffer until we collect enough eligible
  // OR the pool is exhausted. Safety cap at 1000 to avoid runaway DB cost.
  const coldEligible = []
  const coldSoftskipped = []
  const seenIds = new Set()
  let coldBufferLimit = Math.max(coldTarget * 10, 200)
  const COLD_HARD_CAP = 1000
  let attempts = 0
  while (coldEligible.length < coldTarget && coldBufferLimit <= COLD_HARD_CAP && attempts < 4) {
    attempts++
    const rows = await getEligibleByStatus(account.id, coldStatuses, coldBufferLimit)
    const fresh = rows.filter(r => !seenIds.has(r.id))
    for (const r of rows) seenIds.add(r.id)
    if (fresh.length === 0) break // pool exhausted

    if (opts.progressCallback && attempts === 1) {
      try { await opts.progressCallback(`⏳ Checking ${fresh.length} cold owners…`) } catch {}
    }

    const part = await parallelEligibility(fresh, sessionName, account.id, isKev, 'cold')
    coldEligible.push(...part.eligible)
    coldSoftskipped.push(...part.softskipped)

    if (coldEligible.length >= coldTarget) break
    if (rows.length < coldBufferLimit) break // entire pool already returned
    coldBufferLimit = Math.min(coldBufferLimit * 2, COLD_HARD_CAP)
  }

  const coldList = coldEligible.slice(0, coldTarget)
  softskipped.push(...coldSoftskipped)

  if (coldList.length < coldTarget) {
    log.warn('listBuilder: cold pool exhausted before target', {
      session: sessionName, delivered_cold: coldList.length, cold_target: coldTarget,
      eligible_total: coldEligible.length, attempts,
    })
  }

  // ── Interleave 2-warm / 1-cold (capped at requestedCount) ──────
  const coldMixed = [...coldList]
  for (let i = softwarmList.length - 1; i >= 0; i--) {
    const pos = Math.min((i + 1) * 2, coldMixed.length)
    coldMixed.splice(pos, 0, softwarmList[i])
  }

  const final = []
  let h = 0, c = 0
  while ((h < hotList.length || c < coldMixed.length) && final.length < requestedCount) {
    if (h < hotList.length && final.length < requestedCount) final.push(hotList[h++])
    if (h < hotList.length && final.length < requestedCount) final.push(hotList[h++])
    if (c < coldMixed.length && final.length < requestedCount) final.push(coldMixed[c++])
  }

  const notes = []
  if (final.length < requestedCount)
    notes.push(`⚠️ Only ${final.length}/${requestedCount} eligible (caps + cooldowns).`)
  if (hotList.length === 0)
    notes.push(`⚠️ No hot owners eligible. Cold-only list — consider ~50h send interval.`)
  if (softwarmList.length > 0)
    notes.push(`💡 ${softwarmList.length} softwarm sprinkled in. Watch restrictions.`)
  if (softskipped.length > 0)
    notes.push(`⏭️ ${softskipped.length} skipped via WhatsApp history check (see DM for details).`)

  log.info('listBuilder: parallel build done', {
    session: sessionName,
    delivered: final.length, wa_softskipped: softskipped.length,
    cold_target: coldTarget, warm_target: warmTarget,
  })

  return {
    session:         sessionName,
    requested:       requestedCount,
    delivered:       final.length,
    hot_count:       hotList.length,
    cold_count:      coldList.length,
    softwarm_count:  softwarmList.length,
    wa_skipped:      softskipped,
    list:            final,
    notes,
    caps: { coldMax, warmMax, coldTarget, warmTarget }
  }
}

module.exports = Object.assign(module.exports, { buildListCapped })

// ── buildPoolBatch: sequential pool-cursor walk with same-account 20d cooldown ─
// Top pool walks UP (id ASC, cursor advances from 0), bottom walks DOWN
// (id DESC, cursor advances from MAX+1). When the direction is exhausted the
// cursor auto-resets and cycle_count is bumped. DNC filter is global; 20d
// cooldown is checked per-account only (no cross-account block).
async function buildPoolBatch(sessionName, requestedCount, options = {}) {
  const advanceCursor = options.advanceCursor !== false
  const acc = await db.query(
    'SELECT pool FROM whatsapp_accounts WHERE session_name = $1',
    [sessionName]
  )
  const pool = acc.rows[0]?.pool || 'top'

  const curRow = await db.query(
    'SELECT cursor_id, cycle_count FROM pool_cursors WHERE pool = $1',
    [pool]
  )
  if (curRow.rows.length === 0) {
    throw new Error(`pool_cursors row missing for pool="${pool}"`)
  }
  let cursor = options.cursorOverride == null ? curRow.rows[0].cursor_id : options.cursorOverride
  const cycleCount = curRow.rows[0].cycle_count

  const buffer = Math.max(requestedCount * 3, 30)
  // Rotation windows (see the candidate query). options.* only for tests.
  const RECYCLE_DAYS = options.recycleDays ?? 25
  const REPLY_HOLD_DAYS = options.replyHoldDays ?? 30

  const candidatesQuery = pool === 'top'
    ? `
      SELECT oc.id, oc.name, oc.phone_normalized
      FROM owner_contacts oc
      WHERE oc.id > $1
        AND COALESCE(oc.do_not_contact, FALSE) = FALSE AND COALESCE(oc.status, '') <> 'do_not_contact'
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
        -- 2026-10-18 (Kev): the pool is a ROTATION — every owner comes round
        -- again every ~25 days. "Contacted ever" excluded them for good, so a
        -- pass left only the never-delivered dead numbers (379 of 7 581) and
        -- Cedric/Gabriela kept drawing the same ones. Now: nobody wrote to this
        -- owner from ANY account within RECYCLE_DAYS, and the owner is not in
        -- a live conversation (replied within REPLY_HOLD_DAYS).
        AND NOT EXISTS (
          SELECT 1 FROM owner_account_labels oal
          WHERE oal.contact_id = oc.id
            AND (oal.last_outreach_at > NOW() - make_interval(days => $3)
                 OR oal.last_we_sent_at > NOW() - make_interval(days => $3)
                 OR oal.last_reply_at > NOW() - make_interval(days => $4))
        )
        AND NOT EXISTS (
          SELECT 1 FROM contact_account_history cah
          WHERE cah.contact_id = oc.id
            AND (cah.last_message_we_sent_at > NOW() - make_interval(days => $3)
                 OR cah.last_message_they_sent_at > NOW() - make_interval(days => $4))
        )
        AND NOT EXISTS (
          SELECT 1 FROM owner_account_labels
          WHERE contact_id = oc.id AND label IN ('dnc', 'angry')
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach_reservations r
          WHERE r.normalized_phone = oc.phone_normalized AND r.released_at IS NULL
        )
        -- Provider said "not on WhatsApp" recently (pool check below, or a
        -- send that failed with no LID). Rechecked after 90 days.
        AND NOT EXISTS (
          SELECT 1 FROM outreach_unreachable u
          WHERE u.phone = oc.phone_normalized
            AND u.reason IN ('not_registered', 'no_lid')
            AND u.last_seen_at > NOW() - INTERVAL '90 days'
        )
      ORDER BY oc.id ASC
      LIMIT $2
    `
    : `
      SELECT oc.id, oc.name, oc.phone_normalized
      FROM owner_contacts oc
      WHERE oc.id < $1
        AND COALESCE(oc.do_not_contact, FALSE) = FALSE AND COALESCE(oc.status, '') <> 'do_not_contact'
      AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
        -- 2026-10-18 (Kev): the pool is a ROTATION — every owner comes round
        -- again every ~25 days. "Contacted ever" excluded them for good, so a
        -- pass left only the never-delivered dead numbers (379 of 7 581) and
        -- Cedric/Gabriela kept drawing the same ones. Now: nobody wrote to this
        -- owner from ANY account within RECYCLE_DAYS, and the owner is not in
        -- a live conversation (replied within REPLY_HOLD_DAYS).
        AND NOT EXISTS (
          SELECT 1 FROM owner_account_labels oal
          WHERE oal.contact_id = oc.id
            AND (oal.last_outreach_at > NOW() - make_interval(days => $3)
                 OR oal.last_we_sent_at > NOW() - make_interval(days => $3)
                 OR oal.last_reply_at > NOW() - make_interval(days => $4))
        )
        AND NOT EXISTS (
          SELECT 1 FROM contact_account_history cah
          WHERE cah.contact_id = oc.id
            AND (cah.last_message_we_sent_at > NOW() - make_interval(days => $3)
                 OR cah.last_message_they_sent_at > NOW() - make_interval(days => $4))
        )
        AND NOT EXISTS (
          SELECT 1 FROM owner_account_labels
          WHERE contact_id = oc.id AND label IN ('dnc', 'angry')
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach_reservations r
          WHERE r.normalized_phone = oc.phone_normalized AND r.released_at IS NULL
        )
        -- Provider said "not on WhatsApp" recently (pool check below, or a
        -- send that failed with no LID). Rechecked after 90 days.
        AND NOT EXISTS (
          SELECT 1 FROM outreach_unreachable u
          WHERE u.phone = oc.phone_normalized
            AND u.reason IN ('not_registered', 'no_lid')
            AND u.last_seen_at > NOW() - INTERVAL '90 days'
        )
      ORDER BY oc.id DESC
      LIMIT $2
    `

  const candidates = (await db.query(candidatesQuery, [cursor, buffer, RECYCLE_DAYS, REPLY_HOLD_DAYS])).rows

  // EXHAUSTED — auto-cycle restart
  if (candidates.length === 0) {
    // Already wrapped once in this request: nothing left anywhere — stop
    // instead of recursing (an empty pool used to wrap forever).
    if (options._wrapped) return { list: [], pool, cursor_advanced_to: cursor, cycle_count: cycleCount, reachability: { notRegistered: 0, unverified: 0 } }
    const maxId = await db.query('SELECT COALESCE(MAX(id), 0) AS m FROM owner_contacts')
    const newCursor = pool === 'top' ? 0 : (maxId.rows[0].m + 1)
    if (advanceCursor) {
      await db.query(
        `UPDATE pool_cursors
           SET cursor_id = $1,
               cycle_count = cycle_count + 1,
               cycle_started_at = NOW(),
               updated_at = NOW()
         WHERE pool = $2`,
        [newCursor, pool]
      )
      log.info('pool exhausted, cycle restarted', { pool, new_cycle: cycleCount + 1 })
      return await buildPoolBatch(sessionName, requestedCount, { ...options, _wrapped: true })
    }
    if (options.wrappedPreview) return { list: [], pool, cursor_advanced_to: cursor, cycle_count: cycleCount }
    return await buildPoolBatch(sessionName, requestedCount, { ...options, cursorOverride: newCursor, wrappedPreview: true, _wrapped: true })
  }

  // Filter: same-account 20-day cooldown (NOT cross-account), then — new on
  // 2026-10-17 — WhatsApp reachability with the sending session. Batch 276
  // got 40 numbers none of which was on WhatsApp because nothing checked.
  // Only VALID numbers enter the list. NOT_REGISTERED is remembered in
  // outreach_unreachable (skipped by the query above for 90 days). A lookup
  // that fails technically is never treated as "no WhatsApp": the number is
  // left out of THIS list and stays in the pool. options.verifyWhatsApp=false
  // restores the previous behaviour.
  const COOLDOWN_DAYS = 20
  const verify = options.verifyWhatsApp !== false
  const reachability = verify ? (options.reachability || require('./whatsappReachability')) : null
  const eligible = []
  const skippedReach = { notRegistered: 0, unverified: 0 }
  let lastProcessedId = cursor
  const seen = new Set()

  const cooldownOk = async (c) => {
    const lastOutreach = await db.query(
      `SELECT last_outreach_at FROM owner_account_labels
       WHERE contact_id = $1 AND account_session = $2`,
      [c.id, sessionName]
    )
    const last = lastOutreach.rows[0]?.last_outreach_at
    return !last || (Date.now() - new Date(last).getTime()) > COOLDOWN_DAYS * 86400000
  }

  let index = 0
  scan: while (index < candidates.length && eligible.length < requestedCount) {
    const chunk = []
    while (index < candidates.length && chunk.length < 5) {
      const c = candidates[index++]
      seen.add(c.id)
      // After a wrap, owners already looked at in this same request are not
      // checked (or listed) a second time.
      if (options._seen?.has(c.id)) { lastProcessedId = c.id; continue }
      if (await cooldownOk(c)) chunk.push(c)
      else lastProcessedId = c.id
    }
    if (!chunk.length) continue
    const statuses = verify
      ? await reachability.classifyMany(sessionName, chunk.map(c => c.phone_normalized))
      : chunk.map(() => ({ status: 'VALID' }))
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk[k]
      const status = statuses[k].status
      if (status === 'VALID') {
        // Full: leave this valid owner (and everything after it) for the next list.
        if (eligible.length >= requestedCount) break scan
        eligible.push(c)
      } else if (status === 'NOT_REGISTERED') {
        skippedReach.notRegistered++
        db.query(
          `INSERT INTO outreach_unreachable (phone, reason, notes, last_seen_at, occurrence_count)
           VALUES ($1, 'not_registered', $2, NOW(), 1)
           ON CONFLICT (phone, reason) DO UPDATE SET last_seen_at = NOW(), occurrence_count = outreach_unreachable.occurrence_count + 1`,
          [c.phone_normalized, `pool check via ${sessionName}`]
        ).catch(err => log.warn('listBuilder: could not record not_registered', { err: err.message }))
      } else {
        skippedReach.unverified++
      }
      lastProcessedId = c.id
    }
  }

  if (advanceCursor) {
    await db.query(
      'UPDATE pool_cursors SET cursor_id = $1, updated_at = NOW() WHERE pool = $2',
      [lastProcessedId, pool]
    )
  }

  // End of the pool reached with the list still short (CRM: "only 8/15
  // eligible found"): it used to stop and only wrap on the NEXT request. Wrap
  // now — start the next cycle from the other end — and fill the rest once.
  const sideExhausted = candidates.length < buffer && index >= candidates.length
  if (eligible.length < requestedCount && sideExhausted && !options._wrapped) {
    const maxId = (await db.query('SELECT COALESCE(MAX(id), 0) AS m FROM owner_contacts')).rows[0].m
    const wrapCursor = pool === 'top' ? 0 : maxId + 1
    if (advanceCursor) {
      await db.query(
        `UPDATE pool_cursors SET cursor_id = $1, cycle_count = cycle_count + 1, cycle_started_at = NOW(), updated_at = NOW()
          WHERE pool = $2`, [wrapCursor, pool])
      log.info('pool end reached mid-list, cycle restarted', { pool, new_cycle: cycleCount + 1, have: eligible.length, want: requestedCount })
    }
    const taken = new Set(eligible.map(c => c.id))
    const rest = await buildPoolBatch(sessionName, requestedCount - eligible.length,
      { ...options, cursorOverride: advanceCursor ? undefined : wrapCursor, _wrapped: true, _seen: seen })
    for (const c of rest.list) if (!taken.has(c.id)) eligible.push(c)
    skippedReach.notRegistered += rest.reachability?.notRegistered || 0
    skippedReach.unverified += rest.reachability?.unverified || 0
    return { list: eligible, pool, cursor_advanced_to: rest.cursor_advanced_to, cycle_count: rest.cycle_count, wrapped: true, reachability: skippedReach }
  }

  return {
    list: eligible,
    pool,
    cursor_advanced_to: lastProcessedId,
    cycle_count: cycleCount,
    reachability: skippedReach,
  }
}

module.exports = Object.assign(module.exports, { buildPoolBatch })
