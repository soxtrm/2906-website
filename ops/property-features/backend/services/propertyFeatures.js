'use strict'
// ============================================================================
// services/propertyFeatures.js — NEXUS adaptive property features (Claude, 2026-11-21).
//
//   • dictionary (nexus_feature_dictionary): canonical features with aliases in several languages. Seeded from the
//     ARGUS feature tags (services/featureTags.js) plus counters and common extras. A new phrase becomes a
//     CANDIDATE: stored with the owner's own words, never a filter until staff promote it (or merge it into an
//     existing feature, which keeps the phrase as an alias so the next owner gets it suggested).
//   • suggest(text): normalised exact/alias match, then contained phrase, then token overlap; candidates rank
//     below standard features. No guessing below the threshold: the phrase is offered as a new candidate.
//   • property features (nexus_property_features): value + provenance. source owner/agent/import; confirmation
//     declared -> agent_confirmed (or rejected); verification none / document / verified (staff only).
//     The public listing shows only agent-confirmed or document-backed/verified features, each with its label.
//     Nothing here is a quality seal.
//   • access: owners through SYNC (own homes, or representatives with 'edit'); agents through the CRM for listings
//     they are responsible for; admins for all. Every change is in agent_activity_log.
// ============================================================================
const db = require('../db')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { audit } = L._internal
const err = (code, message, status = 400) => new LinkError(code, message, status)

const STOP = new Set(['the', 'a', 'an', 'with', 'and', 'of', 'in', 'for', 'to', 'de', 'la', 'le', 'les', 'il', 'lo', 'i', 'gli', 'der', 'die', 'das', 'mit', 'und', 'con', 'e', 'et', 'avec', 'y', 'el', 'tal', 'ta'])
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim()
const stem = w => (w.length > 4 && /(ies)$/.test(w) ? w.slice(0, -3) + 'y' : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)
const tokens = s => norm(s).split(' ').filter(w => w && !STOP.has(w)).map(stem)
const slug = s => tokens(s).join('_').replace(/[^a-z0-9_]/g, '').slice(0, 48)
// Choosing tenants by these is not allowed (same rule as house rules / owner chat).
const PROTECTED = /\b(nationalit|ethnic|race|racial|religio|muslim|christian|jewish|hindu|african|arab|asian|indian|gay|lesbian|pregnan)/i

let dictCache = null
async function dictionary({ fresh = false } = {}) {
  if (!fresh && dictCache && Date.now() - dictCache.at < 60e3) return dictCache.rows
  const { rows } = await db.query(`SELECT * FROM nexus_feature_dictionary WHERE status <> 'retired' ORDER BY status DESC, label`)
  dictCache = { at: Date.now(), rows }
  return rows
}
const entryView = d => ({ key: d.key, label: d.label, group: d.grp, kind: d.kind, choices: d.choices, status: d.status, filterable: d.filterable })

/** Ranked suggestions for a phrase. exact (1.0) > contained (0.85) > token overlap (>= 0.5). */
async function suggest(text, { limit = 6 } = {}) {
  const q = norm(text); const qt = tokens(text)
  if (!q || q.length < 2) return { query: text, suggestions: [], newCandidate: null }
  const out = []
  for (const d of await dictionary()) {
    let best = 0
    for (const term of [d.label, d.key.replace(/_/g, ' '), ...d.aliases]) {
      const t = norm(term); if (!t) continue
      if (t === q) { best = 1; break }
      if (q.length >= 4 && t.length >= 4 && (t.includes(q) || q.includes(t))) best = Math.max(best, 0.85)
      const tt = tokens(term); const inter = qt.filter(x => tt.includes(x)).length
      if (inter) best = Math.max(best, inter / new Set([...qt, ...tt]).size)
    }
    if (best >= 0.5) out.push({ ...entryView(d), score: Math.round((best - (d.status === 'candidate' ? 0.05 : 0)) * 100) / 100 })
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
  const exact = out[0]?.score >= 0.95
  return { query: text, suggestions: out.slice(0, limit), newCandidate: exact ? null : { label: text.trim().slice(0, 80) } }
}

function cleanValue(d, value) {
  if (d.kind === 'boolean') { if (value !== true && value !== false) throw err('VALUE_INVALID', 'Yes or no.'); return value }
  if (d.kind === 'count') { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 50) throw err('VALUE_INVALID', 'A number from 0 to 50.'); return n }
  if (!d.choices.includes(value)) throw err('VALUE_INVALID', 'Choose one of the options.'); return value
}

