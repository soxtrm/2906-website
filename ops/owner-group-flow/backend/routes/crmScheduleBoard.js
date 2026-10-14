'use strict'
// ============================================================================
// routes/crmScheduleBoard.js — Schedule Board API for the CRM frontend
// Mounted at /api/crm/schedule-board (see index.js).
//
// WHY THIS EXISTS ALONGSIDE routes/scheduleBoard.js
//   The older board (routes/scheduleBoard.js) is gated by the magic-link
//   `sb_session` / `kind:'schedule_board'` JWT. That session carries only
//   { email, role } — it has NO agent id, so it structurally cannot answer
//   "is this listing mine?", which is the entire Fall A / Fall B decision.
//   The CRM login (routes/crm.js) already issues a JWT with { id, username,
//   role, name } and the Next.js app already proxies it. So the board API
//   for the CRM lives here, on the CRM's own auth.
//
// WHY NOT REUSE /api/crm/properties
//   That endpoint is the inventory surface: it returns location.street,
//   location.apt and the owner's real name (only phone/email are masked).
//   The Schedule Board must never expose any of those — every agent sees
//   every listing here, so owner data is the one thing that must not leak.
//   This router therefore does its own SELECT that never returns an owner's
//   name, phone or email, and never returns `apt` at all. The address is
//   reduced to a boolean, `hasViewingLocation`.
//
//   ONE NARROW EXCEPTION, Kev's call on 2026-08-13: `p.street` IS read, and
//   shapeCard emits it as a STREET NAME WITH NO NUMBER, and only on the
//   viewer's own listing (`streetName`). Reason: an agent viewing their own
//   listing should not need a location check-up for an address already on file.
//   "Triq il-Kbira" names a street; "Triq il-Kbira 45" names the property and
//   is enough to reach the owner directly, so the number never travels — nor
//   does anything at all on someone else's listing. See streetWithoutNumber().
//
// FALL A / FALL B
//   Fall A = the listing belongs to the logged-in agent → the bot messages
//            the OWNER directly (same path as `!av`).
//   Fall B = somebody else's listing → the agent never sees the owner; the
//            request is relayed by WhatsApp to the listing agent.
//   Note the disambiguation: "own listing OR Kev's" in the brief means Kev
//   gets Fall A on his own listings. It does NOT mean every agent gets a
//   direct owner line to Kev's listings — the worked example in the spec
//   has Tanja hitting Fall B on Kev's listing. So: Fall A iff
//   listed_by_agent_id === the logged-in agent's id.
//
// SAFETY
//   Fall A is a real, irreversible WhatsApp message to a real customer.
//   It runs in dry-run (resolve + log, send nothing) unless the env var
//   SCHEDULE_BOARD_FALL_A_LIVE is set to '1'.
// ============================================================================

const express = require('express')
const jwt     = require('jsonwebtoken')
const multer  = require('multer')
const cloudinary = require('cloudinary').v2
const db      = require('../db')
const log     = require('../logger')
// Same Cloudinary upload helper !upload and !picup already use
// (handlers/uploadListing.js:uploadBuffer) — the dashboard uploader below is
// additive to that path, not a second one. See POST /listings/:ref/images.
const { uploadBuffer } = require('../handlers/uploadListing')
// Every availability write on this router goes through boardAction: it owns the
// SQL, the rented/archived guards and the audit-log shape, so the four buttons
// below cannot each invent their own idea of what a status change is. It is
// also the single gate on pin precision — see emitPinPrecision().
const boardAction = require('../services/boardAction')
// Tells the groups the listing was posted in, and the agents who asked about it,
// that it has changed. See services/boardFeedback.js for the two audiences and
// why only one of them gets the reason.
const boardFeedback = require('../services/boardFeedback')
// WATag: the "." forwarding anchor. Owns the max-15 ceiling, the one-account
// rule and the quote-or-nothing rule — see services/waTag.js.
const waTag = require('../services/waTag')
// @Agenttag: sends a photo+description card into the agent's OWN workspace
// group and logs the request for Kev's dashboard. See services/agentApartmentRequest.js.
const agentApartmentRequest = require('../services/agentApartmentRequest')
// Booking engine + dynamic owner facts (Kev, 2026-09-23). See those files.
const bookingEngine = require('../services/bookingEngine')
const viewingWindows = require('../services/viewingWindows')
const ownerFactEngine = require('../services/ownerFactEngine')
const propertyRef = require('../services/propertyRef')
const ownerGroupRequests = require('../services/ownerGroupRequests')

const router = express.Router()

// Kev, 2026-09-04: "ich vertrau denen, der bot ist eh introduced" — Olga and
// Katya may create WhatsApp viewing groups even though they are not admins.
// Deliberately scoped to ONLY this one action, not a role change: every
// other admin-only board action is untouched. Mirrored in the frontend
// (lib/crm/ui.tsx TRUSTED_CREATE_GROUP) purely for button state; this is the
// real gate.
function canCreateGroup(me) {
  return ownerGroupRequests.canCreateOwnerGroup(me)
}

const JWT_SECRET = process.env.JWT_SECRET

// Memory storage: uploadBuffer() wants the raw bytes, not a disk path — same
// shape multer hands !upload/!picup's WhatsApp-media buffers already went
// through, just sourced from a browser file input instead of WAHA.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
  fileFilter(_req, file, cb) {
    cb(null, /^image\//.test(file.mimetype))
  },
})

const relayAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
})
async function uploadOwnerAttachment(file) {
  const uploaded = await cloudinary.uploader.upload(
    `data:${file.mimetype || 'application/octet-stream'};base64,${file.buffer.toString('base64')}`,
    { folder: '2906-owner-documents', resource_type: 'auto',
      filename_override: file.originalname, use_filename: true })
  return uploaded.secure_url
}

// Fall A sends real messages to real owners only when explicitly armed.
const FALL_A_LIVE = process.env.SCHEDULE_BOARD_FALL_A_LIVE === '1'

// ── auth ────────────────────────────────────────────────────────────────────
// Same contract as routes/crm.js `auth`: Bearer JWT issued by /api/crm/login.
// Kept local rather than exported from routes/crm.js so that file's shape
// (a plain express Router) stays untouched.
// This router accepts BOTH audiences — 'crm' (staff) and 'board' (whitelisted
// board-only agents) — because the board is the one surface they share. The
// gate here is `board_access`, read live from the DB rather than from the
// token, so revoking someone takes effect on their next request instead of
// when their token happens to expire.
async function auth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try {
    payload = jwt.verify(h.slice(7), JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Session invalid or expired' })
  }
  if (payload.aud && payload.aud !== 'crm' && payload.aud !== 'board') {
    return res.status(403).json({ error: 'Token not valid for the board.' })
  }
  try {
    const r = await db.query(
      `SELECT active, board_access FROM agents WHERE id = $1`, [payload.id])
    const row = r.rows[0]
    if (!row || !row.active) return res.status(401).json({ error: 'Account inactive' })
    if (!row.board_access) {
      return res.status(403).json({ error: 'Not whitelisted for the Schedule Board.' })
    }
    // A long-lived cookie is not evidence that somebody stopped using the
    // board. Keep login and real activity separate, with a small write
    // throttle so normal navigation does not hammer the row.
    await db.query(
      `UPDATE agents SET last_active_at = NOW()
        WHERE id = $1
          AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '5 minutes')`,
      [payload.id])
  } catch (e) {
    log.error('board auth lookup failed', { err: e.message })
    return res.status(500).json({ error: 'Auth check failed' })
  }
  req.agent = payload
  next()
}

// Re-read the agent from the DB — role and active flag can change after the
// token was issued, and we need whatsapp_phones for the Fall A reply echo.
async function liveAgent(id) {
  const r = await db.query(
    `SELECT id, username, email, name, role, active, whatsapp_phones, whatsapp_session,
            notify_whatsapp, board_tour_completed_at, can_create_owner_group
       FROM agents WHERE id = $1`, [id])
  return r.rows[0] || null
}

// ── firewalled projection ───────────────────────────────────────────────────
// NOTE the absence of: p.street, p.apt, p.owner_id, and any join to
// owner_contacts. Adding any of them here is a firewall break.
const BOARD_COLS = `
  p.id, p.ref, p.town, p.sub_location, p.property_type,
  p.category_override,
  -- Safe category keys only: exposes that a listing was published to the
  -- Seafront/bed/luxury/villa stream, never a private group id or name.
  ARRAY(
    SELECT DISTINCT cg.key
      FROM property_publishing_status pps
      JOIN category_groups cg ON cg.group_id = pps.target_ref
     WHERE pps.property_id = p.id
       AND pps.channel = 'category_groups'
       AND pps.status = 'posted'
     ORDER BY cg.key
  ) AS category_group_keys,
  p.bedrooms, p.bathrooms, p.size_sqm,
  p.longlet_price, p.sale_price, p.shortlet,
  -- ARGUS V3 (Kev, 2026-09-16): first-class lease type -- lets the board flag
  -- winter/short-let stock distinctly from a normal long-let. Listing
  -- lifecycle field, not owner data, so it's inside the firewall like
  -- shortlet/available_until above.
  p.lease_type,
  -- Rental modes (2026-09-21): several at once; NULL until set explicitly, then
  -- derived from lease_type/shortlet (services/rentalModes.js).
  p.rental_modes,
  p.unit_group_root_id,
  (SELECT COUNT(*)::int FROM properties unit
    WHERE COALESCE(unit.unit_group_root_id, unit.id) = COALESCE(p.unit_group_root_id, p.id)
      AND COALESCE(unit.available_status, 'available') <> 'archived') AS unit_total,
  (SELECT COUNT(*)::int FROM properties unit
    WHERE COALESCE(unit.unit_group_root_id, unit.id) = COALESCE(p.unit_group_root_id, p.id)
      AND COALESCE(unit.available_status, 'available') NOT IN ('rented', 'archived')) AS unit_available,
  p.available_status, p.available_date,
  -- Owner-Kadenz #4 (Kev, 2026-09-10) — the board's "Bis" button: longlet
  -- termination date (current tenancy ends), independent of available_date
  -- (next tenant can move in). Inside the firewall like available_date --
  -- a listing lifecycle fact, not owner data.
  p.available_until,
  -- When an agent last stood in front of this listing and said "still
  -- available". The card prints it, and it is the tiebreaker sort.
  p.last_confirmed_available_at, p.status_change_reason,
  -- Phase 3. AXIS A = what the card shows (tier), AXIS B = how often we bother
  -- the owner (priority_class). Neither is owner data; they are listing
  -- lifecycle fields, so they are inside the firewall by construction.
  p.priority_class, p.priority, p.lifecycle_state, p.recently_rented_at,
  -- "Leave this owner alone" (migration 019). A listing-level flag about OUR
  -- robot, not about the owner, so it is inside the firewall like the rest of
  -- the lifecycle fields.
  p.auto_reachout_opt_out,
  -- The per-listing Auto AV arm + rhythm (migration 020). Same category as
  -- auto_reachout_opt_out above: a flag about OUR robot, not the owner.
  p.av_auto_rhythm, p.av_auto_rhythm_set_by, p.av_auto_rhythm_set_at,
  -- Read only so emitPinPrecision() can decide what the browser is told. It is
  -- never put on a response as-is — shapeCard() replaces it with the verdict.
  p.geocoding_precision_tier,
  -- Read ONLY to answer two yes/no/unknown questions: pets, and sharing. This is
  -- the listing's own wording, including the internal description, which can
  -- contain anything an owner typed — so it is NEVER emitted. shapeCard() turns
  -- it into two booleans and drops it on the floor. Putting rules_text on a
  -- response is a firewall break, same rule as street_raw below.
  (COALESCE(p.description, '') || ' ' ||
   COALESCE(p.public_payload->>'description_social', '') || ' ' ||
   COALESCE(p.public_payload->>'description_public', '') || ' ' ||
   COALESCE(p.public_payload->>'features', ''))       AS rules_text,
  -- Exact activity-feed facts. These contain no owner data: only when a
  -- property changed and, for a real price change, the old/new public price.
  price_touch.changed_at                              AS latest_price_change_at,
  price_touch.old_price                               AS latest_price_old,
  price_touch.new_price                               AS latest_price_new,
  update_touch.changed_at                             AS latest_update_at,
  update_touch.activity_type                          AS latest_update_type,
  p.created_at,
  -- Kev, 2026-09-04: "freshly updated" badge/sort-boost, first 48h. Deliberately
  -- separate from last_confirmed_available_at (an agent's spoken confirmation)
  -- and created_at (upload time) — this is "something on this listing changed
  -- recently", the same bump crm.js's PATCH /properties/:id already does on
  -- every edit.
  p.updated_at,
  p.viewing_status, p.viewing_date,
  p.images, p.image_ranking, p.is_exclusive,
  p.listed_by_agent_id,
  -- the exact address never leaves the server; the board only learns
  -- whether one exists, which is what drives the "Request
  -- Viewing-Location" button.
  (p.street IS NOT NULL AND btrim(p.street) <> '') AS has_viewing_location,
  -- Read so streetWithoutNumber() can strip it. NEVER emitted raw: shapeCard
  -- turns it into a number-free street name, and only on the viewer's OWN
  -- listing. Putting p.street on a response is a firewall break.
  p.street AS street_raw,
  a.username AS agent_username, a.name AS agent_name,
  a.alias AS agent_alias, a.color_hex AS agent_color, a.active AS agent_active,
  -- Owner contactability, as three facts and never a contact detail. The
  -- board has to grey a button out and say why, and it cannot do that
  -- without knowing that much. Note what is NOT selected from oc:
  -- phone_normalized, name, emails. Same rule as the address above —
  -- the answer travels, the data does not.
  (p.owner_id IS NOT NULL
     AND oc.phone_normalized IS NOT NULL
     AND btrim(oc.phone_normalized) <> '')            AS owner_has_phone,
  COALESCE(oc.do_not_contact, false)                  AS owner_dnc,
  oc.do_not_contact_reason                            AS owner_dnc_reason,
  oc.owner_contact_paused_until                       AS owner_contact_paused_until,
  oc.owner_contact_pause_note                         AS owner_contact_pause_note,
  p.property_contact_paused_until,
  p.property_contact_pause_note,
  owner_touch.kind                                    AS owner_last_contact_kind,
  owner_touch.status                                  AS owner_last_contact_status,
  owner_touch.touched_at                              AS owner_last_contact_at,
  -- One availability message per owner per Malta day, counted across every
  -- listing that owner has and every agent. Queued counts as spent.
  EXISTS (
    SELECT 1 FROM owner_contact_log l
     WHERE l.owner_phone = oc.phone_normalized
       AND l.kind   = 'availability'
       AND l.status IN ('sent', 'queued')
       AND l.malta_day = (now() AT TIME ZONE 'Europe/Malta')::date
  )                                                   AS owner_contacted_today,
  -- Global Hot Property (migration 031). Deliberately NOT named bare "hot" —
  -- owner_account_labels.label='hot' is an unrelated owner-warmth concept;
  -- this is a board pin, nothing to do with an owner. Admin-only to set (see
  -- POST/DELETE /listings/:ref/hot below); every agent reads the same value.
  p.is_hot_property, p.is_hot_property_at,
  -- Kev, 2026-09-12: the owner-chat bot already asks and stores this
  -- structurally (services/autoOwnerConversation.js), but the board's own
  -- subletting answer used to come ONLY from scanning rules_text above --
  -- which almost never mentions subletting, since the canonical ad text
  -- deliberately omits conditional/negative facts. listingRules.subletPolicy()
  -- now prefers this structured column when set, falling back to the text
  -- scan only when the owner was never asked / it's still unknown.
  p.subletting_considered, p.subletting_note,
  -- ARGUS dynamic facts (2026-09-23): the structured answers the owner-chat
  -- fact engine keeps current (services/ownerFactEngine.js). They win over the
  -- rules_text scan whenever set — the text is the ad, the column is the
  -- owner's latest word.
  p.pets_allowed, p.sharing_allowed, p.chat_extracted_fields->>'pets_policy' AS pets_policy,
  -- Booking engine (2026-09-23): the owner-confirmed next viewing window /
  -- viewings-from date (services/viewingWindows.js keeps these in sync).
  p.viewing_window_start, p.viewing_window_end, p.viewings_from_date
`
const BOARD_FROM = `
    FROM properties p
    LEFT JOIN argus_workspace_property_index aw ON aw.property_id = p.id
    LEFT JOIN agents a ON a.id = p.listed_by_agent_id
    LEFT JOIN owner_contacts oc ON oc.id = p.owner_id
    LEFT JOIN LATERAL (
      SELECT l.kind, l.status, COALESCE(l.sent_at, l.created_at) AS touched_at
        FROM owner_contact_log l
       WHERE l.owner_phone = oc.phone_normalized
       ORDER BY COALESCE(l.sent_at, l.created_at) DESC NULLS LAST
       LIMIT 1
    ) owner_touch ON TRUE
    LEFT JOIN LATERAL (
      SELECT pa.created_at AS changed_at,
             COALESCE(pa.details->>'old_price', pa.details->>'old') AS old_price,
             COALESCE(pa.details->>'new_price', pa.details->>'new') AS new_price
        FROM property_activities pa
       WHERE pa.property_id = p.id
         AND pa.activity_type IN ('price_changed', 'price_change_major', 'price_change_minor')
         AND COALESCE(pa.details->>'old_price', pa.details->>'old')
             IS DISTINCT FROM COALESCE(pa.details->>'new_price', pa.details->>'new')
       ORDER BY pa.created_at DESC
       LIMIT 1
    ) price_touch ON TRUE
    LEFT JOIN LATERAL (
      SELECT pa.created_at AS changed_at, pa.activity_type
        FROM property_activities pa
       WHERE pa.property_id = p.id
         AND pa.activity_type NOT IN (
           'price_changed', 'price_change_major', 'price_change_minor',
           'property_created_via_upload', 'board_relay_opened', 'watag_anchor',
           'nexus_safe_backfill', 'nexus_settings_corrected'
         )
         AND pa.activity_type NOT LIKE 'feature_tags_%'
       ORDER BY pa.created_at DESC
       LIMIT 1
    ) update_touch ON TRUE
`

// ── REAL_LISTING_WHERE — the "no ghosts on the board" gate ─────────────────
// Kev, 2026-09-07: hundreds of empty/half-created rows (interrupted test
// fixtures, in-progress owner-chat extraction drafts, portfolio-split
// placeholders — see services/autoOwnerConversation.js's writeEntityDraft /
// writeSummaryDraft, and the proof scripts under test/) were showing up as
// blank cards on the operator board. A property is only a real, workable
// listing once it has a ref, a locality, a price and a type — and bedrooms
// too, for every type except 'commercial' where the concept doesn't apply.
// This is deliberately scoped to GET /listings (the main board) only:
// GET /review-queue exists specifically to triage rows that fail this
// exact test, and GET /favourites only ever shows rows an agent picked by
// hand, so gating either would hide the one worklist meant to fix them.
// Kev, 2026-09-16 ("Shortlets übernehmen wir bei nexus... das sollte
// garnicht ins longletboard"): a short_let property (the snowflake-marked
// nightly/holiday stock, distinct from a WINTER_LET which stays on the
// board as real seasonal rental business — Marcelle's Riviera 2/4 etc. are
// winter_let and are meant to be visible here) has no place on this board
// at all for now, not even flagged — short-let inventory is Nexus's job,
// once that exists. Scoped to REAL_LISTING_WHERE only, same as the ghost-
// row gate right above it: the main board hides it, review-queue/
// favourites are untouched.
const REAL_LISTING_WHERE = `
  (p.ref IS NOT NULL AND btrim(p.ref) <> '')
  AND (p.town IS NOT NULL AND btrim(p.town) <> '')
  AND COALESCE(p.longlet_price, p.sale_price) IS NOT NULL
  AND (p.property_type IS NOT NULL AND btrim(p.property_type) <> '')
  AND (LOWER(p.property_type) = 'commercial' OR p.bedrooms IS NOT NULL)
  -- only a PURE short let is hidden; a listing that is also a winter/long let (rental
  -- modes, 2026-09-21) stays. Same result as the old lease_type test for every row
  -- that has no explicit rental_modes.
  AND COALESCE(NULLIF(p.rental_modes, '{}'::text[]), ARRAY[COALESCE(p.lease_type, 'long_let')])
        && ARRAY['long_let','winter_let']::text[]
`

// Questions this agent has already spent today, per property. Kept out of
// BOARD_COLS because that string is shared by two queries with different
// parameter counts, and threading $n through both is worse than one extra
// indexed read.
// QUESTIONS_PER_DAY / questionsUsedFor (single-property form, below) now
// live in services/ownerAsk.js — handlers/ask.js's !ask command counts
// against the exact same limit. This batch (per-agent, every property at
// once) form stays local: nothing outside board rendering needs it.
const { QUESTIONS_PER_DAY, questionsUsedFor } = require('../services/ownerAsk')
async function questionCountsToday(agentId) {
  const r = await db.query(
    `SELECT property_id, COUNT(*)::int AS n
       FROM owner_contact_log
      WHERE agent_id = $1
        AND kind = 'question'
        AND status IN ('sent', 'queued')
        AND malta_day = (now() AT TIME ZONE 'Europe/Malta')::date
      GROUP BY property_id`, [agentId])
  const m = new Map()
  for (const row of r.rows) m.set(row.property_id, row.n)
  return m
}

// ── street name, without the number ─────────────────────────────────────────
//
// Kev chose variant (a) on 2026-08-13: show the STREET so an agent does not
// need a location check-up for a listing that already has one — but never the
// house or flat number, and never on somebody else's listing.
//
// WHY THE NUMBER IS THE LINE
//   "Triq il-Kbira" narrows a viewing to a street. "Triq il-Kbira 45" IS the
//   property, and on a small island that is enough for an agent to reach the
//   owner directly and cut Kev out. The street helps the person doing the
//   viewing; the number only helps someone going around him.
//
// WHY OWN LISTINGS ONLY
//   Fall B exists because another agent's owner is not yours to reach. Handing
//   out their address defeats the whole separation.
//
// Applied in shapeCard, which is the only place a row becomes a response — the
// raw p.street stays server-side. Note this is near-empty in practice: 2 of 181
// listings have a street at all (2026-08-13).
function streetWithoutNumber(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  // Drop flat/apt/floor fragments outright — they are never shown.
  s = s.replace(/[,;]?\s*\b(flat|apt|apartment|maisonette|penthouse|ph|floor|fl|no\.?|number)\b\.?\s*[-\w/]*/gi, ' ')
  // Drop standalone numbers wherever they sit: "45, Triq il-Kbira",
  // "Triq il-Kbira 45", "Triq il-Kbira, 45A".
  s = s.replace(/\b\d+\s*[a-zA-Z]?\b/g, ' ')
  // Tidy up what the removals left behind.
  s = s.replace(/[,;]\s*(?=[,;])/g, ' ').replace(/^[\s,;/-]+|[\s,;/-]+$/g, '').replace(/\s{2,}/g, ' ')
  // If stripping the digits left nothing street-like, say nothing at all rather
  // than a fragment.
  if (s.length < 4 || !/[a-z]{3}/i.test(s)) return null
  return s
}

// ── availability: now / soon / a date ───────────────────────────────────────
//
// Kev's rule, and the default matters more than the happy path: unless the
// listing is unambiguously free NOW or carries a real future date, it is
// 'soon'. Never "available immediately" on a guess — that is the answer that
// puts an agent in front of a flat somebody still lives in.
//
// Today 62 of 173 active listings have an available_date at all, so 111 land on
// 'soon'. That is the honest answer for them, not a gap to paper over.
//
// Decided here rather than in the browser because the filter in GET /listings
// has to agree with the chip on the card, and two implementations of one rule
// drift.
function availabilityOf(row) {
  const d = row.available_date
  if (!d) return { kind: 'soon', date: null, label: 'soon' }

  // available_date is a DATE column; compare on the calendar day, not the
  // instant, or "free today" reads as past at 00:30 and future at 23:30.
  const day = (v) => {
    const t = new Date(v)
    return Number.isFinite(t.getTime())
      ? Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) : null
  }
  const on = day(d), today = day(new Date())
  if (on == null) return { kind: 'soon', date: null, label: 'soon' }

  // On or before today → it is free now.
  if (on <= today) return { kind: 'now', date: null, label: 'now' }

  // A real future date. Month precision is what an agent actually uses
  // ("free from October"), and it is also all the owner usually said.
  const dt = new Date(on)
  const month = dt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
  return {
    kind: 'date',
    date: dt.toISOString().slice(0, 10),
    label: `${dt.getUTCDate()} ${month}`,
  }
}

// images is a jsonb array of { url }. image_ranking.order, when Gemini has
// scored the listing, is an array of indices into that array, best first —
// without it the raw upload order regularly leads with a bathroom.
function orderedImages(row) {
  const imgs = Array.isArray(row.images) ? row.images : []
  const urls = imgs.map(i => (typeof i === 'string' ? i : i && i.url)).filter(Boolean)
  const order = row.image_ranking && Array.isArray(row.image_ranking.order)
    ? row.image_ranking.order : null
  if (!order) return urls
  const picked = order.map(i => urls[i]).filter(Boolean)
  // Anything the ranker did not mention still belongs to the listing.
  const rest = urls.filter(u => !picked.includes(u))
  return [...picked, ...rest]
}

