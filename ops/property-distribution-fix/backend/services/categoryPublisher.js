'use strict'
// ============================================================================
// categoryPublisher.js — publish a classified property to its WhatsApp
// category groups.
//
//   publishToCategoryGroups(propertyId) → { posted:[...], failed:[...], ... }
//   previewCategoryPost(propertyId)     → DRY RUN, sends nothing
//
// Flow:
//   1. load properties.public_payload
//   2. keys = classifyProperty(payload)
//   3. key → group_id from category_groups (active only)
//   4. send text + images to the group via waha.sendText / waha.sendImage
//      (default session — the same helper avCapture uses for group sends).
//      Group sends are spaced 8–15 s apart, randomized per send.
//   5. capture the returned WhatsApp message id → external_ref
//      (needed later for rented-detection)
//   6. upsert property_publishing_status per group
//   7. IDEMPOTENCY: skip a group already status='posted' for this property
//   8. return a summary
//
// Publishers receive ONLY sanitizeForPublic() output — never the raw row.
// Package 1 (buildMessage, the public/introduction text) keeps that
// contract exactly: street/apt are read only for the LEAK ASSERTION that
// proves they are ABSENT from it. Package 2 (buildAgentMessage, added
// 2026-09-08) is the one deliberate exception — it is EXPECTED to carry
// the real address (falling back to locality if none is on file yet) and
// any restriction lines the ad text had, sent as its own message right
// after Package 1 in the SAME property groups only. Never call
// buildAgentMessage for any other channel (website/CRM public description/
// Facebook) — those stay on Package 1's locality-only text, unchanged.
// ============================================================================

const db   = require('../db')
const log  = require('../logger')
const waha = require('../waha')
const { classifyProperty } = require('./categoryClassifier')
const { formatForCategoryGroup, formatAgentPackage, splitRestrictions, availableLabel, assertNoOwnerDataLeak, liveLeasePatch } = require('./categoryFormatter')
const { formatPostTag } = require('./agentTag')
// NOTE: withKevCta is intentionally NOT applied here. Kev's WA CTA belongs on
// FB Page posts / FB group shares / schedule-board posts (the FB channel where
// it surfaces FB's "WhatsApp-Nachricht senden" button), NOT on the WhatsApp
// category groups — owners browsing those groups already have a tap-to-chat
// with Kev via the platform itself, and surfacing a second CTA on every
// ad there clutters the channel and looks like the bot is trying to pull
// viewers off WA onto WhatsApp-DM (which is what the CTA is for, but the
// audience there is owner-side, not viewer-side).

// Fallback identity when a caller does not pass one explicitly (e.g. a
// script run by hand, or !recategorize). handlers/upload.js's own upload
// flow always passes its already-resolved pickUploadSession() result instead
// — see publishToCategoryGroups(propertyId, opts) below — so Default being
// down does not block a normal !upload. 'default' stays the last-resort
// value here, matching every other admin-fallback in this codebase.
const DEFAULT_SESSION    = 'default'
const GROUP_GAP_MIN_MS   = 8000
const GROUP_GAP_MAX_MS   = 15000
const IMAGE_GAP_MS       = 2500
const IMAGE_TIMEOUT_MS   = 20000
// Kev, 2026-08-29: waha.sendText's own 15s default was aborting during a
// mass campaign — GOWS is one worker per session, and back-to-back
// sendImage calls to other groups leave a plain text send queued long
// enough to blow it. Same fix as sendImage/sendVideo already have.
const TEXT_TIMEOUT_MS    = 30000
const MAX_VIDEOS         = 3
// A clip is 10–100× the bytes of a photo, and WAHA re-encodes it with ffmpeg
// before it goes out, so both the download and the send need real headroom.
const VIDEO_TIMEOUT_MS   = 90000
const VIDEO_GAP_MS       = 6000
// Same '...' separator AV CENTRAL gets after an upload cycle, sent into the
// category group once text + images are through, so consecutive listings are
// visually separated there too. Best-effort: never fails the post.
const DIVIDER            = '...'
const { propertyActionLinks } = require('./agentPropertyLinks')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// fresh random gap for EVERY send — not computed once at module load
const groupGap = () =>
  GROUP_GAP_MIN_MS + Math.floor(Math.random() * (GROUP_GAP_MAX_MS - GROUP_GAP_MIN_MS + 1))

// ── helpers ──────────────────────────────────────────────────────────────────