async function candidateFor(text, actor) {
  const label = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (label.length < 3) throw err('FEATURE_INVALID', 'Describe the feature in a few words.')
  if (PROTECTED.test(label)) throw err('PROTECTED_CHARACTERISTIC', 'Characteristics of people cannot be listed as a property feature.')
  const s = await suggest(label)
  if (s.suggestions[0]?.score >= 0.95) return (await dictionary()).find(d => d.key === s.suggestions[0].key)
  let key = `c_${slug(label)}`.slice(0, 63).replace(/_+$/, '')
  if (key.length < 4) key = `c_feature_${Date.now().toString(36)}`
  const { rows: [d] } = await db.query(
    `INSERT INTO nexus_feature_dictionary (key, label, grp, kind, aliases, status, filterable, created_from) VALUES ($1,$2,'other','boolean',$3,'candidate',false,$4)
     ON CONFLICT (key) DO UPDATE SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(nexus_feature_dictionary.aliases || EXCLUDED.aliases))), updated_at=NOW() RETURNING *`,
    [key, label, [label.toLowerCase()], actor])
  dictCache = null
  return d
}

// ── who may change which property ─────────────────────────────────────────────
async function ownerProperty(S, account, propertyId) {
  const p = (await S.ownedProperties(account, 'edit')).find(x => x.id === Number(propertyId))
  if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
  return p
}
async function agentProperty(agent, propertyId) {
  const { rows: [p] } = await db.query(`SELECT id, ref, listed_by_agent_id FROM properties WHERE id=$1`, [Number(propertyId) || 0])
  if (!p) throw err('PROPERTY_NOT_FOUND', 'Listing not found.', 404)
  if (!(agent?.role === 'admin' || (agent?.role === 'agent' && Number(p.listed_by_agent_id) === Number(agent.id)))) throw err('FORBIDDEN', 'Only the listing agent or an admin can change this listing.', 403)
  return p
}

const featureView = r => ({ key: r.feature_key, label: r.label, group: r.grp, kind: r.kind, choices: r.choices, status: r.status, value: r.value, originalText: r.original_text || null,
  note: r.note || null, source: r.source, confirmation: r.confirmation, verification: r.verification, updatedAt: r.updated_at })
async function forProperty(propertyId) {
  const { rows } = await db.query(
    `SELECT f.*, d.label, d.grp, d.kind, d.choices, d.status FROM nexus_property_features f JOIN nexus_feature_dictionary d ON d.key=f.feature_key
      WHERE f.property_id=$1 AND f.confirmation <> 'rejected' ORDER BY d.grp, d.label`, [propertyId])
  return rows.map(featureView)
}

