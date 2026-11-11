'use strict'
// ============================================================================
// services/nexusSmartDefaults.js — harmless form defaults for the NEXUS owner
// link and distribution routing (Claude, 2026-11-12, queue addendum 01).
//
// A default here may only save typing. It may never decide anything on
// someone's behalf. So:
//   • every suggestion carries where it came from and a one-line explanation;
//   • the fields in NEVER_PRESELECTED are returned without a value, always —
//     external sharing, the audience, commercial terms, approval, ownership
//     verification and anything the owner decides in NEXUS;
//   • the server treats a suggestion as nothing: a request must still state
//     every value itself (routing validate() rejects a missing audience).
// ============================================================================
const freshness = require('./availabilityFreshness')

const STANDARD_DELAY_DAYS = 7

const NEVER_PRESELECTED = [
  { field: 'audienceType', why: 'Who a listing is released to is a decision about sharing it outside your agency.' },
  { field: 'audienceRefs', why: 'Naming agencies is a decision about sharing with each of them.' },
  { field: 'commercialTermsRef', why: 'Commercial terms refer to an agreement that must already exist. None is assumed.' },
  { field: 'approveRelease', why: 'Approval starts the release clock. It is always a separate, explicit step.' },
  { field: 'verificationMethod', why: 'How ownership was checked must be stated by the person who checked it.' },
  { field: 'ownerDistribution', why: 'What the owner allows is decided by the owner in NEXUS, never prefilled by the agency.' },
  { field: 'ownerContactSharing', why: 'Owner contact details are never shared by default.' },
]
const FORBIDDEN = new Set(NEVER_PRESELECTED.map(f => f.field))

// 09:00 Europe/Malta on the next working day, as an instant.
function nextWorkingMorning(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', hourCycle: 'h23' })
  for (let d = new Date(now.getTime() + 86400000), i = 0; i < 8; d = new Date(d.getTime() + 86400000), i++) {
    const part = Object.fromEntries(day.formatToParts(d).map(x => [x.type, x.value]))
    if (part.weekday === 'Sat' || part.weekday === 'Sun') continue
    for (const offset of ['+01:00', '+02:00']) {
      const at = new Date(`${part.year}-${part.month}-${part.day}T09:00:00${offset}`)
      if (hour.format(at) === '09') return at
    }
  }
  return new Date(now.getTime() + 86400000)
}

// Guard used by every builder below and by the tests: a suggestion for a
// decision field is a programming error, not a product option.
function suggestion(field, value, source, explain, extra = {}) {
  if (FORBIDDEN.has(field)) throw new Error(`nexusSmartDefaults: "${field}" must never be preselected`)
  return { field, value, source, explain, ...extra }
}

// Defaults for the distribution-routing form of one listing.
async function routeDefaults(q, agent, { now = new Date() } = {}) {
  let delay = STANDARD_DELAY_DAYS
  let source = 'standard'
  let explain = `${STANDARD_DELAY_DAYS} days is the usual head start. Change it freely.`
  if (agent?.id) {
    const { rows: [last] } = await q.query(
      `SELECT delay_days FROM nexus_distribution_routes WHERE created_by_agent_id=$1 AND mode='delay_days' AND delay_days IS NOT NULL ORDER BY id DESC LIMIT 1`, [agent.id])
    if (last) { delay = last.delay_days; source = 'your_last_rule'; explain = `You used ${delay} day${delay === 1 ? '' : 's'} on your last delayed release.` }
  }
  return {
    suggestions: [
      suggestion('mode', 'none', 'safe_default', 'Nothing is shared until you choose otherwise.'),
      suggestion('delayDays', delay, source, explain, { appliesWhen: 'mode = delay_days' }),
      suggestion('releaseAt', nextWorkingMorning(now).toISOString(), 'standard', 'Next working day, 09:00 Malta time. Only used if you pick a date.', { appliesWhen: 'mode = release_at' }),
    ],
    neverPreselected: NEVER_PRESELECTED,
  }
}

// Defaults for recording what an owner said about availability.
function availabilityAnswerDefaults({ now = new Date() } = {}) {
  const hours = freshness.settings().intervalHours
  return {
    suggestions: [
      suggestion('askAgainAt', new Date(now.getTime() + hours * 3600000).toISOString(), 'standard', `The usual re-check interval is ${hours} hours.`, { appliesWhen: 'outcome = ask_later or temporarily_held' }),
    ],
    // The answer itself is what the owner said; it is never guessed.
    neverPreselected: [{ field: 'outcome', why: 'Only what the owner actually said is recorded.' }, { field: 'availableFrom', why: 'The date comes from the owner.' }],
  }
}

module.exports = { routeDefaults, availabilityAnswerDefaults, nextWorkingMorning, suggestion, NEVER_PRESELECTED, STANDARD_DELAY_DAYS }
