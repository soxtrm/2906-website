'use strict'
// ============================================================================
// services/viewingGroupPlan.js — pure planner for the Phase-5 viewing-group
// pipeline. No DB, no WAHA, no network. The only side effect is the built
// string templates; the actual side effects (createGroup, sendText) live in
// handlers/upload.js so they can be exercised by the integration suite.
//
// Why this is a separate module:
//   The previous createViewingGroup() in handlers/upload.js had the
//   participant list, group name, and welcome text inlined and tangled with
//   the WAHA call. Refactors that wanted to change the welcome message
//   (e.g. add Kev's signature) had to either edit the live integration path
//   or duplicate the logic. The pure planner + contract test pin the format
//   so a refactor cannot silently change what owners see.
//
// Contract:
//   buildViewingGroupPlan({ c, uploaderPhone, olgaEnabled? })
//     -> { name, participants[], welcomeText, forwardText, locationMessage: { to, text }, errors[] }
//   c is { propId, ref, ownerPhone, ownerName, town, street, apt, price?, beds?, baths? }
//   uploaderPhone is the agent who triggered the upload.
//   olgaEnabled defaults to false; set true via OLGA_ENABLED=1 in env or
//   pass it explicitly to the planner.
// ============================================================================

// Welcome message variants. The default is the plain operator-friendly
// greeting. When Olga is enabled and added to the group, the welcome gets
// a one-line intro of Olga as a co-host who can help with questions
// between operator replies.
//
// Olga's phone is hard-coded for now; an env override is reserved for the
// day we swap her number or take her offline. `OLGA_DISPLAY_NAME` is the
// short name she signs in with — Kev wants her on a first-name basis
// from day one so the owner feels they're chatting with a person, not
// the bot.
const OLGA_PHONE = process.env.OLGA_PHONE || '35679010070'
const OLGA_NAME  = process.env.OLGA_DISPLAY_NAME || 'Olga'

function buildWelcomeText({ firstName, ref, olgaEnabled, requesterName, timeoutCreated }) {
  const base = `Hi ${firstName}! Thank you for working with us, we're really glad to have you on board and interested to help you get your property rented out quickly. We'll keep you posted here every step of the way.\n\nRef: #${ref}`
  const requester = requesterName
    ? `\n\n👋 ${requesterName} requested this group and is here to coordinate the viewing with you.`
    : ''
  const timeout = timeoutCreated
    ? `\n\n★ This group was opened after the 60-minute request window under your pre-approved trusted-agent group policy. You remain in control — say so here at any time and 2906 will close it.`
    : ''
  if (!olgaEnabled) return base + requester + timeout
  // Olga is in the group. Introduce her in one short line so the owner
  // knows who to ping when they have a question. The intro is on a
  // separate paragraph so it reads as an addendum, not part of the
  // operator's greeting.
  return base + requester + timeout +
    `\n\n👋 Quick intro: ${OLGA_NAME} is on the group too — she is part of the team and will be helping you with viewings, paperwork, and any quick questions. If you message her directly she will get back to you in a few minutes during work hours.`
}

// Forward to the group: the agent's ORIGINAL text. The planner must not
// fabricate a "📋 #2906 · town · 2BR" header on top of the original —
// the original already starts with its own header (Address, town, price)
// and a second one just pushes Kev's emoji block down and makes the post
// look like the bot edited it. We append the ref as a single line at the
// end so the agent's content stays verbatim and the ref is still discoverable.
//
// Precedence: c.rawText > c.publicPayload.description_social > c.description >
// fallback "(no description)". When rawText is provided we never touch the
// sanitiser output — sanitisation strips the apartment number and the operator
// wants the ORIGINAL apartment on the post, not a sanitised "📍 town".
const FORWARD_TEMPLATE = (body, ref) =>
  `${body}\n\n— 2906 · #${ref}`