// Whether the two contact buttons are live, and if not, the sentence the card
// shows instead. Decided here rather than in the browser so the rule has one
// home — the POST handlers enforce the same conditions, and a button that
// looks enabled but 409s is worse than one that is honestly greyed out.
function contactState(row, isMine, questionsUsed) {
  const agentName = row.agent_alias || row.agent_name || row.agent_username || null
  const todayMalta = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const ownerPauseUntil = row.owner_contact_paused_until
    ? String(row.owner_contact_paused_until).slice(0, 10) : null
  const propertyPauseUntil = row.property_contact_paused_until
    ? String(row.property_contact_paused_until).slice(0, 10) : null

  // Fall A — my own listing, the message reaches the owner directly.
  if (isMine) {
    let can = true, reason = null, blockCode = null
    if (!row.owner_has_phone)            { can = false; blockCode = 'NO_PHONE'; reason = 'No owner phone on file for this listing.' }
    else if (row.owner_dnc)              { can = false; blockCode = 'OWNER_BLOCKED'; reason = row.owner_dnc_reason
                                             ? `Owner opted out: ${row.owner_dnc_reason}`
                                             : 'Owner is marked do-not-contact.' }
    else if (ownerPauseUntil && ownerPauseUntil >= todayMalta) {
      can = false; blockCode = 'OWNER_PAUSED'
      reason = `Owner contact paused until ${ownerPauseUntil}${row.owner_contact_pause_note ? `: ${row.owner_contact_pause_note}` : '.'}`
    }
    else if (propertyPauseUntil && propertyPauseUntil >= todayMalta) {
      can = false; blockCode = 'PROPERTY_PAUSED'
      reason = `Property contact paused until ${propertyPauseUntil}${row.property_contact_pause_note ? `: ${row.property_contact_pause_note}` : '.'}`
    }
    // A prior message today is context, not a dead button. The availability
    // service still detects a same-day AV check and returns its deliberate
    // "Ask anyway" confirmation, while ordinary Ask keeps its own atomic
    // per-listing question counter. DNC and explicit pauses above remain hard
    // stops. This keeps ASK/AV available during the working day without
    // bypassing the real recipient protections.
    return {
      mode: 'owner',
      reachesName: null,
      canAsk: can,
      reason,
      blockCode,
      ownerBlocked: !!row.owner_dnc,
      ownerPauseUntil,
      propertyPauseUntil,
      lastContactAt: row.owner_last_contact_at || null,
      lastContactKind: row.owner_last_contact_kind || null,
      lastContactStatus: row.owner_last_contact_status || null,
      questionsUsed,
      questionsPerDay: QUESTIONS_PER_DAY,
      canQuestion: can,
      questionReason: reason,
    }
  }

  // Fall B — someone else's listing. The owner is never reachable from here;
  // the request is relayed to the listing agent, so the wire is open only if
  // there is an active listing agent on the other end.
  let can = true, reason = null
  if (!row.listed_by_agent_id) { can = false; reason = 'No listing agent on this property — nobody to ask.' }
  else if (!row.agent_active)  { can = false; reason = `${agentName || 'The listing agent'} is inactive.` }
  return {
    mode: 'agent',
    reachesName: agentName,
    canAsk: can,
    reason,
    blockCode: can ? null : 'LISTING_AGENT_UNAVAILABLE',
    ownerBlocked: !!row.owner_dnc,
    ownerPauseUntil,
    propertyPauseUntil,
    lastContactAt: row.owner_last_contact_at || null,
    lastContactKind: row.owner_last_contact_kind || null,
    lastContactStatus: row.owner_last_contact_status || null,
    questionsUsed,
    questionsPerDay: QUESTIONS_PER_DAY,
    canQuestion: can,
    questionReason: reason,
  }
}

// Pets and sharing, read off the listing's own words. The patterns, the three
// states and the traps they avoid all live in services/listingRules.js — the
// board only decides to show them.
const listingRules = require('../services/listingRules')

// ── AXIS A: collapse the six internal statuses to three visible states ──────
// Agents get a three-state world; the extra internal values exist so the
// machine can tell "the AI is unsure" from "the owner said no" without making
// the operator learn six words. `availableStatus` still carries the internal
// value for the buttons — `tier` is the collapsed view.
const RECENTLY_RENTED_WINDOW_MS = 48 * 60 * 60 * 1000
function visibleTier(row) {
  const s = String(row.available_status || '').toLowerCase()
  if (s === 'rented') {
    const t = row.recently_rented_at ? new Date(row.recently_rented_at).getTime() : 0
    return (t && Date.now() - t < RECENTLY_RENTED_WINDOW_MS) ? 'RECENTLY_RENTED' : 'OFF_MARKET'
  }
  if (s === 'archived') return 'OFF_MARKET'
  // Kev, 2026-09-14 (spec item 1): a listing the owner confirmed is occupied
  // until a known future date is its own visible state -- not lumped into
  // ON_HOLD (which reads as "AI unsure" / "operator paused it"), and never
  // AVAILABLE (that is exactly the wrong action to offer here).
  if (s === 'upcoming') return 'UPCOMING'
  if (s === 'pending_check' || s === 'not_available') return 'ON_HOLD'
  return 'AVAILABLE' // available | available_confirmed | NULL
}

// Mirrors BOOKINGS_POSSIBLE_SQL below — one rule for the badge and the sort.
function bookingsPossibleOf(row) {
  if (row.viewing_window_end && new Date(row.viewing_window_end) > new Date()) return true
  return !!row.viewings_from_date
}
// COALESCE matters: for a listing with no window the OR is NULL, and
// ORDER BY … DESC puts NULLs FIRST in Postgres — bookable listings sank below
// everything else instead of leading (found in the 2026-09-24 browser pass).
const BOOKINGS_POSSIBLE_SQL = `COALESCE(p.viewing_window_end > NOW() OR p.viewings_from_date IS NOT NULL, FALSE)`
// Only a real, tagged appointment in the future may jump ahead of the normal
// board order. An owner saying that bookings are possible is useful as a badge
// and action state, but it must not keep an old listing above fresh uploads.
const FUTURE_TAGGED_BOOKING_SQL = `EXISTS (
  SELECT 1 FROM property_viewings pv
   WHERE pv.property_id = p.id
     AND COALESCE(pv.status, 'requested') NOT IN ('cancelled', 'rejected', 'completed')
     AND (pv.viewing_date > CURRENT_DATE
       OR (pv.viewing_date = CURRENT_DATE
         AND (CASE
              WHEN btrim(COALESCE(pv.viewing_time, '')) ~ '^\d{1,2}:\d{2}$'
                THEN btrim(pv.viewing_time)::time
              ELSE time '23:59'
            END) >= LOCALTIME))
)`

function shapeCard(row, meId, questionsUsed = 0) {
  const images = orderedImages(row)
  const isMine = !!(row.listed_by_agent_id && meId && row.listed_by_agent_id === meId)
  return {
    id: row.id,
    ref: row.ref,
    town: row.town || null,
    subLocation: row.sub_location || null,
    type: row.property_type ? String(row.property_type).toLowerCase() : null,
    categoryGroups: Array.isArray(row.category_group_keys) ? row.category_group_keys : [],
    beds: row.bedrooms,
    baths: row.bathrooms,
    sizeSqm: row.size_sqm == null ? null : Number(row.size_sqm),
    price: row.longlet_price == null ? null : Number(row.longlet_price),
    salePrice: row.sale_price == null ? null : Number(row.sale_price),
    shortlet: !!row.shortlet,
    leaseType: row.lease_type || (row.shortlet ? 'short_let' : 'long_let'),
    rentalModes: require('../services/rentalModes').effectiveModes(row),
    units: {
      groupRootId: row.unit_group_root_id || null,
      total: Number(row.unit_total) || 1,
      available: Number(row.unit_available) || (['rented', 'archived'].includes(row.available_status) ? 0 : 1),
    },
    // The upload timestamp, and the board's default sort key. Sent to the
    // browser as well as sorted on, because the client re-groups cards by town
    // to place the pins and would otherwise lose the server's ordering.
    createdAt: row.created_at || null,
    // Drives the "freshly updated" glow, first 48h — see BOARD_COLS' own note.
    updatedAt: row.updated_at || null,
    latestPriceChangeAt: row.latest_price_change_at || null,
    latestPriceOld: row.latest_price_old == null ? null : Number(row.latest_price_old),
    latestPriceNew: row.latest_price_new == null ? null : Number(row.latest_price_new),
    latestUpdateAt: row.latest_update_at || null,
    latestUpdateType: row.latest_update_type || null,
    // now / soon / a real date — one rule, shared with the ?avail= filter, so
    // the chip on the card and the search can never disagree.
    availability: availabilityOf(row),
    availableStatus: row.available_status || null,
    availableDate: row.available_date,
    // Owner-Kadenz #4 (Kev, 2026-09-10) -- the board's "Bis" button: longlet
    // termination date, a separate fact from availableDate (see BOARD_COLS'
    // own note above).
    availableUntil: row.available_until || null,
    // The two facts behind the check-in / check-out buttons. The timestamp is
    // what a click on "Available" is actually for; the reason is what a click
    // on "Not available" left behind, and the review queue reads it.
    lastConfirmedAvailableAt: row.last_confirmed_available_at || null,
    statusChangeReason: row.status_change_reason || null,
    // Whether the robot has been told to leave this owner alone. The card needs
    // it to draw the toggle in the right position; it says nothing about the
    // owner, only about our own scheduler.
    autoReachoutOptOut: row.auto_reachout_opt_out === true,
    // Global Hot Property (migration 031). isFavourite/starStep are stamped
    // on afterward by withCardFlags, which needs this value plus the
    // per-viewer favourite lookup together to compute the star's step.
    isHotProperty: !!row.is_hot_property,
    hotSince: row.is_hot_property_at || null,
    // Per-listing Auto AV arm + rhythm (migration 020). off = the button has
    // never been pressed for this listing = the robot never auto-asks.
    avAutoRhythm: row.av_auto_rhythm || 'off',
    avAutoRhythmSetAt: row.av_auto_rhythm_set_at || null,
    // ── Phase 3 ───────────────────────────────────────────────────────────
    // tier    (AXIS A): AVAILABLE | ON_HOLD | RECENTLY_RENTED | OFF_MARKET
    // priority (AXIS B): the re-check rhythm, not the rank on the board.
    tier: visibleTier(row),
    recentlyRentedAt: row.recently_rented_at || null,
    priorityClass: row.priority_class || 'normal',
    priority: row.priority == null ? 0 : Number(row.priority),
    lifecycleState: row.lifecycle_state || 'active',
    // THE FIREWALL. The browser learns how precise a pin it may draw, never
    // the internal geocoding_precision_tier itself. boardAction.emitPinPrecision
    // is the only thing that answers this question, on every route that shapes
    // a card — so there is no second path to a street-accurate marker.
    pinPrecision: boardAction.emitPinPrecision({ row, viewerAgentId: meId }),
    viewingStatus: row.viewing_status || null,
    // Kev, 2026-08-31 (AV-date-confirm button) -- already selected by
    // BOARD_COLS above but never mapped onto the card until now. "From
    // when can this be viewed", a separate fact from availableDate.
    viewingDate: row.viewing_date || null,
    hasViewingLocation: !!row.has_viewing_location,
    // Variant (a): street name, no number, own listings only. null for
    // everybody else's — see streetWithoutNumber above.
    streetName: isMine ? streetWithoutNumber(row.street_raw) : null,
    exclusive: !!row.is_exclusive,
    // true = the listing says so, false = it says the opposite, null = nobody
    // wrote it down. The card renders three states; do not collapse to a boolean.
    petFriendly: row.pets_allowed != null ? !!row.pets_allowed : listingRules.petPolicy(row),
    // cats_only / small_only / no_dogs / case_by_case — the nuance behind the icon
    petsPolicy: row.pets_policy || null,
    sharing: row.sharing_allowed != null ? !!row.sharing_allowed : listingRules.sharingPolicy(row),
    // ── booking engine (2026-09-23) ───────────────────────────────────────
    // BOOKINGS POSSIBLE = the owner confirmed a viewing window (slots can be
    // booked) or a viewings-from date (a viewing can be requested for then).
    bookingsPossible: bookingsPossibleOf(row),
    viewingWindow: row.viewing_window_end && new Date(row.viewing_window_end) > new Date()
      ? { start: row.viewing_window_start, end: row.viewing_window_end } : null,
    viewingsFrom: row.viewings_from_date || null,
    // Subletting is read the same way but deliberately has NO card icon — it is
    // a search filter only (Kev, 2026-08-16). Sent down because the board filters
    // client-side over the whole result set; a SQL filter would have to
    // re-implement listingRules' regexes in Postgres.
    subletting: listingRules.subletPolicy(row),
    // The nuance behind a "yes" (e.g. "Depends on serious companies only") --
    // considered does not mean automatically accepted; the note is what tells
    // an agent that before they promise something to a client.
    sublettingNote: row.subletting_note || null,
    images,
    imageCount: images.length,
    listedBy: {
      id: row.listed_by_agent_id || null,
      // alias overrides the real name (Tomas → "Adrian"), same rule the
      // inventory surface uses.
      displayName: row.agent_alias || row.agent_name || row.agent_username || null,
      colorHex: row.agent_color || null,
    },
    // Drives the button set on the card. Fall A === my own listing.
    isMine,
    contact: contactState(row, isMine, questionsUsed),
  }
}

// ── per-viewer card flags ───────────────────────────────────────────────────
// Two facts that cannot come out of the main projection, stamped onto the
// finished cards: can WATag anchor to this listing, and has THIS agent
// favourited it.
//
// Done as a pass rather than extra arguments to shapeCard: it is two queries
// for the whole page instead of two per row, and the four routes that shape
// cards all get the same answers without four edits to a signature.
//
// canTag — 85 of the 215 listings have no stored group message id (they predate
// the capture in categoryPublisher). The button is greyed out for those,
// because a WATag that quietly does nothing is worse than one that says why.
//
// isFavourite — drives the star on the card, which is a toggle, so it has to
// know which way it is already pointing.
async function withCardFlags(cards, meId) {
  // Canonical locality for every card (2026-09-22): key/label/pin come from the ONE
  // resolver (services/localityResolver.js), not from the frontend's own town table.
  try { await require('../services/localityResolver').annotateBoardCards(cards) }
  catch (err) { log.warn('board locality annotate failed', { err: err.message }) }
  const ids = cards.map(c => c.id)
  try {
    const set = await waTag.taggableIds(ids)
    for (const c of cards) c.canTag = set.has(c.id)
  } catch (err) {
    // The board must render even if this lookup fails. false = "cannot tag",
    // which is the safe direction: a disabled button, never a silent no-op.
    log.warn('board canTag lookup failed', { err: err.message })
    for (const c of cards) c.canTag = false
  }
  try {
    const r = ids.length
      ? await db.query(
          `SELECT property_id FROM agent_favourites
            WHERE agent_id = $1 AND property_id = ANY($2::int[])`, [meId, ids])
      : { rows: [] }
    const fav = new Set(r.rows.map(x => x.property_id))
    for (const c of cards) c.isFavourite = fav.has(c.id)
  } catch (err) {
    log.warn('board favourite lookup failed', { err: err.message })
    for (const c of cards) c.isFavourite = false
  }
  // starStep — the 3-click cycle's current position, for the one star icon:
  // 0 normal, 1 favourite (this agent only), 2 hot (global, admin-set). Hot
  // always wins the display regardless of this agent's own favourite, which
  // is why it has to be computed here, after both flags above are known.
  for (const c of cards) c.starStep = c.isHotProperty ? 2 : (c.isFavourite ? 1 : 0)

  // lastChatAt — when THIS agent last exchanged a message in the relay chat
  // on this listing (any thread, not just the currently open one), so the
  // Chat button can read "2h ago" instead of every card looking identical.
  // Scoped to agent_id same as everything else here — never another agent's
  // activity.
  try {
    const r = ids.length
      ? await db.query(
          `SELECT t.property_id, MAX(m.created_at) AS last_at
             FROM book_relay_threads t JOIN book_relay_messages m ON m.thread_id = t.id
            WHERE t.agent_id = $1 AND t.property_id = ANY($2::int[])
            GROUP BY t.property_id`, [meId, ids])
      : { rows: [] }
    const lastAt = new Map(r.rows.map(x => [x.property_id, x.last_at]))
    for (const c of cards) c.lastChatAt = lastAt.get(c.id) || null
  } catch (err) {
    log.warn('board lastChatAt lookup failed', { err: err.message })
    for (const c of cards) c.lastChatAt = null
  }
  return cards
}

// ── sort ────────────────────────────────────────────────────────────────────
// Newest-first is the default and the reason the board is usable: the listing
// that just came in is the one an agent is looking for, and it belongs
// top-left. The grid fills left-to-right, top-to-bottom, so "first row of the
// ORDER BY" and "top-left card" are the same thing.
//
// created_at is the real upload timestamp — handlers/uploadListing.js and
// handlers/upload.js both write it on insert, and it is NOT NULL on all 174
// live rows. last_confirmed_available_at is the documented fallback: it only
// exists once somebody has pressed the button, so it can never be the primary
// key, but it breaks ties sensibly (most recently vouched-for first).
// Kev, 2026-09-04: a listing that was just edited (price fix, photos, status)
// should sit a bit higher for a couple of days, same "recent thing floats up,
// then settles back" shape as RECENTLY_RENTED_WINDOW_MS above. Implemented as
// GREATEST(created_at, updated_at-if-inside-the-48h-window) rather than a bare
// updated_at sort — a stale row bumped by an UNRELATED background job (there
// is no such job today, but nothing stops one existing later) still only gets
// the same 48h grace period as a real edit, never a permanent reorder.
const FRESH_UPDATE_WINDOW = `p.updated_at > NOW() - INTERVAL '48 hours'`
// Kev, 2026-09-11: a listing freshly uploaded (or edited) but not actually
// available for 3+ months was still winning the "newest" sort on the
// strength of created_at/updated_at alone — it doesn't belong at the top just
// because someone touched it, it belongs at the bottom because nobody can
// move a client in for months. A separate leading bucket, not a tweak to the
// freshness formula itself: everything with a far-future (or no) available
// date sorts AFTER everything else, and only within that bottom bucket does
// the normal newest-first order still apply — so it never fully disappears,
// it just never rises above what an agent can actually offer today.
const FAR_FUTURE_AVAILABLE = `p.available_date IS NOT NULL AND p.available_date > CURRENT_DATE + INTERVAL '3 months 21 days'`
const SORTS = {
  newest:     `(CASE WHEN ${FAR_FUTURE_AVAILABLE} THEN 1 ELSE 0 END) ASC,
               p.created_at DESC NULLS LAST, p.id DESC`,
  oldest:     `p.created_at ASC NULLS LAST, p.id ASC`,
  // "Freshest confirmation first" — the sort to work a stale board down.
  confirmed:  `p.last_confirmed_available_at DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC`,
  // Oldest confirmation first: the listings most in need of a check-in.
  stalest:    `p.last_confirmed_available_at ASC NULLS FIRST, p.created_at DESC NULLS LAST, p.id DESC`,
  price_low:  `COALESCE(p.longlet_price, p.sale_price) ASC NULLS LAST, p.created_at DESC`,
  price_high: `COALESCE(p.longlet_price, p.sale_price) DESC NULLS LAST, p.created_at DESC`,
  // AXIS A ranking, as an OPTION rather than the default. Confirmed-first, then
  // believed-available, then the yellow "AI unsure" pile. Keyed on
  // last_confirmed_available_at, never updated_at — updated_at moves on every
  // unrelated edit and would scramble the order.
  confirmed_first: `(p.available_status = 'available_confirmed') DESC,
                    p.last_confirmed_available_at DESC NULLS LAST,
                    (COALESCE(p.available_status, 'available') = 'available') DESC,
                    (p.available_status = 'pending_check') DESC,
                    p.created_at DESC NULLS LAST, p.id DESC`,
  // AXIS B: urgent first. A pure priority sweep for whoever is working the
  // re-check list rather than placing a client.
  priority: `CASE COALESCE(p.priority_class, 'normal')
               WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
               WHEN 'normal' THEN 2 ELSE 3 END ASC,
             p.priority DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC`,
}
const DEFAULT_SORT = 'newest'
function orderBy(sort) { return SORTS[String(sort || '')] || SORTS[DEFAULT_SORT] }

function csvQuery(value, max = 30) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean).slice(0, max)
}

// Filters that used to exist only in the browser. Keeping them here makes the
// API the source of truth for board, favourites and any future ARGUS client.
// The joined workspace index contains private owner search text too, but this
// board deliberately uses board_search_text only: a board query must not turn
// an owner name or phone number into a side channel.
function appendWorkspaceBoardFilters(q, me, params, where, allowPrivateSearch = false) {
  const needle = String(q.q || '').trim().toLowerCase().slice(0, 120)
  if (needle) {
    params.push(`%${needle}%`)
    // Town/sub-location remain searchable even while the derived workspace
    // index is missing or stale. The index is enrichment, never the only way
    // to find a locality already stored on the property row.
    where.push(`(
      COALESCE(aw.${allowPrivateSearch ? 'private_search_text' : 'board_search_text'}, '') LIKE $${params.length}
      OR lower(COALESCE(p.town, '')) LIKE $${params.length}
      OR lower(COALESCE(p.sub_location, '')) LIKE $${params.length}
    )`)
  }

  if (q.towns) {
    const towns = csvQuery(q.towns).map(value => value.toLowerCase())
    if (towns.length) {
      params.push(towns)
      where.push(`(lower(aw.village_key) = ANY($${params.length}) OR lower(p.town) = ANY($${params.length}))`)
    }
  }
  if (q.pets === 'yes' || q.pets === 'no') {
    params.push(q.pets === 'yes')
    where.push(`aw.pets_allowed = $${params.length}`)
  }
  if (q.sharing === 'yes' || q.sharing === 'no') {
    params.push(q.sharing === 'yes')
    where.push(`aw.sharing_allowed = $${params.length}`)
  }
  if (q.sublet === '1') where.push(`aw.subletting_considered = TRUE`)

  const recency = { '24h': '24 hours', '48h': '48 hours', '5d': '5 days', '10d': '10 days', '3w': '3 weeks' }
  if (recency[q.updated]) {
    params.push(recency[q.updated])
    where.push(`GREATEST(p.created_at, p.updated_at) >= NOW() - $${params.length}::interval`)
  }

  const discovery = csvQuery(q.discovery)
  if (discovery.includes('popular-new')) {
    params.push(me.id)
    where.push(`(p.is_hot_property = TRUE
      OR EXISTS (SELECT 1 FROM agent_favourites af WHERE af.property_id=p.id AND af.agent_id=$${params.length})
      OR GREATEST(p.created_at, p.updated_at) >= NOW() - INTERVAL '10 days')`)
  }
  if (discovery.includes('seafront')) {
    where.push(`(EXISTS (
      SELECT 1 FROM property_publishing_status pps
      JOIN category_groups cg ON cg.group_id=pps.target_ref
      WHERE pps.property_id=p.id AND pps.channel='category_groups'
        AND pps.status='posted' AND lower(cg.key)='seafront'
    ) OR lower(concat_ws(' ',p.town,p.sub_location,p.property_type,p.description,
           p.public_payload->>'description_public',p.public_payload->>'features'))
           ~ '(sea[[:space:]]*front|seafront|waterfront|frontline)')`)
  }
  const discoveryBeds = discovery.filter(key => /^beds-\d+$/.test(key)).map(key => Number(key.slice(5)))
  if (discoveryBeds.length) {
    params.push(discoveryBeds)
    where.push(`p.bedrooms = ANY($${params.length})`)
  }
  const typeClauses = []
  if (discovery.includes('apartments')) typeClauses.push(`lower(p.property_type) ~ '(apartment|penthouse|maisonette)'`)
  if (discovery.includes('villas')) typeClauses.push(`lower(p.property_type) LIKE '%villa%'`)
  if (typeClauses.length) where.push(`(${typeClauses.join(' OR ')})`)

  const rect = csvQuery(q.rect, 4).map(Number)
  if (rect.length === 4 && rect.every(Number.isFinite)) {
    const [north, south, east, west] = rect
    params.push(north, south, east, west)
    where.push(`aw.locality_latitude BETWEEN $${params.length - 2} AND $${params.length - 3}
                AND aw.locality_longitude BETWEEN $${params.length} AND $${params.length - 1}`)
  }
  const circ = csvQuery(q.circ, 3).map(Number)
  if (circ.length === 3 && circ.every(Number.isFinite) && circ[2] > 0) {
    const [lat, lng, radius] = circ
    params.push(lat, lng, radius)
    const latParam = params.length - 2
    const lngParam = params.length - 1
    const radiusParam = params.length
    where.push(`aw.locality_latitude IS NOT NULL AND aw.locality_longitude IS NOT NULL AND
      6371000 * 2 * asin(sqrt(
        power(sin(radians(aw.locality_latitude - $${latParam}) / 2), 2) +
        cos(radians($${latParam})) * cos(radians(aw.locality_latitude)) *
        power(sin(radians(aw.locality_longitude - $${lngParam}) / 2), 2)
      )) <= $${radiusParam}`)
  }

  if (q.horizon === 'future') where.push(FAR_FUTURE_AVAILABLE)
  else if (q.horizon === 'active') where.push(`NOT (${FAR_FUTURE_AVAILABLE})`)
}