// waha.sendImage()/sendVideo() take base64 + mimeType (NOT a URL), so download first.
async function downloadAsBase64(url, { timeoutMs = IMAGE_TIMEOUT_MS, fallbackMime = 'image/jpeg' } = {}) {
  const ctl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(url, { signal: ctl })
  if (!res.ok) throw new Error(`media fetch ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('empty media body')
  const mime = res.headers.get('content-type') || fallbackMime
  return { data: buf.toString('base64'), mime: mime.split(';')[0].trim() }
}

async function loadProperty(propertyId) {
  // post_tag comes from the agent who ran !upload (properties.listed_by_agent_id).
  // Kev, 2026-09-07: p.available_date is selected separately from
  // public_payload on purpose — public_payload is a snapshot frozen at
  // upload time, so a later dashboard edit to the date (or any other field
  // the CRM writes straight to the properties row) never touched it. Every
  // repost read that frozen copy and kept showing whatever month the ad
  // said on day one. buildMessage() below overrides public_payload's own
  // available_date with this live column so a repost always reflects
  // whatever the property record says RIGHT NOW — the property row is the
  // source of truth, public_payload is only a cache of the ad prose.
  // Kev, 2026-09-08: p.viewing_date, same live-column reasoning as
  // available_date above — buildAgentMessage's "Viewings:" line used to be
  // hardcoded 'Now' with no real field behind it at all (see that
  // function's own former comment, now corrected). Real bug, live on
  // #2906-9193: Package 2 said "Viewings: Now" while Package 1 correctly
  // said "Available After 21st September" one line above it — because
  // nothing ever read this column.
  //
  // MATCH + AV HOTFIX (Kev, 2026-09-16): p.viewing_date turned out to be the
  // wrong field for this line too — it is a specific scheduled-APPOINTMENT
  // timestamp (property_viewings' own concept), not "can this generally be
  // viewed and how". A stale PAST appointment date sitting in that column
  // reads as "Viewings: Now" via availableLabel()'s own <=today rule —
  // functionally the SAME #2906-9193 symptom recurring for a different
  // reason. p.viewings_allowed/viewing_mode/viewing_confirmation_status
  // (CRITICAL OWNER FLOW FIX, same date — availability_checks.
  // pending_question_type) are the real canonical viewing state; p.
  // viewing_date is still selected below for anything else that may still
  // read it, but buildAgentMessage no longer uses it for this line.
  // PROPERTY GROUP ROUTING AUDIT (Kev, 2026-09-16): p.bedrooms/property_type/
  // longlet_price, same live-column reasoning as available_date/viewing_date
  // above. classifyProperty() (services/categoryClassifier.js) decides the
  // destination group from beds/type/price -- if those numbers come from the
  // FROZEN public_payload snapshot instead of the live properties row, a
  // property whose bedroom count was ever wrong at upload time and later
  // corrected in the CRM (or corrected during upload itself, after the
  // payload snapshot was already built) keeps routing by the OLD number
  // forever, on every repost, even though the rendered description text
  // (also read from public_payload, but the free-text ad copy the agent
  // actually wrote) can independently say the right thing. That mismatch —
  // description says "3 Double Bedrooms", routed to ONE BEDROOM — is exactly
  // the reported Għargħur incident. See liveClassificationPayload() below,
  // used at every classifyProperty() call site in this file.
  const r = await db.query(
    `SELECT p.id, p.ref, p.street, p.apt, p.sub_location, p.town, p.public_payload, p.videos,
            p.available_status, p.available_date, p.available_until, p.rental_modes, p.lease_type, p.shortlet, p.viewing_date, p.viewings_allowed, p.viewing_mode, p.viewing_confirmation_status,
            p.bedrooms, p.property_type, p.longlet_price,
            p.category_override,
            COALESCE((
              SELECT jsonb_agg(e.source_image_url ORDER BY e.position)
                FROM property_photo_edits e
               WHERE e.property_id=p.id AND e.source_image_url IS NOT NULL
            ), '[]'::jsonb) AS original_group_images,
            a.post_tag
       FROM properties p
       LEFT JOIN agents a ON a.id = p.listed_by_agent_id
      WHERE p.id = $1`,
    [propertyId])
  const row = r.rows[0]
  if (!row) throw new Error(`property id ${propertyId} not found`)
  if (!row.public_payload) {
    throw new Error(`#${row.ref} has no public_payload — re-run !upload for this listing`)
  }
  return row
}

// The live-canonical override for classification specifically — same
// pattern buildMessage() already uses for available_date, applied to every
// field services/categoryClassifier.js's classifyKeys() reads (beds/type/
// price). ALWAYS call this instead of passing row.public_payload straight
// into classifyProperty(), so a stale snapshot can never route a listing to
// the wrong group again. properties.bedrooms/property_type/longlet_price
// are NEVER null for a real published listing, so `??` only ever falls back
// to the snapshot for a row this fix doesn't apply to (none currently).
function liveClassificationPayload(row) {
  return {
    ...row.public_payload,
    beds: row.bedrooms, bedrooms: row.bedrooms,
    type: row.property_type, property_type: row.property_type,
    longlet_price: row.longlet_price,
  }
}

