'use strict'
// ============================================================================
// categoryClassifier.js — classify a property into category-group keys.
//
// classifyProperty(publicPayload) → { keys: [oneKey], reasoning: '' }
//
// ONE GROUP PER PROPERTY. A property is never cross-posted: every candidate
// category is evaluated, then exactly ONE winner is picked by PRECEDENCE.
//
// PRECEDENCE (highest first) — confirmed by Kev 2026-07-26, rules 2026-10-22:
//   seafront  >  villas (houses)  >  luxury  >  bed3 / bed2 / bed1
//
//   seafront: the agent text says "direct seafront" → ALWAYS seafront
//   villas  : every house / villa / townhouse / house of character …
//   luxury  : €2,500/month or more (one threshold for every size)
//   bed1-3  : below €2,500 and none of the above
//
//   so:  2BR €2600 direct seafront → seafront (not luxury, not bed2)
//        4BR villa €3000    → villas     (not luxury)
//        4BR villa €1800    → villas
//        1BR €2100          → bed1       (was luxury under the old €2,000 1-bed rule)
//        2BR €2200          → bed2
//        maisonette 3BR     → bed3       (maisonettes count as apartments)
//
// CANDIDATES:
//   bedroom bucket (always one of): beds <= 1 or studio → bed1
//                                   beds == 2           → bed2
//                                   beds >= 3           → bed3
//   villas : standalone house/villa — anything with its OWN entrance,
//            EXCEPT maisonettes, which we count as apartments.
//   luxury : longlet >= 2500 (any size, bedrooms not needed)
//   seafront: "direct seafront" in the agent text (not "sea glimpse" / "near" / "5 min walk")
//
// GEMINI (ONE call, only for the two things code cannot decide):
//   1. is it genuinely seafront?
//   2. does an unclear-type property have its own entrance?
//   Returns JSON {"seafront":bool,"own_entrance":bool}
//   On ANY failure → both false, log warning, continue. Never blocks.
//
// If the winning key's category_groups row is inactive, the next candidate in
// precedence order wins (the bedroom bucket is the final fallback).
// ============================================================================

const db  = require('../db')
const log = require('../logger')
const { GoogleGenAI } = require('@google/genai')

// NOTE: gemini-flash-latest REJECTS thinkingConfig{thinkingBudget:0} with
// 400 INVALID_ARGUMENT (verified against the live API 2026-07-26), and a small
// maxOutputTokens gets swallowed by its default thinking, returning "".
// So: try flash-latest without thinkingConfig, then fall back to 2.5-flash
// which does accept thinkingBudget:0 (and is ~3x faster).
const GEMINI_ATTEMPTS = [
  { model: 'gemini-flash-latest',
    config: { temperature: 0, maxOutputTokens: 2000, responseMimeType: 'application/json' } },
  { model: 'gemini-2.5-flash',
    config: { temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 },
              responseMimeType: 'application/json' } },
]

// ── Deterministic bucket + luxury ────────────────────────────────────────────

// Precedence, highest first. Hardcoded on purpose (Kev's call) — changing the
// order means editing this array, then scp + restart.
const PRECEDENCE = ['seafront', 'villas', 'luxury', 'bed3', 'bed2', 'bed1']

// Types that are standalone houses by their own name.
const HOUSE_TYPES = ['villa', 'house', 'bungalow', 'townhouse', 'detached', 'farmhouse']
// Types that are apartments even when they have their own entrance.
// Maisonettes live here deliberately — "die zählen wir meistens als apartments".
const APARTMENT_TYPES = ['apartment', 'flat', 'studio', 'penthouse', 'maisonette', 'duplex']
// Kev, 2026-10-22: "Houses = alle Häuser, Villen und co" — matched as words
// inside the type too ("house of character", "semi-detached villa",
// "terraced house"), not only as an exact type value.
const HOUSE_TYPE_RE = /\b(villas?|houses?|bungalows?|townhouses?|town\s+house|farmhouses?|detached|semi[- ]detached|terraced|palazz[oi]|chalet|mansion|razzett|house\s+of\s+character)\b/i
const APARTMENT_TYPE_RE = /\b(apartments?|flats?|studios?|penthouses?|maisonettes?|duplex)\b/i
const LUXURY_MIN_PRICE = 2500