async function upsert(propertyId, { key, text, value, note }, who) {
  let d
  if (key) { d = (await dictionary()).find(x => x.key === key) || (await dictionary({ fresh: true })).find(x => x.key === key); if (!d) throw err('FEATURE_UNKNOWN', 'Unknown feature.') }
  else d = await candidateFor(text, who.label)
  const v = cleanValue(d, value === undefined ? true : value)
  const n = note ? String(note).trim().slice(0, 300) || null : null
  if (n && PROTECTED.test(n)) throw err('PROTECTED_CHARACTERISTIC', 'Characteristics of people cannot be part of a property feature.')
  const { rows: [before] } = await db.query(`SELECT * FROM nexus_property_features WHERE property_id=$1 AND feature_key=$2`, [propertyId, d.key])
  const agentSide = who.kind === 'agent'
  // an owner's change of a confirmed feature goes back to 'declared' (the agent looks again); an agent's statement counts as confirmed
  const { rows: [row] } = await db.query(
    `INSERT INTO nexus_property_features (property_id, feature_key, value, original_text, note, source, confirmation, declared_by_account, declared_by_agent, confirmed_by_agent, confirmed_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (property_id, feature_key) DO UPDATE SET value=EXCLUDED.value, original_text=COALESCE(EXCLUDED.original_text, nexus_property_features.original_text), note=EXCLUDED.note,
       confirmation=CASE WHEN $6='agent' THEN 'agent_confirmed' WHEN nexus_property_features.value = EXCLUDED.value AND nexus_property_features.confirmation='agent_confirmed' THEN 'agent_confirmed' ELSE 'declared' END,
       confirmed_by_agent=CASE WHEN $6='agent' THEN EXCLUDED.confirmed_by_agent ELSE nexus_property_features.confirmed_by_agent END,
       confirmed_at=CASE WHEN $6='agent' THEN NOW() ELSE nexus_property_features.confirmed_at END,
       verification=CASE WHEN nexus_property_features.value = EXCLUDED.value THEN nexus_property_features.verification ELSE 'none' END,
       updated_at=NOW()
     RETURNING *`,
    [propertyId, d.key, JSON.stringify(v), key ? null : String(text).trim().slice(0, 200), n, agentSide ? 'agent' : 'owner', agentSide ? 'agent_confirmed' : 'declared',
     agentSide ? null : who.accountId, agentSide ? who.agentId : null, agentSide ? who.agentId : null, agentSide ? new Date() : null])
  await audit(db, agentSide ? who.agent : null, 'PROPERTY_FEATURE_SET', { account: who.publicId || undefined, key: d.key, value: v, before: before ? before.value : null, candidate: d.status === 'candidate' }, { id: propertyId, ref: who.ref })
  return { ...featureView({ ...row, label: d.label, grp: d.grp, kind: d.kind, choices: d.choices, status: d.status }) }
}

// ── owner side (SYNC) ─────────────────────────────────────────────────────────
const ownerWho = (account, p) => ({ kind: 'owner', accountId: account.id, publicId: account.public_id, label: 'owner', ref: p.ref })
async function ownerList(S, account, { propertyId }) {
  const p = (await S.ownedProperties(account, 'view')).find(x => x.id === Number(propertyId))
  if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
  const { rows: [core] } = await db.query(`SELECT bedrooms, bathrooms FROM properties WHERE id=$1`, [p.id])
  return { propertyId: p.id, core: { bedrooms: core?.bedrooms ?? null, bathrooms: core?.bathrooms ?? null }, features: await forProperty(p.id),
    common: (await dictionary()).filter(d => d.status === 'standard').map(entryView) }
}
async function ownerSet(S, account, { propertyId, key, text, value, note }) {
  const p = await ownerProperty(S, account, propertyId)
  return { feature: await upsert(p.id, { key, text, value, note }, ownerWho(account, p)) }
}
async function ownerRemove(S, account, { propertyId, key }) {
  const p = await ownerProperty(S, account, propertyId)
  const { rowCount } = await db.query(`DELETE FROM nexus_property_features WHERE property_id=$1 AND feature_key=$2 AND source='owner'`, [p.id, String(key || '')])
  if (!rowCount) throw err('FEATURE_NOT_FOUND', 'Only features you added yourself can be removed here. Ask your agent for the others.', 404)
  await audit(db, null, 'PROPERTY_FEATURE_REMOVED', { account: account.public_id, key }, { id: p.id, ref: p.ref })
  return { removed: true }
}

