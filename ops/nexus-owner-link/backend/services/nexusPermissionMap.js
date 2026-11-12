'use strict'
// ============================================================================
// services/nexusPermissionMap.js — the one mapping between the NEXUS Owner
// Portal permission names and the contract's distribution vocabulary
// (Claude, 2026-11-12). Documented in CONTRACT.md §4a.
//
// The contract vocabulary (channel + audience + scopes) is canonical. NEXUS
// Stage A also has five per-agency permission names; two of them have an exact
// contract meaning, three have none yet. Anything without an exact meaning is
// REFUSED — it is never widened, guessed or silently dropped.
// ============================================================================

const CHANNELS = ['origin_agency', 'selected_agency', 'approved_large_agencies', 'all_eligible_agencies', 'independent_agents', 'nexus_direct_from_owner', 'other_approved']
const SCOPES = ['listing_data', 'photos', 'availability', 'viewing_schedule', 'approved_answers']

// NEXUS permission → contract scopes, always on channel `origin_agency`
// (a Stage A permission is a grant to the agency that brought the listing).
const NEXUS_TO_SCOPES = Object.freeze({
  view_facts: Object.freeze(['listing_data']),
  manage_viewings: Object.freeze(['viewing_schedule']),
})
// Known NEXUS names with no contract meaning yet. Recorded in NEXUS as the
// owner's wish; they authorise nothing in ARGUS.
const NEXUS_WITHOUT_MEANING = Object.freeze(['market', 'contact_owner', 'receive_leads'])

class PermissionError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400 }
}

// → { channel: 'origin_agency', scopes: [...] }. Throws on anything unknown.
function fromNexusPermissions(permissions) {
  if (!Array.isArray(permissions) || !permissions.length) throw new PermissionError('PERMISSIONS_INVALID', 'permissions must be a non-empty list')
  const scopes = new Set()
  for (const p of permissions) {
    if (NEXUS_WITHOUT_MEANING.includes(p)) throw new PermissionError('PERMISSION_NOT_MAPPED', `"${p}" has no meaning in the integration contract yet and authorises nothing`)
    if (!Object.prototype.hasOwnProperty.call(NEXUS_TO_SCOPES, p)) throw new PermissionError('PERMISSION_UNRECOGNIZED', 'Unrecognised permission')
    NEXUS_TO_SCOPES[p].forEach(s => scopes.add(s))
  }
  return { channel: 'origin_agency', scopes: [...scopes].sort() }
}

// Contract grants → the NEXUS permission names they amount to. Only
// origin_agency grants count; a scope without a NEXUS name yields nothing.
function toNexusPermissions(grants) {
  const scopes = new Set((grants || []).filter(g => g.channel === 'origin_agency').flatMap(g => g.scopes || []))
  return Object.keys(NEXUS_TO_SCOPES).filter(p => NEXUS_TO_SCOPES[p].every(s => scopes.has(s))).sort()
}

// Validates a contract-form grant. Unknown channel or scope → refused.
function assertContractGrant({ channel, scopes }) {
  if (!CHANNELS.includes(channel)) throw new PermissionError('CHANNEL_INVALID', 'Unknown distribution channel')
  const list = [...new Set(Array.isArray(scopes) ? scopes : [])]
  if (!list.length || list.some(s => !SCOPES.includes(s))) throw new PermissionError('SCOPES_INVALID', 'scopes must name exactly what is shared')
  return { channel, scopes: list.sort() }
}

module.exports = { CHANNELS, SCOPES, NEXUS_TO_SCOPES, NEXUS_WITHOUT_MEANING, PermissionError, fromNexusPermissions, toNexusPermissions, assertContractGrant }