// Bedroom count confidence (2026-09-17 fix — Kev's exact bug: unknown
// bedrooms silently became `Number(undefined) || 0` → `0 <= 1` → bed1, live
// and reproducible right up until this fix). Distinguishes:
//   KNOWN_VALUE    — a usable bedrooms count exists
//   LOW_CONFIDENCE — only a 'beds' field exists, no 'bedrooms' — 'beds' on a
//                    source site can mean sleeping capacity, not bedroom
//                    count (Beds != Bedrooms), so it's usable but weaker
//   CONFLICTING    — beds and bedrooms are both present and DISAGREE
//   UNKNOWN        — neither field has a usable number
// KNOWN/LOW_CONFIDENCE both route normally (LOW_CONFIDENCE is flagged in the
// reasoning string for a human to notice, not blocked). CONFLICTING and
// UNKNOWN never produce a bedroom bucket or a luxury verdict — see
// classifyKeys() below. NOTE: on the real production publish path,
// categoryPublisher.js's liveClassificationPayload() always sets beds AND
// bedrooms to the SAME live properties.bedrooms value, so CONFLICTING can't
// happen there today — it's a defensive case for other callers (handlers/
// upload.js passes a payload built before liveClassificationPayload exists
// for a brand-new listing; a future website-ingest caller might pass raw
// scraped 'beds' distinct from a confirmed 'bedrooms').
function bedroomStatus(p) {
  const rawBeds = p.beds
  const rawBedrooms = p.bedrooms
  const hasBeds = rawBeds !== undefined && rawBeds !== null && rawBeds !== ''
  const hasBedrooms = rawBedrooms !== undefined && rawBedrooms !== null && rawBedrooms !== ''
  const numBeds = hasBeds ? Number(rawBeds) : null
  const numBedrooms = hasBedrooms ? Number(rawBedrooms) : null
  const validBeds = numBeds !== null && Number.isFinite(numBeds) && numBeds >= 0
  const validBedrooms = numBedrooms !== null && Number.isFinite(numBedrooms) && numBedrooms >= 0

  if (!validBeds && !validBedrooms) return { state: 'UNKNOWN', value: null }
  if (validBeds && validBedrooms) {
    if (numBeds !== numBedrooms) {
      return { state: 'CONFLICTING', value: null, beds: numBeds, bedrooms: numBedrooms }
    }
    return { state: 'KNOWN_VALUE', value: numBedrooms }
  }
  if (validBedrooms) return { state: 'KNOWN_VALUE', value: numBedrooms }
  return { state: 'LOW_CONFIDENCE', value: numBeds }
}

function classifyKeys(publicPayload) {
  const p = publicPayload || {}
  const bedState = bedroomStatus(p)
  const bedsKnown = bedState.state === 'KNOWN_VALUE' || bedState.state === 'LOW_CONFIDENCE'
  const type  = String(p.type ?? p.property_type ?? '').toLowerCase().trim()
  const price = Number(p.longlet_price) || 0

  // bedroom bucket — only when bedrooms are actually known. UNKNOWN/
  // CONFLICTING → no bucket at all (was: silently falls into bed1).
  let bucket = null
  if (bedsKnown) {
    const beds = bedState.value
    if (type === 'studio' || beds <= 1) bucket = 'bed1'
    else if (beds === 2)                bucket = 'bed2'
    else                                 bucket = 'bed3'
  }

  // Kev, 2026-10-22: ONE luxury threshold, €2,500/month, for every size
  // ("3b 2b 1b … wenn unter 2500€"). It no longer needs the bedroom count, so
  // a €3,000 listing with unknown bedrooms is Luxury instead of "needs manual
  // categorisation". Below €2,500 the bedroom groups take it.
  const luxury = price >= LUXURY_MIN_PRICE
  const luxuryWhy = luxury ? `price ${price} >= ${LUXURY_MIN_PRICE}` : null

  // Houses = every house, villa and the like; apartments (incl. maisonette,
  // penthouse) never count as a house.
  const isApartmentType = APARTMENT_TYPES.includes(type) || APARTMENT_TYPE_RE.test(type)
  const isHouseType = !isApartmentType && (HOUSE_TYPES.includes(type) || HOUSE_TYPE_RE.test(type))

  return { bucket, luxury, luxuryWhy, beds: bedState.value, bedState, type, price, isHouseType, isApartmentType }
}