function appendFavouriteCoreFilters(q, params, where) {
  if (q.beds) {
    const clauses = csvQuery(q.beds).map(value => {
      params.push(parseInt(value, 10))
      return `p.bedrooms ${/\+$/.test(value) ? '>=' : '='} $${params.length}`
    })
    if (clauses.length) where.push(`(${clauses.join(' OR ')})`)
  }
  if (q.baths) {
    const clauses = csvQuery(q.baths).map(value => {
      params.push(parseInt(value, 10))
      return `p.bathrooms >= $${params.length}`
    })
    if (clauses.length) where.push(`(${clauses.join(' OR ')})`)
  }
  if (q.price_min) { params.push(parseFloat(q.price_min)); where.push(`COALESCE(p.longlet_price,p.sale_price) >= $${params.length}`) }
  if (q.price_max) { params.push(parseFloat(q.price_max)); where.push(`COALESCE(p.longlet_price,p.sale_price) <= $${params.length}`) }
  if (q.type) { params.push(String(q.type).toLowerCase()); where.push(`lower(p.property_type) = $${params.length}`) }
  const rental = q.rental_mode || q.rental
  if (rental) {
    const rm = require('../services/rentalModes')
    const mode = rm.normalizeModes([rental])[0]
    if (mode) { params.push(mode); where.push(rm.sqlHasMode('p', params.length)) }
  }
}

// ── GET /listings ───────────────────────────────────────────────────────────
// Filters mirror the board UI: beds, baths, budget, type, towns.
// Every agent sees every listing — the firewall above, not row filtering, is
// what protects owner data.
//
// THE ACTIVE FILTER
//   The board is a worklist, not an archive: it shows only what an agent could
//   actually offer a client today — 'available' and 'available_confirmed'.
//   Everything else (not_available, rented, pending_check, archived) drops off
//   it. Nothing is deleted and nothing else changes: /api/crm/properties, the
//   detail route below, the review queue and property_activities all still hold
//   every row. `include_all=1` opts back into the unfiltered list for a
//   CRM/history view that wants it.
router.get('/listings', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })

    const q = req.query
    const params = []
    const where = ['TRUE', REAL_LISTING_WHERE]

    // Rental-mode tab (2026-09-21): ?rental_mode=winter_let|long_let|short_let, on the
    // effective modes. (short_let alone is hidden by REAL_LISTING_WHERE, so that tab
    // shows the winter/long listings that are ALSO short lets.)
    if (q.rental_mode || q.rental) {
      const rm = require('../services/rentalModes')
      const mode = rm.normalizeModes([q.rental_mode || q.rental])[0]
      if (mode) { params.push(mode); where.push(rm.sqlHasMode('p', params.length)) }
    }

    // Kev, 2026-09-01 ("Duplicate Listing" angry-emoji option): an
    // agent-flagged duplicate is hidden from every normal board view —
    // never deleted (only Kev's own admin path deletes outright, and that
    // removes the row entirely, so it never reaches this query at all).
    // ?duplicate_flagged=1 is Kev's own review list of exactly these
    // flagged-but-not-yet-deleted rows, so they are "clearly listed"
    // somewhere rather than just invisible.
    if (q.duplicate_flagged === '1') {
      where.push(`p.duplicate_flagged = TRUE`)
    } else {
      where.push(`p.duplicate_flagged IS NOT TRUE`)
    }

    // '4+' (Kev, 2026-08-20) is the one open-ended tier — "4 or more". Every
    // other value is an exact match, not a floor: the board used to read
    // every "2" chip as ">=2", which put 3- and 4-bed listings in a "2 bed"
    // search.
    //
    // Kev, 2026-09-11: beds/baths became multi-select on the board ("ich
    // will nicht nur eine Sache suchen können") — a comma-separated list,
    // OR'd together, same shape `towns` already used. "1,3,4+" means
    // bedrooms = 1 OR bedrooms = 3 OR bedrooms >= 4, never an AND (a
    // property can't have two bedroom counts at once, so AND would always
    // return nothing once two exact tiers are picked).
    if (q.beds) {
      const values = String(q.beds).split(',').map(s => s.trim()).filter(Boolean)
      const clauses = values.map(v => {
        const plus = /\+$/.test(v)
        params.push(parseInt(v, 10))
        return `p.bedrooms ${plus ? '>=' : '='} $${params.length}`
      })
      if (clauses.length) where.push(`(${clauses.join(' OR ')})`)
    }
    if (q.baths) {
      const values = String(q.baths).split(',').map(s => s.trim()).filter(Boolean)
      // Baths tiers are already "at least N" (the UI labels them "1+/2+/3+"),
      // so picking several is really just picking the loosest one — OR'd
      // anyway rather than collapsed to MIN() here, so the SQL stays honest
      // about what was actually selected if the UI semantics ever change.
      const clauses = values.map(v => {
        params.push(parseInt(v, 10))
        return `p.bathrooms >= $${params.length}`
      })
      if (clauses.length) where.push(`(${clauses.join(' OR ')})`)
    }
    if (q.price_min) {
      params.push(parseFloat(q.price_min))
      where.push(`COALESCE(p.longlet_price, p.sale_price) >= $${params.length}`)
    }
    if (q.price_max) {
      params.push(parseFloat(q.price_max))
      where.push(`COALESCE(p.longlet_price, p.sale_price) <= $${params.length}`)
    }
    // property_type is stored inconsistently cased ('Apartment' and
    // 'apartment' both occur), so match on LOWER().
    if (q.type) {
      params.push(String(q.type).toLowerCase())
      where.push(`LOWER(p.property_type) = $${params.length}`)
    }
    // An explicit ?status= is an explicit request and wins over the active
    // filter — that is how the review queue and any history view ask for a
    // single status without needing include_all as well.
    // AXIS A: only_recently_rented=1 is the "what just went?" view — rented AND
    // stamped within 48h. Anything older is off-market history and has no
    // business on a working board. Checked before ?status= so the window is not
    // silently widened by passing both.
    if (q.only_recently_rented === '1') {
      where.push(`p.available_status = 'rented'
                  AND p.recently_rented_at IS NOT NULL
                  AND p.recently_rented_at > NOW() - interval '48 hours'`)
    } else if (q.status) {
      params.push(q.status)
      where.push(`p.available_status = $${params.length}`)
    } else if (q.only_confirmed === '1') {
      // Only listings somebody has actually vouched for, with the timestamp to
      // prove it. A row could in principle carry the status without the
      // timestamp (a hand-edited status, a future importer), and on this filter
      // that row is not evidence of anything — hence both conditions.
      where.push(`p.available_status = 'available_confirmed'`)
      where.push(`p.last_confirmed_available_at IS NOT NULL`)
    } else if (q.include_all !== '1') {
      // Kev, 2026-09-10: 'pending_check' ("needs recheck") no longer lives in
      // its own separate tab — it stays ON the active board (as a watermarked
      // card, sorted to the bottom below, see the ORDER BY change further
      // down) UNLESS the owner is known-unreachable (outreach_unreachable),
      // in which case there is nothing an agent could do with the card and it
      // drops off entirely, same as any other dead listing.
      params.push(boardAction.getActiveStatuses())
      where.push(`(
        COALESCE(p.available_status, 'available') = ANY($${params.length})
        OR (
          p.available_status = 'pending_check'
          AND NOT EXISTS (
            SELECT 1 FROM outreach_unreachable ou WHERE ou.owner_id = p.owner_id
          )
        )
      )`)
    }
    appendWorkspaceBoardFilters(q, me, params, where, req.agent.aud !== 'board' && me.role !== 'board')
    if (q.only_mine === '1') { params.push(me.id); where.push(`p.listed_by_agent_id = $${params.length}`) }

    // AXIS B: the re-check tier. 'normal' has to match NULL too — the column
    // was added after the rows existed, so an untouched listing carries NULL
    // and is normal by definition.
    if (q.priority_class) {
      const cls = String(q.priority_class).toLowerCase()
      if (boardAction.getValidPriorityClasses().includes(cls)) {
        params.push(cls)
        where.push(`COALESCE(p.priority_class, 'normal') = $${params.length}`)
      }
    }

    // ── availability window ─────────────────────────────────────────────────
    // "show me everything free from October". Mirrors availabilityOf() exactly:
    //   now   → a date on or before today
    //   soon  → NO date at all (the honest default, 111 of 173 listings)
    //   dated → a real future date
    //   from  → free on or before the end of the given month, which is what
    //           "from October" means to an agent placing a client: anything
    //           already free by then qualifies, not only things free exactly
    //           in October.
    if (q.avail === 'now') {
      where.push(`p.available_date IS NOT NULL AND p.available_date <= CURRENT_DATE`)
    } else if (q.avail === 'soon') {
      where.push(`p.available_date IS NULL`)
    } else if (q.avail === 'dated') {
      where.push(`p.available_date IS NOT NULL AND p.available_date > CURRENT_DATE`)
    } else if (/^\d{4}-\d{2}$/.test(String(q.avail_from || ''))) {
      // Inclusive of everything already free earlier — a flat free in August is
      // available to a client asking for October.
      params.push(`${q.avail_from}-01`)
      where.push(`(p.available_date IS NULL
                   OR p.available_date <= (($${params.length}::date + INTERVAL '1 month') - INTERVAL '1 day'))`)
    }

    // Newest-first by default. The old ORDER BY led with
    // `available_status = 'available' DESC`, which was harmless while every row
    // was 'available' — but the moment check-in starts writing
    // 'available_confirmed' it would have sunk every confirmed listing to the
    // bottom of the board, i.e. punished the agents who used the button.
    const sort = SORTS[String(req.query.sort || '')] ? String(req.query.sort) : DEFAULT_SORT
    // Hot Property (migration 031) sorts first, additively, ahead of whichever
    // sort the agent picked — it never touches SORTS/orderBy() itself, so
    // every existing sort option keeps its own internal order intact below it.
    // Kev, 2026-09-10: 'pending_check' cards sort to the very bottom,
    // beneath every other sort option's own order — a no-op tiebreak on any
    // view where every row already shares the same status (?status=..., the
    // review queue), but on the default mixed board it pushes the "needs
    // recheck" watermarked cards down without needing their own tab.
    const sql = `SELECT ${BOARD_COLS} ${BOARD_FROM} WHERE ${where.join(' AND ')}
                 ORDER BY ${FUTURE_TAGGED_BOOKING_SQL} DESC,
                          p.is_hot_property DESC,
                          (p.available_status = 'pending_check') ASC,
                          ${orderBy(sort)}
                 LIMIT 500`
    const r = await db.query(sql, params)
    const qmap = await questionCountsToday(me.id)

    // Kev, 2026-08-28: the Create Group button (components/crm/board-dialogs
    // via page.tsx's onCreateGroup) has been unreachable from the main board
    // since Phase 2 landed on 2026-08-27 — canCreateGroup was only ever
    // computed in GET /favourites (see its vmap below), so every card here
    // always had r.viewing === undefined and the button stayed permanently
    // greyed out, even for a listing the owner had actually confirmed.
    // Mirrors that SAME computation, but WITHOUT the /favourites agent
    // restriction (viewing_agent_id = $2 OR user_id = $2): the create-group
    // route itself lets any admin create the group for any confirmed
    // booking on a listing, not just the agent who made it, so the board
    // that feeds that button must not scope it any tighter than the button
    // it drives actually is.
    const ids = r.rows.map(x => x.id)
    const vmap = new Map()
    if (ids.length) {
      const v = await db.query(
        `SELECT DISTINCT ON (property_id)
                property_id, id, viewing_date, viewing_time, status,
                owner_survey_status, proposed_date, proposed_time, viewing_group_jid
           FROM property_viewings
          WHERE property_id = ANY($1::int[])
            AND status IN ('pending', 'confirmed')
          ORDER BY property_id, viewing_date ASC, id ASC`, [ids])
      for (const row of v.rows) {
        vmap.set(row.property_id, {
          id: row.id,
          date: row.viewing_date,
          time: row.viewing_time || null,
          status: row.status,
          ownerSurveyStatus: row.owner_survey_status || null,
          proposedDate: row.proposed_date || null,
          proposedTime: row.proposed_time || null,
          groupJid: row.viewing_group_jid || null,
          canCreateGroup: row.status === 'confirmed' && !row.viewing_group_jid,
        })
      }
    }

    // Owner-group approval requests are a separate lifecycle from bookings.
    // A group may be requested for an eligible property without inventing a
    // confirmed viewing; the latest request is projected without owner/client
    // phone numbers so the existing board privacy boundary stays intact.
    const grmap = new Map()
    if (ids.length) {
      const gr = await db.query(
        `SELECT DISTINCT ON (property_id) property_id,request_id,status,approval_policy,expires_at,
                group_jid,group_name,created_at,updated_at,last_error
           FROM owner_group_requests WHERE property_id=ANY($1::int[])
          ORDER BY property_id,created_at DESC`, [ids])
      for (const row of gr.rows) grmap.set(row.property_id, ownerGroupRequests.publicRequest(row))
    }

    const cards = await withCardFlags(r.rows.map(row => {
      const card = shapeCard(row, me.id, qmap.get(row.id) || 0)
      card.viewing = vmap.get(row.id) || null
      card.ownerGroupRequest = grmap.get(row.id) || null
      card.canCreateOwnerGroup = canCreateGroup(me)
      return card
    }), me.id)
    // "Agent XY · Tue 4:00 PM · Confirmed" on the card (booking engine).
    try {
      const bmap = await bookingEngine.upcomingByProperty(ids, me)
      for (const c of cards) c.bookings = bmap.get(c.id) || []
    } catch (err) {
      log.warn('board bookings lookup failed', { err: err.message })
      for (const c of cards) c.bookings = []
    }

    res.json({
      listings: cards,
      total: r.rows.length,
      sort,
      me: { id: me.id, name: me.name || me.username, role: me.role },
    })
  } catch (err) {
    log.error('crm schedule-board listings failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load listings' })
  }
})

// ── GET /config ─────────────────────────────────────────────────────────────
// Browser-side settings the board needs, currently just the Maps key.
//
// WHY THE KEY IS SERVED INSTEAD OF BUNDLED
//   A NEXT_PUBLIC_* value is inlined into a JavaScript chunk that Vercel serves
//   to anyone who asks — and the frontend repo is public, so committing it
//   there would publish it twice over. Handed out here it reaches logged-in
//   agents only, and rotating it is an .env change plus a restart, with no
//   frontend rebuild. The key still needs its HTTP-referrer restriction: that,
//   not secrecy, is what stops someone else's site from spending Kev's quota.
router.get('/config', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    res.json({ mapsKey: process.env.SCHEDULE_BOARD_MAPS_KEY || '' })
  } catch (err) {
    log.error('crm schedule-board config failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load config' })
  }
})

// ── GET /me ─────────────────────────────────────────────────────────────────
// A board-only agent cannot call /api/crm/me — that router refuses their
// audience by design — so the board serves its own bootstrap. Deliberately
// thinner than the CRM one: no reveal budget, because a board agent has
// nothing to reveal.
router.get('/me', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    // Two ways to be board-only, and either is enough. `role` is the durable
    // one; the token audience covers a staff account that signed in through
    // the board. Ignoring the audience would offer Inventory and Owners to a
    // token those routes refuse anyway — a menu full of doors that 403.
    const boardOnly = me.role === 'board' || req.agent.aud === 'board'
    res.json({
      agent: {
        id: me.id, username: me.username, email: me.email,
        name: me.name, role: me.role, boardOnly,
        boardTourCompletedAt: me.board_tour_completed_at,
      },
      // The shell reads this to decide which nav items exist at all. A
      // board-only agent gets the board and nothing else — Inventory and
      // Owners are where the owner data lives.
      // 'bookings' (2026-09-23): the booking add-on is for every agent, board-only included
      nav: boardOnly ? ['board', 'bookings'] : ['dashboard', 'inventory', 'board', 'bookings', 'owners'],
      reveals: { used: 0, limit: 0 },
    })
  } catch (err) {
    log.error('crm schedule-board me failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load account' })
  }
})

// Persisted first-run state keeps the tour from replaying on another device.
router.post('/me/tour-complete', auth, async (req, res) => {
  try {
    await db.query(
      `UPDATE agents SET board_tour_completed_at = COALESCE(board_tour_completed_at, NOW()) WHERE id = $1`,
      [req.agent.id])
    res.json({ ok: true })
  } catch (err) {
    log.error('crm schedule-board tour completion failed', { err: err.message })
    res.status(500).json({ error: 'Could not save tour progress' })
  }
})

// ── GET /towns ──────────────────────────────────────────────────────────────
// Distinct towns with listing counts. The frontend geocodes these once and
// caches the coordinates — properties have no lat/lng column by design.
router.get('/towns', auth, async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT COALESCE(aw.village_key, lower(regexp_replace(p.town, '[^a-zA-Z0-9]+', '-', 'g'))) AS key,
              COALESCE(aw.village_name, p.town) AS label,
              COUNT(*)::int AS n
         FROM properties p
         LEFT JOIN argus_workspace_property_index aw ON aw.property_id=p.id
        WHERE ${REAL_LISTING_WHERE}
          AND COALESCE(p.available_status, 'available') = ANY($1)
          AND p.duplicate_flagged IS NOT TRUE
        GROUP BY 1,2 ORDER BY n DESC, label`, [boardAction.getActiveStatuses()])
    res.json({ towns: r.rows })
  } catch (err) {
    log.error('crm schedule-board towns failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load towns' })
  }
})

// ── GET /listings/:ref ──────────────────────────────────────────────────────
// Detail modal. Same firewall, plus the public description/features which
// sanitizeForPublic already cleaned when !upload wrote public_payload.
router.get('/listings/:ref', auth, async (req, res) => {
  const ref = req.params.ref
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })

    const r = await db.query(
      `SELECT ${BOARD_COLS}, p.public_payload ${BOARD_FROM}
        WHERE LOWER(p.ref) = LOWER($1) LIMIT 1`, [ref])
    const row = r.rows[0]
    if (!row) return res.status(404).json({ error: 'Listing not found' })

    const payload = row.public_payload || {}
    const qmap = await questionCountsToday(me.id)
    const [card] = await withCardFlags([shapeCard(row, me.id, qmap.get(row.id) || 0)], me.id)
    // Belt-and-suspenders: public_payload is written by sanitizeForPublic,
    // but it is the one free-text field on this response, so re-check it.
    const description = payload.description_social || payload.description_public || ''

    res.json({
      ...card,
      description,
      features: Array.isArray(payload.features) ? payload.features : [],
    })
  } catch (err) {
    log.error('crm schedule-board detail failed', { err: err.message, ref })
    res.status(500).json({ error: 'Failed to load listing' })
  }
})

// ── shared lookup for the three action endpoints ────────────────────────────
// Returns { prop, me } or sends the error response itself.
async function loadForAction(req, res) {
  const me = await liveAgent(req.agent.id)
  if (!me || !me.active) { res.status(401).json({ error: 'Account inactive' }); return null }

  const r = await db.query(
    `SELECT p.id, p.ref, p.town, p.bedrooms, p.property_type, p.listed_by_agent_id, p.owner_id,
            p.available_status, p.available_date, p.updated_at, p.last_confirmed_available_at,
            (p.street IS NOT NULL AND btrim(p.street) <> '') AS has_viewing_location,
            a.id AS agent_id, a.username AS agent_username, a.name AS agent_name,
            a.whatsapp_phones, a.whatsapp_session, a.active AS agent_active
       FROM properties p
       LEFT JOIN agents a ON a.id = p.listed_by_agent_id
      WHERE LOWER(p.ref) = LOWER($1) LIMIT 1`, [req.params.ref])
  const prop = r.rows[0]
  if (!prop) { res.status(404).json({ error: `Property ${req.params.ref} not found` }); return null }
  return { prop, me }
}

function blockFutureAction(res, prop, me, action) {
  if (!require('../services/futureAvailability').isFarFuture(prop.available_date) || me.role === 'admin') return false
  res.status(409).json({
    ok: false, status: 'future_locked', ref: prop.ref, availableDate: prop.available_date,
    lastConfirmedAvailableAt: prop.last_confirmed_available_at, updatedAt: prop.updated_at,
    error: `#${prop.ref} is expected from ${prop.available_date}. ${action} opens when the property enters the next three months.`,
  })
  return true
}

// Fall B relay: DM the listing agent. Shared by all three buttons. Wait for
// the central router's delivered/queued result so the board never says
// "sent" while a broken self-session send is failing in the background.
async function relayToListingAgent({ res, kind, prop, me, note }) {
  if (!prop.agent_id) {
    return res.status(409).json({
      error: `#${prop.ref} has no listing agent on file — nobody to relay to.`,
    })
  }
  if (!prop.agent_active) {
    return res.status(409).json({ error: `Listing agent ${prop.agent_username} is inactive.` })
  }

  const agentRow = {
    id: prop.agent_id,
    username: prop.agent_username,
    name: prop.agent_name,
    whatsapp_phones: prop.whatsapp_phones || [],
    whatsapp_session: prop.whatsapp_session,
  }
  const notify = require('../services/listingAgentNotify')
  // listingAgentNotify builds its text from operator.name — pass the agent's
  // display name so the listing agent reads "Tanja requested ...".
  const operator = { email: me.email, name: me.name || me.username }

  const fn = kind === 'availability' ? notify.requestAvailability
    : kind === 'location' ? notify.requestLocation
    : notify.sendComment

  let delivery
  try {
    delivery = await fn({ operator, ref: prop.ref, note, agentRow })
    log.info('board relay routed', { kind, ref: prop.ref, agent: agentRow.username, ...delivery })
  } catch (e) {
    log.warn('board relay failed', { kind, ref: prop.ref, err: e.message })
    return res.status(502).json({ error: `Could not send: ${e.message}` })
  }

  return res.json({
    ok: true,
    queued: !!delivery.queued,
    mode: 'fall_b',
    ref: prop.ref,
    sentTo: { agent: agentRow.name || agentRow.username, agentId: agentRow.id },
    message: delivery.queued
      ? `Request queued for ${agentRow.name || agentRow.username}; it will send when the ARGUS bridge is back.`
      : `Request sent to ${agentRow.name || agentRow.username}.`,
  })
}