// Private location message to the owner ONLY — never the group. The exact
// street and apartment are sensitive; they go to the owner on a 1:1 chat.
const LOCATION_TEMPLATE = (firstName, ref, street, apt, town) =>
  `Hi ${firstName}, the exact location of #${ref} is:\n\n📍 ${street}${apt ? ', ' + apt : ''}${town ? ', ' + town : ''}\n\nI'm sending this 1:1 because we only share the town publicly. If you'd rather we don't send the exact address here either, just say the word and I'll switch to the town only.`

// Drop everything except digits. The number is what WAHA actually keys on.
function digitsOnly(s) { return String(s || '').replace(/[^0-9]/g, '') }
function firstNameOf(fullName) {
  const s = String(fullName || '').trim()
  if (!s) return 'there'
  return s.split(/\s+/)[0]
}

function buildViewingGroupPlan({ c, uploaderPhone, olgaEnabled, requesterPhone, requesterName, timeoutCreated = false } = {}) {
  // Default olgaEnabled to false, but honour OLGA_ENABLED so the operator
  // can flip the switch with a process restart and never edit code. Reading
  // the env at call-time (not at module-load) lets tests mutate it between
  // cases without reloading the module.
  const envOlga = process.env.OLGA_ENABLED
  const olga = (typeof olgaEnabled === 'boolean')
    ? olgaEnabled
    : /^(1|true|yes)$/i.test(String(envOlga == null ? '' : envOlga))
  const errors = []
  if (!c || typeof c !== 'object') {
    errors.push('c (property context) is required')
    return { name: '', participants: [], welcomeText: '', forwardText: '', locationMessage: null, errors }
  }
  if (!c.ownerPhone) errors.push('c.ownerPhone is required')
  if (!c.ref) errors.push('c.ref is required')

  const ownerPhone = digitsOnly(c.ownerPhone)
  const uploader = digitsOnly(uploaderPhone)
  const olgaPhone = '35679010070'

  // Dedupe while keeping order. Uploader = owner? Skip the double-add — WAHA
  // returns 4xx on duplicate invites and the group is created anyway.
  const seen = new Set()
  const participants = []
  function add(p) {
    if (!p) return
    if (p.length < 7) return   // too short to be a real phone
    if (seen.has(p)) return
    seen.add(p)
    participants.push(p)
  }
  add(uploader)
  add(ownerPhone)
  add(digitsOnly(requesterPhone))
  if (olga) add(olgaPhone)

  // Group name: "Anna Sliema Viewings @2906". Falls back to "Owner" if no
  // owner name. The "Viewings @2906" suffix is what the operator's address
  // book learns to filter on.
  const ownerFirst = firstNameOf(c.ownerName)
  const town = c.town || ''
  const name = `${ownerFirst}${town ? ' ' + town : ''} Viewings @2906`.slice(0, 90)

  const welcomeText = buildWelcomeText({ firstName: ownerFirst, ref: c.ref, olgaEnabled: olga, requesterName, timeoutCreated })
  // Original-message verbatim: the agent typed a freeform message and that
  // message IS the listing. We do not pass the sanitised body through the
  // forward — sanitisation strips the apartment number and replaces the
  // operator's chosen layout. Sanitised text is for the CRM/FB-Page/
  // category channels; the viewing-group forward is the operator's own ad.
  const forwardBody = (typeof c.rawText === 'string' && c.rawText.trim())
    ? c.rawText
    : (c.publicPayload && c.publicPayload.description_social)
        || c.description
        || '(no description)'
  const forwardText = FORWARD_TEMPLATE(forwardBody, c.ref)

  // Private location message — only when we actually have the street.
  let locationMessage = null
  if (c.street) {
    locationMessage = {
      to: ownerPhone,
      text: LOCATION_TEMPLATE(ownerFirst, c.ref, c.street, c.apt || '', town),
    }
  }

  return { name, participants, welcomeText, forwardText, locationMessage, errors }
}

module.exports = {
  buildViewingGroupPlan,
  buildWelcomeText, OLGA_PHONE, OLGA_NAME,
  FORWARD_TEMPLATE,
  LOCATION_TEMPLATE,
  digitsOnly,
  firstNameOf,
}