// ── agent side (CRM) ──────────────────────────────────────────────────────────
const agentWho = (agent, p) => ({ kind: 'agent', agentId: agent.id, agent, label: `agent:${agent.id}`, ref: p.ref })
async function agentList(agent, { propertyId }) { const p = await agentProperty(agent, propertyId); return { propertyId: p.id, ref: p.ref, features: await forProperty(p.id) } }
async function agentSet(agent, { propertyId, key, text, value, note }) { const p = await agentProperty(agent, propertyId); return { feature: await upsert(p.id, { key, text, value, note }, agentWho(agent, p)) } }
async function agentDecide(agent, { propertyId, key, decision, verification, documentId }) {
  const p = await agentProperty(agent, propertyId)
  if (decision === 'confirm' || decision === 'reject') {
    const { rows: [r] } = await db.query(`UPDATE nexus_property_features SET confirmation=$3, confirmed_by_agent=$4, confirmed_at=NOW(), updated_at=NOW() WHERE property_id=$1 AND feature_key=$2 RETURNING *`,
      [p.id, String(key || ''), decision === 'confirm' ? 'agent_confirmed' : 'rejected', agent.id])
    if (!r) throw err('FEATURE_NOT_FOUND', 'Not found.', 404)
  } else if (decision === 'verify') {
    if (!['none', 'document', 'verified'].includes(verification)) throw err('VERIFICATION_INVALID', 'none, document or verified')
    if (verification === 'verified' && agent.role !== 'admin') throw err('FORBIDDEN', 'Only an admin marks a feature as independently verified.', 403)
    if (verification === 'document') {
      const { rows: [doc] } = await db.query(`SELECT d.id FROM owner_documents d JOIN properties pr ON pr.owner_id=d.owner_contact_id WHERE d.id=$1 AND pr.id=$2 AND d.deleted_at IS NULL`, [Number(documentId) || 0, p.id])
      if (!doc) throw err('DOCUMENT_REQUIRED', 'Link a document of this owner as evidence.')
    }
    const { rows: [r] } = await db.query(`UPDATE nexus_property_features SET verification=$3, document_id=$4, confirmation=CASE WHEN $3='none' THEN confirmation ELSE 'agent_confirmed' END,
        confirmed_by_agent=$5, confirmed_at=NOW(), updated_at=NOW() WHERE property_id=$1 AND feature_key=$2 RETURNING *`,
      [p.id, String(key || ''), verification, verification === 'document' ? Number(documentId) : null, agent.id])
    if (!r) throw err('FEATURE_NOT_FOUND', 'Not found.', 404)
  } else throw err('DECISION_INVALID', 'confirm, reject or verify')
  await audit(db, agent, 'PROPERTY_FEATURE_REVIEWED', { key, decision, verification: verification || null }, { id: p.id, ref: p.ref })
  return { features: await forProperty(p.id) }
}
/** CRM queue: owner-declared features waiting for the listing agent (admins see all). */
async function reviewQueue(agent) {
  const { rows } = await db.query(
    `SELECT f.*, d.label, d.grp, d.kind, d.choices, d.status, p.ref, p.town, a.name AS agent_name FROM nexus_property_features f
       JOIN nexus_feature_dictionary d ON d.key=f.feature_key JOIN properties p ON p.id=f.property_id LEFT JOIN agents a ON a.id=p.listed_by_agent_id
      WHERE f.confirmation='declared' AND ($1::int IS NULL OR p.listed_by_agent_id=$1::int) ORDER BY f.created_at LIMIT 300`, [agent?.role === 'admin' ? null : agent?.id || -1])
  return { features: rows.map(r => ({ ...featureView(r), propertyId: r.property_id, ref: r.ref, town: r.town, listingAgent: r.agent_name })) }
}
/** Admin: candidates with how often they were used; promote (standard, optional filter) or merge into a feature. */
async function candidates() {
  const { rows } = await db.query(`SELECT d.*, (SELECT COUNT(*)::int FROM nexus_property_features f WHERE f.feature_key=d.key) AS used FROM nexus_feature_dictionary d WHERE d.status='candidate' ORDER BY used DESC, d.created_at`)
  return { candidates: rows.map(d => ({ ...entryView(d), aliases: d.aliases, used: d.used, createdAt: d.created_at })), standard: (await dictionary({ fresh: true })).filter(d => d.status === 'standard').map(entryView) }
}
async function curate(agent, { key, action, into, label, group, filterable }) {
  if (agent?.role !== 'admin') throw err('FORBIDDEN', 'Only admins curate the feature dictionary.', 403)
  const { rows: [d] } = await db.query(`SELECT * FROM nexus_feature_dictionary WHERE key=$1 AND status='candidate'`, [String(key || '')])
  if (!d) throw err('FEATURE_NOT_FOUND', 'Candidate not found.', 404)
  if (action === 'promote') {
    await db.query(`UPDATE nexus_feature_dictionary SET status='standard', label=COALESCE($2,label), grp=COALESCE($3,grp), filterable=$4, updated_at=NOW() WHERE key=$1`,
      [d.key, label ? String(label).slice(0, 80) : null, group ? String(group).slice(0, 30) : null, filterable === true])
  } else if (action === 'merge') {
    const { rows: [t] } = await db.query(`SELECT * FROM nexus_feature_dictionary WHERE key=$1 AND status='standard'`, [String(into || '')])
    if (!t) throw err('FEATURE_UNKNOWN', 'Choose the standard feature to merge into.')
    await db.query(`UPDATE nexus_feature_dictionary SET aliases=(SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))), updated_at=NOW() WHERE key=$1`, [t.key, [d.label.toLowerCase(), ...d.aliases]])
    // properties that used the candidate now carry the standard feature (unless they already had it)
    await db.query(`UPDATE nexus_property_features f SET feature_key=$2, updated_at=NOW() WHERE f.feature_key=$1 AND NOT EXISTS (SELECT 1 FROM nexus_property_features g WHERE g.property_id=f.property_id AND g.feature_key=$2)`, [d.key, t.key])
    await db.query(`DELETE FROM nexus_property_features WHERE feature_key=$1`, [d.key])
    await db.query(`UPDATE nexus_feature_dictionary SET status='retired', updated_at=NOW() WHERE key=$1`, [d.key])
  } else if (action === 'retire') {
    await db.query(`UPDATE nexus_feature_dictionary SET status='retired', updated_at=NOW() WHERE key=$1`, [d.key])
  } else throw err('ACTION_INVALID', 'promote, merge or retire')
  dictCache = null
  await audit(db, agent, 'FEATURE_DICTIONARY_CURATED', { key: d.key, action, into: into || null })
  return candidates()
}