// Adrian → (^A), Olga → (^O). Agents without a post_tag (Kev / house
// listings) stay untagged, exactly as before.
const agentTag = (row) => formatPostTag(row?.post_tag)

// Build the message and prove it carries no owner data / precise location.
// Restriction lines ("🚫 No Pets"/"🚫 No Sharing") are stripped HERE, before
// formatForCategoryGroup ever sees the text — that function is shared with
// FB Page posts, FB group direct-share and the agenttag caption, none of
// which get the two-package split (Kev's explicit "Facebook bleibt
// unverändert" scoping), so the strip cannot live inside it. The stripped
// lines feed buildAgentMessage() below for Package 2.
function buildMessage(row) {
  // Kev, 2026-09-16 (live incident #2906-9304): available_date was already
  // live-overridden here, but available_until was not — winterLine() below
  // reads p.available_until, which only ever existed in the frozen
  // public_payload snapshot (almost always absent there, since it's a
  // newer column than most stored snapshots), so a genuine short/winter-let
  // end date silently never rendered. Same live-column pattern as
  // available_date right next to it.
  const livePayload = { ...row.public_payload, available_date: row.available_date, available_until: row.available_until, ...liveLeasePatch(row) }
  if (livePayload.description_social) livePayload.description_social = splitRestrictions(livePayload.description_social).body
  if (livePayload.description_public) livePayload.description_public = splitRestrictions(livePayload.description_public).body
  let message = formatForCategoryGroup(livePayload)
  const tag = agentTag(row)
  if (tag) message += `\n${tag}`
  // NOTE: Kev's WA-CTA is intentionally NOT appended here. The category
  // WhatsApp groups are shared with other agents — adding Kev's personal
  // WhatsApp-link on a multi-agent channel would push prospects to one
  // specific agent over the others, breaking the fairness the channel
  // exists for. The CTA lives on FB-only channels (Page posts, FB-Direct-
  // share, FB-group campaigns) where a single attribution makes sense.
  // Leak check still runs on the post-CTA-free string.
  assertNoOwnerDataLeak(message, { street: row.street, apt: row.apt })
  return message
}

// Package 2 — agent-only details (Kev, 2026-09-08). The ONE place in this
// file allowed to put the real address into a property-group message —
// same audience as Package 1 (the agents already in that group), never
// forwarded to buildMessage()'s own leak-checked public package, the
// website, CRM description or Facebook, which all still get exactly the
// single locality-only package they always have.
//
// restrictions come from splitRestrictions() run on the SAME raw ad text
// buildMessage() strips them out of — one extraction, read twice, not a
// second source of truth for what the ad said.
//
// viewingsLabel: MATCH + AV HOTFIX (Kev, 2026-09-16) — reads the canonical
// viewing-state columns (viewings_allowed/viewing_mode/
// viewing_confirmation_status), NOT properties.viewing_date (a specific
// scheduled-appointment timestamp; see loadProperty's own comment on why
// that field kept reproducing the #2906-9193 "Viewings: Now" bug). Property
// availability and viewing availability are two separate state machines —
// this line only ever describes the second one, and says nothing at all
// (returns null, no line rendered) rather than inventing an answer when the
// owner has never actually confirmed viewing conditions.
function viewingsLabelFor(row) {
  if (row.viewings_allowed === false) return null
  if (row.viewing_confirmation_status === 'conditional') return 'Possible, pending confirmation'
  if (row.viewing_mode === 'by_appointment') return 'By appointment'
  if (row.viewing_mode === 'advance_notice') return 'Possible with prior notice'
  if (row.viewings_allowed === true) return 'Now'
  return null // unknown — never invent a viewings line
}
function buildAgentMessage(row, restrictions) {
  const address = (row.street && row.street.trim()) || row.sub_location || row.town || null
  // Kev, 2026-09-10: maps_links is written by sanitizeForPublic's maps-link
  // firewall (services/sanitizer.js) at upload time — whatever Google Maps
  // link/coordinate the owner pasted, pulled OUT of the public ad text.
  // Package 2 is the one place it is allowed to surface, same as address.
  const mapsLinks = Array.isArray(row.public_payload?.maps_links) ? row.public_payload.maps_links : []
  const label = availableLabel(row.available_date)
  let message = formatAgentPackage({
    ref_id: row.ref, restrictions, address, mapsLinks,
    viewingsLabel: viewingsLabelFor(row), availableLabel: label,
  })
  // Kev, 2026-10-19: the AGENT card (Package 2, never the client description)
  // carries the availability marker on top and the booking + info links, so
  // agents can jump straight to the listing. Package 1 stays untouched.
  const marker = label === 'Now' ? '🟢 AVAILABLE NOW' : `🗓️ AVAILABLE ${String(label).toUpperCase()}`
  const links = propertyActionLinks(row.ref)
  if (links) {
    const linkLines = `📅 Book a viewing: ${links.book}\nℹ️ Info & photos: ${links.detail}`
    const refLine = `\n\n#${row.ref}`
    message = message.includes(refLine)
      ? message.replace(refLine, `\n${linkLines}${refLine}`)
      : `${message}\n${linkLines}`
  }
  message = `${marker}\n\n${message}`
  const tag = agentTag(row)
  if (tag) message += `\n${tag}`
  return message
}

