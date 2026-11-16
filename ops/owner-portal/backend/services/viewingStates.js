'use strict'
// Viewing coordination state machine (ARGUS Owner Portal / Viewing Desk,
// Claude 2026-11-16). Pure: which transition is allowed for which actor, and
// how each state maps onto the existing `property_viewings.status`, so the
// board, bookings page and ICS feeds keep reading one calendar.
//
//   REQUESTED → OWNER_SLOT_PROPOSED → AGENT_CLIENT_CONFIRMATION_PENDING → CONFIRMED
//   plus DECLINED, RESCHEDULE_REQUESTED, CANCELLED, EXPIRED, COMPLETED, NO_SHOW
//
// A viewing is CONFIRMED only after the owner proposed (or auto-approval
// proposed within the owner's rules) AND the requesting agent reconfirmed that
// the client accepted. Nothing earlier is ever presented as confirmed.

const STATES = ['REQUESTED', 'OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED',
  'DECLINED', 'RESCHEDULE_REQUESTED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW']

// States that occupy time on the property's calendar.
const HOLDING = ['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED']
// States that still need someone to act.
const OPEN = ['REQUESTED', 'RESCHEDULE_REQUESTED', 'OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING']
const FINAL = ['DECLINED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW']

// action → { from: allowed states, to, actors }
// actor kinds: owner (incl. an authorised property manager), agent (the
// requesting agent only), system (auto-approval, expiry), staff (ARGUS admin).
const TRANSITIONS = {
  propose:          { from: ['REQUESTED', 'RESCHEDULE_REQUESTED'], to: 'OWNER_SLOT_PROPOSED', actors: ['owner', 'system', 'staff'] },
  decline:          { from: ['REQUESTED', 'RESCHEDULE_REQUESTED', 'OWNER_SLOT_PROPOSED'], to: 'DECLINED', actors: ['owner', 'staff'] },
  ack_checking:     { from: ['OWNER_SLOT_PROPOSED'], to: 'AGENT_CLIENT_CONFIRMATION_PENDING', actors: ['agent'] },
  confirm:          { from: ['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING'], to: 'CONFIRMED', actors: ['agent'] },
  request_other:    { from: ['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED'], to: 'RESCHEDULE_REQUESTED', actors: ['agent'] },
  owner_reschedule: { from: ['CONFIRMED'], to: 'RESCHEDULE_REQUESTED', actors: ['owner', 'staff'] },
  cancel:           { from: ['REQUESTED', 'RESCHEDULE_REQUESTED', 'OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED'], to: 'CANCELLED', actors: ['owner', 'agent', 'staff'] },
  expire:           { from: ['REQUESTED', 'RESCHEDULE_REQUESTED', 'OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING'], to: 'EXPIRED', actors: ['system'] },
  complete:         { from: ['CONFIRMED'], to: 'COMPLETED', actors: ['owner', 'agent', 'staff'] },
  no_show:          { from: ['CONFIRMED'], to: 'NO_SHOW', actors: ['owner', 'agent', 'staff'] },
}

class TransitionError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status }
}

function transition(state, action, actor) {
  const t = TRANSITIONS[action]
  if (!t) throw new TransitionError('UNKNOWN_ACTION', `Unknown action: ${String(action).slice(0, 40)}`, 400)
  if (!t.actors.includes(actor)) throw new TransitionError('NOT_ALLOWED', `${actor} may not ${action}`, 403)
  if (!t.from.includes(state)) throw new TransitionError('INVALID_STATE', `Cannot ${action.replace('_', ' ')} a viewing that is ${state.toLowerCase().replace(/_/g, ' ')}`)
  return t.to
}

// Mapping onto the existing table, so every current reader stays correct:
// only CONFIRMED is 'confirmed'; everything still open is 'pending'.
function legacyStatus(state) {
  if (state === 'CONFIRMED') return 'confirmed'
  if (state === 'COMPLETED') return 'done'
  if (state === 'NO_SHOW') return 'no_show'
  if (['DECLINED', 'CANCELLED', 'EXPIRED'].includes(state)) return 'cancelled'
  return 'pending'
}

const LABEL = {
  REQUESTED: 'Requested', OWNER_SLOT_PROPOSED: 'Slot proposed', AGENT_CLIENT_CONFIRMATION_PENDING: 'Agent checking with client',
  CONFIRMED: 'Confirmed', DECLINED: 'Declined', RESCHEDULE_REQUESTED: 'Different time requested', CANCELLED: 'Cancelled',
  EXPIRED: 'Expired', COMPLETED: 'Completed', NO_SHOW: 'No show',
}

// The exact agent notification the founder specified, rendered from data.
function proposalMessage({ ref, startsAt, tz = 'Europe/Malta' }) {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(startsAt))
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(startsAt))
  return `Viewing slot proposed for #${ref} on ${when} at ${time}. Please confirm availability with your client and reconfirm in ARGUS.`
}

module.exports = { STATES, HOLDING, OPEN, FINAL, TRANSITIONS, LABEL, TransitionError, transition, legacyStatus, proposalMessage }