// ── public listing projection (nexusBridge.inventory) ─────────────────────────
const PUBLIC_LABEL = { agent_confirmed: 'Confirmed by the agency', document: 'Backed by a document', verified: 'Independently verified' }
async function attachPublic(props) {
  const refs = props.map(p => p.id).filter(Boolean)
  if (!refs.length) return props
  const { rows } = await db.query(
    `SELECT p.ref, f.feature_key, f.value, f.confirmation, f.verification, d.label, d.grp, d.kind, d.filterable FROM nexus_property_features f
       JOIN nexus_feature_dictionary d ON d.key=f.feature_key AND d.status='standard' JOIN properties p ON p.id=f.property_id
      WHERE p.ref = ANY($1::text[]) AND (f.confirmation='agent_confirmed' OR f.verification <> 'none') AND f.value <> 'false'::jsonb AND f.value <> '0'::jsonb`, [refs])
  const by = {}
  for (const r of rows) (by[r.ref] = by[r.ref] || []).push({ key: r.feature_key, label: r.label, group: r.grp, kind: r.kind, value: r.value, filterable: r.filterable,
    evidence: r.verification !== 'none' ? r.verification : 'agent_confirmed', evidenceLabel: PUBLIC_LABEL[r.verification !== 'none' ? r.verification : 'agent_confirmed'] })
  for (const p of props) p.features = by[p.id] || []
  return props
}
async function publicDictionary() {
  return { features: (await dictionary()).filter(d => d.status === 'standard').map(d => ({ ...entryView(d), aliases: d.aliases })) }
}

module.exports = { suggest, ownerList, ownerSet, ownerRemove, agentList, agentSet, agentDecide, reviewQueue, candidates, curate, attachPublic, publicDictionary, _test: { norm, tokens, slug } }