function payloadImages(payload, property = null) {
  // GPT selection/replacement belongs to online publishing. Property groups
  // receive the complete original package. For a normal !upload there is no
  // photo-edit mapping, so this falls back to the canonical gallery.
  const originals = Array.isArray(property?.original_group_images) ? property.original_group_images : []
  const imgs = originals.length ? originals : (Array.isArray(payload?.images) ? payload.images : [])
  const seen = new Set()
  return imgs
    .map(i => (typeof i === 'string' ? i : (i && i.url) || null))
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
    .filter(u => !seen.has(u) && seen.add(u))
  // WhatsApp property groups are the complete internal property package:
  // forward every valid gallery image in its original order. Website cards,
  // previews and other publishing channels keep their own compact limits.
}

// properties.videos, not public_payload — the sanitizer is off-limits and a
// media URL has nothing to sanitize.
function propertyVideos(row) {
  const vids = Array.isArray(row?.videos) ? row.videos : []
  return vids
    .map(v => (typeof v === 'string' ? v : (v && v.url) || null))
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
    .slice(0, MAX_VIDEOS)
}

async function activeGroupsForKeys(keys) {
  if (!keys.length) return []
  const r = await db.query(
    `SELECT key, group_id, display_name FROM category_groups
      WHERE key = ANY($1::text[]) AND active = TRUE
      ORDER BY priority, key`,
    [keys])
  return r.rows
}

// channel: 'category_groups' (Package 1, public) or 'category_groups_agent'
// (Package 2, agent-only) — two independent rows per group (the table's
// UNIQUE is (property_id, channel, target_ref)), so each package is its
// own idempotency/repost unit exactly as the brief requires ("beide müssen
// über !av <ref> einzeln abrufbar/repostbar sein"), no schema change.
async function alreadyPosted(propertyId, groupId, channel = 'category_groups') {
  const r = await db.query(
    `SELECT 1 FROM property_publishing_status
      WHERE property_id = $1 AND channel = $3
        AND target_ref = $2 AND status = 'posted'
      LIMIT 1`,
    [propertyId, groupId, channel])
  return r.rowCount > 0
}

// `session` recorded so a later reaction (rented-detection's 😡, see
// availability.js reactAngryInPropertyGroups) reacts AS the account that
// actually sent this message — a fallback account's send is invisible to
// 'default' otherwise.
async function markPosted(propertyId, groupId, externalRef, session, channel = 'category_groups') {
  await db.query(
    `INSERT INTO property_publishing_status
       (property_id, channel, target_ref, status, posted_at, external_ref,
        attempt_count, last_error, updated_at, session)
     VALUES ($1,$5,$2,'posted',NOW(),$3,1,NULL,NOW(),$4)
     ON CONFLICT (property_id, channel, target_ref) DO UPDATE
       SET status = 'posted', posted_at = NOW(), external_ref = EXCLUDED.external_ref,
           attempt_count = property_publishing_status.attempt_count + 1,
           last_error = NULL, updated_at = NOW(), session = EXCLUDED.session`,
    [propertyId, groupId, externalRef, session || null, channel])
}