// ── Gemini: seafront + own_entrance in ONE call ──────────────────────────────

let _ai = null
function getAI() {
  if (_ai) return _ai
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  _ai = new GoogleGenAI({ apiKey: key })
  return _ai
}

// Cheap local hints so we don't burn a Gemini call on the obvious cases.
// Returns true / false / null (null = ambiguous, ask Gemini).
function seafrontHint(desc, type) {
  const d = String(desc || '')
  // explicit negatives first — these phrases are the ones we must NOT trust
  // Includes spelled-out minutes ("few minutes", "5 min", "walking distance")
  // and the "from the seafront" pattern, which is the bug that mis-classified
  // 2906-077 (St Paul's Bay penthouse, "few minutes from the seafront") as
  // seafront. The original regex only caught digit-prefixed minutes and the
  // word "the seafront" as a positive, so a "from the seafront" hit the
  // positive branch. Also rejects "sea view" / "sea glimpse" / "sea
  // overlook" patterns where the property is not on the water.
  // Note: "to the sea" is NOT in negatives — "steps to the sea" is a positive
  // signal and the minutes-based phrase "5 min walk to the sea" is already
  // caught by the digit-minutes pattern.
  //
  // Kev, 2026-09-07: "close to seafront" and "next to the sea" were slipping
  // through as seafront=true. Root cause: the negative list only rejected
  // "close to THE BEACH", never "close to (the) seafront/beachfront/sea" or
  // "next to (the) sea", so those phrases fell through to the bare
  // /\bseafront\b/ positive below and matched anyway. Kev's own definition:
  // only bare "seafront" / "direct seafront" (standing alone, no proximity
  // adjective) counts — anything qualified with close/near/next to is a
  // proximity claim, not a seafront claim.
  //
  // 2026-09-21 — EXPLICIT EVIDENCE ONLY. The verdict now comes from
  // seafrontEvidence(): a seafront claim counts only when the text itself says the
  // property IS on the seafront, judged clause by clause, so a proximity phrase in
  // ANOTHER sentence ("5 min to the bus") no longer cancels a real claim and a
  // locality / marina / "waterfront" / "shoreline" / "sea view" never creates one.
  // This function keeps its old contract for its callers and test:
  //   true  = explicit claim,  false = seafront-ish wording that is NOT a claim
  //   (near / minutes from / view of / glimpse …),  null = no seafront wording at all.
  const ev = seafrontEvidence(d)
  if (ev.verdict !== null) return ev.verdict
  // A property type only counts when it says DIRECT seafront too.
  if (SF_DIRECT_RE.test(String(type || ''))) return true
  return null
}