// ── POST /listings/:ref/request-availability ────────────────────────────────
// The one button that branches. Own listing → message the owner. Someone
// else's → relay to them.
router.post('/listings/:ref/request-availability', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    // ARGUS dynamic facts: every Ask / availability / Book interaction re-reads the
    // owner chat, so the listing carries the owner's latest word (2026-09-23).
    ownerFactEngine.rescanProperty(loaded.prop.id).catch(() => {})
    const { prop, me } = loaded
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 1000) : null
    // Kev, 2026-09-11 ("Still Available" escalation): the agent already got
    // "already_checked_today" once and is deliberately asking again. Only
    // meaningful on your own listing (Fall A) — relayToListingAgent below
    // has no daily guard of its own to lift.
    const force = req.body && req.body.force === true
    // Kev, 2026-09-14 (spec item 6): default GENERAL, no fabricated client
    // interest. An agent explicitly opts into URGENT wording from the board.
    const urgent = req.body && req.body.urgent === true
    // Kev, 2026-09-14 (far-future guardrail): the agent has already seen the
    // "available in N days, are you sure?" prompt (status 'confirm_required')
    // and clicked CHECK ANYWAY.
    const confirmed = req.body && req.body.confirmed === true

    const isMine = !!(prop.listed_by_agent_id && prop.listed_by_agent_id === me.id)

    if (!isMine) return relayToListingAgent({ res, kind: 'availability', prop, me, note })

    // ── Fall A ──────────────────────────────────────────────────────────
    const { requestOwnerAvailability } = require('../services/availability')
    const result = await requestOwnerAvailability({
      ref: prop.ref,
      urgent,
      confirmed,
      requester: {
        agentId: me.id,
        name: me.name || me.username,
        // notify_whatsapp (migration 016) is where the agent actually wants
        // to be reached; whatsapp_phones is the number their WA SESSION runs
        // on, which is empty for a board-only agent (e.g. kevinsony1).
        phone: me.notify_whatsapp || (me.whatsapp_phones || [])[0] || null,
      },
      dryRun: !FALL_A_LIVE,
      force,
    })

    const httpStatus = result.ok ? 200
      : ['already_checked_today', 'confirm_required', 'already_pending'].includes(result.status) ? 409 : 422
    return res.status(httpStatus).json({
      ...result,
      mode: 'fall_a',
      live: FALL_A_LIVE,
    })
  } catch (err) {
    log.error('board request-availability failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/request-location ────────────────────────────────────
// Always Fall B by nature: on your own listing you already have the address,
// so there is nobody to ask.
router.post('/listings/:ref/request-location', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (prop.listed_by_agent_id === me.id) {
      return res.status(409).json({
        error: `#${prop.ref} is your own listing — add the address in Inventory instead.`,
      })
    }
    return relayToListingAgent({ res, kind: 'location', prop, me, note: null })
  } catch (err) {
    log.error('board request-location failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/comment ─────────────────────────────────────────────
router.post('/listings/:ref/comment', auth, async (req, res) => {
  try {
    const note = req.body && req.body.note ? String(req.body.note).trim() : ''
    if (!note) return res.status(400).json({ error: 'A comment is required.' })

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (prop.listed_by_agent_id === me.id) {
      return res.status(409).json({ error: `#${prop.ref} is your own listing.` })
    }
    return relayToListingAgent({ res, kind: 'comment', prop, me, note: note.slice(0, 1000) })
  } catch (err) {
    log.error('board comment failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// PHOTOS — dashboard uploader (Kev, 2026-08-29). Same destination !picup
// writes to: properties.images ([{url}]) and public_payload.images (plain
// url strings) both get the new Cloudinary URLs appended, never replaced —
// existing photos are untouched. Any board agent may add photos to any
// listing, matching !picup (no listed_by_agent_id restriction there either).
// ════════════════════════════════════════════════════════════════════════════
router.post('/listings/:ref/images', auth, photoUpload.array('images', 12), async (req, res) => {
  try {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No image files in the request.' })

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    // Kev, 2026-09-02 (explicit instruction, dashboard uploader): restricted
    // to the agent's OWN listing (or admin) here -- unlike !picup, which this
    // endpoint's original comment deliberately modelled itself on ("no
    // listed_by_agent_id restriction there either"). !picup is untouched;
    // this is the dashboard-specific tightening Kev asked for, same
    // own-listing-or-admin idiom every other write action on this router
    // already uses.
    const mine = prop.listed_by_agent_id != null && prop.listed_by_agent_id === me.id
    if (me.role !== 'admin' && !mine) {
      return res.status(403).json({
        error: `#${prop.ref} is not yours — ask ${prop.agent_name || 'the listing agent'} or an admin`,
      })
    }

    const urls = []
    for (const f of files) {
      const url = await uploadBuffer(f.buffer, f.mimetype)
      if (url) urls.push(url)
    }
    if (!urls.length) {
      return res.status(502).json({ error: 'Cloudinary upload failed for every image.' })
    }

    const row = await db.query(`SELECT images, public_payload FROM properties WHERE id=$1`, [prop.id])
    const p = row.rows[0]
    // Same two shapes createListing()/cmdPicup() already write — see
    // handlers/upload.js:cmdPicup for why there are two.
    const existingImages = Array.isArray(p.images) ? p.images
      : (typeof p.images === 'string' ? JSON.parse(p.images || '[]') : [])
    const existingPayloadImages = Array.isArray(p.public_payload?.images) ? p.public_payload.images : []
    const mergedImages = [...existingImages, ...urls.map(url => ({ url }))]
    const newPayload = { ...(p.public_payload || {}), images: [...existingPayloadImages, ...urls] }

    await db.query(
      `UPDATE properties SET images = $2::jsonb, public_payload = $3::jsonb, updated_at = NOW() WHERE id = $1`,
      [prop.id, JSON.stringify(mergedImages), JSON.stringify(newPayload)])

    await db.query(
      `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
       VALUES ($1, $2, 'photos_added_via_dashboard', $3::jsonb, TRUE)`,
      [prop.id, me.id, JSON.stringify({
        source: 'crm_schedule_board', added: urls.length,
        total_after: mergedImages.length, agent_username: me.username || null,
        timestamp: new Date().toISOString(),
      })])

    res.json({
      ok: true, ref: prop.ref, added: urls.length,
      failed: files.length - urls.length,
      totalImages: mergedImages.length, images: mergedImages,
    })
  } catch (err) {
    log.error('board image upload failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ASK — the comment field. Two steps on purpose: /preview rewrites and shows,
// /send delivers exactly the text that came back. Nothing reaches an owner
// that the agent has not read first.
// ════════════════════════════════════════════════════════════════════════════
const boardAsk = require('../services/boardAsk')

// questionsUsedFor (single-property) now comes from services/ownerAsk.js,
// imported near QUESTIONS_PER_DAY above. ownerFor/humanName/isReachout,
// right below, moved there too — handlers/ask.js (!ask command) needs the
// exact same three, not a second copy.
const { ownerFor, humanName, isReachout } = require('../services/ownerAsk')

// A rented-listing re-engagement is about the owner's wider portfolio, not
// the old property. Count it per recipient across every listing so an owner
// with ten rented properties still receives at most one such approach a day.
async function ownerInventoryQuestionsUsedFor(agentId, recipientKey) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM owner_contact_log
      WHERE agent_id = $1 AND owner_phone = $2 AND kind = 'question'
        AND status IN ('sent', 'queued')
        AND malta_day = (now() AT TIME ZONE 'Europe/Malta')::date`,
    [agentId, recipientKey])
  return r.rows[0].n
}

// ── POST /listings/:ref/ask/preview ─────────────────────────────────────────
router.post('/listings/:ref/ask/preview', auth, async (req, res) => {
  try {
    const note = req.body && req.body.note ? String(req.body.note).trim().slice(0, 1000) : ''
    const ownerInventoryIntent = req.body && req.body.intent === 'owner-inventory'
    if (!note) return res.status(400).json({ error: 'Write a question first.' })

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const isMine = !!(prop.listed_by_agent_id && prop.listed_by_agent_id === me.id)
    const owner = isMine ? await ownerFor(prop.id) : null
    const recipientKey = owner ? owner.phone_normalized : `agent:${prop.listed_by_agent_id || 0}`
    const used = ownerInventoryIntent
      ? await ownerInventoryQuestionsUsedFor(me.id, recipientKey)
      : await questionsUsedFor(me.id, prop.id)
    if (isMine) {
      if (!owner || !owner.phone_normalized) {
        return res.status(422).json({ error: 'No owner phone on file for this listing.' })
      }
      if (owner.do_not_contact) {
        return res.status(422).json({
          error: owner.do_not_contact_reason
            ? `Owner opted out: ${owner.do_not_contact_reason}`
            : 'Owner is marked do-not-contact.',
        })
      }
    }

    // FIREWALL: never the owner's real name on the isMine/owner leg — this
    // exact composed text is what /ask/preview shows the AGENT to read and
    // edit before it sends, so a personalised "Hi Maria," greeting would dox
    // the owner to the one person this whole board anonymises them from.
    // services/bookRelay.js's own owner-forward already makes this same call
    // (recipientName: null there); the Board's Ask dialog just never matched
    // it until now. The colleague leg (Fall B) is unaffected — a listing
    // agent's own name isn't owner PII.
    const recipientName = isMine
      ? null
      : humanName(prop.agent_name) || prop.agent_username || null

    // General portfolio re-engagement must not be rewritten into a question
    // about the rented reference. The agent sees and approves this exact text.
    const composed = ownerInventoryIntent
      ? { text: note.slice(0, 420), dropped: null, model: null, rewritten: false }
      : await boardAsk.composeQuestion({
          mode: isMine ? 'owner' : 'agent',
          ref: prop.ref,
          agentName: me.name || me.username,
          recipientName,
          // Owner-first viewing introductions name Kevin as the referring
          // colleague for every other profile. Kevin's own profile uses the
          // separately configured colleague instead, so he never claims that
          // he referred the number to himself.
          colleagueName: String(me.name || me.username || '').trim().split(/\s+/)[0].toLowerCase() === 'kevin'
            ? (process.env.BOARD_KEVIN_REFERRAL_PROFILE || 'Cedric')
            : 'Kevin',
          propertySummary: [
            prop.bedrooms != null ? `${prop.bedrooms} bedroom` : null,
            prop.property_type || prop.type || 'property',
            prop.town ? `in ${prop.town}` : null,
          ].filter(Boolean).join(' '),
          rawNote: note,
          isReachout: isMine ? await isReachout(owner.phone_normalized, prop.id) : false,
        })

    const now = new Date()
    const queued = !boardAsk.insideWindow(now)
    res.json({
      ...composed,
      ref: prop.ref,
      mode: isMine ? 'owner' : 'agent',
      // Never the phone — just who the agent is about to talk to.
      recipientLabel: isMine ? (recipientName || 'the owner') : (recipientName || 'the listing agent'),
      willQueue: queued,
      sendAt: queued ? boardAsk.nextSendTime(now).toISOString() : null,
      windowNote: queued
        ? `Outside the ${boardAsk.WINDOW_START_HOUR}:00–${boardAsk.WINDOW_END_HOUR}:00 contact window — this will go out at 08:00.`
        : null,
      questionsUsed: used,
      questionsLeft: null,
    })
  } catch (err) {
    log.error('board ask/preview failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/ask/send ────────────────────────────────────────────
// Takes the text the agent confirmed, not the raw note — so what was previewed
// is what goes out.
router.post('/listings/:ref/ask/send', auth, async (req, res) => {
  try {
    const text = req.body && req.body.text ? String(req.body.text).trim().slice(0, 900) : ''
    const ownerInventoryIntent = req.body && req.body.intent === 'owner-inventory'
    if (!text) return res.status(400).json({ error: 'Nothing to send.' })
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 3) : []

    // Planned Message (Kev, 2026-08-28): the agent picks an exact future
    // send time instead of "now" or "whenever the window next opens". Same
    // owner_contact_log row, same daily-limit accounting, same delivery path
    // — only WHEN it fires is different, via scripts/planned_message_flush_cron.js.
    let explicitSchedule = null
    if (req.body && req.body.scheduledFor) {
      explicitSchedule = new Date(String(req.body.scheduledFor))
      if (Number.isNaN(explicitSchedule.getTime()) || explicitSchedule.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'scheduledFor must be a valid time in the future.' })
      }
    }

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    // ARGUS dynamic facts: every Ask / availability / Book interaction re-reads the
    // owner chat, so the listing carries the owner's latest word (2026-09-23).
    ownerFactEngine.rescanProperty(loaded.prop.id).catch(() => {})
    const { prop, me } = loaded

    const isMine = !!(prop.listed_by_agent_id && prop.listed_by_agent_id === me.id)

    // Re-check the limit here, not just in /preview — two tabs, one limit.
    const owner = isMine ? await ownerFor(prop.id) : null
    if (isMine && (!owner || !owner.phone_normalized || owner.do_not_contact)) {
      return res.status(422).json({ error: 'This owner cannot be contacted.' })
    }
    const recipientKey = owner ? owner.phone_normalized : `agent:${prop.listed_by_agent_id || 0}`
    const used = ownerInventoryIntent
      ? await ownerInventoryQuestionsUsedFor(me.id, recipientKey)
      : await questionsUsedFor(me.id, prop.id)
    const now      = new Date()
    const inWindow = !explicitSchedule && boardAsk.insideWindow(now)
    const sendAt   = explicitSchedule || (inWindow ? now : boardAsk.nextSendTime(now))
    const day      = boardAsk.maltaDay(sendAt)

    // The log row is written FIRST, in both branches. It is what the throttles
    // count, so a send that races a second tab still only gets one slot.
    // is_mine/agent_name/agent_phone/images are stored so a LATER flush (the
    // outside-window case, or an explicit Planned Message) can replay the
    // delivery without re-deriving "who is this from" — see migration 033.
    const ins = await db.query(
      `INSERT INTO owner_contact_log
         (owner_contact_id, owner_phone, property_id, ref, agent_id, kind, status,
          body, scheduled_for, malta_day, is_mine, agent_name, agent_phone, images)
       VALUES ($1,$2,$3,$4,$5,'question',$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
      [owner ? owner.id : null,
       owner ? owner.phone_normalized : `agent:${prop.listed_by_agent_id || 0}`,
       prop.id, prop.ref, me.id,
       inWindow ? 'sent' : 'queued',
       text, sendAt, day,
       isMine, me.name || me.username || null, me.notify_whatsapp || null,
       JSON.stringify(images)])
    const logId = ins.rows[0].id

    if (!inWindow) {
      return res.json({
        ok: true, queued: true, ref: prop.ref, logId,
        sendAt: sendAt.toISOString(),
        message: explicitSchedule
          ? `Planned — goes out ${sendAt.toLocaleString('en-GB', { timeZone: 'Europe/Malta', dateStyle: 'medium', timeStyle: 'short' })} (Malta time).`
          : `Queued — outside the ${boardAsk.WINDOW_START_HOUR}:00–${boardAsk.WINDOW_END_HOUR}:00 window. It goes out at 08:00.`,
        questionsUsed: used + 1, questionsLeft: null,
      })
    }

    // ── deliver ────────────────────────────────────────────────────────────
    let relayQueued = false
    try {
      if (isMine) {
        // Fall A — opens (or supersedes) this agent's Board relay thread for
        // this listing and sends the composed text as its first message. From
        // here the owner's reply — and any follow-up the agent types straight
        // into the Board's chat window — rides the same thread. See
        // services/bookRelay.js `openBoardThread` for the owner-account rule
        // (never a cold default) and the property_activities write.
        const bookRelay = require('../services/bookRelay')
        const opened = await bookRelay.openBoardThread({
          ref: prop.ref, agentId: me.id, agentName: me.name || me.username,
          agentPhone: me.notify_whatsapp || null, initialText: text, action: 'question',
        })
        if (!opened.ok) throw new Error(opened.message || 'Could not reach the owner.')
        if (images.length) {
          const waha = require('../waha')
          for (const img of images) {
            if (!img || !img.dataBase64) continue
            await waha.sendImage(opened.session, opened.ownerPhone, img.dataBase64, img.mime || 'image/jpeg', '')
          }
        }
      } else {
        // Fall B — relayed to the listing agent, same path the old comment
        // button used. The owner is never reachable from here.
        const notify = require('../services/listingAgentNotify')
        const delivery = await notify.sendComment({
          operator: { email: me.email, name: me.name || me.username },
          ref: prop.ref,
          note: text,
          agentRow: {
            id: prop.agent_id, username: prop.agent_username, name: prop.agent_name,
            whatsapp_phones: prop.whatsapp_phones || [], whatsapp_session: prop.whatsapp_session,
          },
        })
        relayQueued = !!delivery.queued
      }
      await db.query(
        relayQueued
          ? `UPDATE owner_contact_log SET status = 'queued' WHERE id = $1`
          : `UPDATE owner_contact_log SET status = 'sent', sent_at = now() WHERE id = $1`,
        [logId])
    } catch (sendErr) {
      // The row stays, marked failed, so a broken send does not silently
      // burn one of the agent's two daily questions.
      await db.query(
        `UPDATE owner_contact_log SET status = 'failed', error = $2 WHERE id = $1`,
        [logId, sendErr.message.slice(0, 300)])
      log.warn('board ask send failed', { ref: prop.ref, err: sendErr.message })
      return res.status(502).json({ error: `Could not send: ${sendErr.message}` })
    }

    res.json({
      ok: true, ref: prop.ref, logId,
      queued: relayQueued,
      message: isMine ? `Sent to the owner of #${prop.ref}.`
                      : relayQueued
                        ? `Queued for ${prop.agent_name || prop.agent_username}; it will send when the ARGUS bridge is back.`
                        : `Sent to ${prop.agent_name || prop.agent_username}.`,
      questionsUsed: used + 1, questionsLeft: null,
    })
  } catch (err) {
    log.error('board ask/send failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// BOOK — a viewing, with the party detail the owner will ask about anyway.
// Writes one clients row (the party) and one property_viewings row (the slot).
// Sends nothing: booking is an internal act, and the owner ping is the
// separate, throttled button next to it.
// ════════════════════════════════════════════════════════════════════════════
router.post('/listings/:ref/book', auth, async (req, res) => {
  try {
    const b = req.body || {}
    const clientsText = String(b.clients || '').trim()
    const date        = String(b.date || '').trim()
    if (!clientsText) return res.status(400).json({ error: 'Who is viewing? Add at least one name.' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Pick a viewing date.' })

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    // ARGUS dynamic facts: every Ask / availability / Book interaction re-reads the
    // owner chat, so the listing carries the owner's latest word (2026-09-23).
    ownerFactEngine.rescanProperty(loaded.prop.id).catch(() => {})
    const { prop, me } = loaded
    if (blockFutureAction(res, prop, me, 'Booking requests')) return

    // The viewing agent defaults to whoever is booking, but the form lets you
    // book on a colleague's behalf.
    let viewingAgentId = me.id, viewingAgentName = me.name || me.username
    if (b.agentId && Number(b.agentId) !== me.id) {
      const a = await db.query(`SELECT id, name, username FROM agents WHERE id=$1 AND active=TRUE`, [Number(b.agentId)])
      if (!a.rows[0]) return res.status(422).json({ error: 'That agent is not active.' })
      viewingAgentId = a.rows[0].id
      viewingAgentName = a.rows[0].name || a.rows[0].username
    }

    const groupSize = b.groupSize ? Number(b.groupSize) : null

    const cl = await db.query(
      `INSERT INTO clients (id, name, group_size, ages, pets, profession, relation,
                            notes, source_agent, lead_agent, assigned_agent, status, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $8, $8, 'viewing_booked', now(), now())
       RETURNING id`,
      [clientsText,
       Number.isFinite(groupSize) && groupSize > 0 ? groupSize : null,
       b.ages       ? String(b.ages).trim().slice(0, 120)       : null,
       b.pets       ? String(b.pets).trim().slice(0, 120)       : null,
       b.jobs       ? String(b.jobs).trim().slice(0, 200)       : null,
       b.relation   ? String(b.relation).trim().slice(0, 80)    : null,
       b.notes      ? String(b.notes).trim().slice(0, 1000)     : null,
       viewingAgentName])

    const vw = await db.query(
      `INSERT INTO property_viewings
         (property_id, viewing_date, viewing_time, requester_name, status, notes,
          source, user_id, user_name, viewing_agent_id, viewing_agent_name)
       VALUES ($1,$2,$3,$4,'pending',$5,'agent_book',$6,$7,$8,$9)
       RETURNING id, viewing_date, viewing_time`,
      [prop.id, date, b.time ? String(b.time).trim().slice(0, 20) : null,
       clientsText,
       [b.relation && `Relation: ${b.relation}`, b.ages && `Ages: ${b.ages}`,
        b.pets && `Pets: ${b.pets}`, b.jobs && `Jobs: ${b.jobs}`,
        b.notes && String(b.notes).trim()].filter(Boolean).join(' · ').slice(0, 1000) || null,
       me.id, me.name || me.username, viewingAgentId, viewingAgentName])

    // ── FAVOURITES ──────────────────────────────────────────────────────────
    // A booked listing lands in the Favourites tab by itself. That is the whole
    // point of the tab (Kev, 2026-08-16): the flats you are actually taking
    // someone to are the ones you need to find again in a hurry, and nobody
    // remembers to bookmark them while filling in a booking form.
    //
    // Both the person who booked and the agent doing the viewing get it. They
    // are usually the same person; when a booking is made on a colleague's
    // behalf they are not, and both of them need it on their list.
    //
    // Deliberately NOT the same list as WATag: tagged = "I want to pass this
    // on", favourite = "I have a viewing on this". agent_favourites already
    // exists and is what the Inventory CRM's star writes to, so a listing
    // starred there and one booked here land in the same place.
    //
    // Non-fatal: the viewing is in the database and the client has been told.
    // A failed bookmark must not turn a completed booking into a 500.
    const favAgents = [...new Set([me.id, viewingAgentId].filter(Boolean))]
    let favourited = false
    try {
      await db.query(
        `INSERT INTO agent_favourites (agent_id, property_id)
         SELECT UNNEST($1::int[]), $2
         ON CONFLICT (agent_id, property_id) DO NOTHING`, [favAgents, prop.id])
      favourited = true
    } catch (err) {
      log.warn('board booking: favourite insert failed',
        { ref: prop.ref, err: err.message })
    }

    // ── owner chat (additive) ────────────────────────────────────────────────
    // Opens the same Board relay thread Ask uses, so confirming this viewing
    // is a real conversation with the owner instead of a silent DB write —
    // "läuft dann auch im Chat mit dem Owner ab wie AV" (Kev). Best-effort:
    // the viewing is already saved and the client already told, so a failed
    // or impossible owner-contact (no owner linked, no phone, do-not-contact,
    // no account in touch with them yet) must never turn a completed booking
    // into an error.
    let relayOpened = false
    if (prop.owner_id) {
      try {
        const bookRelay = require('../services/bookRelay')
        const when = b.time ? `${date} at ${b.time}` : date
        const party = [
          `Group: ${clientsText}`,
          Number.isFinite(groupSize) && groupSize > 0 ? `${groupSize} people` : null,
          b.ages ? `Ages: ${b.ages}` : null,
          b.pets ? `Pets: ${b.pets}` : null,
        ].filter(Boolean).join(' · ')
        const ask =
          `Hi! I'd like to book a viewing for #${prop.ref} on ${when}.\n\n${party}\n\n` +
          `Just say yes, no, or another time that suits you better 🙂`
        const opened = await bookRelay.openBoardThread({
          ref: prop.ref, agentId: me.id, agentName: me.name || me.username,
          agentPhone: me.notify_whatsapp || null, initialText: ask, action: 'viewing',
          viewingId: vw.rows[0].id,
        })
        relayOpened = !!opened.ok
        if (!opened.ok) {
          log.info('board booking: no owner chat opened', { ref: prop.ref, reason: opened.reason })
        } else {
          // Phase 2 (Kev, 2026-08-27): owner_chat_id/account_session so
          // services/bookingSurvey.js's Yes/No/Suggest-time listener can find
          // this row when the owner replies — the board's own ask never
          // populated these before, so a board booking's owner reply had no
          // way to be classified (only bookFlow.js executeBook's WhatsApp
          // !book path did). Best-effort: the booking + board chat already
          // succeeded, so a failure here only means the survey misses this
          // one row, never a failed booking.
          try {
            const ownerChatId = opened.ownerPhone
              ? String(opened.ownerPhone).replace(/[^0-9]/g, '') + '@c.us'
              : null
            await db.query(
              `UPDATE property_viewings SET owner_chat_id = $2, account_session = $3, updated_at = NOW()
                WHERE id = $1`,
              [vw.rows[0].id, ownerChatId, opened.session])
          } catch (err) {
            log.warn('board booking: survey linkage update failed', { ref: prop.ref, err: err.message })
          }
        }
      } catch (err) {
        log.warn('board booking: owner chat failed', { ref: prop.ref, err: err.message })
      }
    }

    log.info('board booking created', { ref: prop.ref, viewingId: vw.rows[0].id, by: me.username, relayOpened })
    res.json({
      ok: true, ref: prop.ref,
      viewingId: vw.rows[0].id,
      clientId: cl.rows[0].id,
      favourited,
      relayOpened,
      message: `Viewing booked for #${prop.ref} on ${date}${b.time ? ` at ${b.time}` : ''}.`
        + (favourited ? ' Added to your Favourites.' : '')
        + (relayOpened ? ' Owner notified — check the chat.' : ''),
    })
  } catch (err) {
    log.error('board book failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// OWNER GROUP REQUEST — persistent owner approval in front of the existing
// createViewingGroup() engine. Group request and booking remain independent.
// ════════════════════════════════════════════════════════════════════════════
router.get('/listings/:ref/group-request-context', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (!canCreateGroup(me)) return res.status(403).json({ error: 'Create Group ★ is not enabled for this profile.' })
    const p = await db.query(
      `SELECT p.id,p.ref,p.town,oc.name AS owner_name,oc.owner_group_policy
         FROM properties p JOIN owner_contacts oc ON oc.id=p.owner_id WHERE p.id=$1`, [prop.id])
    const latest = await ownerGroupRequests.getLatestForProperty(prop.id)
    const clients = await ownerGroupRequests.listClientChoices(me.id, req.query.q || '')
    res.json({
      property: { id:p.rows[0].id,ref:p.rows[0].ref,town:p.rows[0].town },
      owner: { label:p.rows[0].owner_name || 'Owner', contact:'masked' },
      agent: { id:me.id,name:me.name || me.username },
      approvalPolicy:p.rows[0].owner_group_policy || ownerGroupRequests.EXPLICIT,
      clients, latest,
    })
  } catch (err) {
    log.error('owner group context failed',{ ref:req.params.ref,err:err.message })
    res.status(err.statusCode || 500).json({ error:err.message })
  }
})

router.post('/listings/:ref/group-request', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error:'Account inactive' })
    const result = await ownerGroupRequests.createRequest({
      propertyRef:req.params.ref,agentId:me.id,
      clientIds:req.body?.clientIds,relationship:req.body?.relationship,
      moveInDate:req.body?.moveInDate,viewingIntent:req.body?.viewingIntent,
      note:req.body?.note,viewingId:req.body?.viewingId,
    })
    res.status(201).json({ ok:true,request:result,message:'Owner approval request sent.' })
  } catch (err) {
    log.error('owner group request failed',{ ref:req.params.ref,err:err.message })
    res.status(err.statusCode || 500).json({ error:err.message,code:err.code || null })
  }
})

router.get('/listings/:ref/group-request-status', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req,res)
    if (!loaded) return
    const request = await ownerGroupRequests.getLatestForProperty(loaded.prop.id)
    res.json({ request })
  } catch (err) { res.status(500).json({ error:err.message }) }
})

router.post('/owner-group-requests/:requestId/cancel', auth, async (req,res) => {
  try {
    const me=await liveAgent(req.agent.id)
    const q=await db.query(
      `UPDATE owner_group_requests SET status='GROUP_REQUEST_CANCELLED',resolution_source='manual_cancel',updated_at=NOW()
        WHERE request_id=$1 AND status IN ('GROUP_REQUEST_DRAFT','GROUP_REQUEST_PENDING')
          AND (requesting_agent_id=$2 OR $3::boolean=TRUE) RETURNING request_id`,
      [req.params.requestId,me.id,me.role==='admin'])
    if(!q.rows.length) return res.status(409).json({error:'Request is no longer cancellable.'})
    res.json({ok:true})
  } catch(err){res.status(500).json({error:err.message})}
})

router.post('/owner-group-requests/:requestId/approve', auth, async (req,res) => {
  try {
    const me=await liveAgent(req.agent.id)
    if(me.role!=='admin') return res.status(403).json({error:'Admin only'})
    const q=await db.query(
      `UPDATE owner_group_requests SET status='GROUP_REQUEST_APPROVED',resolution_source='admin_approval',updated_at=NOW()
        WHERE request_id=$1 AND status IN ('GROUP_REQUEST_PENDING','GROUP_REQUEST_TIMEOUT') RETURNING request_id`,[req.params.requestId])
    if(!q.rows.length) return res.status(409).json({error:'Request cannot be approved in its current state.'})
    const request=await ownerGroupRequests.createGroupForRequest(req.params.requestId,'admin_approval')
    res.json({ok:true,request})
  } catch(err){res.status(500).json({error:err.message})}
})

router.post('/owner-group-requests/:requestId/close', auth, async (req,res) => {
  try {
    const me=await liveAgent(req.agent.id)
    if(me.role!=='admin') return res.status(403).json({error:'Admin only'})
    const q=await db.query(
      `UPDATE owner_group_requests SET status='GROUP_CLOSED',group_closed_at=NOW(),resolution_source='admin_close',updated_at=NOW()
        WHERE request_id=$1 AND status IN ('GROUP_CREATED','GROUP_ACTIVE') RETURNING request_id`,[req.params.requestId])
    if(!q.rows.length) return res.status(409).json({error:'Group is not active.'})
    res.json({ok:true,message:'Group archived in ARGUS. Remove participants in WhatsApp if the owner requested immediate removal.'})
  } catch(err){res.status(500).json({error:err.message})}
})

router.patch('/owners/:ownerId/group-policy', auth, async (req,res) => {
  try {
    const me=await liveAgent(req.agent.id)
    if(me.role!=='admin') return res.status(403).json({error:'Admin only'})
    const policy=req.body?.policy===ownerGroupRequests.TRUSTED_TIMEOUT?ownerGroupRequests.TRUSTED_TIMEOUT:ownerGroupRequests.EXPLICIT
    const relationships=[...new Set((Array.isArray(req.body?.relationships)?req.body.relationships:[]).map(x=>String(x).trim().toLowerCase()).filter(Boolean))].slice(0,20)
    const q=await db.query(`UPDATE owner_contacts SET owner_group_policy=$2,owner_group_trusted_relationships=$3::jsonb,updated_at=NOW() WHERE id=$1 RETURNING id,owner_group_policy,owner_group_trusted_relationships`,
      [Number(req.params.ownerId),policy,JSON.stringify(relationships)])
    if(!q.rows.length) return res.status(404).json({error:'Owner not found'})
    res.json({ok:true,policy:q.rows[0]})
  } catch(err){res.status(500).json({error:err.message})}
})

// ════════════════════════════════════════════════════════════════════════════
// CREATE GROUP — Phase 2 (Kev, 2026-08-27). Locked until the owner has
// actually said yes to a viewing (services/bookingSurvey.js flips
// property_viewings.status to 'confirmed'); the frontend's disabled state
// mirrors this same canCreateGroup check (see /favourites' vmap above), but
// the real gate is here, server-side.
//
// Reuses handlers/upload.js createViewingGroup() — the exact group-creation
// + welcome-message tool !uploadlisting's "group" keyword already uses —
// rather than building a second group-creation path. The only new part is
// WHICH account creates it: uploaderPhone is resolved from the viewing's own
// account_session (whichever of Kev's accounts has been talking to this
// owner), not the requesting agent's phone, so Jasmine/Cedric's persona
// never breaks by having a DIFFERENT account suddenly show up in the group.
// ════════════════════════════════════════════════════════════════════════════
router.post('/listings/:ref/create-group', auth, async (req, res) => {
  try {
    // Compatibility endpoint retained so older clients receive a clear,
    // fail-closed answer. Every new group must enter through /group-request;
    // a confirmed viewing alone is no longer sufficient owner consent.
    return res.status(409).json({
      error:'Owner approval is required. Open Create Group ★ and send an owner request.',
      replacement:`/api/crm/schedule-board/listings/${encodeURIComponent(req.params.ref)}/group-request`,
    })
    /* istanbul ignore next -- legacy implementation kept below as an audit reference */
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    // Admin-gated (see canCreateGroup() above for the Olga/Katya exception,
    // 2026-09-04) — creating a real WhatsApp group with the owner in it is
    // exactly the kind of action that stays locked down; enforced here, not
    // just by hiding the button.
    if (!canCreateGroup(me)) return res.status(403).json({ error: 'Admins only.' })

    // Any admin can create the group for any confirmed booking on this
    // listing — not scoped to "your own" the way Favourites' canCreateGroup
    // is, since it is an admin action on the listing, not a personal one.
    const v = await db.query(
      `SELECT id, viewing_date, viewing_time, notes, requester_name, account_session, viewing_group_jid
         FROM property_viewings
        WHERE property_id = $1 AND status = 'confirmed'
        ORDER BY id DESC LIMIT 1`, [prop.id])
    const viewing = v.rows[0]
    if (!viewing) return res.status(409).json({ error: 'No confirmed booking on this listing yet — the owner has to say yes first.' })
    if (viewing.viewing_group_jid) return res.status(409).json({ error: 'A group already exists for this booking.' })

    const p = await db.query(
      `SELECT p.id, p.ref, p.town, p.street, p.apt, p.public_payload,
              oc.name AS owner_name, oc.phone_normalized AS owner_phone
         FROM properties p LEFT JOIN owner_contacts oc ON oc.id = p.owner_id
        WHERE p.id = $1`, [prop.id])
    const propRow = p.rows[0]
    if (!propRow || !propRow.owner_phone) return res.status(422).json({ error: 'No owner phone on file for this listing.' })

    // Same account that has been talking to this owner creates the group —
    // the persona-consistency rule. Falls back to Default only when the
    // viewing has no account_session on file at all (pre-Phase-2 rows).
    let uploaderPhone = null
    if (viewing.account_session) {
      const acc = await db.query(
        `SELECT phone FROM whatsapp_accounts WHERE LOWER(session_name) = LOWER($1) LIMIT 1`,
        [viewing.account_session])
      uploaderPhone = acc.rows[0]?.phone || null
    }

    const uploadListing = require('../handlers/upload')
    if (typeof uploadListing.createViewingGroup !== 'function') {
      return res.status(500).json({ error: 'Group-creation tool unavailable.' })
    }

    const c = {
      propId: propRow.id, ref: propRow.ref,
      ownerPhone: propRow.owner_phone, ownerName: propRow.owner_name,
      town: propRow.town, street: propRow.street, apt: propRow.apt,
      publicPayload: propRow.public_payload,
      description: propRow.public_payload?.description_social || null,
    }

    let created
    try {
      created = await uploadListing.createViewingGroup({ c, uploaderPhone })
    } catch (err) {
      log.error('board create-group failed', { ref: prop.ref, err: err.message })
      return res.status(502).json({ error: `Could not create the group: ${err.message.slice(0, 200)}` })
    }

    await db.query(
      `UPDATE property_viewings SET viewing_group_jid = $2, group_created_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [viewing.id, created.groupId])

    log.info('board create-group succeeded', { ref: prop.ref, viewingId: viewing.id, groupId: created.groupId, via: uploaderPhone ? viewing.account_session : 'default' })
    res.json({
      ok: true, ref: prop.ref, groupId: created.groupId, name: created.name,
      failed: created.failed || [],
      message: `Group created: ${created.name}.`,
    })
  } catch (err) {
    log.error('board create-group failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// RELAY CHAT — the WhatsApp-style chat window Ask/Book open onto.
//
// Anonymised, owner-identity-free, phone numbers masked — see
// services/bookRelay.js `getBoardMessages` / `maskPhonesForDisplay`. Firewall:
// every read and write below is scoped to `me.id`, so an agent only ever sees
// their own thread with an owner, never a colleague's.
//
// The owner label, persona and milchglas summary are all computed in
// services/bookRelay.js getBoardSnapshot() — this route is just auth +
// property resolution in front of it.
// ════════════════════════════════════════════════════════════════════════════

// ── GET /listings/:ref/relay ─────────────────────────────────────────────────
router.get('/listings/:ref/relay', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const bookRelay = require('../services/bookRelay')
    res.json(await bookRelay.getBoardSnapshot({
      ref: prop.ref,
      agentId: me.id,
      // The property Board is already owner-anonymised. Agents need the
      // complete operational conversation here; privacy redaction belongs
      // only in the cross-agent monitor below /admin/agent-chats.
      privateDeviceChat: false,
    }))
  } catch (err) {
    log.error('board relay read failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/relay/attachments ───────────────────────────────────
router.post('/listings/:ref/relay/attachments', auth, relayAttachmentUpload.array('files', 5), async (req, res) => {
  try {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No files in the request.' })
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    const caption = String(req.body?.caption || '').trim().slice(0, 1000)
    const bookRelay = require('../services/bookRelay')
    let thread = await bookRelay.getBoardThread({ ref: prop.ref, agentId: me.id })
    if (!thread || thread.status !== 'relaying') {
      const opened = await bookRelay.openBoardThread({
        ref: prop.ref, agentId: me.id, agentName: me.name || me.username,
        agentPhone: me.notify_whatsapp || null,
        initialText: caption || (files.length === 1 ? `Sharing ${files[0].originalname}.` : `Sharing ${files.length} files.`),
      })
      if (!opened.ok) return res.status(422).json({ error: opened.message || 'Could not reach the owner.' })
      thread = await bookRelay.getBoardThread({ ref: prop.ref, agentId: me.id })
    }
    const sent = []
    for (const file of files) {
      const result = await bookRelay.sendBoardAttachment({
        threadId: thread.id, agentId: me.id,
        file: { filename: file.originalname, mime: file.mimetype, dataBase64: file.buffer.toString('base64') },
        caption: sent.length === 0 ? caption : '',
      })
      if (!result.ok) throw new Error(result.reason || 'Attachment send failed')
      let url = null
      if (prop.owner_id) {
        url = await uploadOwnerAttachment(file).catch(err => {
          log.warn('board relay owner-document archive failed', { ref: prop.ref, err: err.message })
          return null
        })
        if (url) await db.query(
          `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, property_id, notes)
           VALUES ($1,$2,$3,$4,$5,'Board relay attachment')`,
          [prop.owner_id, file.originalname, url, me.username || me.name || 'board', prop.id])
      }
      sent.push({ filename: file.originalname, archived: !!url })
    }
    res.json({ ok: true, files: sent })
  } catch (err) {
    log.error('board relay attachment failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: `Could not send attachment: ${err.message}` })
  }
})

// ── POST /listings/:ref/relay/message ────────────────────────────────────────
// The agent typing directly into the chat window. Verbatim to the owner — no
// rewrite, see services/bookRelay.js `relayVerbatim`.
router.post('/listings/:ref/relay/message', auth, async (req, res) => {
  try {
    const text = req.body && req.body.text ? String(req.body.text).trim().slice(0, 1000) : ''
    if (!text) return res.status(400).json({ error: 'Nothing to send.' })

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const bookRelay = require('../services/bookRelay')
    const thread = await bookRelay.getBoardThread({ ref: prop.ref, agentId: me.id })

    // No Ask/Book prerequisite (Kev, 2026-08-27): typing into an empty (or
    // 50h-expired — getBoardThread already ran that check) chat window starts
    // the conversation itself, verbatim — no boardAsk rewrite, no template.
    // That's the whole point of a chat box versus the Ask dialog's
    // compose-then-confirm flow.
    if (!thread || thread.status !== 'relaying') {
      const opened = await bookRelay.openBoardThread({
        ref: prop.ref, agentId: me.id, agentName: me.name || me.username,
        agentPhone: me.notify_whatsapp || null, initialText: text,
      })
      if (!opened.ok) return res.status(422).json({ error: opened.message || 'Could not reach the owner.' })
      return res.json({ ok: true, opened: true, scrubbed: false, persona: opened.persona })
    }

    const sent = await bookRelay.sendBoardMessage({ threadId: thread.id, agentId: me.id, text })
    if (!sent.ok) {
      const status = sent.reason === 'thread_closed' || sent.reason === 'chat_presence' ? 409 : sent.reason === 'not_found' ? 404 : 502
      const error = sent.reason === 'thread_closed'
        ? 'This conversation has closed — start a new one with Ask or Book.'
        : sent.reason === 'chat_presence'
        ? `${sent.presence?.agentName || 'Another agent'} is actively chatting about this property. Free-form chat unlocks after two quiet minutes; Ask and Book still work.`
        : `Could not send: ${sent.reason || 'unknown'}.`
      return res.status(status).json({ error, presence: sent.presence })
    }
    res.json({ ok: true, scrubbed: !!sent.scrubbed })
  } catch (err) {
    log.error('board relay send failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// AVAILABILITY BUTTONS — check-in / check-out / recheck / archive
//
// The SQL for all four lives in services/boardAction.js and nowhere else. These
// handlers resolve the ref, decide the HTTP shape, and run what boardAction
// hands back. That split is what keeps one set of rented/archived guards and
// one audit-log shape across the manual buttons, the AI path and the emoji
// path.
//
// Nothing here sends a WhatsApp message and nothing here deletes anything. A
// check-out moves a listing off the ACTIVE board; the row, its photos and its
// activity trail are untouched.
// ════════════════════════════════════════════════════════════════════════════

// Run a boardAction plan: the UPDATE and its property_activities row, in one
// transaction. The audit row is not optional — a status change nobody can trace
// back to a person is exactly what status_change_reason exists to prevent — so
// if the log insert fails the status change goes with it.
async function runPlan(plan) {
  // db.js exports the pg Pool itself, so db.connect() is the checkout — same
  // call routes/crm.js and services/labelEngine.js use for their transactions.
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const upd = await client.query(plan.update.sql, plan.update.params)
    // No row matched: the guard held (rented/archived). Nothing to log.
    if (!upd.rows.length) { await client.query('ROLLBACK'); return { changed: false, row: null } }
    await client.query(plan.activity.sql, plan.activity.params)
    await client.query('COMMIT')
    return { changed: true, row: upd.rows[0] }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
    throw e
  } finally {
    client.release()
  }
}

// What the agent is told about the announcement their click set off. Two counts
// and nothing else: a card action should not turn into a wall of text, but
// "nobody was told" and "three groups were told" are different outcomes and the
// agent is the only one who can act on the difference.
function feedbackSummary(told) {
  if (!told || told.skipped) return { groupsUpdated: 0, agentsTold: 0, skipped: told && told.skipped }
  return {
    groupsUpdated: told.groups ? told.groups.replied : 0,
    groupsTotal:   told.groups ? told.groups.total : 0,
    agentsTold:    told.requesters ? told.requesters.notified : 0,
  }
}

// One sentence for the toast, built from the same summary.
function feedbackSentence(f) {
  if (!f || f.skipped) return ''
  const bits = []
  if (f.groupsTotal) bits.push(`${f.groupsUpdated}/${f.groupsTotal} group${f.groupsTotal === 1 ? '' : 's'} updated`)
  if (f.agentsTold)  bits.push(`${f.agentsTold} agent${f.agentsTold === 1 ? '' : 's'} told`)
  return bits.length ? ` ${bits.join(', ')}.` : ''
}

// 'rented' and 'archived' are the machine's and the operator's final verdicts.
// A manual availability button must not talk over either of them, and the
// guards inside boardAction already refuse to. This pre-check exists only so
// the agent gets a sentence explaining why instead of a silent no-op — the
// guard in the SQL, not this, is what actually protects the row.
function lockedReason(status) {
  if (status === 'rented')   return 'marked RENTED — reopen it in Inventory if that is wrong.'
  if (status === 'archived') return 'archived — restore it in Inventory first.'
  return null
}

// ── POST /listings/:ref/check-in ────────────────────────────────────────────
// "Available Confirmed". The card stays on the board and its timestamp moves to
// now — that timestamp is the entire point of the click, so pressing it twice
// in a day is a legitimate act, not a no-op.
router.post('/listings/:ref/check-in', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const locked = lockedReason(prop.available_status)
    if (locked) return res.status(409).json({ error: `#${prop.ref} is ${locked}` })

    const plan = await boardAction.checkIn({
      propertyId: prop.id,
      agentId: me.id,
      oldStatus: prop.available_status || null,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed, row } = await runPlan(plan)
    if (!changed) return res.status(409).json({ error: `#${prop.ref} could not be confirmed.` })

    log.info('board check-in', { ref: prop.ref, by: me.username, from: prop.available_status })
    res.json({
      ok: true,
      ref: prop.ref,
      availableStatus: row.available_status,
      lastConfirmedAvailableAt: row.last_confirmed_available_at,
      // The card stays put — this is the one action that does not remove it.
      removedFromBoard: false,
      message: `#${prop.ref} confirmed available.`,
    })
  } catch (err) {
    log.error('board check-in failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/check-out ───────────────────────────────────────────
// "Not Available". The reason is mandatory — boardAction refuses without one —
// because a listing that vanished from the board with no explanation is the
// thing nobody can debug three weeks later.
router.post('/listings/:ref/check-out', auth, async (req, res) => {
  try {
    const reason = req.body && req.body.reason ? String(req.body.reason).trim() : ''
    if (!reason) return res.status(400).json({ error: 'Why is it not available? A reason is required.' })

    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const locked = lockedReason(prop.available_status)
    if (locked) return res.status(409).json({ error: `#${prop.ref} is already ${locked}` })

    const plan = await boardAction.checkOut({
      propertyId: prop.id,
      agentId: me.id,
      reason: reason.slice(0, 500),
      oldStatus: prop.available_status || null,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed, row } = await runPlan(plan)
    if (!changed) return res.status(409).json({ error: `#${prop.ref} could not be checked out.` })

    log.info('board check-out', { ref: prop.ref, by: me.username, from: prop.available_status })

    // Kev's Prompt C, event PROPERTY RENTED (this is the generic off-market
    // path — "rented" is often the reason typed here, not a distinct status
    // value) — this listing is no longer offerable, so its pending matches
    // stop being live suggestions. Fire-and-forget: never blocks the
    // check-out itself.
    require('../services/matchEngine').invalidateMatchesForProperty(prop.id, `check-out:${reason.slice(0, 100)}`)
      .catch(err => log.warn('board check-out: match invalidation failed', { ref: prop.ref, err: err.message }))

    // The listing is gone from the board — now say so where it was offered.
    // Awaited so the response can report what actually happened, but it never
    // throws: the status change has committed and must not be undone by a
    // WhatsApp hiccup.
    //
    // Only on a real transition. Unlike the other three actions, check-out has no
    // "already in this state" guard — correcting the reason from "Owner not
    // reachable" to "Rented out" is a legitimate second click, and it must not
    // tell the groups a second time that the listing died.
    const wasAlreadyOff = prop.available_status === 'not_available'
    const told = wasAlreadyOff ? { skipped: 'already_off_market' }
      : await boardFeedback.announceStatusChange({
          propertyId: prop.id, ref: prop.ref, kind: 'off_market',
          reason: reason.slice(0, 500), actor: me.username,
        })

    res.json({
      ok: true,
      ref: prop.ref,
      availableStatus: row.available_status,
      statusChangeReason: row.status_change_reason,
      feedback: feedbackSummary(told),
      // Tells the browser its optimistic removal was right. Nothing was
      // deleted — the listing is still in Inventory and in its own history.
      removedFromBoard: true,
      message: `#${prop.ref} is off the board.${feedbackSentence(feedbackSummary(told))}`,
    })
  } catch (err) {
    log.error('board check-out failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/recheck ─────────────────────────────────────────────
// "Needs Recheck" → pending_check. The same state the AI reaches for when it
// cannot read an owner's reply, so a human doubt and a machine doubt land in
// one queue. changed_by separates them in the audit trail.
router.post('/listings/:ref/recheck', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const locked = lockedReason(prop.available_status)
    if (locked) return res.status(409).json({ error: `#${prop.ref} is ${locked}` })

    const reason = req.body && req.body.reason
      ? String(req.body.reason).trim().slice(0, 500)
      : `Flagged for recheck by ${me.name || me.username}`

    const plan = await boardAction.markPendingCheck({
      propertyId: prop.id,
      agentId: me.id,
      reason,
      oldStatus: prop.available_status || null,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed } = await runPlan(plan)
    if (!changed) return res.status(409).json({ error: `#${prop.ref} could not be flagged.` })

    log.info('board recheck', { ref: prop.ref, by: me.username, from: prop.available_status })
    res.json({
      ok: true, ref: prop.ref, availableStatus: 'pending_check',
      removedFromBoard: true,
      message: `#${prop.ref} moved to the recheck queue.`,
    })
  } catch (err) {
    log.error('board recheck failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/archive ─────────────────────────────────────────────
// The end of the line. Off the active board and out of the review queue, but
// still every bit as present in Inventory and in property_activities.
router.post('/listings/:ref/archive', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const reason = req.body && req.body.reason
      ? String(req.body.reason).trim().slice(0, 500)
      : `Archived by ${me.name || me.username}`

    const plan = await boardAction.archive({
      propertyId: prop.id,
      agentId: me.id,
      reason,
      oldStatus: prop.available_status || null,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed } = await runPlan(plan)
    if (!changed) return res.status(409).json({ error: `#${prop.ref} is already archived.` })

    log.info('board archive', { ref: prop.ref, by: me.username, from: prop.available_status })
    const told = await boardFeedback.announceStatusChange({
      propertyId: prop.id, ref: prop.ref, kind: 'archived',
      reason, actor: me.username,
    })
    const f = feedbackSummary(told)
    res.json({
      ok: true, ref: prop.ref, availableStatus: 'archived',
      removedFromBoard: true,
      feedback: f,
      message: `#${prop.ref} archived.${feedbackSentence(f)}`,
    })
  } catch (err) {
    log.error('board archive failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/duplicate — clone one real unit, with a new REF ────
router.post('/listings/:ref/duplicate', auth, async (req, res) => {
  const client = await db.connect()
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })
    const unit = String(req.body?.unit || '').trim().slice(0, 80)
    if (!unit) return res.status(400).json({ error: 'Enter the new flat / unit number.' })
    await client.query('BEGIN')
    const src = (await client.query(`SELECT * FROM properties WHERE ref=$1 FOR SHARE`, [req.params.ref])).rows[0]
    if (!src) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Listing not found.' }) }
    if (['rented', 'archived'].includes(src.available_status)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Reactivate the source listing before copying a new available unit.' })
    }
    const ref = await propertyRef.nextRef(client)
    const rootId = src.unit_group_root_id || src.id
    await client.query(`UPDATE properties SET unit_group_root_id=$2 WHERE id=$1 AND unit_group_root_id IS NULL`, [src.id, rootId])
    const copied = (await client.query(
      `INSERT INTO properties
        (ref, owner_id, property_type, town, sub_location, street, apt,
         bedrooms, bathrooms, size_sqm, longlet_price, shortlet, sale_price,
         description, images, published, listed_by_agent_id, available_status,
         available_date, viewing_status, viewing_notes, internal_notes,
         is_exclusive, exclusive_until, completeness_pct, listed_by_phone,
         activity_agent_id, public_payload, no_fb, videos, image_ranking,
         geocoding_precision_tier, priority_class, priority, lifecycle_state,
         system_online, website_manually_hidden, available_until,
         pets_allowed, sharing_allowed, sharing_price, subletting_allowed,
         subletting_price, subletting_considered, subletting_note, has_balcony,
         balcony_size, has_study_room, parking_available, lease_type,
         viewings_allowed, viewing_mode, viewing_tenant_confirmation_required,
         island, category_override, field_provenance, locality_id,
         locality_resolution_status, locality_override, rental_modes,
         feature_tags, feature_tags_locked, unit_group_root_id)
       SELECT $2, owner_id, property_type, town, sub_location, street, $3,
         bedrooms, bathrooms, size_sqm, longlet_price, shortlet, sale_price,
         description, images, published, listed_by_agent_id, 'available',
         available_date, viewing_status, viewing_notes,
         CONCAT_WS(E'\\n', NULLIF(internal_notes,''), $4),
         is_exclusive, exclusive_until, completeness_pct, listed_by_phone,
         activity_agent_id, public_payload, no_fb, videos, image_ranking,
         geocoding_precision_tier, priority_class, priority, 'active',
         system_online, website_manually_hidden, available_until,
         pets_allowed, sharing_allowed, sharing_price, subletting_allowed,
         subletting_price, subletting_considered, subletting_note, has_balcony,
         balcony_size, has_study_room, parking_available, lease_type,
         viewings_allowed, viewing_mode, viewing_tenant_confirmation_required,
         island, category_override, field_provenance, locality_id,
         locality_resolution_status, locality_override, rental_modes,
         feature_tags, feature_tags_locked, $5
        FROM properties WHERE id=$1
       RETURNING id, ref, apt, published`,
      [src.id, ref, unit, `Unit copy of #${src.ref}; created by ${me.username}.`, rootId])).rows[0]
    await client.query(
      `INSERT INTO property_activities(property_id,agent_id,activity_type,details,is_significant)
       VALUES($1,$2,'property_unit_copied',$3::jsonb,TRUE)`,
      [copied.id, me.id, JSON.stringify({ sourcePropertyId: src.id, sourceRef: src.ref, ref, unit, unitGroupRootId: rootId })])
    await client.query('COMMIT')
    if (copied.published) {
      require('../services/websiteSync').syncPropertyToWebsite(copied.id)
        .catch(err => log.warn('unit copy website sync failed', { ref, err: err.message }))
    }
    log.info('board property-unit copied', { sourceRef: src.ref, ref, unit, by: me.username })
    return res.json({ ok: true, id: copied.id, ref, unit, sourceRef: src.ref, message: `Created #${ref} · ${unit}.` })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log.error('board property-unit copy failed', { ref: req.params.ref, err: err.message })
    return res.status(500).json({ error: 'Could not copy this property.' })
  } finally {
    client.release()
  }
})

// ── PATCH /listings/:ref/owner-contact — admin contact controls ────────────
router.patch('/listings/:ref/owner-contact', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })
    const row = (await db.query(
      `SELECT p.id AS property_id,p.owner_id,oc.phone_normalized
         FROM properties p LEFT JOIN owner_contacts oc ON oc.id=p.owner_id
        WHERE p.ref=$1`, [req.params.ref])).rows[0]
    if (!row) return res.status(404).json({ error: 'Listing not found.' })
    if (!row.owner_id) return res.status(409).json({ error: 'This listing has no linked owner.' })
    const action = String(req.body?.action || '')
    const reason = String(req.body?.reason || 'Agency Board admin control').trim().slice(0, 200)
    const gate = require('../services/ownerSendGate')
    if (action === 'block') {
      await db.query(`UPDATE owner_contacts SET do_not_contact=TRUE,do_not_contact_reason=$2,do_not_contact_at=NOW(),updated_at=NOW() WHERE id=$1`, [row.owner_id, reason])
      if (row.phone_normalized) await gate.permanentlyStopOwnerFlow({ phone: row.phone_normalized, reason: `Agency Board: ${reason}` })
    } else if (action === 'unblock') {
      await db.query(`UPDATE owner_contacts SET do_not_contact=FALSE,do_not_contact_reason=NULL,do_not_contact_at=NULL,updated_at=NOW() WHERE id=$1`, [row.owner_id])
      if (row.phone_normalized) await gate.resumeOwnerFlow({ phone: row.phone_normalized, reason: `Agency Board unblock by ${me.username}` })
    } else if (action === 'pause') {
      const until = String(req.body?.until || '')
      const result = await gate.setContactPause({ scope: 'owner', id: row.owner_id, until, note: reason, by: `agent:${me.id}` })
      if (!result.ok) return res.status(400).json({ error: 'Choose a valid pause date.' })
    } else if (action === 'clear_pause') {
      await gate.clearContactPause({ scope: 'owner', id: row.owner_id, by: `agent:${me.id}` })
    } else return res.status(400).json({ error: 'Unknown owner-contact action.' })
    await db.query(
      `INSERT INTO property_activities(property_id,agent_id,activity_type,details,is_significant)
       VALUES($1,$2,'owner_contact_control',$3::jsonb,TRUE)`,
      [row.property_id, me.id, JSON.stringify({ action, reason, until: req.body?.until || null })])
    return res.json({ ok: true, action })
  } catch (err) {
    log.error('board owner-contact control failed', { ref: req.params.ref, err: err.message })
    return res.status(500).json({ error: 'Owner contact control failed.' })
  }
})

// ── DELETE /listings/:ref/duplicate — Kev's explicit request (2026-09-04) ──
// The ONE genuinely destructive action in this file. Every other button
// above is deliberately soft (see this file's own header: "Nothing here
// deletes anything") -- this is the one exception, for exactly the case
// Kev described: a duplicate posting that was never marked and keeps
// annoying other agents. Admin-only (not the same board-wide permission
// as check-out/recheck/archive) precisely because it is irreversible --
// reuses the SAME `DELETE FROM properties` routes/crm.js's own Inventory
// delete already does, not a new deletion path.
router.delete('/listings/:ref/duplicate', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (me.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only — this permanently deletes the listing.' })
    }
    await db.query(`DELETE FROM properties WHERE id=$1`, [prop.id])
    log.info('board duplicate-delete', { ref: prop.ref, by: me.username })
    res.json({ ok: true, ref: prop.ref, message: `#${prop.ref} permanently deleted (duplicate listing).` })
  } catch (err) {
    log.error('board duplicate-delete failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// PHASE 3 ROUTES — AXIS A (rented / back on market) and AXIS B (priority)
//
// Same three-step shape as the buttons above: loadForAction resolves the ref and
// the agent, boardAction builds the SQL, runPlan runs the update and its audit
// row in one transaction. The only thing these add is that two of them are
// public events, so they announce.
// ════════════════════════════════════════════════════════════════════════════

// ── POST /listings/:ref/mark-recently-rented ────────────────────────────────
// The strongest off-market verdict there is. Unpublishes, and the board keeps
// showing it for 48h under ?only_recently_rented=1 so agents see what just went.
router.post('/listings/:ref/mark-recently-rented', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const reason = req.body && req.body.reason
      ? String(req.body.reason).trim().slice(0, 500)
      : `Marked rented by ${me.name || me.username}`

    const plan = await boardAction.markRecentlyRented({
      propertyId: prop.id,
      agentId: me.id,
      reason,
      oldStatus: prop.available_status || null,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed, row } = await runPlan(plan)
    if (!changed) {
      return res.status(409).json({
        error: `#${prop.ref} is archived, or was already marked rented in the last 48h.`,
      })
    }

    log.info('board mark-recently-rented', { ref: prop.ref, by: me.username, from: prop.available_status })

    // Kev's Prompt C, event PROPERTY RENTED — the strongest verdict there
    // is, so this path always invalidates.
    require('../services/matchEngine').invalidateMatchesForProperty(prop.id, 'mark-recently-rented')
      .catch(err => log.warn('board mark-recently-rented: match invalidation failed', { ref: prop.ref, err: err.message }))

    const told = await boardFeedback.announceStatusChange({
      propertyId: prop.id, ref: prop.ref, kind: 'rented',
      reason, actor: me.username,
    })
    const f = feedbackSummary(told)
    res.json({
      ok: true, ref: prop.ref,
      availableStatus: row.available_status,
      recentlyRentedAt: row.recently_rented_at,
      removedFromBoard: true,
      feedback: f,
      message: `#${prop.ref} marked rented — visible under "recently rented" for 48h.${feedbackSentence(f)}`,
    })
  } catch (err) {
    log.error('board mark-recently-rented failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/return-to-market ────────────────────────────────────
// The recovery path, and the only one allowed to talk over rented/archived —
// that is the point of it. Resets to plain 'available', NOT confirmed: nobody
// confirmed anything, so the card stays faint until somebody does.
router.post('/listings/:ref/return-to-market', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const reason = req.body && req.body.reason
      ? String(req.body.reason).trim().slice(0, 500)
      : `Returned to market by ${me.name || me.username}`

    const plan = await boardAction.returnToMarket({
      propertyId: prop.id,
      agentId: me.id,
      reason,
      oldStatus: prop.available_status || null,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed, row } = await runPlan(plan)
    if (!changed) return res.status(409).json({ error: `#${prop.ref} is already available.` })

    log.info('board return-to-market', { ref: prop.ref, by: me.username, from: prop.available_status })
    const told = await boardFeedback.announceStatusChange({
      propertyId: prop.id, ref: prop.ref, kind: 'back_on_market',
      reason, actor: me.username,
    })
    const f = feedbackSummary(told)
    res.json({
      ok: true, ref: prop.ref,
      availableStatus: row.available_status,
      // It comes BACK onto the board, so the browser must re-add it rather than
      // treat this like the three actions that remove a card.
      removedFromBoard: false,
      feedback: f,
      message: `#${prop.ref} is back on the market — availability not confirmed yet.${feedbackSentence(f)}`,
    })
  } catch (err) {
    log.error('board return-to-market failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/priority ────────────────────────────────────────────
// AXIS B. Sets how often the robot re-asks the owner, and nothing else — it
// never touches available_status, so a rented listing can carry a priority for
// when it comes back. No announcement: this is internal rhythm, not news.
router.post('/listings/:ref/priority', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const b = req.body || {}
    const plan = await boardAction.setPriority({
      propertyId: prop.id,
      agentId: me.id,
      priorityClass: b.priorityClass || b.priority_class,
      priority: b.priority,
      changedBy: 'agent',
    })
    if (!plan.ok) return res.status(400).json({ error: plan.reason })

    const { changed, row } = await runPlan(plan)
    if (!changed) return res.status(409).json({ error: `#${prop.ref} — priority unchanged.` })

    log.info('board priority', { ref: prop.ref, by: me.username, cls: plan.priorityClass })
    res.json({
      ok: true, ref: prop.ref,
      priorityClass: row.priority_class,
      priority: row.priority,
      removedFromBoard: false,
      message: `#${prop.ref} priority → ${row.priority_class}` +
               (row.priority ? ` (rank ${row.priority}).` : '.'),
    })
  } catch (err) {
    log.error('board priority failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── GET /review-queue ───────────────────────────────────────────────────────
// Everything at 'pending_check': the listings where the AI read an owner's
// reply and could not tell what it meant, plus anything a human flagged. This
// is the alternative to guessing — an unreadable reply parks the listing here
// instead of silently dropping it off the board or silently leaving it on.
//
// ── the auto-reachout switch (migration 019) ────────────────────────────────
//
// Kev's call 2026-08-16: the >60h robot flow is opt-in and its cadence is a
// setting, not a deploy. Reading is open to every board user — an agent should
// be able to see whether the robot is chasing owners before deciding to chase
// one himself. Changing it is admin-only: it decides how often we message real
// customers, which is not a per-agent preference.
const availabilityReachout = require('../services/availabilityReachout')

router.get('/reachout-settings', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })

    const s = await availabilityReachout.getSchedule()
    const row = await db.query(
      `SELECT updated_at, updated_by FROM reachout_settings WHERE id = 1`)
    const optedOut = await db.query(
      `SELECT COUNT(*)::int AS n FROM properties
        WHERE COALESCE(auto_reachout_opt_out, false) = true`)

    res.json({
      ok: true,
      mode: s.mode,                 // '2d' | '3d' | 'weekly' | 'monthly' | 'never'
      retryDays: s.retryDays,       // null when never
      dailyCap: s.dailyCap,
      enabled: s.enabled,
      // The env flag is an independent second kill switch, and the UI has to
      // say so — otherwise picking "every 3 days" while it is off looks broken.
      envArmed: availabilityReachout.ARMED,
      effective: s.enabled && availabilityReachout.ARMED,
      updatedAt: row.rows[0]?.updated_at || null,
      updatedBy: row.rows[0]?.updated_by || null,
      optedOutCount: optedOut.rows[0].n,
      canEdit: me.role === 'admin',
      options: ['2d', '3d', 'weekly', 'monthly', 'never'],
    })
  } catch (err) {
    log.error('reachout-settings read failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

router.put('/reachout-settings', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    if (me.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change the owner-reachout schedule' })
    }

    const mode = String((req.body && req.body.mode) || '').trim()
    const dailyCap = req.body && req.body.dailyCap != null ? Number(req.body.dailyCap) : null
    if (dailyCap != null && (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 200)) {
      return res.status(400).json({ error: 'dailyCap must be a whole number between 0 and 200' })
    }

    const r = await availabilityReachout.setSchedule({
      mode, dailyCap, updatedBy: me.username || me.email || `agent:${me.id}`,
    })
    if (!r.ok) return res.status(400).json({ error: r.reason })

    const s = await availabilityReachout.getSchedule()
    log.info('board reachout schedule changed', { mode: s.mode, cap: s.dailyCap, by: me.username })
    res.json({
      ok: true, mode: s.mode, retryDays: s.retryDays, dailyCap: s.dailyCap,
      enabled: s.enabled, envArmed: availabilityReachout.ARMED,
      effective: s.enabled && availabilityReachout.ARMED,
      message: s.mode === 'never'
        ? 'The robot will not ask any owner on a schedule.'
        : `The robot will re-ask an owner at most every ${s.retryDays} days, up to ${s.dailyCap} owners a day.`,
    })
  } catch (err) {
    log.error('reachout-settings write failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/reachout-opt-out ────────────────────────────────────
// "Leave THIS owner alone" — the per-listing exception. Built because a global
// switch is the wrong tool for one annoying case: on 2026-08-16 the robot kept
// chasing an owner who had already sent Kev something different from Gozo.
//
// It only silences the ROBOT. An agent clicking "Still on Market?" by hand is
// unaffected: that is a human deciding, in a moment they can see.
//
// Permission: admin, or the agent this listing is attributed to. Silencing the
// robot on a colleague's listing is not yours to decide.
router.post('/listings/:ref/reachout-opt-out', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const mine = prop.listed_by_agent_id != null && prop.listed_by_agent_id === me.id
    if (me.role !== 'admin' && !mine) {
      return res.status(403).json({
        error: `#${prop.ref} is not yours — ask ${prop.agent_name || 'the listing agent'} or an admin`,
      })
    }

    // Absent body → treat as "switch it on", which is the direction the button
    // is pressed in 95% of cases. Explicit false turns it back off.
    const optOut = !(req.body && req.body.optOut === false)
    const reason = req.body && req.body.reason
      ? String(req.body.reason).trim().slice(0, 500) : null

    const upd = await db.query(
      `UPDATE properties
          SET auto_reachout_opt_out    = $2,
              auto_reachout_opt_out_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
              auto_reachout_opt_out_by = CASE WHEN $2 THEN $3::text ELSE NULL END,
              updated_at               = NOW()
        WHERE id = $1
      RETURNING id, ref, auto_reachout_opt_out, auto_reachout_opt_out_at`,
      [prop.id, optOut, me.username || me.email || `agent:${me.id}`])
    if (!upd.rows.length) return res.status(409).json({ error: `#${prop.ref} could not be updated.` })

    // Audited like every other board decision — property_activities keeps
    // old/new inside `details`, it has no columns for them.
    await db.query(
      `INSERT INTO property_activities
         (property_id, agent_id, activity_type, details, is_significant, created_at)
       VALUES ($1, $2, $3, $4::jsonb, TRUE, NOW())`,
      [prop.id, me.id, optOut ? 'reachout_opt_out' : 'reachout_opt_in',
       JSON.stringify({
         source: 'crm_schedule_board',
         changed_by: 'agent',
         auto_reachout_opt_out: optOut,
         reason: reason || (optOut
           ? 'Robot told to stop asking this owner about availability'
           : 'Robot allowed to ask this owner again'),
         timestamp: new Date().toISOString(),
       })])

    log.info('board reachout opt-out', { ref: prop.ref, optOut, by: me.username })
    res.json({
      ok: true, ref: prop.ref, optOut,
      message: optOut
        ? `The robot will stop asking the owner of #${prop.ref}. You can still ask by hand.`
        : `The robot may ask the owner of #${prop.ref} again.`,
    })
  } catch (err) {
    log.error('board reachout opt-out failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// -- POST /listings/:ref/auto-av -----------------------------------------------
// "Arm this ONE listing for the robot to keep asking, on a rhythm I choose" --
// the manual, per-property replacement for the old design where the global
// reachout_settings dial chased every stale listing at once (migration 020,
// 2026-08-18). Kev's own wording maps straight onto the DB enum:
//
//   Never          -> off       (also the column DEFAULT -- untouched means untouched)
//   Every 2nd Day  -> every_2d
//   Every 4 Days   -> every_4d
//   Weekly         -> weekly
//   Monthly        -> monthly   (was "All 2 Weeks" / every_2w until migration 021, 2026-08-18)
//
// Same permission model as reachout-opt-out: admin, or the agent this listing
// is attributed to. Arming the robot to message an owner on a schedule is at
// least as consequential as silencing it, so it gets the same bar.
const AV_RHYTHM_OPTIONS = availabilityReachout.RHYTHM_OPTIONS
const AV_RHYTHM_VALUES = AV_RHYTHM_OPTIONS.map(o => o.value)

router.get('/listings/:ref/auto-av', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })

    const r = await db.query(
      `SELECT ref, av_auto_rhythm, av_auto_rhythm_set_by, av_auto_rhythm_set_at
         FROM properties WHERE LOWER(ref) = LOWER($1)`, [req.params.ref])
    if (!r.rows.length) return res.status(404).json({ error: `#${req.params.ref} not found` })

    res.json({
      ok: true, ref: r.rows[0].ref,
      rhythm: r.rows[0].av_auto_rhythm || 'off',
      setBy: r.rows[0].av_auto_rhythm_set_by,
      setAt: r.rows[0].av_auto_rhythm_set_at,
      options: AV_RHYTHM_OPTIONS,
    })
  } catch (err) {
    log.error('board av auto-rhythm read failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

router.post('/listings/:ref/auto-av', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const mine = prop.listed_by_agent_id != null && prop.listed_by_agent_id === me.id
    if (me.role !== 'admin' && !mine) {
      return res.status(403).json({
        error: `#${prop.ref} is not yours -- ask ${prop.agent_name || 'the listing agent'} or an admin`,
      })
    }

    const rhythm = String((req.body && req.body.rhythm) || '').trim()
    if (!AV_RHYTHM_VALUES.includes(rhythm)) {
      return res.status(400).json({ error: `rhythm must be one of: ${AV_RHYTHM_VALUES.join(', ')}` })
    }

    const setBy = me.username || me.email || `agent:${me.id}`
    const upd = await db.query(
      `UPDATE properties
          SET av_auto_rhythm        = $2,
              av_auto_rhythm_set_by = $3,
              av_auto_rhythm_set_at = NOW(),
              updated_at            = NOW()
        WHERE id = $1
      RETURNING id, ref, av_auto_rhythm, av_auto_rhythm_set_at`,
      [prop.id, rhythm, setBy])
    if (!upd.rows.length) return res.status(409).json({ error: `#${prop.ref} could not be updated.` })

    // Audited like every other board decision -- property_activities keeps
    // old/new inside details, it has no columns for them.
    await db.query(
      `INSERT INTO property_activities
         (property_id, agent_id, activity_type, details, is_significant, created_at)
       VALUES ($1, $2, $3, $4::jsonb, TRUE, NOW())`,
      [prop.id, me.id, 'av_auto_rhythm_changed',
       JSON.stringify({
         source: 'crm_schedule_board',
         changed_by: 'agent',
         av_auto_rhythm: rhythm,
         timestamp: new Date().toISOString(),
       })])

    const label = (AV_RHYTHM_OPTIONS.find(o => o.value === rhythm) || {}).label || rhythm
    log.info('board av auto-rhythm changed', { ref: prop.ref, rhythm, by: me.username })
    res.json({
      ok: true, ref: prop.ref, rhythm, setAt: upd.rows[0].av_auto_rhythm_set_at,
      message: rhythm === 'off'
        ? `The robot will not auto-ask the owner of #${prop.ref} about availability.`
        : `The robot may auto-ask the owner of #${prop.ref} -- ${label}.`,
    })
  } catch (err) {
    log.error('board av auto-rhythm failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// -- POST /listings/:ref/fb-repost ---------------------------------------------
// "This one's been on the market longer than planned, push it again." Kev's
// Schedule Board FB icon (2026-08-18). Runs the SAME fbShareQueue.startRun()
// that "!fbgroups <ref> force" already calls from WhatsApp, 1-5 times,
// staggered one-at-a-time (services/fbRepost.js) — this route only validates,
// authorises and queues; it never touches a browser or a group list itself.
// Same permission bar as auto-av: admin, or the agent this listing belongs to.
router.post('/listings/:ref/fb-repost', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    // Kev, 2026-09-08 (Agent-Command-Cleanup, confirmed decision): admin
    // only — this used to also allow the listing's own agent ("mine"),
    // dropped, not narrowed to a different check. FB reposting is now an
    // admin action full stop, same bar as !fbgroups/!fbstatus/!fbtest/
    // !fbstop on the WhatsApp side (all behind adminCommands.js's own
    // top-level isAdminAccount gate).
    if (me.role !== 'admin') {
      return res.status(403).json({ error: 'Admins only.' })
    }

    const fbRepost = require('../services/fbRepost')
    const count = req.body && req.body.count
    const dryRun = !!(req.body && req.body.dryRun)

    const result = await fbRepost.queueRepost({
      ref: prop.ref, propertyId: prop.id, count, dryRun,
      requestedBy: me.username || me.email || `agent:${me.id}`,
    })
    if (!result.ok) return res.status(400).json({ error: result.error })

    log.info('board fb-repost', { ref: prop.ref, count: result.count, dryRun, by: me.username })
    res.json(result)
  } catch (err) {
    log.error('board fb-repost failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// -- POST /listings/:ref/av-date-confirm -----------------------------------
// The board's small calendar icon next to the € price (Kev, 2026-08-31) — a
// fast manual correction path for when available/viewing dates drift (bot
// misreads or !upload inaccuracies). The board itself saves the two dates
// via the EXISTING PATCH /api/crm/properties/:id (same field the full
// property editor and the € price-edit button already write) BEFORE calling
// this route — this route's only job is the repost: mark the category-group
// posts superseded and re-run the SAME distribution !price/!upload already
// use (handlers/upload.js runCategoryDistribution), then a short "still on
// market" confirmation into each group actually posted to. Nothing here is
// a new pipeline, only a new trigger for the existing one — same shape as
// !price's cmdPrice(). Admin only, no agent/"mine" exception (Kev: "kein
// Agent-Zugriff").
router.post('/listings/:ref/av-date-confirm', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    if (me.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only.' })
    }

    const row = await db.query(
      `SELECT id, ref, available_date, viewing_date, public_payload FROM properties WHERE id = $1`,
      [prop.id]
    )
    const p = row.rows[0]
    if (!p) return res.status(404).json({ error: `Property ${req.params.ref} not found` })
    if (!p.public_payload) {
      return res.status(409).json({ error: `#${p.ref} has no public_payload yet — run !upload for it first.` })
    }

    // Bump created_at, same reason !price does: the board's default "newest"
    // sort is keyed on created_at, so a deliberate date confirmation moves
    // the card back to the top and reads as a fresh listing, exactly like a
    // repost should.
    await db.query(`UPDATE properties SET created_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id])
    await db.query(
      `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
       VALUES ($1, $2, 'available_date_confirmed', $3::jsonb, TRUE)`,
      [p.id, me.id, JSON.stringify({
        source: 'board', command: 'av-date-confirm',
        available_date: p.available_date, viewing_date: p.viewing_date,
        by: me.username || me.email,
      })]
    )

    res.json({ ok: true, message: `#${p.ref} dates confirmed — reposting to its category group now.` })

    // Repost async, same "never block the reply" shape !price uses —
    // category-group sends run 8-15s each and must not hold the HTTP request.
    ;(async () => {
      const waha = require('../waha')
      const config = require('../config')
      const { runCategoryDistribution } = require('../handlers/upload')

      const session = (await waha.pickActiveAdminSession()) || config.waha.session1
      const adminChatId = config.admin.botNumber
      if (!session || !adminChatId) {
        log.warn('av-date-confirm: no admin session/botNumber to repost through', { ref: p.ref })
        return
      }

      await db.query(
        `UPDATE property_publishing_status SET status='superseded', updated_at=NOW()
          WHERE property_id=$1 AND channel='category_groups' AND status='posted'`,
        [p.id]
      )

      const pub = await runCategoryDistribution(session, adminChatId, p.id, p.ref)
      const postedGroups = (pub?.results || []).filter(r => r.status === 'posted')
      if (!postedGroups.length) return

      // Tone: a short, natural confirmation under the repost, not a system
      // message (Kev's explicit instruction).
      const dateLine = p.available_date
        ? `Available from ${new Date(p.available_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`
        : ''
      // STYLE-1 (Kev, 2026-09-04): no em-dash in any outgoing message.
      const followUp = `Just confirming, this one's still on the market. ${dateLine}`.trim()
      for (const g of postedGroups) {
        try {
          await waha.sendText(session, g.group_id, followUp)
        } catch (e) {
          log.warn('av-date-confirm: follow-up send failed', { ref: p.ref, group: g.group_id, err: e.message })
        }
      }
    })().catch(e => {
      log.error('av-date-confirm: async repost crashed', { ref: p.ref, err: e.message })
    })
  } catch (err) {
    log.error('board av-date-confirm failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// Same firewalled projection as the board, so the queue cannot leak what the
// board does not. Oldest doubt first: the queue is meant to be emptied.
router.get('/review-queue', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    // Kev, 2026-09-04: "Needs recheck" is triage for cases the classifier
    // refused to guess -- admin-only now, enforced here (not just the
    // frontend tab being hidden), same "the real gate is here, server-side"
    // rule this file's own create-group route already states.
    if (me.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })

    const r = await db.query(
      `SELECT ${BOARD_COLS} ${BOARD_FROM}
        WHERE p.available_status = 'pending_check'
        ORDER BY p.updated_at ASC NULLS LAST, p.id ASC
        LIMIT 200`)
    const qmap = await questionCountsToday(me.id)
    res.json({
      listings: await withCardFlags(r.rows.map(row => shapeCard(row, me.id, qmap.get(row.id) || 0)), me.id),
      total: r.rows.length,
      me: { id: me.id, name: me.name || me.username, role: me.role },
    })
  } catch (err) {
    log.error('board review-queue failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load the review queue' })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// WATAG — the "." forwarding anchor
//
// Two ways in, one service. services/waTag.js owns the ceiling, the one-account
// rule and the quote-or-nothing rule; these handlers resolve refs and shape the
// HTTP answer, exactly like the availability buttons above delegate to
// boardAction.
//
// FIREWALL: the tag is a single "." — no address, no owner, no price. There is
// nothing in it to leak, and the message it points AT is the listing post that
// was already sanitised by sanitizeForPublic before it was ever put in a group.
// ════════════════════════════════════════════════════════════════════════════

// ── POST /listings/:ref/watag ───────────────────────────────────────────────
// One listing, from its own card.
router.post('/listings/:ref/watag', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (blockFutureAction(res, prop, me, 'Property Chat sharing')) return

    // A tag is an invitation to forward this listing to somebody. Doing that on
    // a flat that is gone is worse than doing nothing — the agent forwards it,
    // a client asks about it, and the answer is "sorry, that went last week".
    // The board's active filter hides these, but the Favourites tab does NOT
    // (a booked viewing on a listing that just went off-market is exactly what
    // an agent must keep seeing), so the guard has to live on the route.
    const locked = lockedReason(prop.available_status)
    if (locked) {
      return res.status(409).json({
        ok: false, ref: prop.ref, status: 'locked',
        error: `#${prop.ref} is ${locked} Tagging it would invite somebody to forward it.`,
      })
    }

    const session = await waTag.pickSession()
    const r = await waTag.tagOne({
      propertyId: prop.id, ref: prop.ref, agentId: me.id, session })

    // 'no_anchor' is a real, permanent answer about this listing, not a
    // transient failure — 409 so the browser can say so in place rather than
    // showing a red error the agent will retry forever.
    if (r.status === 'no_anchor') {
      return res.status(409).json({
        ok: false, ref: prop.ref, status: r.status,
        error: `#${prop.ref} was never posted to a group we kept the message id for — there is nothing to anchor to.`,
      })
    }
    // The listing HAS a stored message id, but no account still holds that
    // message, so nothing could be anchored to it and nothing was sent. A
    // different answer from no_anchor, and from a transient failure: clicking
    // again will not fix it.
    if (r.status === 'no_quote') {
      return res.status(409).json({
        ok: false, ref: prop.ref, status: r.status,
        error: `None of our WhatsApp accounts still has the original message for #${prop.ref}, so the "." had nothing to point at. Nothing was sent.`,
      })
    }
    if (r.status === 'no_session') {
      return res.status(503).json({
        ok: false, ref: prop.ref, status: r.status,
        error: 'No WhatsApp account is connected right now, so the tag was not sent.',
      })
    }
    if (r.status === 'failed') {
      return res.status(502).json({
        ok: false, ref: prop.ref, status: r.status,
        error: `WhatsApp refused the reply in ${r.groups === 1 ? 'the group' : 'all ' + r.groups + ' groups'}.`,
      })
    }

    log.info('board watag single', { ref: prop.ref, by: me.username, ...r })
    res.json({
      ok: true, ref: prop.ref, status: r.status,
      groups: r.groups, tagged: r.tagged, session,
      message: r.status === 'duplicate'
        ? `#${prop.ref} was tagged a moment ago.`
        : `#${prop.ref} tagged — ${r.message.toLowerCase()}`,
    })
  } catch (err) {
    log.error('board watag failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /watag ─────────────────────────────────────────────────────────────
// The multi-select from the toolbar. Body: { refs: ["2906-001", ...] }.
//
// THE CEILING IS ENFORCED HERE, not only in the browser. Fifteen is Kev's
// anti-spam number and a UI-only limit is not a limit — a stale tab, a replayed
// request or a second board open in another window would all walk straight past
// it. Over fifteen, the tail is dropped and named in `skipped` so the agent is
// told exactly which listings did not go out and can pick again.
router.post('/watag', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })

    const refs = Array.isArray(req.body?.refs)
      ? req.body.refs.map(x => String(x || '').trim()).filter(Boolean)
      : []
    if (!refs.length) return res.status(400).json({ error: 'Pick at least one listing.' })

    // Resolve refs → ids, and keep the AGENT'S order. A plain `= ANY()` comes
    // back in whatever order Postgres feels like, and with a ceiling of 15 the
    // order decides which listings are dropped — so "the first fifteen" has to
    // mean the first fifteen the agent picked, not the first fifteen on disk.
    const r = await db.query(
      `SELECT id, ref, available_status FROM properties WHERE LOWER(ref) = ANY($1::text[])`,
      [refs.map(x => x.toLowerCase())])
    const byRef = new Map(r.rows.map(row => [String(row.ref).toLowerCase(), row]))
    const ordered = []
    const unknown = []
    const locked  = []
    for (const ref of refs) {
      const hit = byRef.get(ref.toLowerCase())
      if (!hit) { unknown.push(ref); continue }
      // Same guard as the single route: never invite anybody to forward a flat
      // that is already gone. Dropped BEFORE the ceiling is applied, so a
      // rented listing in the selection does not eat one of the fifteen.
      if (lockedReason(hit.available_status)) { locked.push(hit.ref); continue }
      ordered.push({ id: hit.id, ref: hit.ref })
    }
    if (!ordered.length) {
      return res.status(404).json({
        error: locked.length
          ? 'Every listing you picked is off the market.'
          : 'None of those listings exist.',
        unknown, locked,
      })
    }

    const out = await waTag.tagMany({ properties: ordered, agentId: me.id })
    log.info('board watag bulk', {
      by: me.username, requested: refs.length, tagged: out.tagged,
      skipped: out.skipped.length, session: out.session })

    res.json({
      ok: true,
      max: out.max,
      requested: refs.length,
      tagged: out.tagged,
      session: out.session,
      results: out.results.map(x => ({
        ref: x.ref, status: x.status, groups: x.groups, tagged: x.tagged, message: x.message })),
      // Named, not counted: the agent has to know WHICH ones to pick next.
      skipped: out.skipped,
      unknown,
      locked,
      message: out.summary
        + (locked.length  ? ` ${locked.length} off the market.` : '')
        + (unknown.length ? ` ${unknown.length} ref${unknown.length === 1 ? '' : 's'} not found.` : ''),
    })
  } catch (err) {
    log.error('board watag bulk failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// @AGENTTAG — request a card in your own group, no direct message to Kev
//
// Same shape as WATag (pick box, toolbar button, single-card button) but a
// different payload and a different destination: instead of a "." anchored
// into a shared category group, it sends ONE photo + description into the
// REQUESTING AGENT'S OWN workspace group (agent_workspace_config), and logs a
// row Kev's dashboard can list. Built for agents who don't want it visible
// that they're asking Kev about a listing — the request never touches a chat
// with Kev's own number.
// ════════════════════════════════════════════════════════════════════════════

const AGENTTAG_MAX = 15

// ── POST /listings/:ref/agenttag ────────────────────────────────────────────
router.post('/listings/:ref/agenttag', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    // Kev, 2026-09-08 (Agent-Command-Cleanup, confirmed decision): admin
    // only — was open to any active agent (only `auth`/loadForAction,
    // no role check at all).
    if (me.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })

    const locked = lockedReason(prop.available_status)
    if (locked) {
      return res.status(409).json({
        ok: false, ref: prop.ref, status: 'locked',
        error: `#${prop.ref} is ${locked}`,
      })
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null
    const r = await agentApartmentRequest.requestOne({
      agentId: me.id, agentName: me.name || me.username, propertyId: prop.id, note })

    if (r.status === 'no_group_configured') {
      return res.status(409).json({ ok: false, ref: prop.ref, status: r.status, error: r.message })
    }
    if (r.status === 'no_session') {
      return res.status(503).json({ ok: false, ref: prop.ref, status: r.status, error: r.message })
    }
    if (r.status === 'failed') {
      return res.status(502).json({ ok: false, ref: prop.ref, status: r.status, error: r.message })
    }

    log.info('board agenttag single', { ref: prop.ref, by: me.username, requestId: r.requestId })
    res.json({ ok: true, ref: prop.ref, status: r.status, message: r.message })
  } catch (err) {
    log.error('board agenttag failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /agenttag ───────────────────────────────────────────────────────────
// Body: { refs: ["2906-001", ...], note?: string }. Same ceiling convention
// as /watag — enforced here, not only in the browser.
router.post('/agenttag', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    // Kev, 2026-09-08 (Agent-Command-Cleanup, confirmed decision): admin
    // only, same bar as the per-listing route above.
    if (me.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })

    const refs = Array.isArray(req.body?.refs)
      ? req.body.refs.map(x => String(x || '').trim()).filter(Boolean)
      : []
    if (!refs.length) return res.status(400).json({ error: 'Pick at least one listing.' })
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null

    const r = await db.query(
      `SELECT id, ref, available_status FROM properties WHERE LOWER(ref) = ANY($1::text[])`,
      [refs.map(x => x.toLowerCase())])
    const byRef = new Map(r.rows.map(row => [String(row.ref).toLowerCase(), row]))
    const ordered = []
    const unknown = []
    const locked = []
    for (const ref of refs) {
      const hit = byRef.get(ref.toLowerCase())
      if (!hit) { unknown.push(ref); continue }
      if (lockedReason(hit.available_status)) { locked.push(hit.ref); continue }
      ordered.push(hit)
    }
    const skipped = ordered.length > AGENTTAG_MAX ? ordered.slice(AGENTTAG_MAX).map(x => x.ref) : []
    const capped = ordered.slice(0, AGENTTAG_MAX)

    if (!capped.length) {
      return res.status(404).json({
        error: locked.length ? 'Every listing you picked is off the market.' : 'None of those listings exist.',
        unknown, locked,
      })
    }

    const out = await agentApartmentRequest.requestMany({
      agentId: me.id, agentName: me.name || me.username, properties: capped, note })
    log.info('board agenttag bulk', { by: me.username, requested: refs.length, sent: out.sent })

    res.json({
      ok: true,
      max: AGENTTAG_MAX,
      requested: refs.length,
      sent: out.sent,
      results: out.results,
      skipped, unknown, locked,
      message: `${out.sent} of ${capped.length} sent to your group.`
        + (locked.length ? ` ${locked.length} off the market.` : '')
        + (unknown.length ? ` ${unknown.length} ref${unknown.length === 1 ? '' : 's'} not found.` : '')
        + (skipped.length ? ` ${skipped.length} over the ${AGENTTAG_MAX} limit — send these, then pick the rest.` : ''),
    })
  } catch (err) {
    log.error('board agenttag bulk failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── GET /agent-requests ──────────────────────────────────────────────────────
// Kev's dashboard: every open @Agenttag request, grouped by agent. Admin only —
// the whole point is that the requesting agent's identity stays off WhatsApp,
// so it should not leak to other board agents either.
router.get('/agent-requests', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
    const groups = await agentApartmentRequest.listOpenRequests()
    res.json({ groups })
  } catch (err) {
    log.error('board agent-requests failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /agent-requests/:id/done ───────────────────────────────────────────
router.post('/agent-requests/:id/done', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
    const row = await agentApartmentRequest.markHandled(parseInt(req.params.id, 10), me.username)
    if (!row) return res.status(404).json({ error: 'Not found or already handled' })
    res.json({ ok: true })
  } catch (err) {
    log.error('board agent-requests done failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// FAVOURITES
//
// The list of listings this agent has a viewing on. Written automatically by
// the Book handler above; agent_favourites is the same table the Inventory
// CRM's star uses (routes/crm.js), so the two surfaces cannot drift apart.
//
// Separate from WATag on purpose: tagged = "I want to pass this on",
// favourite = "I am taking somebody to see this".
// ════════════════════════════════════════════════════════════════════════════

// ── GET /favourites ─────────────────────────────────────────────────────────
// Same firewalled projection as the board — this is the board, filtered to one
// agent's list, so it must not answer with one byte more than the grid does.
//
// NO active-status filter, deliberately. A booked viewing on a listing that has
// since gone off-market is exactly the thing an agent must not stop seeing: the
// viewing is still in the diary and somebody has to be told it is off. The card
// carries its own status dot, so an OFF_MARKET favourite reads as what it is.
router.get('/favourites', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })

    const params = [me.id]
    const where = ['TRUE']
    appendFavouriteCoreFilters(req.query, params, where)
    appendWorkspaceBoardFilters(req.query, me, params, where, req.agent.aud !== 'board' && me.role !== 'board')
    const r = await db.query(
      `SELECT ${BOARD_COLS}, f.created_at AS favourited_at ${BOARD_FROM}
         JOIN agent_favourites f ON f.property_id = p.id AND f.agent_id = $1
        WHERE ${where.join(' AND ')}
        ORDER BY f.created_at DESC, p.id DESC
        LIMIT 300`, params)

    // The viewings behind them, so a favourite can say WHY it is one. One query
    // for the page rather than one per card. Only this agent's own viewings —
    // who else is taking clients where is not on this router's menu.
    const ids = r.rows.map(x => x.id)
    const vmap = new Map()
    if (ids.length) {
      const v = await db.query(
        `SELECT DISTINCT ON (property_id)
                property_id, id, viewing_date, viewing_time, status,
                owner_survey_status, proposed_date, proposed_time, viewing_group_jid
           FROM property_viewings
          WHERE property_id = ANY($1::int[])
            AND (viewing_agent_id = $2 OR user_id = $2)
            AND status IN ('pending', 'confirmed')
          ORDER BY property_id, viewing_date ASC, id ASC`, [ids, me.id])
      for (const row of v.rows) {
        vmap.set(row.property_id, {
          id: row.id,
          date: row.viewing_date,
          time: row.viewing_time || null,
          status: row.status,
          // Phase 2 (Kev, 2026-08-27): drives the Create Group unlock —
          // canCreateGroup is true only once the owner has actually said
          // yes AND no group has been made for this viewing yet.
          ownerSurveyStatus: row.owner_survey_status || null,
          proposedDate: row.proposed_date || null,
          proposedTime: row.proposed_time || null,
          groupJid: row.viewing_group_jid || null,
          canCreateGroup: row.status === 'confirmed' && !row.viewing_group_jid,
        })
      }
    }

    const qmap  = await questionCountsToday(me.id)
    const cards = await withCardFlags(r.rows.map(row => {
      const card = shapeCard(row, me.id, qmap.get(row.id) || 0)
      card.favouritedAt = row.favourited_at || null
      card.viewing = vmap.get(row.id) || null
      return card
    }), me.id)

    res.json({
      listings: cards,
      total: cards.length,
      me: { id: me.id, name: me.name || me.username, role: me.role },
    })
  } catch (err) {
    log.error('board favourites failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load favourites' })
  }
})

// ── DELETE /listings/:ref/favourite ─────────────────────────────────────────
// Take one off the list. Favourites fill up by themselves, so there has to be a
// way to empty them or the tab stops being a worklist within a month.
//
// It removes the BOOKMARK and nothing else — the viewing, the client and the
// listing are all untouched. Only ever this agent's own row.
router.delete('/listings/:ref/favourite', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    const r = await db.query(
      `DELETE FROM agent_favourites WHERE agent_id = $1 AND property_id = $2`,
      [me.id, prop.id])
    res.json({
      ok: true, ref: prop.ref, removed: r.rowCount > 0,
      message: r.rowCount > 0
        ? `#${prop.ref} removed from your Favourites. The viewing is untouched.`
        : `#${prop.ref} was not in your Favourites.`,
    })
  } catch (err) {
    log.error('board favourite delete failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/favourite ───────────────────────────────────────────
// The manual counterpart. Booking is what normally fills this list, but an
// agent who has just spent ten minutes finding a flat should be able to keep it
// without booking a viewing on it first.
router.post('/listings/:ref/favourite', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    await db.query(
      `INSERT INTO agent_favourites (agent_id, property_id) VALUES ($1, $2)
       ON CONFLICT (agent_id, property_id) DO NOTHING`, [me.id, prop.id])
    res.json({ ok: true, ref: prop.ref, message: `#${prop.ref} saved to your Favourites.` })
  } catch (err) {
    log.error('board favourite add failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /listings/:ref/hot — global Hot Property (migration 031) ──────────
// The star's 3rd-click-away stage on top of the existing Favourite above:
// Normal -> Favourite (agent_favourites, unchanged) -> Hot (here) -> Normal.
// Admin-only, checked server-side — the frontend hiding the option for a
// board agent is not the gate, this status check is. Highlighted + sorted
// first for EVERY agent (see the is_hot_property DESC sort above), unlike a
// favourite which only the agent who set it ever sees.
router.post('/listings/:ref/hot', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    if (me.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can mark a property Hot.' })
    }

    const r = await db.query(
      `UPDATE properties
          SET is_hot_property = TRUE, is_hot_property_by = $2, is_hot_property_at = NOW()
        WHERE id = $1
      RETURNING is_hot_property_at`, [prop.id, me.id])

    log.info('board hot set', { ref: prop.ref, by: me.username })
    res.json({
      ok: true, ref: prop.ref, isHotProperty: true,
      hotSince: r.rows[0].is_hot_property_at,
      message: `#${prop.ref} is now a HOT property — highlighted for everyone.`,
    })
  } catch (err) {
    log.error('board hot add failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /listings/:ref/hot ────────────────────────────────────────────────
// The cycle's 3rd click, back to Normal. Clears the global flag AND the
// acting admin's own favourite row on this listing — a 3-click reset has to
// land on the true Normal step (0), not silently back on step 1 (Favourite)
// underneath it. Only ever the CALLING admin's favourite row; nobody else's.
router.delete('/listings/:ref/hot', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded

    if (me.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can clear a Hot property.' })
    }

    await db.query(
      `UPDATE properties
          SET is_hot_property = FALSE, is_hot_property_by = NULL, is_hot_property_at = NULL
        WHERE id = $1`, [prop.id])
    await db.query(
      `DELETE FROM agent_favourites WHERE agent_id = $1 AND property_id = $2`, [me.id, prop.id])

    log.info('board hot cleared', { ref: prop.ref, by: me.username })
    res.json({ ok: true, ref: prop.ref, isHotProperty: false, message: `#${prop.ref} is no longer Hot.` })
  } catch (err) {
    log.error('board hot delete failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// ── GET /agents ─────────────────────────────────────────────────────────────
// For the Book form's agent picker. Names only — no phones, no emails.
router.get('/agents', auth, async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT id, COALESCE(alias, name, username) AS name, color_hex
         FROM agents WHERE active = TRUE ORDER BY display_order, name`)
    res.json({ agents: r.rows })
  } catch (err) {
    log.error('board agents failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load agents' })
  }
})

// ── availability-answer notifications ───────────────────────────────────────
// The website half of the notify (2026-08-19). services/availability.js:
// notifyOpenRequesters already sends the WhatsApp DM + photo for a website
// request (migration 022's requester_agent_id is how it knows who asked);
// this is the same answers, surfaced as a toast/badge on the board instead of
// a full request-tracking inbox — that inbox is separate, later work.
const NOTIFICATION_STATUS_LABEL = {
  replied_available: 'Now available for viewings',
  replied_no:         'Rented',
  closed_off_market:  'Off the board',
}

// ── GET /notifications ───────────────────────────────────────────────────────
// Answered-but-not-yet-seen requests for the logged-in agent. Same firewall
// as the rest of this file: ref/town/beds/price/photo only, no owner data.
router.get('/notifications', auth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.status, c.notified_at, p.ref, p.town, p.bedrooms,
              p.longlet_price, p.sale_price,
              p.public_payload->'images'->>0 AS image_url
         FROM availability_checks c
         JOIN properties p ON p.id = c.property_id
        WHERE c.requester_agent_id = $1
          AND c.notified_at IS NOT NULL
          AND c.agent_seen_at IS NULL
        ORDER BY c.notified_at DESC
        LIMIT 20`, [req.agent.id])
    const notifications = r.rows.map(row => ({
      id: row.id,
      ref: row.ref,
      town: row.town,
      beds: row.bedrooms,
      price: row.longlet_price || row.sale_price || null,
      image: row.image_url || null,
      status: row.status,
      statusLabel: NOTIFICATION_STATUS_LABEL[row.status] || 'Answered',
      notifiedAt: row.notified_at,
    }))
    // Booking alerts (acceptance pass 2026-09-24): an owner changed/withdrew
    // the window one of MY bookings sits in. The booking is never moved; this
    // is how the agent finds out. id is 'b-<viewingId>' for the seen route.
    try {
      const b = await db.query(
        `SELECT pv.id, pv.attention_reason, pv.attention_at, pv.starts_at, p.ref, p.town, p.bedrooms,
                p.longlet_price, p.sale_price, p.public_payload->'images'->>0 AS image_url
           FROM property_viewings pv JOIN properties p ON p.id = pv.property_id
          WHERE (pv.viewing_agent_id = $1 OR pv.user_id = $1)
            AND pv.attention_reason IS NOT NULL AND pv.attention_seen_at IS NULL
            AND pv.status IN ('pending','confirmed')
          ORDER BY pv.attention_at DESC LIMIT 20`, [req.agent.id])
      for (const row of b.rows) {
        notifications.push({
          id: `b-${row.id}`, kind: 'booking_attention', ref: row.ref, town: row.town, beds: row.bedrooms,
          price: row.longlet_price || row.sale_price || null, image: row.image_url || null,
          status: 'booking_attention', statusLabel: '⚠ Viewing time changed',
          detail: row.attention_reason, bookingId: row.id, startsAt: row.starts_at, notifiedAt: row.attention_at,
        })
      }
      notifications.sort((x, y) => new Date(y.notifiedAt) - new Date(x.notifiedAt))
    } catch (err) { log.warn('board booking alerts failed', { err: err.message }) }
    try {
      const l = await db.query(
        `SELECT n.id,n.status_label,n.detail,n.notified_at,p.ref,p.town,p.bedrooms,
                p.longlet_price,p.sale_price,p.public_payload->'images'->>0 AS image_url
           FROM agent_listing_notifications n JOIN properties p ON p.id=n.property_id
          WHERE n.agent_id=$1 AND n.seen_at IS NULL
          ORDER BY n.notified_at DESC LIMIT 20`, [req.agent.id])
      for (const row of l.rows) notifications.push({
        id: `l-${row.id}`, kind: 'request_on_your_listing', ref: row.ref, town: row.town,
        beds: row.bedrooms, price: row.longlet_price || row.sale_price || null,
        image: row.image_url || null, status: 'request_on_your_listing',
        statusLabel: row.status_label, detail: row.detail, notifiedAt: row.notified_at,
      })
      notifications.sort((x,y)=>new Date(y.notifiedAt)-new Date(x.notifiedAt))
    } catch (err) { log.warn('board listing notifications failed', { err: err.message }) }
    res.json({ notifications })
  } catch (err) {
    log.error('board notifications failed', { err: err.message })
    res.status(500).json({ error: 'Failed to load notifications' })
  }
})

// ── POST /notifications/:id/seen ────────────────────────────────────────────
// Scoped to the caller's own agent id — an agent can only dismiss their own
// notification, never guess another agent's row id into silence.
router.post('/notifications/:id/seen', auth, async (req, res) => {
  try {
    if (/^l-\d+$/.test(String(req.params.id))) {
      const r = await db.query(
        `UPDATE agent_listing_notifications SET seen_at=NOW()
          WHERE id=$1 AND agent_id=$2 AND seen_at IS NULL RETURNING id`,
        [Number(String(req.params.id).slice(2)), req.agent.id])
      return res.json({ ok:true, seen:r.rows.length>0 })
    }
    if (/^b-\d+$/.test(String(req.params.id))) {
      const r = await db.query(
        `UPDATE property_viewings SET attention_seen_at = NOW()
          WHERE id = $1 AND (viewing_agent_id = $2 OR user_id = $2) AND attention_seen_at IS NULL
          RETURNING id`, [Number(String(req.params.id).slice(2)), req.agent.id])
      return res.json({ ok: true, seen: r.rows.length > 0 })
    }
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
    const r = await db.query(
      `UPDATE availability_checks SET agent_seen_at = NOW()
        WHERE id = $1 AND requester_agent_id = $2 AND agent_seen_at IS NULL
        RETURNING id`, [id, req.agent.id])
    res.json({ ok: true, seen: r.rows.length > 0 })
  } catch (err) {
    log.error('board notification seen failed', { err: err.message, id: req.params.id })
    res.status(500).json({ error: 'Failed to mark notification seen' })
  }
})

// ============================================================================
// SWIPE BOARDS — agent-authenticated half (Kev, 2026-08-29). Pick listings,
// get a shareable link, see who liked what and the outcome. The public
// swipe/like traffic itself is served by routes/swipe.js (unauthenticated,
// rate-limited) — a like there calls the exact same requestOwnerAvailability
// / listingAgentNotify paths this router's own "Request Availability" button
// uses above, so this section adds no new owner-contact machinery.
// ============================================================================
const shareLinks = require('../services/shareLinks')

// POST /swipe-links  { refs: string[], title?, mode? } -> { mode:'collected', id, url, count }
//                                                        | { mode:'multiple', links: [{ref,id,url}] }
// Kev, 2026-09-01: creation itself moved into services/shareLinks.js
// (createClientSwipeLink) so services/matchEngine.js's `!match` command can
// produce the exact same MatchingSwipeLink without a second copy of this
// INSERT pair drifting out of sync with this one. This route now only owns
// auth + ref->id resolution (order preserved, same as before).
//
// Kev, 2026-09-10: two multi-select modes. "Collected" (default, unchanged
// behaviour) bundles every picked listing into ONE deck link. "Multiple"
// instead returns one persistent single-property link per listing (the same
// ones getOrCreatePropertyLink already hands out one at a time via the board's
// own Copy button) — so he can send 5 individual links instead of one deck.
router.post('/swipe-links', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    const refs = Array.isArray(req.body?.refs)
      ? [...new Set(req.body.refs.map(r => String(r).trim()).filter(Boolean))] : []
    if (!refs.length) return res.status(400).json({ error: 'Pick at least one listing.' })
    if (refs.length > 40) return res.status(400).json({ error: 'Max 40 listings per link.' })
    const mode = req.body?.mode === 'multiple' ? 'multiple' : 'collected'

    const found = (await db.query(
      `SELECT id, ref FROM properties WHERE LOWER(ref) = ANY($1::text[])`,
      [refs.map(r => r.toLowerCase())])).rows
    if (!found.length) return res.status(400).json({ error: 'None of those refs were found.' })

    const byRefLower = new Map(found.map(p => [p.ref.toLowerCase(), p]))

    if (mode === 'multiple') {
      const links = []
      for (const ref of refs) {
        const p = byRefLower.get(ref.toLowerCase())
        if (!p) continue
        try {
          const link = await shareLinks.getOrCreatePropertyLink(p.id)
          links.push({ ref: p.ref, id: link.id, url: link.url })
        } catch (err) {
          log.error('swipe-links multiple: per-property link failed', { ref: p.ref, err: err.message })
          links.push({ ref: p.ref, error: 'failed' })
        }
      }
      log.info('swipe-link created (multiple)', { agentId: me.id, count: links.length })
      return res.json({ mode: 'multiple', links })
    }

    const orderedIds = refs.map(ref => byRefLower.get(ref.toLowerCase())?.id).filter(Boolean)

    const link = await shareLinks.createClientSwipeLink({
      propertyIds: orderedIds, agentId: me.id,
      title: req.body?.title ? String(req.body.title).slice(0, 200) : null,
    })
    if (link.error) return res.status(400).json({ error: link.error })
    log.info('swipe-link created', { id: link.id, agentId: me.id, count: link.count })
    res.json({ mode: 'collected', id: link.id, url: link.url, count: link.count })
  } catch (err) {
    log.error('swipe-links create failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// GET /swipe-links — every link THIS agent made, newest first, with counts
router.get('/swipe-links', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me) return res.status(401).json({ error: 'Account inactive' })
    const r = await db.query(
      `SELECT sl.id, sl.title, sl.created_at, sl.active,
              COUNT(DISTINCT p.id)::int AS property_count,
              COUNT(DISTINCT sk.id) FILTER (WHERE sk.kind = 'like')::int AS like_count,
              COUNT(DISTINCT sk.id) FILTER (WHERE sk.kind = 'favourite')::int AS favourite_count,
              COUNT(DISTINCT sk.visitor_id)::int AS visitor_count,
              COALESCE(BOOL_OR((p.lease_type = 'winter_let' OR 'winter_let' = ANY(COALESCE(p.rental_modes, '{}'::text[])) OR p.available_until IS NOT NULL)) FILTER (WHERE p.id IS NOT NULL), FALSE) AS has_winter,
              COALESCE(BOOL_OR((p.sale_price IS NOT NULL AND p.sale_price > 0)) FILTER (WHERE p.id IS NOT NULL), FALSE) AS has_sale,
              COALESCE(BOOL_OR(('long_let' = ANY(COALESCE(p.rental_modes, ARRAY[COALESCE(p.lease_type, CASE WHEN p.shortlet THEN 'short_let' ELSE 'long_let' END)])))) FILTER (WHERE p.id IS NOT NULL), FALSE) AS has_longlet,
              MAX(p.available_until) FILTER (WHERE p.lease_type = 'winter_let' OR 'winter_let' = ANY(COALESCE(p.rental_modes, '{}'::text[])) OR p.available_until IS NOT NULL) AS winter_until
         FROM swipe_links sl
         LEFT JOIN swipe_link_properties slp ON slp.link_id = sl.id
         LEFT JOIN properties p ON p.id = COALESCE(slp.property_id, sl.property_id)
         LEFT JOIN swipe_likes sk ON sk.link_id = sl.id
        WHERE sl.agent_id = $1
        GROUP BY sl.id
        ORDER BY sl.created_at DESC`, [me.id])
    res.json({ links: r.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /swipe-links/:id — one link's listings + who liked what (own links only)
router.get('/swipe-links/:id', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me) return res.status(401).json({ error: 'Account inactive' })
    const link = (await db.query(`SELECT * FROM swipe_links WHERE id = $1`, [req.params.id])).rows[0]
    if (!link || link.agent_id !== me.id) return res.status(404).json({ error: 'Not found' })

    const properties = (await db.query(
      `SELECT p.id, p.ref, p.town, p.sub_location, p.bedrooms, p.longlet_price, p.sale_price,
              p.lease_type, p.rental_modes, p.available_until,
              slp.position
         FROM swipe_link_properties slp JOIN properties p ON p.id = slp.property_id
        WHERE slp.link_id = $1 ORDER BY slp.position`, [link.id])).rows

    // kind: 'favourite' (star) ranks above 'like' (heart) in the agent's
    // list — Kev, 2026-08-29 — so favourites sort first, newest-first within
    // each.
    const likes = (await db.query(
      `SELECT sk.property_id, sk.visitor_id, sk.liked_at, sk.kind, sk.av_status, sk.av_message,
              v.contact_name, v.contact_phone
         FROM swipe_likes sk
         LEFT JOIN swipe_visitors v ON v.id = sk.visitor_id AND v.link_id = sk.link_id
        WHERE sk.link_id = $1
        ORDER BY (sk.kind = 'favourite') DESC, sk.liked_at DESC`, [link.id])).rows

    res.json({
      id: link.id, title: link.title, createdAt: link.created_at, active: link.active,
      url: `https://www.2906.estate/swipe/${link.id}`,
      properties, likes,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /swipe-links/:id  { active: boolean } — pause / reactivate
router.patch('/swipe-links/:id', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me) return res.status(401).json({ error: 'Account inactive' })
    const link = (await db.query(`SELECT agent_id FROM swipe_links WHERE id = $1`, [req.params.id])).rows[0]
    if (!link || link.agent_id !== me.id) return res.status(404).json({ error: 'Not found' })
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' })
    await db.query(`UPDATE swipe_links SET active = $1 WHERE id = $2`, [req.body.active, req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /property-link/:ref — the ONE persistent share link for a property.
// Kev's Prompt A (2026-08-29): normally auto-created the moment an agent
// flips "Published (LIVE)" (routes/crm.js's publish hook). This endpoint is
// the fallback for the 15k+ properties that were published before this
// feature existed — get-or-create, idempotent, same link every time. Any
// authenticated agent may fetch it (it is meant to be reused everywhere,
// not owned by whoever happens to ask first).
router.get('/property-link/:ref', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me) return res.status(401).json({ error: 'Account inactive' })
    const prop = (await db.query(
      `SELECT id FROM properties WHERE LOWER(ref) = LOWER($1)`, [req.params.ref])).rows[0]
    if (!prop) return res.status(404).json({ error: 'Not found' })
    // Kev, 2026-09-01 (explicit instruction, supersedes the 08-31 published
    // gate that stood here): a property-kind swipe link is deliberately
    // "unlisted" -- independent of the site's own publish flag. Creating/
    // copying the link is what makes it live; shareLinks.computePropertyLinkState()
    // no longer requires `published` at all, only real availability.
    const link = await shareLinks.getOrCreatePropertyLink(prop.id)
    res.json(link)
  } catch (err) {
    log.error('property-link get-or-create failed', { ref: req.params.ref, err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ============================================================================
// MATCH — Property -> Clients (Kev's Prompt B, 2026-08-29). Same engine as
// Client -> Properties (services/matchEngine.js), other direction. Pure
// read: no property_matches row is written, no admin notification fires —
// re-opening a property's match panel five times in a row is free. The
// persisting/notifying path (matchPropertyToClients) stays reserved for the
// automatic queue trigger in services/matcher.js.
// ============================================================================

// GET /property-matches/:ref — the strongest active clients for one listing.
router.get('/property-matches/:ref', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me) return res.status(401).json({ error: 'Account inactive' })
    const prop = (await db.query(
      `SELECT id, ref FROM properties WHERE LOWER(ref) = LOWER($1)`, [req.params.ref])).rows[0]
    if (!prop) return res.status(404).json({ error: 'Not found' })

    const matchEngine = require('../services/matchEngine')
    const { property, matches } = await matchEngine.computePropertyMatches(prop.id)
    if (!property) return res.status(400).json({ error: 'Property is not published/available — nothing to match against.' })

    res.json({
      ref: property.ref,
      matches: matches.map(m => ({
        clientId: m.client.id,
        clientName: m.client.name || 'Unknown',
        clientPhone: m.client.phone || null,
        leadAgent: m.client.lead_agent || null,
        score: m.score,
        reasons: m.reasons,
      })),
    })
  } catch (err) {
    log.error('property-matches failed', { ref: req.params.ref, err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// BOOKING ENGINE (Kev, 2026-09-23) — Calendly-style slots, every agent.
// Owner Conversation → Fact Update → Viewing Window → Booking Slots →
// Agent/Client Booking → Schedule Board / Calendars.
// services/bookingEngine.js (slots/bookings/ICS), services/viewingWindows.js
// (owner-confirmed windows), services/calendarSync.js (external calendars).
// ════════════════════════════════════════════════════════════════════════════
const PUBLIC_CRM_URL = (process.env.PUBLIC_CRM_URL || 'https://crm.2906.estate').replace(/\/$/, '')
const canManageListing = (prop, me) => me.role === 'admin' || prop.listed_by_agent_id === me.id

function bookingErr(res, out) {
  const code = out.error === 'not_found' ? 404 : out.error === 'not_allowed' ? 403
    : ['slot_taken', 'occupied', 'outside_window', 'cancelled'].includes(out.error) ? 409 : 422
  return res.status(code).json({ error: out.message || out.error, code: out.error })
}

// Everything the booking dialog shows for one property.
router.get('/listings/:ref/booking', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    const view = await bookingEngine.bookingView(prop.id, me)
    const calendarSync = require('../services/calendarSync')
    const rm = require('../services/rentalModes')
    const modeRow = (await db.query('SELECT rental_modes, lease_type, shortlet FROM properties WHERE id = $1', [prop.id])).rows[0] || {}
    const manage = canManageListing(prop, me)
    res.json({
      ref: prop.ref, town: prop.town, ...view,
      rentalModes: rm.effectiveModes(modeRow),
      // Classification only: a winter let is ALSO classified short let. The
      // season below is the Malta default, NOT confirmed availability, rates or
      // booking permission — none of that is ever inferred from the tag.
      dualUse: rm.isDualUse(modeRow),
      defaultShortLetSeason: rm.SHORT_LET_SEASON,
      seasonConfirmed: false,
      canManageCalendars: manage,
      calendarFeeds: manage ? await calendarSync.listFeeds(prop.id) : [],
      calendarExportUrl: manage
        ? `${PUBLIC_CRM_URL}/api/crm/schedule-board/property-calendar/${await calendarSync.exportToken(prop.id)}.ics` : null,
      canSetWindow: true,
    })
  } catch (err) {
    log.error('board booking view failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// Every Book action creates a booking REQUEST. An existing owner window makes
// the time selectable; it does not silently replace the owner's final OK for
// this particular client.
router.post('/listings/:ref/booking', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (blockFutureAction(res, prop, me, 'Booking requests')) return
    const b = req.body || {}
    let bookingAgent = null
    if (b.agentId && Number(b.agentId) !== me.id) {
      const a = await db.query(`SELECT id, name, username, alias FROM agents WHERE id = $1 AND active = TRUE`, [Number(b.agentId)])
      if (!a.rows[0]) return res.status(422).json({ error: 'That agent is not active.' })
      bookingAgent = a.rows[0]
    }
    const out = await bookingEngine.createSlotBooking({
      prop, me, bookingAgent, startsAt: b.startsAt, durationMin: Number(b.durationMin),
      appointmentType: b.appointmentType, partyLabel: b.clientName, partySize: b.groupSize, notes: b.notes,
      country: b.clientCountry, groupType: b.clientGroupType, job: b.clientJob, ages: b.clientAge,
    })
    if (out.error) return bookingErr(res, out)
    setImmediate(() => require('../services/bookingOwnerAsk').runPass()
      .catch(err => log.warn('immediate booking owner ask failed', { ref: prop.ref, err: err.message })))
    const view = await bookingEngine.bookingView(prop.id, me)
    const booking = view.bookings.find(x => x.id === out.id)
    res.json({
      ok: true, booking, view, confirmed: !!out.confirmed, occupied: !!out.occupied,
      message: `${booking ? `${booking.agent.name} · ${booking.label}` : 'Slot'} reserved as a booking request — pending the owner's confirmation.`
        + (out.occupied ? ' Note: guests are in the property then (short-stay calendar).' : ''),
    })
  } catch (err) {
    log.error('board slot booking failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

router.patch('/bookings/:id', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    const b = req.body || {}
    const out = await bookingEngine.rescheduleBooking(Number(req.params.id), me, {
      startsAt: b.startsAt, durationMin: b.durationMin, appointmentType: b.appointmentType,
      partyLabel: b.clientName, partySize: b.groupSize, notes: b.notes,
    })
    if (out.error) return bookingErr(res, out)
    res.json({ ok: true, id: out.id })
  } catch (err) {
    log.error('board booking update failed', { err: err.message, id: req.params.id })
    res.status(500).json({ error: err.message })
  }
})

router.post('/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    const out = await bookingEngine.cancelBooking(Number(req.params.id), me, (req.body || {}).reason)
    if (out.error) return bookingErr(res, out)
    res.json({ ok: true, id: out.id })
  } catch (err) {
    log.error('board booking cancel failed', { err: err.message, id: req.params.id })
    res.status(500).json({ error: err.message })
  }
})

// One deliberate second request after an owner decline. The agent must state
// why this client is worth reconsidering; the previous answer remains in the
// row and no automatic retry is created. REVIEW_ONLY still holds the outbound
// ask at the shared send gate.
router.post('/bookings/:id/justify', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    const reason = String((req.body || {}).reason || '').trim()
    if (reason.length < 8) return res.status(422).json({ error: 'Add a concrete reason for asking the owner again.' })
    const v = (await db.query(`SELECT * FROM property_viewings WHERE id=$1`, [Number(req.params.id)])).rows[0]
    if (!v) return res.status(404).json({ error: 'Booking request not found.' })
    if (me.role !== 'admin' && me.id !== v.user_id && me.id !== v.viewing_agent_id) return res.status(403).json({ error: 'Only the booking agent or an admin can do this.' })
    if (v.owner_survey_status !== 'declined') return res.status(409).json({ error: 'This request was not declined by the owner.' })
    const u = await db.query(
      `UPDATE property_viewings
          SET status='pending',agent_justification=$2,justification_at=NOW(),
              request_round=COALESCE(request_round,1)+1,owner_ask_sent_at=NULL,
              owner_ask_status='justification_pending',owner_survey_status=NULL,
              cancelled_at=NULL,cancel_reason=NULL,updated_at=NOW()
        WHERE id=$1 RETURNING id,request_round`, [v.id, reason.slice(0,500)])
    res.json({ ok:true, id:u.rows[0].id, requestRound:u.rows[0].request_round,
      message:'Justification saved. The owner request is queued for review and will not bypass contact safety.' })
  } catch (err) {
    if (err.code === '23P01') return res.status(409).json({ error: 'That time has since been taken.' })
    log.error('board booking justification failed', { err: err.message, id: req.params.id })
    res.status(500).json({ error: 'Could not save the justification.' })
  }
})

// Team / agent overview. ?from=&to= (ISO, default today → +14d), ?agent=me|all|<id>
router.get('/bookings', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 2 * 3600000)
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 14 * 86400000)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: 'Bad from/to' })
    const agentId = req.query.agent === 'me' ? me.id : (/^\d+$/.test(String(req.query.agent || '')) ? Number(req.query.agent) : null)
    const bookings = await bookingEngine.listBookings({
      from, to, agentId, includeCancelled: req.query.include_cancelled === '1',
    }, me)
    const windows = await db.query(
      `SELECT w.id, w.property_id, p.ref, p.town, w.kind, w.starts_at, w.ends_at, w.from_date, w.evidence
         FROM property_viewing_windows w JOIN properties p ON p.id = w.property_id
        WHERE w.status = 'active' AND ((w.kind = 'window' AND w.ends_at > $1 AND w.starts_at < $2)
              OR (w.kind = 'from_date' AND w.from_date < $2::date + 1))
          AND COALESCE(p.available_status,'available') NOT IN ('rented','archived')
        ORDER BY COALESCE(w.starts_at, w.from_date::timestamptz)`, [from, to])
    res.json({
      from: from.toISOString(), to: to.toISOString(), bookings,
      windows: windows.rows.map(w => ({
        id: w.id, propertyId: w.property_id, ref: w.ref, town: w.town, kind: w.kind,
        start: w.starts_at, end: w.ends_at, fromDate: w.from_date, evidence: w.evidence,
      })),
      me: { id: me.id, role: me.role },
    })
  } catch (err) {
    log.error('board bookings overview failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// Human override of the owner-confirmed viewing availability.
// { start, end } → window;  { fromDate } → viewings-from date.
router.post('/listings/:ref/viewing-window', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    const b = req.body || {}
    let w
    if (b.fromDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.fromDate))) return res.status(400).json({ error: 'fromDate must be YYYY-MM-DD' })
      w = { kind: 'from_date', fromDate: String(b.fromDate) }
    } else {
      const s = new Date(b.start), e = new Date(b.end)
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return res.status(400).json({ error: 'Pick a start and an end time.' })
      if (e - s > 8 * 3600000) return res.status(400).json({ error: 'A viewing window can be at most 8 hours.' })
      // Did the owner approve the whole range, or only a start time? Default is
      // the safe one: only the start is confirmed, the rest stays proposed.
      w = { kind: 'window', start: s.toISOString(), end: e.toISOString(),
            confirmation: b.confirmation === 'full_window' ? 'full_window' : 'start_only' }
    }
    const out = await viewingWindows.addWindow(prop.id, w, {
      sourceType: 'human_override', evidence: b.note ? String(b.note).slice(0, 300) : `set by ${me.username}`,
      reference: `agent:${me.id}`, createdBy: `agent:${me.id}`, confidence: 'explicit',
    })
    res.json({ ok: true, ...out, view: await bookingEngine.bookingView(prop.id, me) })
  } catch (err) {
    log.error('board viewing-window set failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

router.delete('/listings/:ref/viewing-window/:id', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    const out = await viewingWindows.cancelWindow(prop.id, req.params.id === 'all' ? null : Number(req.params.id), `agent:${me.id}`)
    res.json({ ok: true, ...out, view: await bookingEngine.bookingView(prop.id, me) })
  } catch (err) {
    log.error('board viewing-window cancel failed', { err: err.message, ref: req.params.ref })
    res.status(500).json({ error: err.message })
  }
})

// Re-read the owner chat for this listing now (pets/sharing/price/viewings…).
router.post('/listings/:ref/rescan-facts', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    res.json({ ok: true, ...(await ownerFactEngine.rescanProperty(loaded.prop.id)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── connected calendars (dual-use winter/short lets) ────────────────────────
router.post('/listings/:ref/calendar-feeds', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (!canManageListing(prop, me)) return res.status(403).json({ error: 'Only the listing agent or an admin can connect calendars.' })
    const calendarSync = require('../services/calendarSync')
    const out = await calendarSync.addFeed(prop.id, { url: (req.body || {}).url, sourceLabel: (req.body || {}).source, createdBy: me.id })
    res.json({ ...out, feeds: await calendarSync.listFeeds(prop.id) })
  } catch (err) {
    res.status(422).json({ error: err.message })
  }
})

router.post('/listings/:ref/calendar-feeds/:id/sync', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const calendarSync = require('../services/calendarSync')
    const own = await db.query('SELECT 1 FROM property_calendar_feeds WHERE id = $1 AND property_id = $2', [Number(req.params.id), loaded.prop.id])
    if (!own.rows[0]) return res.status(404).json({ error: 'Calendar not found' })
    const out = await calendarSync.syncFeed(Number(req.params.id))
    res.json({ ...out, feeds: await calendarSync.listFeeds(loaded.prop.id) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/listings/:ref/calendar-feeds/:id', auth, async (req, res) => {
  try {
    const loaded = await loadForAction(req, res)
    if (!loaded) return
    const { prop, me } = loaded
    if (!canManageListing(prop, me)) return res.status(403).json({ error: 'Only the listing agent or an admin can disconnect calendars.' })
    const calendarSync = require('../services/calendarSync')
    await calendarSync.removeFeed(prop.id, Number(req.params.id))
    res.json({ ok: true, feeds: await calendarSync.listFeeds(prop.id) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// My subscribable calendar URLs (Google / Apple / Outlook "subscribe by URL").
router.get('/calendar-feed', auth, async (req, res) => {
  try {
    const me = await liveAgent(req.agent.id)
    if (!me || !me.active) return res.status(401).json({ error: 'Account inactive' })
    const tok = await bookingEngine.feedToken(me.id)
    const base = `${PUBLIC_CRM_URL}/api/crm/schedule-board/calendar-feed/${tok}`
    res.json({
      mine: `${base}.ics`,
      team: me.role === 'admin' ? `${base}.ics?scope=team` : null,
      webcal: `${base.replace(/^https?:/, 'webcal:')}.ics`,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Token-authenticated feeds — calendar apps cannot send a Bearer header.
router.get('/calendar-feed/:token', async (req, res) => {
  try {
    const tok = String(req.params.token || '').replace(/\.ics$/i, '')
    const scope = req.query.scope === 'team' ? 'team' : 'mine'
    if (scope === 'team') {
      const a = await db.query(`SELECT role FROM agents WHERE calendar_feed_token = $1 AND active`, [tok])
      if (!a.rows[0] || a.rows[0].role !== 'admin') return res.status(404).send('not found')
    }
    const ics = await bookingEngine.icsForToken(tok, { scope })
    if (!ics) return res.status(404).send('not found')
    res.set('content-type', 'text/calendar; charset=utf-8').set('cache-control', 'no-cache').send(ics)
  } catch (err) {
    log.error('calendar feed failed', { err: err.message })
    res.status(500).send('error')
  }
})

router.get('/property-calendar/:token', async (req, res) => {
  try {
    const calendarSync = require('../services/calendarSync')
    const ics = await calendarSync.exportIcs(String(req.params.token || '').replace(/\.ics$/i, ''), { exclude: req.query.exclude })
    if (!ics) return res.status(404).send('not found')
    res.set('content-type', 'text/calendar; charset=utf-8').set('cache-control', 'no-cache').send(ics)
  } catch (err) {
    log.error('property calendar export failed', { err: err.message })
    res.status(500).send('error')
  }
})

try { require('../services/calendarSync').startSync() } catch (err) { log.warn('calendar sync not started', { err: err.message }) }

module.exports = router