async function markFailed(propertyId, groupId, errMsg, channel = 'category_groups') {
  await db.query(
    `INSERT INTO property_publishing_status
       (property_id, channel, target_ref, status, attempt_count, last_error, updated_at)
     VALUES ($1,$4,$2,'failed',1,$3,NOW())
     ON CONFLICT (property_id, channel, target_ref) DO UPDATE
       SET status = 'failed',
           attempt_count = property_publishing_status.attempt_count + 1,
           last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [propertyId, groupId, String(errMsg || '').slice(0, 2000), channel])
}

// ── publish ──────────────────────────────────────────────────────────────────

// Kev, 2026-09-01 (KRITISCH: category distribution stuck on Default): the
// bug was never "no fallback resolver exists" — pickActiveAdminSession() was
// already here. It is that a session picked as WORKING at the top of this
// function can still be a zombie by the time the actual send happens (WAHA
// occasionally reports WORKING/CONNECTED status while the underlying
// whatsmeow socket is actually dead), and wahaRequest()'s own client-side
// AbortController then fires after its timeout with exactly "This operation
// was aborted" — a real send failure, not a categorization bug, and not
// something a single upfront status check can catch. !recategorize repeated
// the identical failure because it kept retrying the SAME session with no
// escape hatch.
//
// Fix: the text send that opens each group's post — the one whose failure
// currently aborts the whole group — now retries across this SAME
// Default→Second→Third→Cedric→Jasmine chain upload.js's own
// pickUploadSession() falls back through, actually attempting a real send
// on each candidate (not just checking its status) until one works. Once a
// session is confirmed live THIS RUN, it becomes the preferred session for
// the remaining groups too, so a confirmed-dead Default is not re-tried
// (and re-timed-out) once per group.
// Kev's exact chain: Default → Kevsecond → kevthirdd → Cedric → Jasmine.
// `default` is included here too (not just as the initial pick) — a status
// check moments earlier saying it's down doesn't rule out a transient
// zombie state recovering by the time we'd otherwise reach it in the chain.
const FALLBACK_SESSION_CHAIN = ['default', 'Kevsecond', 'kevthirdd', 'Cedric', 'Jasmine']

async function sendTextWithFallback(preferredSession, chatId, message) {
  const order = [preferredSession, ...FALLBACK_SESSION_CHAIN.filter(s => s !== preferredSession)]
  let lastErr = null
  for (const candidate of order) {
    try {
      const status = await waha.getSessionStatus(candidate)
      if (status?.status !== 'WORKING' && status?.status !== 'CONNECTED') {
        lastErr = new Error(`session ${candidate} not live (status=${status?.status || 'unknown'})`)
        continue
      }
    } catch (err) {
      lastErr = err
      continue
    }
    try {
      const sent = await waha.sendText(candidate, chatId, message, { timeoutMs: TEXT_TIMEOUT_MS })
      return { session: candidate, sent }
    } catch (err) {
      log.warn('categoryPublisher: send failed on session, trying next fallback', {
        session: candidate, chatId, err: err.message })
      lastErr = err
    }
  }
  throw new Error(`no working WhatsApp session for category post (tried ${order.join(', ')}): ${lastErr?.message || 'unknown'}`)
}

async function publishToCategoryGroups(propertyId, opts = {}) {
  // opts.session: the identity to post as. handlers/upload.js passes its
  // pickUploadSession() result so the whole upload (gate + reaction + this)
  // reads as one consistent account; a caller with no opinion (a one-off
  // script, !recategorize) falls back to the same Default→Second→Third
  // chain !av/!book already use, same as everywhere else in this file's
  // neighbourhood — never a bare hardcoded 'default' with no live check.
  // This is still only the STARTING preference — sendTextWithFallback above
  // is what actually keeps the whole run alive if it turns out to be dead.
  let session = opts.session || (await waha.pickActiveAdminSession()) || DEFAULT_SESSION

  const row = await loadProperty(propertyId)
  const payload = row.public_payload

  if (require('./futureAvailability').isFarFuture(row.available_date)) {
    log.info('categoryPublisher: future availability suppressed', { ref: row.ref, availableDate: row.available_date })
    return {
      ref: row.ref, propertyId, keys: [], reasoning: 'future_availability',
      availableDate: row.available_date instanceof Date ? row.available_date.toISOString().slice(0, 10) : String(row.available_date),
      posted: [], failed: [], skipped: [], results: [], skippedReason: 'future_availability',
    }
  }

  // PROPERTY GROUP ROUTING AUDIT fix (2026-09-16): classify from LIVE
  // beds/type/price, never the frozen public_payload snapshot — see
  // liveClassificationPayload()'s own comment. category_override (Phase 1,
  // 2026-09-17) is a ROUTING decision the Agent/Admin made explicitly — it
  // always wins over the automatic classifier, but never touches the
  // canonical bedrooms/price/type on `row` itself.
  const cls  = await classifyProperty(liveClassificationPayload(row), { manualOverride: row.category_override })
  require('./extractionProvenance').recordSeafrontProvenance(row.id, cls).catch(() => {})   // evidence for the seafront call
  const keys = cls.keys || []
  if (cls.category_review_required) {
    throw new Error(`#${row.ref} needs manual categorisation — bedrooms are ${cls.bedroom_status.toLowerCase()} and no seafront/villa/luxury signal applies. Set category_override or confirm bedrooms before publishing.`)
  }

  const message = buildMessage(row)          // throws before anything is sent
  // Two-package property-group output (Kev, 2026-09-08): restrictions come
  // off the SAME raw ad text buildMessage() already stripped them from —
  // one extraction, read twice, not a second source of truth.
  const rawDesc = String(payload?.description_social || payload?.description_public || '')
  const { restrictions } = splitRestrictions(rawDesc)
  const agentMessage = buildAgentMessage(row, restrictions)
  const images  = payloadImages(payload, row)
  const videos  = propertyVideos(row)
  const groups  = await activeGroupsForKeys(keys)

  const results = []

  if (!groups.length) {
    log.info('categoryPublisher: no active groups matched', { ref: row.ref, keys })
    return {
      ref: row.ref, propertyId, keys, reasoning: cls.reasoning,
      message, agentMessage, imageCount: images.length, videoCount: videos.length,
      tag: agentTag(row) || null,
      posted: [], failed: [], skipped: [], results,
    }
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]

    // 7. idempotency
    if (await alreadyPosted(propertyId, g.group_id)) {
      log.info('categoryPublisher: already_posted', {
        ref: row.ref, key: g.key, group: g.group_id })
      results.push({ key: g.key, display_name: g.display_name,
        group_id: g.group_id, status: 'already_posted' })
      continue
    }

    try {
      // Kev, 2026-09-08 (live feedback right after the first real two-package
      // post): Package 1 and Package 2 must post BACK TO BACK, images never
      // sandwiched between them, and the whole listing bookended by the
      // existing '...' divider convention (start AND end, not just end).
      // New order: divider → Package 1 → Package 2 → images → videos → divider.

      // opening divider
      try {
        await waha.sendText(session, g.group_id, DIVIDER, { timeoutMs: TEXT_TIMEOUT_MS })
      } catch (divErr) {
        log.warn('categoryPublisher: opening divider send failed', { ref: row.ref, key: g.key, err: divErr.message })
      }

      // Package 1 — via the fallback chain, not a single trusted pick. A
      // session that actually works here becomes `session` for every
      // remaining group too, so Default (once confirmed dead this run)
      // is not re-tried-and-re-timed-out for each subsequent group.
      const { session: winner, sent } = await sendTextWithFallback(session, g.group_id, message)
      if (winner !== session) {
        log.warn('categoryPublisher: switched session mid-run — preferred was unreachable', {
          ref: row.ref, from: session, to: winner })
        session = winner
      }
      const msgId = sent?.key?.id || sent?.id || sent?._data?.id?.id || null

      // Package 2 — agent-only details, immediately after Package 1 (no
      // media in between). Own tracking row (channel 'category_groups_agent'),
      // independently repostable via !av. A failure here is logged and
      // tracked separately; it must never undo Package 1's already-
      // successful, already-recorded post.
      let agentMsgId = null
      try {
        const sentAgent = await waha.sendText(session, g.group_id, agentMessage, { timeoutMs: TEXT_TIMEOUT_MS })
        agentMsgId = sentAgent?.key?.id || sentAgent?.id || sentAgent?._data?.id?.id || null
        await markPosted(propertyId, g.group_id, agentMsgId, session, 'category_groups_agent')
        log.info('categoryPublisher: agent package posted', { ref: row.ref, key: g.key, group: g.group_id, msgId: agentMsgId })
      } catch (agentErr) {
        log.warn('categoryPublisher: agent package send failed', { ref: row.ref, key: g.key, err: agentErr.message })
        try { await markFailed(propertyId, g.group_id, agentErr.message, 'category_groups_agent') }
        catch (dbErr) { log.error('categoryPublisher: markFailed (agent) failed', { err: dbErr.message }) }
      }

      // then images (best-effort — a failed image must not fail the post)
      let sentImages = 0
      for (const url of images) {
        try {
          const { data, mime } = await downloadAsBase64(url)
          await waha.sendImage(session, g.group_id, data, mime, '')
          sentImages++
        } catch (imgErr) {
          log.warn('categoryPublisher: image send failed', {
            ref: row.ref, key: g.key, err: imgErr.message })
        }
        await sleep(IMAGE_GAP_MS)
      }

      // then videos, same best-effort rule
      let sentVideos = 0
      for (const url of videos) {
        try {
          const { data, mime } = await downloadAsBase64(url,
            { timeoutMs: VIDEO_TIMEOUT_MS, fallbackMime: 'video/mp4' })
          await waha.sendVideo(session, g.group_id, data, mime, '')
          sentVideos++
        } catch (vidErr) {
          log.warn('categoryPublisher: video send failed', {
            ref: row.ref, key: g.key, err: vidErr.message })
        }
        await sleep(VIDEO_GAP_MS)
      }

      // closing divider — closes this listing off inside the category group
      try {
        await waha.sendText(session, g.group_id, DIVIDER, { timeoutMs: TEXT_TIMEOUT_MS })
      } catch (divErr) {
        log.warn('categoryPublisher: closing divider send failed', {
          ref: row.ref, key: g.key, err: divErr.message })
      }

      // 5 + 6. persist WhatsApp message id for later rented-detection
      await markPosted(propertyId, g.group_id, msgId, session)

      log.info('categoryPublisher: posted', {
        ref: row.ref, key: g.key, group: g.group_id, msgId, agentMsgId,
        images: sentImages, videos: sentVideos })
      results.push({ key: g.key, display_name: g.display_name, group_id: g.group_id,
        status: 'posted', external_ref: msgId, images: sentImages, videos: sentVideos })
    } catch (err) {
      log.error('categoryPublisher: send failed', {
        ref: row.ref, key: g.key, group: g.group_id, err: err.message })
      try { await markFailed(propertyId, g.group_id, err.message) }
      catch (dbErr) { log.error('categoryPublisher: markFailed failed', { err: dbErr.message }) }
      results.push({ key: g.key, display_name: g.display_name, group_id: g.group_id,
        status: 'failed', error: err.message })
    }

    // space group sends 8–15 s apart — but never idle after the last group
    if (i < groups.length - 1) await sleep(groupGap())
  }

  return {
    ref: row.ref,
    propertyId,
    keys,
    reasoning: cls.reasoning,
    message,
    agentMessage,
    imageCount: images.length,
    videoCount: videos.length,
    tag: agentTag(row) || null,
    posted:  results.filter(r => r.status === 'posted'),
    failed:  results.filter(r => r.status === 'failed'),
    skipped: results.filter(r => r.status === 'already_posted'),
    results,
  }
}