// ── explicit seafront evidence ───────────────────────────────────────────────
// { verdict: true|false|null, evidence: '<the clause>'|null, why }
// A token is a word that CAN carry a seafront claim. A claim needs a token that
// is not qualified as near / from / view-of / minutes-away in its own clause.
const SF_TOKEN_RE = /\bsea\s*-?front\b/ig
// wording that is about the sea but is NOT a claim of being on it
const SF_NOT_A_CLAIM_RE = /sea\s*glimpse|glimpse\s+of\s+the\s+sea|distant\s+sea|\bsea\s+(?:view|views|overlook\w*|sight)\b|\bviews?\s+(?:of|over)\s+the\s+sea\b|\boverlook\w*\s+the\s+sea\b/i
// qualifiers that turn a token into a proximity statement (checked right around the token)
const SF_BEFORE_DISQ = [
  /\b(?:close|near|nearby|next)\s+(?:to\s+)?(?:the\s+)?$/i,
  /\b(?:easy|direct|private|convenient)?\s*access\s+to\s+(?:the\s+)?$/i,
  /\b(?:from|off|opposite|behind|across\s+from|towards?|steps?\s+from|just\s+off|around\s+the\s+corner\s+from)\s+(?:the\s+)?$/i,
  /\b(?:\d+|a\s+few|few|two|three|four|five|ten|couple\s+of)\s*(?:min(?:ute)?s?|m|metres?|meters?|km|blocks?)\s+(?:walk\s+)?(?:from|to|away\s+from)\s+(?:the\s+)?$/i,
  /\b(?:not|no|isn'?t|non|without)\s+(?:a\s+|on\s+the\s+)?$/i,
  /\bwalking\s+distance\s+(?:to|from)\s+(?:the\s+)?$/i,
  /\b(?:views?|overlook\w*|glimpse)\s+(?:of|over|onto)\s+(?:the\s+)?$/i,
  // a token that ends a list of NEARBY things ("… Tower Road & Seafront", "shops and
  // seafront", "promenade and seafront") is an amenity list, not a claim. Real case
  // 2026-09-21, #2906-9316: the ad said "Only 2 Minutes Walk to Tower Road & Seafront";
  // the sanitizer stripped the distance and left "Only & Seafront".
  /(?:&|\band\b|\bor\b|\bplus\b)\s+(?:the\s+)?$/i,
  /\b(?:only|just)\s+(?:the\s+)?$/i,
]
const SF_AFTER_DISQ = [
  /^\s*(?:is\s+)?(?:only\s+)?(?:\d+|a\s+few|few|two|three|five|ten)\s*(?:min(?:ute)?s?|m|metres?|meters?|km)\b/i,
  /^\s*(?:is\s+)?(?:a\s+)?(?:short\s+)?walk\b/i,
  /^\s*(?:location|area|vicinity|neighbou?rhood|promenade\s+nearby)\b/i,
]

// Kev, 2026-10-19 (said "a hundred times"): ONLY "direct seafront" is seafront.
// "Easy access to Sliema seafront", "seafront apartment", "one of Tigné's best
// seafront addresses" are not. A token counts only when "direct(ly)" sits right
// in front of it: "direct seafront", "directly on the seafront", "DIRECT
// SEAFRONT apartment". Everything else that mentions the seafront is a
// proximity / marketing claim → not seafront.
const SF_DIRECT_BEFORE = /\bdirect(?:ly)?\s+(?:on\s+(?:the\s+)?|facing\s+(?:the\s+)?)?$/i
const SF_DIRECT_RE = /\bdirect(?:ly)?\s+(?:on\s+(?:the\s+)?|facing\s+(?:the\s+)?)?sea\s*-?front\b/i
const SF_DIRECT_NEGATED_BEFORE = /\b(?:not|no|isn'?t|non|never)\s+(?:a\s+)?direct(?:ly)?\s+(?:on\s+(?:the\s+)?|facing\s+(?:the\s+)?)?$/i

function seafrontEvidence(text) {
  const t = String(text || '')
  if (!t.trim()) return { verdict: null, evidence: null, why: 'empty' }
  let sawToken = false
  const clauses = t.split(/(?<=[.;!?])\s+|\n+/)
  for (const clause of clauses) {
    SF_TOKEN_RE.lastIndex = 0
    let m
    while ((m = SF_TOKEN_RE.exec(clause))) {
      sawToken = true
      const before = clause.slice(Math.max(0, m.index - 45), m.index)
      const after = clause.slice(m.index + m[0].length, m.index + m[0].length + 40)
      // Kev, 2026-10-22 ("wenn direct seafront erwähnt wird → IMMER SEAFRONT"):
      // #2906-9519 said "🌊 Direct Seafront Location" and went to Luxury,
      // because SF_AFTER_DISQ read "… Location" as a proximity phrase. A
      // DIRECT claim is only cancelled by an explicit negation ("not direct
      // seafront"); the proximity qualifiers apply to every other wording.
      const direct = SF_DIRECT_BEFORE.test(before)
      const disq = direct
        ? SF_DIRECT_NEGATED_BEFORE.test(before)
        : true   // without "direct(ly)" the seafront word is never a claim (rule of 2026-10-19)
      void after
      // quote the words AROUND the token (a long ad sentence would otherwise be cut before it)
      if (!disq) return { verdict: true, evidence: clause.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).trim(), why: 'explicit_claim' }
    }
  }
  if (sawToken) return { verdict: false, evidence: null, why: 'proximity_only' }
  if (SF_NOT_A_CLAIM_RE.test(t)) return { verdict: false, evidence: null, why: 'sea_view_only' }
  return { verdict: null, evidence: null, why: 'no_seafront_wording' }
}

async function askGemini(payload) {
  const p = payload || {}
  const desc = String(p.description_public || p.description || '')
  const type = String(p.type ?? p.property_type ?? '').toLowerCase().trim()
  const town = p.town || 'Malta'

  const ai = getAI()
  if (!ai) {
    log.warn('categoryClassifier: GEMINI_API_KEY missing → seafront/own_entrance = false')
    return { seafront: false, own_entrance: false }
  }

  const prompt =
`You are classifying a rental property in ${town}, Malta.

Property type: ${type || 'unknown'}
Description:
"""
${desc.slice(0, 2000)}
"""

Answer strictly from the text:

"own_entrance": If the type is a maisonette or unclear, does the property
have its OWN private entrance (not a shared apartment-block entrance)?
If unsure or not mentioned, answer false.

Return ONLY minified JSON, no prose, no code fences:
{"own_entrance":true|false}`

  let lastErr = null
  for (const attempt of GEMINI_ATTEMPTS) {
    try {
      const r = await ai.models.generateContent({
        model: attempt.model,
        contents: prompt,
        config: attempt.config,
      })
      const raw = String(r.text || '').replace(/```json|```/g, '').trim()
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) { lastErr = `no JSON in response: "${raw.slice(0, 80)}"`; continue }
      const j = JSON.parse(m[0])
      if (typeof j.seafront !== 'boolean' && typeof j.own_entrance !== 'boolean') {
        lastErr = `unexpected JSON shape: ${raw.slice(0, 80)}`
        continue
      }
      return { seafront: j.seafront === true, own_entrance: j.own_entrance === true }
    } catch (e) {
      lastErr = e.message
    }
  }

  // Never block: degrade to both-false and carry on.
  log.warn('categoryClassifier: Gemini unavailable → seafront/own_entrance = false',
    { err: String(lastErr || 'unknown').slice(0, 200) })
  return { seafront: false, own_entrance: false }
}

