'use strict'
// Fixture adapter for the 136 golden cases (2026-11-10). Each case carries its
// thread state only as prose (`relevant_prior_context`). This module turns that
// prose into the structured snapshot the runtime receives from the database
// (sender persona, Malta clock, account/thread gates, known facts, last bot
// question). It never looks at the expected answer. Every rule is keyword
// based and listed here so a reviewer can audit the translation.
const { PERSONA_IDENTITIES } = require('../services/agentIdentityRegistry')

const DAY = { monday: 9, tuesday: 10, wednesday: 11, thursday: 12, friday: 13, saturday: 7, sunday: 8 } // Nov 2026
const PERMIT_Q = 'Perfect, thank you, what permits or licences does the property currently have?'
const SHARING_Q = 'Do you consider professional sharing in the apartment?'

function maltaDate(day, hh, mm) {
  // November 2026 is CET (UTC+1) in Malta.
  return new Date(Date.UTC(2026, 10, day, hh - 1, mm))
}

function senderFrom(ctx) {
  const c = ctx.toLowerCase()
  if (/identity is unknown|unknown after waha|sender unknown/.test(c)) return null
  const explicit = c.match(/(?:outgoing\s+sender|sender(?:\s+is)?|verified|wa\s+account:?)\s+(?:verified\s+)?(kevin|cedric|gabriela)/)
  if (explicit) return explicit[1]
  if (/\bcedric\b[^;]*\b(?:wa\s+)?account\b|\bcedric\s+wa\s+account\b/.test(c)) return 'cedric'
  if (/\bkevin\b|\b2906\b/.test(c)) return 'kevin'
  return 'kevin'
}

function contextFor(fixture) {
  const ctx = String(fixture.relevant_prior_context || '')
  const c = ctx.toLowerCase()
  const sender = senderFrom(ctx)
  const persona = { kevin: 'kev', cedric: 'cedric', gabriela: 'gabriela' }[sender]
  const identity = persona ? { ...PERSONA_IDENTITIES[persona] } : null
  if (identity && persona === 'kev') identity.website = identity.website || 'https://2906.estate'

  // Malta clock: default Tuesday 10 Nov 2026 11:00.
  let now = maltaDate(10, 11, 0)
  const tm = c.match(/(?:inbound|at|replied at|request at|sent at)\s+(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+)?(\d{1,2}):(\d{2})/)
  if (tm) now = maltaDate(tm[1] ? DAY[tm[1]] : 10, Number(tm[2]), Number(tm[3]))

  const known = {}
  const priceMoves = [...ctx.matchAll(/€\s?([\d,]+)/g)].map(m => Number(m[1].replace(/,/g, '')))
  if (/old crm|old €|card says|already known|earlier corrected|copied from/.test(c) && priceMoves.length) known.asking_rent = priceMoves[priceMoves.length - 1]
  if (/studio[^;]*already known|studio already known/.test(c)) known.property_type = 'STUDIO'

  let lastBotText = null
  if (/permit|licen[cs]e|what space is for|commercial permits/.test(c) && /bot|queued|asked|about to/.test(c)) lastBotText = PERMIT_Q
  if (/professional sharing/.test(c)) lastBotText = SHARING_Q

  const priorOwnerLines = []
  if (/owner said no pets|;\s*no pets|no pets$/.test(c)) priorOwnerLines.push('No pets.')

  return {
    sender, identity,
    context: {
      now, identity, senderUnknown: !identity, known, lastBotText,
      autoEnabled: /auto off/.test(c) ? false : true,
      manualPaused: /manually paused/.test(c),
      duplicate: /message_id already processed|already processed/.test(c),
      humanActive: /human agent typed|agent takeover active/.test(c),
      dnc: /global dnc|on global dnc/.test(c),
      ownerAskedToStop: /asks to stop/.test(c),
      burstOpen: /follow-up details \d+ sec later|messages in \d+ seconds|delayed auto reply is ready/.test(c),
    },
    priorOwnerLines,
  }
}

// Attachment phrases written in the burst become the production sentinels.
function burstFor(fixture, priorOwnerLines = []) {
  return [...priorOwnerLines, String(fixture.latest_inbound_burst || '')]
}

module.exports = { contextFor, burstFor, maltaDate }
