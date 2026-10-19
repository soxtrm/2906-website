'use strict'
// ============================================================================
// agentTag.js — render agents.post_tag as the marker shown under an ad.
// ============================================================================
//
// Every listing goes out from the ONE bot account, so the group cannot tell
// who brought the property. The tag restores that: Adrian → (^A), Olga → (^O).
//
// 2026-08-07: extended with REF-tag for direct-search usability. When a
// property has a known ref (e.g. '2906-100'), the post title/footer carries
// the ref so the recipient can search for it: e.g.:
//   "Stefan Sliema Viewings @2906-100"
// vs the older format:
//   "Stefan Sliema Viewings (#2906-100)"
// ============================================================================

const REF_RE = /^(2906[-/]?\d{1,4})$/i

// 'A' → '^A'   'o' → '^O'   null / junk → '' (untagged, as before)
function wrapLetter(postTag) {
  const t = String(postTag || '').trim()
  return /^[A-Za-z]{1,3}$/.test(t) ? `^${t.toUpperCase()}` : ''
}

function extractRef(ref) {
  if (ref == null) return ''
  const m = String(ref).trim().match(REF_RE)
  if (!m) return ''
  return '@' + m[1].replace(/[/-]/, '-').toLowerCase()
}

function formatPostTag(postTag) {
  const letter = wrapLetter(postTag)
  return letter ? `(${letter})` : ''
}

// Title-format: 'Stefan Sliema Viewings @2906-100' (preferred for searchability)
function formatTitle({ title, ref }) {
  const base = String(title || '').trim()
  const refTag = extractRef(ref)
  return refTag ? `${base} ${refTag}` : base
}

// Build a single composed tag from one OR MORE agents.
function formatPostTagsForAgents(agents, { now = Date.now() } = {}) {
  if (!Array.isArray(agents) || agents.length === 0) return ''
  const parts = agents
    .map(a => wrapLetter(a && a.post_tag))
    .filter(Boolean)
  if (parts.length === 0) return ''
  return `(${parts.join(' + ')})`
}

module.exports = { formatPostTag, formatPostTagsForAgents, formatTitle, extractRef }