// ── dry run — sends NOTHING ──────────────────────────────────────────────────

async function previewCategoryPost(propertyId) {
  const row = await loadProperty(propertyId)
  const payload = row.public_payload

  // Same live-override as publishToCategoryGroups — a preview must show the
  // group the listing would ACTUALLY route to, not a stale snapshot's guess.
  const cls  = await classifyProperty(liveClassificationPayload(row), { manualOverride: row.category_override })
  require('./extractionProvenance').recordSeafrontProvenance(row.id, cls).catch(() => {})   // evidence for the seafront call
  const keys = cls.keys || []
  const groups = await activeGroupsForKeys(keys)

  let message = null
  let leakCheck = 'passed'
  try {
    message = buildMessage(row)
  } catch (e) {
    leakCheck = `FAILED — ${e.message}`
  }
  let agentMessage = null
  try {
    const rawDesc = String(payload?.description_social || payload?.description_public || '')
    agentMessage = buildAgentMessage(row, splitRestrictions(rawDesc).restrictions)
  } catch (e) {
    agentMessage = `FAILED — ${e.message}`
  }

  const images = payloadImages(payload, row)
  const videos = propertyVideos(row)

  // report which groups would be skipped by idempotency
  const withState = []
  for (const g of groups) {
    withState.push({ ...g, already_posted: await alreadyPosted(propertyId, g.group_id) })
  }

  return {
    ref: row.ref,
    propertyId,
    keys,
    reasoning: cls.reasoning,
    groups: withState,
    message,
    agentMessage,
    leakCheck,
    imageCount: images.length,
    videoCount: videos.length,
    tag: agentTag(row) || null,
    categoryReviewRequired: cls.category_review_required,
    bedroomStatus: cls.bedroom_status,
    manualOverride: cls.manual_override,
  }
}