// ── Which of the candidate keys have an ACTIVE category_groups row ───────────

async function activeKeys(keys) {
  if (!keys.length) return null
  try {
    const r = await db.query(
      `SELECT key FROM category_groups WHERE key = ANY($1::text[]) AND active = TRUE`,
      [keys])
    return new Set(r.rows.map(x => x.key))
  } catch (e) {
    // A DB hiccup must not block classification. Returning null means "unknown"
    // — we then keep the precedence winner and let the publisher re-filter.
    log.warn('categoryClassifier: active-group lookup failed, skipping filter', { err: e.message })
    return null
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

// Valid manual-override target keys — the routing categories an
// Agent/Admin can explicitly pick when ARGUS can't confidently classify.
// 'commercial' added 2026-09-23 (ARGUS category hotfix, Kev's explicit
// call) — a genuinely new 7th routing category with its own WhatsApp group
// (Commercials & Special Properties), override-only: nothing auto-detects
// it, same as the other five always did before this.
const OVERRIDE_KEYS = new Set(['seafront', 'villas', 'luxury', 'bed1', 'bed2', 'bed3', 'commercial'])

async function classifyProperty(publicPayload, opts = {}) {
  const manualOverride = opts.manualOverride && OVERRIDE_KEYS.has(opts.manualOverride) ? opts.manualOverride : null

  // ── Manual override short-circuits the whole classifier ──────────────────
  // A routing decision, never a canonical-fact decision: this only picks
  // WHICH WhatsApp group the listing posts to. It does not touch bedrooms/
  // price/type — those stay whatever the Property record actually says.
  if (manualOverride) {
    const active = await activeKeys([manualOverride])
    const winner = (!active || active.has(manualOverride)) ? manualOverride : null
    return {
      keys: winner ? [winner] : [],
      reasoning: `manual override: ${manualOverride}${winner ? '' : ' (group inactive — no post)'}`,
      seafront: manualOverride === 'seafront',
      own_entrance: false,
      villas: manualOverride === 'villas',
      luxury: manualOverride === 'luxury',
      candidates: [manualOverride],
      category_review_required: false,
      manual_override: manualOverride,
    }
  }

  const det = classifyKeys(publicPayload)
  const p = publicPayload || {}
  // Kev, 2026-09-08 (Seafront-Erkennungs-Bug): this used to read
  // description_public ONLY. description_public is built (sanitizer.js
  // buildPublicDescription) from the STRUCTURED properties.description
  // column, not from the raw ad text an agent actually types — that raw
  // text (description_social), headline included ("Beautiful SEAFRONT
  // Apartment...") can say "seafront" while the structured column it feeds
  // description_public from never captured the word at all. Concatenating
  // description_social in is the fix — "title" in this codebase has no
  // separate field, it's the first line of description_social, so scanning
  // that string covers exactly the case the brief describes ("Seafront" in
  // the title). Same seafrontHint() regex logic below, unchanged — this
  // only widens what text it is handed, so the existing direct-vs-proximity
  // distinction ("close to seafront" ≠ "seafront") still applies identically.
  const desc = [p.description_social, p.description_public, p.description].filter(Boolean).join('\n')

  // ── Gemini only where code cannot decide ───────────────────────────────────
  // SEAFRONT NEEDS EXPLICIT EVIDENCE (2026-09-21). Evidence is read from what the
  // AGENT / OWNER wrote (description_social, the ad 1:1); our own generated prose
  // (description_public / description) is only a fallback for rows that never had
  // the raw text. A locality ("Pietà Marina", "Marsalforn"), "waterfront",
  // "shoreline", "seaside", a sea view or "5 min to the sea" is NOT evidence, and
  // Gemini is no longer asked — an LLM will happily call a marina address seafront.
  // Without an explicit claim the answer is simply "not seafront", and the reason
  // and the quoted clause travel with the result (provenance).
  const agentText = String(p.description_social || '').trim()
  const evidenceText = agentText || [p.description_public, p.description].filter(Boolean).join('\n')
  const hint = seafrontHint(evidenceText, det.type)
  const sfEv = seafrontEvidence(evidenceText)
  // "unclear type" = not a named house type and not a named apartment type.
  const typeUnclear = !det.isHouseType && !det.isApartmentType
  const needGemini = desc.trim().length > 10 && typeUnclear   // own_entrance only

  // Kev, 2026-10-22: a "direct seafront" in the agent's own text ALWAYS wins.
  // The old VETO (our generated description says only "seafront apartment"
  // → disagreement → not seafront) is what kept #2906-9519 out of the Sea
  // Front group. It existed for sanitizer-damaged proximity text; since only
  // "direct seafront" can be a claim at all, no sanitizer cut can create one.
  let seafront = hint === true
  let sfBasis = null
  let ownEntrance = false
  let geminiUsed = false

  if (needGemini) {
    const g = await askGemini(publicPayload)
    geminiUsed = true
    ownEntrance = g.own_entrance
  }

  // villas = standalone house/villa. Either it is named as one, or its type is
  // unclear AND it has its own entrance. A named apartment type (incl.
  // maisonette) never becomes a villa, own entrance or not.
  const villas = det.isHouseType || (typeUnclear && ownEntrance && !det.isApartmentType)

  // ── candidates, then ONE winner by precedence ─────────────────────────────
  // det.bucket is now null when bedrooms are UNKNOWN/CONFLICTING (2026-09-17
  // fix) — it is NO LONGER an unconditional final fallback. seafront/villas
  // don't need bedrooms at all, so they can still win independently; luxury
  // needs a known bedroom count (for the right threshold) so it's absent
  // too when bedrooms aren't known. If nothing else qualifies, `ordered`
  // comes back empty and this property needs a human, not a guess.
  const candidates = []
  if (seafront)   candidates.push('seafront')
  if (villas)     candidates.push('villas')
  if (det.luxury) candidates.push('luxury')
  if (det.bucket) candidates.push(det.bucket)

  const ordered = PRECEDENCE.filter(k => candidates.includes(k))
  const active  = await activeKeys(ordered)
  // first candidate in precedence order whose group is active; if the active
  // lookup failed (null) just take the precedence winner.
  const winner = active
    ? (ordered.find(k => active.has(k)) || null)
    : (ordered[0] || null)

  const skipped = ordered.filter(k => k !== winner)
  const categoryReviewRequired = !winner

  const bits = [`beds=${det.beds ?? 'unknown'} (${det.bedState.state})`, `type=${det.type || 'unknown'}`, `price=${det.price || 'n/a'}`]
  if (categoryReviewRequired) bits.push('⚠ CATEGORY_REVIEW_REQUIRED — bedrooms not confidently known and no seafront/villa/luxury signal')
  if (det.bedState.state === 'CONFLICTING') bits.push(`bedroom fields conflict: beds=${det.bedState.beds} vs bedrooms=${det.bedState.bedrooms}`)
  if (det.bedState.state === 'LOW_CONFIDENCE') bits.push(`low-confidence bedroom source: only a 'beds' field present, no 'bedrooms'`)
  bits.push(`candidates=[${ordered.join(' > ') || 'none'}]`)
  bits.push(`→ ${winner || 'no active group'}`)
  if (det.luxury) bits.push(`luxury: ${det.luxuryWhy}`)
  if (villas) bits.push(det.isHouseType ? 'villas: named house/villa' : 'villas: own entrance, unclear type')
  if (det.type === 'maisonette') bits.push('maisonette counted as apartment')
  bits.push(`seafront=${seafront} (${seafront ? `explicit: "${sfEv.evidence || 'property type'}"` : (sfBasis || sfEv.why)})`)
  if (geminiUsed) bits.push(`own_entrance=${ownEntrance}`)
  if (skipped.length) bits.push(`outranked: ${skipped.join(', ')}`)

  return {
    // still an array so publisher/handler contracts are unchanged — but it now
    // holds AT MOST ONE key. One property, one group. Empty when
    // category_review_required is true (2026-09-17: previously this could
    // never be empty, because det.bucket was an unconditional fallback that
    // defaulted unknown bedrooms to bed1).
    keys: winner ? [winner] : [],
    reasoning: bits.join('; '),
    seafront,
    // provenance for the one fact that decides the highest-precedence group
    seafront_evidence: seafront ? (sfEv.evidence || null) : null,
    seafront_basis: seafront ? (agentText ? 'agent_text' : 'fallback_text') : (sfBasis || sfEv.why),
    own_entrance: ownEntrance,
    villas,
    luxury: det.luxury,
    candidates: ordered,
    category_review_required: categoryReviewRequired,
    bedroom_status: det.bedState.state,
    manual_override: null,
  }
}

module.exports = { classifyProperty, classifyKeys, bedroomStatus, seafrontHint, seafrontEvidence, PRECEDENCE, OVERRIDE_KEYS }
