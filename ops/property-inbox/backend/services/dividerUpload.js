'use strict'
// ============================================================================
// services/dividerUpload.js — command-less upload packages (P0, 2026-11-12)
//
// In a group marked as a divider-upload group (group_config.group_type =
// 'divider_upload') a registered agent sends: photos → description → "...".
// The closing divider is the trigger. Until now nothing listened for it, so
// complete packages sat in "OLGA UPLOADS" unprocessed.
//
// One package = everything the same sender posted after their previous divider
// (or the previous import) up to this divider. It runs through the EXISTING
// upload pipeline (handlers/upload.js cmdUpload) in review mode: the listing is
// created in the internal inventory under the uploading agent, NOT published,
// no Facebook, no client notifications. The group gets the real result.
//
// Every package has a persisted state (upload_packages):
//   RECEIVED → PROCESSING → IMPORTED | REVIEW_REQUIRED | FAILED | DUPLICATE
// keyed by the divider message, so a redelivered webhook or a restart never
// imports twice. A FAILED package can be retried with "!retry".
// ============================================================================

const db = require('../db')
const log = require('../logger')
const waha = require('../waha')

const MIN_TEXT = 40
const CRM_URL = process.env.CRM_PUBLIC_URL || 'https://crm.2906.estate'
// one package is sent in one sitting: a pause longer than this starts a new one
const SITTING_GAP_S = 2 * 3600
const looksLikeListing = t => /€|\beur\b|\bbed(room)?s?\b|\bbath|\b\d\s?br\b|apartment|penthouse|maisonette|townhouse|house\b|villa|studio|\bflat\b|garage|office|\bshop\b|sqm|per month|\bpm\b|available/i.test(t)
const isDivider = body => /^\s*[.…·]{2,}\s*$/.test(String(body || ''))
const tsOf = m => m.timestamp || m._data?.t || 0
const idOf = m => String(m?.id?._serialized || m?.id || m?.key?.id || '')
const bodyOf = m => String(m?.body || m?._data?.body || m?.caption || '').trim()
const senderOf = m => String(m?.participant || m?.author || m?._data?.key?.participant || m?.from || '')
// one logical message has different ids on different sessions; the stanza id is shared
const stanzaOf = m => { const parts = idOf(m).split('_'); const last = parts.pop(); return /^(lid|c\.us)$/.test(last) || /@/.test(last) ? (parts.pop() || last) : last }
// our own confirmations: another logged-in session sees them as a normal group message
const isBotText = b => /^(✅ #|📥 RECEIVED|📝 (IMPORTED|Sales|Commercial)|🟠 REVIEW|❌ (FAILED|No listing)|⚠️ (DUPLICATE|Looks like)|🔁 Retrying|📂 #|Nothing to retry)/.test(b)
// the same person must compare equal whether WhatsApp reports a phone or a @lid
function senderKey(m) {
  try { const d = require('./senderIdentity').senderDigits(m, true); if (d) return String(d) } catch {}
  return senderOf(m)
}

let groupCache = { at: 0, ids: new Set() }
async function isDividerUploadGroup(chatId) {
  if (Date.now() - groupCache.at > 60_000) {
    try {
      const r = await db.query(`SELECT group_id FROM group_config WHERE group_type = 'divider_upload' AND is_active = TRUE`)
      groupCache = { at: Date.now(), ids: new Set(r.rows.map(x => String(x.group_id))) }
    } catch (err) { log.warn('[dividerUpload] group config read failed', { err: err.message }); groupCache.at = Date.now() }
  }
  return groupCache.ids.has(String(chatId))
}

// Pure: which messages belong to the package closed by `divider`.
// `messages` is the chat history (any order). Returns { text, textCount, mediaCount, firstTs, messageIds }.
function assemblePackage(messages, divider, { floorTs = 0, keyOf = senderOf } = {}) {
  const dTs = tsOf(divider), dSender = keyOf(divider), dId = stanzaOf(divider)
  const mine = messages.filter(m => !m.fromMe && keyOf(m) === dSender && tsOf(m) <= dTs && stanzaOf(m) !== dId && !isBotText(bodyOf(m)))
    .sort((a, b) => tsOf(a) - tsOf(b))
  // previous closing divider of the same sender, or an explicit floor (previous import)
  let start = floorTs
  for (const m of mine) if (isDivider(bodyOf(m)) && tsOf(m) < dTs) start = Math.max(start, tsOf(m))
  const sinceFloor = mine.filter(m => tsOf(m) > start && !isDivider(bodyOf(m)) && !bodyOf(m).startsWith('!'))
  // keep only the last sitting; what was sent hours earlier without a closing divider is reported, not merged
  let cut = 0
  for (let i = sinceFloor.length - 1; i > 0; i--) if (tsOf(sinceFloor[i]) - tsOf(sinceFloor[i - 1]) > SITTING_GAP_S) { cut = i; break }
  const block = sinceFloor.slice(cut), orphans = sinceFloor.slice(0, cut)
  const texts = block.filter(m => bodyOf(m) && !m.hasMedia || (m.hasMedia && bodyOf(m).length >= MIN_TEXT))
  const media = block.filter(m => m.hasMedia)
  const text = texts.map(bodyOf).join('\n').trim()
  return {
    text, textCount: texts.length, mediaCount: media.length,
    firstTs: block.length ? tsOf(block[0]) : 0, lastTs: block.length ? tsOf(block[block.length - 1]) : 0,
    messageIds: block.map(idOf),
    orphanMedia: orphans.filter(m => m.hasMedia).length, orphanText: orphans.filter(m => !m.hasMedia && bodyOf(m).length >= MIN_TEXT).length,
    // chatter that happens to end in "..." is not a package
    complete: text.length >= MIN_TEXT && looksLikeListing(text),
    reason: text.length < MIN_TEXT ? 'no description' : (looksLikeListing(text) ? null : 'text is not a property description'),
  }
}

async function event(type, pkg, extra = {}) {
  try { await require('./automationEvents').record({ rule: 'divider_upload', action: type, result: extra.result || type.toLowerCase(), agentId: pkg.agent_id, propertyId: extra.propertyId || null, ref: extra.ref || null, account: pkg.session, details: { package_id: pkg.id, chat: pkg.chat_id, media_expected: pkg.media_expected, ...extra.details } }) }
  catch (err) { log.debug('[dividerUpload] event not recorded', { err: err.message }) }
}

// Runs one package. `run` is handlers/upload.js cmdUpload; `reply` sends into the group.
async function processPackage({ pkg, dividerPayload, session, chatId, run, reply, historyLimit = null }) {
  const claimed = await db.query(
    `UPDATE upload_packages SET state = 'PROCESSING', attempts = attempts + 1, processing_started_at = NOW(), updated_at = NOW(), failure_reason = NULL
      WHERE id = $1 AND state IN ('RECEIVED', 'FAILED') RETURNING *`, [pkg.id])
  if (!claimed.rows.length) return { skipped: 'not_claimable' }
  pkg = claimed.rows[0]
  await event('PROCESSING', pkg)
  let outcome = null
  try {
    // cmdUpload gathers the same block itself (same sender, back to the previous divider / import)
    const payload = { ...dividerPayload, body: '', _data: { ...(dividerPayload._data || {}), body: '' } }
    if (historyLimit) payload._historyLimit = historyLimit
    if (pkg.first_message_ts) payload._windowStartTs = Number(pkg.first_message_ts) - 1
    // the listing belongs to the agent who sent the package, whichever session or retry runs it
    const agentOverride = pkg.agent_id ? (await db.query(`SELECT id, username, name, display_name, alias, role, post_tag FROM agents WHERE id = $1 AND active = TRUE`, [pkg.agent_id])).rows[0] || null : null
    await run({
      payload, session, chatId, isGroup: true, text: '!upload', variantSuffix: '', force: false, wantsGroup: false,
      noAd: true, intakeMode: 'review', photoMode: null, onResult: r => { outcome = r }, agentOverride,
    })
  } catch (err) {
    outcome = { created: [], dupes: [], errors: [String(err.message || err).slice(0, 300)], crashed: true }
  }
  const created = outcome?.created || [], dupes = outcome?.dupes || [], errors = outcome?.errors || []
  let state, reason = null
  const imported = created.reduce((n, c) => n + (c.imageCount || 0) + (c.videoCount || 0), 0)
  if (created.length) {
    const why = []
    if (imported < pkg.media_expected) why.push(`${imported} of ${pkg.media_expected} media recovered`)
    if (created.some(c => c.explicitFactsOnly)) why.push('AI extractor unavailable: only facts stated in the text were read')
    if (created.some(c => c.ownerUnknown)) why.push('no owner contact in the upload')
    state = why.length ? 'REVIEW_REQUIRED' : 'IMPORTED'
    if (why.length) reason = why.join('; ')
  } else if (dupes.length) { state = 'DUPLICATE'; reason = `duplicate of #${dupes[0]}` }
  else { state = 'FAILED'; reason = errors.join('; ').slice(0, 500) || outcome?.message || 'the upload pipeline created nothing' }
  const done = (await db.query(
    `UPDATE upload_packages SET state = $2, failure_reason = $3, media_imported = $4, property_ids = $5::int[], property_refs = $6::text[], updated_at = NOW(), finished_at = NOW()
      WHERE id = $1 RETURNING *`,
    [pkg.id, state, reason, imported, created.map(c => c.propId), created.map(c => c.ref || '')])).rows[0]
  // Incoming Properties (2026-11-13): every draft from a package starts UNVERIFIED with its
  // WhatsApp upload time, and is reviewed in ARGUS → Incoming. Verification never publishes.
  if (created.length) {
    try {
      await db.query(
        `UPDATE properties SET verification_status = 'unverified', intake_source = 'whatsapp_divider', intake_package_id = $2,
                intake_received_at = to_timestamp($3)
          WHERE id = ANY($1::int[]) AND intake_source IS NULL`,
        [created.map(c => c.propId), pkg.id, Number(pkg.first_message_ts || pkg.divider_ts)])
    } catch (err) { log.warn('[dividerUpload] intake marking failed', { packageId: pkg.id, err: err.message }) }
  }
  for (const c of created) await event(state, done, { propertyId: c.propId, ref: c.ref, result: state === 'IMPORTED' ? 'success' : 'review_required', details: { media_imported: (c.imageCount || 0) + (c.videoCount || 0) } })
  if (!created.length) await event(state, done, { result: state === 'DUPLICATE' ? 'skipped' : 'failed', details: { reason } })

  // The pipeline already posted its own confirmation / error. Add only what it cannot know.
  try {
    const review = created.length ? `\nReview in ARGUS: ${created.map(c => `${CRM_URL}/incoming?id=${c.propId}`).join(' ')}` : ''
    if (state === 'REVIEW_REQUIRED') await reply(session, chatId, `🟠 REVIEW REQUIRED — ${created.map(c => `#${c.ref} (ID ${c.propId})`).join(', ')}: saved as an internal draft with ${imported} of ${pkg.media_expected} photos/videos, not published.\nTo check: ${reason}.${review}`)
    else if (state === 'IMPORTED') await reply(session, chatId, `🔎 Verification required before use — ${created.map(c => `#${c.ref}`).join(', ')}.${review}`)
    else if (state === 'FAILED') await reply(session, chatId, `❌ FAILED — package of ${pkg.media_expected} media was not imported: ${reason}\nNothing was created. Safe retry: reply !retry (package ${pkg.id}).`)
    else if (state === 'DUPLICATE') await reply(session, chatId, `⚠️ DUPLICATE — nothing created (${reason}). If this really is a different property: !upload force.`)
  } catch (err) { log.warn('[dividerUpload] result reply failed', { packageId: pkg.id, err: err.message }) }
  log.info('[dividerUpload] package finished', { packageId: pkg.id, state, properties: created.map(c => c.ref), imported, expected: pkg.media_expected, reason })
  return { state, package: done, created }
}

// Webhook entry: a divider arrived in a divider-upload group. Returns true when it was ours.
async function handleDivider({ payload, session, chatId, uploaderPhone, agent, run, reply, settleMs = 20_000, historyLimit = 120 }) {
  if (!agent) { log.info('[dividerUpload] divider from an unregistered sender ignored', { chatId: String(chatId).slice(-10) }); return false }
  // settle: a large album is still arriving / being stored when the divider lands
  if (settleMs) await new Promise(res => setTimeout(res, settleMs))
  let messages = []
  try { messages = await waha.getChatMessages(session, chatId, historyLimit) }
  catch (err) { log.warn('[dividerUpload] history read failed', { err: err.message }) }
  const floor = await db.query(
    `SELECT COALESCE(MAX(divider_ts), 0)::bigint AS ts FROM upload_packages WHERE chat_id = $1 AND sender_jid = $2 AND divider_ts < $3`,
    [String(chatId), senderOf(payload), tsOf(payload)])
  const pack = assemblePackage(messages, payload, { floorTs: Number(floor.rows[0].ts) || 0, keyOf: senderKey })
  if (!pack.complete && pack.mediaCount >= 3 && !pack.text) {
    // photos closed with a divider but no description: say so instead of staying silent
    try { await reply(session, chatId, `⚠️ REVIEW REQUIRED — ${pack.mediaCount} photos received before "..." but no property description. Nothing was imported. Send the description, then "..." again.`) } catch {}
    await require('./automationEvents').record({ rule: 'divider_upload', action: 'REVIEW_REQUIRED', result: 'skipped', agentId: agent.id, account: session, reason: 'photos without description', details: { chat: String(chatId), media_expected: pack.mediaCount } })
    return true
  }
  if (!pack.complete) {
    // an opening divider, or a divider after chatter: not a package
    log.info('[dividerUpload] divider without a complete package before it — ignored', { chatId: String(chatId).slice(-10), text: pack.text.length, media: pack.mediaCount })
    return false
  }
  const ins = await db.query(
    `INSERT INTO upload_packages (chat_id, session, divider_message_id, divider_stanza_id, divider_ts, sender_jid, uploader_phone, agent_id, media_expected, text_chars, first_message_ts, summary, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RECEIVED')
     ON CONFLICT (chat_id, divider_stanza_id) DO NOTHING RETURNING *`,
    [String(chatId), session, idOf(payload), stanzaOf(payload), tsOf(payload), senderOf(payload), uploaderPhone || null, agent.id, pack.mediaCount, pack.text.length, pack.firstTs, (pack.text.split('\n').find(l => /[a-z0-9]/i.test(l)) || '').trim().slice(0, 160)])
  if (!ins.rows.length) { log.info('[dividerUpload] package already known — not imported twice', { stanza: stanzaOf(payload) }); return true }
  const pkg = ins.rows[0]
  await event('RECEIVED', pkg, { result: 'received' })
  const orphanNote = pack.orphanMedia || pack.orphanText
    ? `\nℹ️ Not included: ${pack.orphanMedia} photo(s) and ${pack.orphanText} text message(s) sent more than 2 hours earlier without a closing "...".` : ''
  try { await reply(session, chatId, `📥 RECEIVED — ${pack.mediaCount} photo${pack.mediaCount === 1 ? '' : 's'}/video${pack.mediaCount === 1 ? '' : 's'} + description. PROCESSING…${orphanNote}`) }
  catch (err) { log.warn('[dividerUpload] received reply failed', { err: err.message }) }
  await processPackage({ pkg, dividerPayload: payload, session, chatId, run, reply, historyLimit })
  return true
}

// "!retry" in the group: re-run the newest FAILED package of that chat.
async function retryLatestFailed({ session, chatId, run, reply }) {
  const r = await db.query(`SELECT * FROM upload_packages WHERE chat_id = $1 AND state = 'FAILED' AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`, [String(chatId)])
  if (!r.rows.length) { await reply(session, chatId, 'Nothing to retry: no failed upload package in this group.'); return true }
  await rerun({ pkg: r.rows[0], session, chatId, run, reply })
  return true
}

// Retry one FAILED package by id (ARGUS → Incoming → Failed uploads → Retry).
async function retryPackage({ packageId, run, reply, requestedBy = null }) {
  const r = await db.query(`SELECT * FROM upload_packages WHERE id = $1`, [Number(packageId)])
  const pkg = r.rows[0]
  if (!pkg) return { skipped: 'not_found' }
  if (pkg.state !== 'FAILED') return { skipped: `state_${String(pkg.state).toLowerCase()}` }
  log.info('[dividerUpload] retry requested from ARGUS', { packageId: pkg.id, by: requestedBy?.id || null })
  return rerun({ pkg, session: pkg.session, chatId: pkg.chat_id, run, reply })
}

async function rerun({ pkg, session, chatId, run, reply }) {
  // Use the real divider message again: only the full WhatsApp message carries the
  // phone behind a @lid sender, and the pipeline matches the sender on that phone.
  let msgs = []
  try { msgs = await waha.getChatMessages(session, chatId, 400) } catch (err) { log.warn('[dividerUpload] retry history read failed', { err: err.message }) }
  let payload = msgs.find(m => stanzaOf(m) === pkg.divider_stanza_id)
  if (!payload) {
    const like = msgs.find(m => !m.fromMe && !m.hasMedia && senderOf(m) === pkg.sender_jid)
    payload = like
      ? { ...like, id: pkg.divider_message_id, timestamp: Number(pkg.divider_ts), body: '...' }
      : { id: pkg.divider_message_id, timestamp: Number(pkg.divider_ts), from: pkg.chat_id, participant: pkg.sender_jid, fromMe: false, body: '...' }
  }
  await reply(session, chatId, `🔁 Retrying package ${pkg.id} (${pkg.media_expected} media). PROCESSING…`)
  return processPackage({ pkg, dividerPayload: payload, session, chatId, run, reply, historyLimit: 300 })
}

// Watchdog (cron): a package that sat in RECEIVED/PROCESSING through a restart is put back to FAILED with a reason, never lost.
async function sweepStuck({ minutes = 20 } = {}) {
  const r = await db.query(
    `UPDATE upload_packages SET state = 'FAILED', failure_reason = 'interrupted (restart or crash) before completion', updated_at = NOW()
      WHERE state IN ('RECEIVED', 'PROCESSING') AND updated_at < NOW() - ($1 || ' minutes')::interval RETURNING id, chat_id`, [String(minutes)])
  if (r.rows.length) log.warn('[dividerUpload] stuck packages marked FAILED (retry with !retry)', { ids: r.rows.map(x => x.id) })
  return r.rows
}

module.exports = { senderKey, stanzaOf, isBotText, isDividerUploadGroup, assemblePackage, handleDivider, processPackage, retryLatestFailed, retryPackage, sweepStuck, isDivider, _resetCache() { groupCache = { at: 0, ids: new Set() } } }