// ── Manual category override (Phase 1, 2026-09-17) ──────────────────────────
// A publishing/routing decision only — never touches canonical Property
// facts (bedrooms/price/type). Every set/reset is audit-logged into
// property_activities, the same table markRented()/rentedDetector.js
// already use, rather than a new one-off log table.
async function setCategoryOverride(propertyId, key, agentId, reason) {
  const { OVERRIDE_KEYS } = require('./categoryClassifier')
  if (!OVERRIDE_KEYS.has(key)) throw new Error(`invalid category key: ${key}`)
  const prev = await db.query(`SELECT category_override, ref FROM properties WHERE id = $1`, [propertyId])
  if (!prev.rows.length) throw new Error(`property ${propertyId} not found`)
  await db.query(
    `UPDATE properties
        SET category_override = $2, category_override_by_agent_id = $3,
            category_override_at = NOW(), category_override_reason = $4
      WHERE id = $1`,
    [propertyId, key, agentId || null, reason || null])
  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
     VALUES ($1, $2, 'category_override_set', $3, TRUE)`,
    [propertyId, agentId || null, JSON.stringify({ from: prev.rows[0].category_override, to: key, reason: reason || null })])
  return { ok: true, ref: prev.rows[0].ref, category_override: key }
}

async function resetCategoryOverride(propertyId, agentId) {
  const prev = await db.query(`SELECT category_override, ref FROM properties WHERE id = $1`, [propertyId])
  if (!prev.rows.length) throw new Error(`property ${propertyId} not found`)
  await db.query(
    `UPDATE properties
        SET category_override = NULL, category_override_by_agent_id = NULL,
            category_override_at = NULL, category_override_reason = NULL
      WHERE id = $1`,
    [propertyId])
  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
     VALUES ($1, $2, 'category_override_reset', $3, TRUE)`,
    [propertyId, agentId || null, JSON.stringify({ from: prev.rows[0].category_override })])
  return { ok: true, ref: prev.rows[0].ref }
}

// Resolves a REF (e.g. "2906-9132" or bare "9132") to a property id — same
// shape rentedDetector.js's ref-normalizing regex already uses for !rented.
async function resolvePropertyByRef(refOrBare) {
  const norm = String(refOrBare || '').trim()
  const withPrefix = /^2906-\d+$/i.test(norm) ? norm : `2906-${norm.replace(/\D/g, '')}`
  const r = await db.query(`SELECT id, ref FROM properties WHERE ref = $1`, [withPrefix])
  return r.rows[0] || null
}

// !categorize REF <category> — WhatsApp admin command mirror of the CRM
// override control. Case-insensitive (cmd is already uppercased by the
// dispatcher, same convention as !RENTED). Accepted category tokens map to
// the real category_groups keys; "3"/"3+"/"4" all mean bed3 (THREE & FOUR
// BEDROOMS is one group, per the existing PRECEDENCE bucket).
// Kev, 2026-09-23 (ARGUS category hotfix): added 'lux' and 'c' — the exact
// short tokens !recategorize REF <token> uses — as plain aliases onto the
// SAME map !categorize already used, not a second token table. 'c' →
// 'commercial' per Kev's explicit call (a genuinely new 7th category, no
// existing key fit); see OVERRIDE_KEYS in categoryClassifier.js.
const CATEGORIZE_TOKEN_MAP = {
  seafront: 'seafront', villa: 'villas', villas: 'villas', house: 'villas',
  luxury: 'luxury', lux: 'luxury', '1': 'bed1', '2': 'bed2', '3': 'bed3', '4': 'bed3',
  c: 'commercial', commercial: 'commercial',
}
// !recategorize (handlers/upload.js) reuses the exact same map under its
// own name for clarity at the call site — same object, not a copy.
const RECATEGORIZE_TOKEN_MAP = CATEGORIZE_TOKEN_MAP
// Same shape as rentedDetector.js:handleRentedCommand — sessionRouter.sendVia
// straight to the chat the command arrived on (works in a DM or a group),
// not a phone-targeted reply() helper.
async function handleCategorizeCommand(payload, session, senderPhone) {
  const sessionRouter = require('../lib/sessionRouter')
  const chatId = payload.from
  const text = (payload.body || '').trim()
  const parts = text.split(/\s+/)
  // parts[0] is '!categorize' (any case) — ref and category follow.
  const refToken = parts[1]
  const catToken = String(parts[2] || '').toLowerCase()
  if (!refToken || !catToken) {
    await sessionRouter.sendVia(session, chatId, '❌ Usage: !categorize REF seafront|villa|luxury|1|2|3')
    return
  }
  const key = CATEGORIZE_TOKEN_MAP[catToken]
  if (!key) {
    await sessionRouter.sendVia(session, chatId, `❌ Unknown category "${catToken}". Use: seafront, villa, luxury, 1, 2, or 3.`)
    return
  }
  const prop = await resolvePropertyByRef(refToken)
  if (!prop) {
    await sessionRouter.sendVia(session, chatId, `❌ Property "${refToken}" not found.`)
    return
  }
  try {
    await setCategoryOverride(prop.id, key, null, `whatsapp command by ${senderPhone}`)
    await sessionRouter.sendVia(session, chatId, `✅ #${prop.ref} → manual category override: ${key.toUpperCase()}. Re-run the publish job or use !fbstatus to see it take effect.`)
  } catch (e) {
    await sessionRouter.sendVia(session, chatId, `❌ ${e.message}`)
  }
}

module.exports = {
  publishToCategoryGroups, previewCategoryPost,
  payloadImages,
  // MATCH + AV HOTFIX (2026-09-16): exported for direct testing of the
  // canonical viewing-label logic independently of a live publish/preview.
  viewingsLabelFor,
  // PROPERTY GROUP ROUTING AUDIT (2026-09-16): exported for direct testing
  // of the live-classification-payload override.
  liveClassificationPayload,
  // Manual category override (Phase 1, 2026-09-17)
  setCategoryOverride, resetCategoryOverride, resolvePropertyByRef, handleCategorizeCommand,
  // ARGUS category hotfix (2026-09-23): shared token map for !categorize
  // and !recategorize's explicit override syntax.
  CATEGORIZE_TOKEN_MAP, RECATEGORIZE_TOKEN_MAP,
}
