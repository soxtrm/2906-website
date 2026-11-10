'use strict'

// ============================================================================
// services/ownerQualityReport.js — weekly Owner Conversation Quality report
// (Claude, 2026-11-10, Owner AI recalibration).
//
// Measured, never invented: every number comes from the stored owner
// conversations (owner_auto_conversations._log), the decision audit
// (owner_ai_decisions), the facts-engine outbound guard and the suppression
// list for the period. Cases are anonymised (no phone, no address, no names);
// the internal conversation id is kept only behind the admin API.
//
// Schedule: Monday 08:30 Europe/Malta over the previous seven calendar days,
// persisted in owner_ai_quality_schedule (survives restarts). Reports are
// immutable rows; founder reviews are append-only and approved corrections
// become fixture candidates for the NEXT release — never a live policy edit.
// ============================================================================

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('../db')
const log = require('../logger')
const { decide, maltaParts, insideWindow, POLICY_VERSION, identityQuestionKind, _RE: RE } = require('./ownerDecision')
const { redact } = require('./ownerDecisionRuntime')

const TZ = 'Europe/Malta'
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 }
const NEUTRAL_IDENTITY = { persona: 'kev', name: 'Agent', agency: 'Agency', affiliationVerified: true }

const FIELD_Q = {
  bedrooms: /\bhow\s+many\s+bedrooms\b/i,
  bathrooms: /\bhow\s+many\s+bathrooms\b/i,
  price: /\b(?:monthly\s+rent|rent\s+per\s+month|rent\s+be\b|asking\s+(?:price|rent))\b/i,
  permit: /\bpermits?\b|\blicen[cs]es?\b|\bpermit\s+pdfs?\b/i,
  sharing: /\bprofessional\s+sharing\b/i,
  sublet: /\bsublet/i,
}
const ANY_FIELD_Q = /\bhow\s+many\b|\bwhich\s+town\b|\bwhen\s+(?:would|could)\b|\bmonthly\s+rent\b|\brent\s+per\s+month\b|\bphotos?\b.*\?|\baddress\b.*\?|\bpermit|\blicen[cs]e|\bprofessional\s+sharing\b|\bpets?\b.*\?|\bsublet/i
const RESIDENTIAL = /\b(?:bed(?:room)?s?|bath(?:room)?s?|apartment|flat|villa|bungalow|maisonette|penthouse|studio|townhouse|house|residential|duplex)\b/i
const COMMERCIAL = /\b(?:commercial|office\s+space|shop|retail|warehouse|showroom|industrial|garage\s+(?:for\s+rent|to\s+let)|class\s+\d|permit)\b/i
const FORBIDDEN = /\bon\s+appointments\b|\bsorry\s+for\s+(?:the\s+)?spam\b|\bone\s+last\s+question\b|\bsubletting\s+compan/i

function sha(s, n = 10) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n) }
function anonymise(text) {
  return redact(text)
    .replace(/\b(Hi|Hello|Dear|Hey|Good\s+(?:morning|afternoon|evening|day))\s+[A-Z][a-z]+/g, '$1 [name]')
    .replace(/\b(?:my\s+name\s+is|I'?m|this\s+is)\s+([A-Z][a-z]+)\b(?!\s+(?:agent|consultant))/g, m => m.replace(/[A-Z][a-z]+$/, '[name]'))
    .slice(0, 280)
}

// Previous seven calendar days in Malta, ending yesterday.
function periodFor(now = new Date()) {
  const p = maltaParts(now)
  const todayMalta = Date.UTC(p.year, p.month - 1, p.day)
  const to = new Date(todayMalta - 86400000)
  const from = new Date(todayMalta - 7 * 86400000)
  const iso = d => d.toISOString().slice(0, 10)
  return { from: iso(from), to: iso(to) }
}
function maltaMidnightUtc(isoDate) {
  // Find the UTC instant of 00:00 Malta on isoDate (DST-safe).
  const [y, m, d] = isoDate.split('-').map(Number)
  for (const off of [1, 2]) {
    const t = new Date(Date.UTC(y, m - 1, d, -off, 0))
    const q = maltaParts(t)
    if (q.hour === 0 && q.minute === 0 && q.day === d) return t
  }
  return new Date(Date.UTC(y, m - 1, d, -1, 0))
}
function nextMondayRun(after = new Date()) {
  // Next Monday 08:30 Europe/Malta strictly after `after`.
  for (let i = 0; i < 8; i++) {
    const day = new Date(after.getTime() + i * 86400000)
    const q = maltaParts(day)
    const iso = `${q.year}-${String(q.month).padStart(2, '0')}-${String(q.day).padStart(2, '0')}`
    const midnight = maltaMidnightUtc(iso)
    const run = new Date(midnight.getTime() + (8 * 60 + 30) * 60000)
    if (maltaParts(run).weekday === 'Mon' && run > after) return run
  }
  return new Date(after.getTime() + 7 * 86400000)
}

function codeHash() {
  try {
    const h = crypto.createHash('sha256')
    for (const f of ['ownerDecision.js', 'ownerDecisionRuntime.js', 'ownerTurnRouter.js']) h.update(fs.readFileSync(path.join(__dirname, f)))
    return h.digest('hex').slice(0, 16)
  } catch { return 'unavailable' }
}

// ── detectors over one conversation log ──────────────────────────────────────
function analyseConversation(conv, range, personaAgency) {
  const out = { cases: [], counts: {}, ownerBursts: 0, botMessages: 0, good: [] }
  const add = (kind, severity, extra) => {
    out.counts[kind] = (out.counts[kind] || 0) + 1
    out.cases.push({ kind, severity, conversation_id: conv.id, session: conv.session, ...extra })
  }
  const entries = (conv.log || []).filter(e => e && e.at && e.text != null)
  let ownerSince = []
  let ownerHistory = ''
  let lastBot = null
  for (const e of entries) {
    const at = new Date(e.at)
    const inRange = at >= range.from && at < range.to
    if (e.from === 'owner') {
      ownerSince.push(String(e.text)); ownerHistory += `\n${e.text}`
      if (inRange) out.ownerBursts++
      continue
    }
    if (e.from !== 'bot') continue
    const b = String(e.text)
    const owner = ownerSince.join('\n')
    if (inRange) {
      out.botMessages++
      const base = { at: e.at, inbound: anonymise(owner), outbound: anonymise(b), stored: snapshot(conv.checklist) }
      let d = null
      if (owner.trim()) {
        try { d = decide({ messages: [owner], context: { now: new Date('2026-11-10T10:00:00Z'), identity: NEUTRAL_IDENTITY } }) } catch { d = null }
      }
      const isQuestion = ANY_FIELD_Q.test(b) && /\?\s*$/.test(b.trim())
      if (FORBIDDEN.test(b)) add('forbidden_copy', /appointments/i.test(b) ? 'P1' : 'P1', { ...base, rule: 'fabricated status / spam pitch in an automated message', expected: d ? `${d.next_action}/${d.reason_code}` : 'NO_SEND' })
      if (FIELD_Q.permit.test(b) && RESIDENTIAL.test(ownerHistory) && !COMMERCIAL.test(ownerHistory)) add('residential_permit_questions', 'P1', { ...base, rule: 'commercial permit question for a residential property', expected: 'continue residential intake; never ask permits' })
      if (FIELD_Q.bedrooms.test(b) && /\bstudio\b/i.test(ownerHistory) && !/\bwas\s+(?:a\s+)?studio\b/i.test(ownerHistory)) add('room_studio_misinterpretations', 'P1', { ...base, rule: 'asked bedrooms for a studio', expected: 'ACKNOWLEDGE_UPDATE/STUDIO_EXPLICIT' })
      if (FIELD_Q.sharing.test(b) && /\b(?:single|double|twin)\s+room\b|\broom\s+in\b|\bshar(?:ed|ing)\s+(?:apartment|flat)\b/i.test(ownerHistory)) add('room_studio_misinterpretations', 'P1', { ...base, rule: 'asked professional sharing for a room that is already shared', expected: 'ACKNOWLEDGE_UPDATE/ROOM_NOT_ENTIRE_APARTMENT' })
      if (FIELD_Q.bedrooms.test(b) && /\b(?:\d+|one|two|three|four|five)[- ]?(?:bed(?:room)?s?|br)\b/i.test(ownerHistory)) add('unnecessary_questions', 'P2', { ...base, rule: 'asked bedrooms after the owner already gave them', expected: 'QUESTION_ALREADY_ANSWERED' })
      if (FIELD_Q.bathrooms.test(b) && /\b(?:\d+|one|two|three|four)\s+bath(?:room)?s?\b/i.test(ownerHistory)) add('unnecessary_questions', 'P2', { ...base, rule: 'asked bathrooms after the owner already gave them', expected: 'QUESTION_ALREADY_ANSWERED' })
      if (FIELD_Q.sublet.test(b)) add('unnecessary_questions', 'P1', { ...base, rule: 'subletting pitch to an owner', expected: 'no subletting pitch' })
      if (/couldn'?t\s+open\s+that\s+file/i.test(b)) add('media_state_errors', 'P1', { ...base, rule: 'media/file claim that re-asks already-known facts', expected: 'WAIT_FOR_MEDIA (no re-ask)' })
      if (d && isQuestion) {
        if (d.reason_code === 'OWNER_DIRECT_QUESTION' && d.next_action !== 'HUMAN_HANDOFF' || identityQuestionKind(owner) || RE.clarification.test(owner)) add('direct_questions_ignored', 'P1', { ...base, rule: 'owner asked a direct question; the bot asked an intake question instead', expected: `${d.next_action}/${d.reason_code}` })
        if (d.reason_code === 'VIEWING_OFFER' || d.reason_code === 'CALLBACK_REQUEST') add('missed_viewing_offers', 'P1', { ...base, rule: 'owner offered a viewing/call; the bot kept asking', expected: `HUMAN_HANDOFF/${d.reason_code}` })
        if (d.reason_code === 'PRICE_CORRECTION' && FIELD_Q.price.test(b)) add('owner_price_correction_missed', 'P1', { ...base, rule: 'owner gave/corrected the price; the bot asked for it', expected: 'ACKNOWLEDGE_UPDATE/PRICE_CORRECTION' })
        if (['LONG_TERM_RENTED', 'NO_REPLY_REQUIRED'].includes(d.reason_code) && d.next_action === 'NO_SEND') add('unnecessary_questions', 'P1', { ...base, rule: 'owner closed the topic; the bot asked another question', expected: `NO_SEND/${d.reason_code}` })
        if (d.next_action === 'DNC') add('dnc_violations', 'P0', { ...base, rule: 'message after an opt-out', expected: 'DNC (no message)' })
      }
      if (d && d.next_action === 'DNC' && !isQuestion && !/will\s+not\s+contact/i.test(b)) add('dnc_violations', 'P0', { ...base, rule: 'message after an opt-out', expected: 'DNC (no message)' })
      if (/sorry\s+to\s+hear/i.test(b) && d && ['AVAILABLE_CONFIRMED', 'PRICE_CORRECTION', 'FUTURE_VACANCY', 'VIEWING_OFFER'].includes(d.reason_code)) add('false_unavailable', 'P0', { ...base, rule: 'negative sympathy for a positive availability statement', expected: `${d.next_action}/${d.reason_code}` })
      if (!insideWindow(at)) add('quiet_hours_violations', 'P1', { ...base, rule: 'automated owner message outside 08:30–19:00 Malta', expected: 'DEFER' })
      if (lastBot && lastBot.text === b) add('duplicate_replies', 'P2', { ...base, rule: 'identical bot message repeated', expected: 'NO_SEND' })
      else if (lastBot && (at - new Date(lastBot.at)) < 10000 && !ownerSince.length) add('duplicate_replies', 'P2', { ...base, rule: 'two automated messages in one burst', expected: 'one message per burst' })
      const agencyHit = b.match(/\brepresenting\s+([A-Z][\w' ]+?)\s+in\s+Malta\b/)
      if (agencyHit && personaAgency && !agencyHit[1].toLowerCase().includes(personaAgency.toLowerCase())) add('wrong_agency', 'P0', { ...base, rule: `named ${agencyHit[1]} from a ${personaAgency} account`, expected: 'verified sender identity only' })
      if (d && d.next_action === 'ANSWER_DIRECT' && !isQuestion && !FORBIDDEN.test(b)) out.good.push({ ...base, kind: 'direct_answer', reason: d.reason_code })
    }
    lastBot = { text: b, at: e.at }
    ownerSince = []
  }
  return out
}

function snapshot(c) {
  if (!c) return {}
  const keep = ['price', 'bedrooms', 'bathrooms', 'town', 'available_date', 'property_category', 'listing_kind', 'property_subtype', 'transaction_type', 'availability_status', 'viewing_status', 'pets']
  return Object.fromEntries(keep.filter(k => c[k] != null).map(k => [k, c[k]]))
}

async function personaAgencies() {
  const map = {}
  try {
    const { PERSONA_IDENTITIES } = require('./agentIdentityRegistry')
    const r = await db.query(`SELECT lower(session_name) s, lower(COALESCE(account_persona,'')) p FROM whatsapp_accounts`)
    for (const row of r.rows) map[row.s] = PERSONA_IDENTITIES[row.p]?.agency || null
  } catch (err) { log.warn('ownerQualityReport persona map failed', { err: err.message }) }
  return map
}

async function measure(range) {
  const agencies = await personaAgencies()
  const convs = (await db.query(
    `SELECT id, session, status, checklist, checklist->'_log' AS log FROM owner_auto_conversations
      WHERE updated_at >= $1 AND created_at < $2`, [range.from, range.to])).rows
  const agg = { cases: [], counts: {}, ownerBursts: 0, botMessages: 0, good: [], conversations: 0 }
  for (const c of convs) {
    const r = analyseConversation(c, range, agencies[String(c.session || '').toLowerCase()])
    if (r.ownerBursts || r.botMessages) agg.conversations++
    agg.ownerBursts += r.ownerBursts; agg.botMessages += r.botMessages
    agg.cases.push(...r.cases); agg.good.push(...r.good)
    for (const [k, v] of Object.entries(r.counts)) agg.counts[k] = (agg.counts[k] || 0) + v
  }
  // Facts-engine replies: "removed the property" for an owner who said it is available / a shared place.
  try {
    const g = await db.query(
      `SELECT g.created_at, g.draft, s.sender_account_id, r.body FROM conversation_outbound_guard g
         JOIN conversation_intelligence_state s ON s.id=g.state_id
         LEFT JOIN conversation_message_revisions r ON r.state_id=g.state_id AND r.source_message_id=g.source_message_id
        WHERE g.status='SENT' AND g.created_at >= $1 AND g.created_at < $2`, [range.from, range.to])
    for (const row of g.rows) {
      agg.botMessages++
      if (/removed the property/i.test(row.draft || '') && /\bavailable\b|\bshare\b|\broom\b|\banother\s+(?:girl|guy|person)\b|\bcoming\s+available\b/i.test(row.body || '')) {
        agg.counts.false_unavailable = (agg.counts.false_unavailable || 0) + 1
        agg.cases.push({ kind: 'false_unavailable', severity: 'P0', conversation_id: null, session: row.sender_account_id, at: row.created_at,
          inbound: anonymise(row.body), outbound: anonymise(row.draft), stored: {}, rule: 'facts engine marked a still-offered property as removed', expected: 'ACKNOWLEDGE_UPDATE (shared place / available) or HUMAN_HANDOFF' })
      }
    }
  } catch (err) { log.warn('ownerQualityReport guard scan failed', { err: err.message }) }
  const dec = (await db.query(
    `SELECT next_action, reason_code, sent, block_reason, count(*)::int n FROM owner_ai_decisions
      WHERE created_at >= $1 AND created_at < $2 GROUP BY 1,2,3,4`, [range.from, range.to]).catch(() => ({ rows: [] }))).rows
  let dnc = 0
  try { dnc = (await db.query(`SELECT count(*)::int n FROM global_contact_suppressions WHERE first_requested_at >= $1 AND first_requested_at < $2`, [range.from, range.to])).rows[0].n } catch { dnc = 0 }
  return { ...agg, decisions: dec, dncEvents: dnc }
}

function indicatorsFrom(m) {
  const n = k => m.counts[k] || 0
  const decN = pred => m.decisions.filter(pred).reduce((s, r) => s + r.n, 0)
  return {
    direct_questions_ignored: n('direct_questions_ignored'),
    false_unavailable: n('false_unavailable'),
    owner_price_correction_missed: n('owner_price_correction_missed'),
    room_studio_misinterpretations: n('room_studio_misinterpretations'),
    residential_permit_questions: n('residential_permit_questions'),
    missed_viewing_offers: n('missed_viewing_offers'),
    media_state_errors: n('media_state_errors'),
    unnecessary_questions: n('unnecessary_questions'),
    forbidden_copy: n('forbidden_copy'),
    quiet_hours_violations: n('quiet_hours_violations'),
    quiet_hours_blocked: decN(r => r.next_action === 'DEFER' && r.reason_code === 'OUT_OF_HOURS') + decN(r => r.block_reason === 'quiet_hours'),
    dnc_events: m.dncEvents + decN(r => r.next_action === 'DNC'),
    dnc_violations: n('dnc_violations'),
    human_takeover_violations: decN(r => r.reason_code === 'HUMAN_ACTIVE' && r.sent),
    duplicate_replies: n('duplicate_replies'),
    wrong_agency: n('wrong_agency'),
    messages_suppressed: decN(r => !r.sent && ['NO_SEND', 'DNC', 'DEFER', 'WAIT_FOR_MEDIA'].includes(r.next_action)),
    human_handoffs: decN(r => r.next_action === 'HUMAN_HANDOFF'),
  }
}

async function generate({ now = new Date(), trigger = 'manual', createdBy = null, period = null } = {}) {
  const p = period || periodFor(now)
  const range = { from: maltaMidnightUtc(p.from), to: new Date(maltaMidnightUtc(p.to).getTime() + 86400000) }
  const prevRange = { from: new Date(range.from.getTime() - 7 * 86400000), to: range.from }
  const [m, prev] = await Promise.all([measure(range), measure(prevRange)])
  const indicators = indicatorsFrom(m)
  const prevIndicators = indicatorsFrom(prev)
  const reg = (await db.query(`SELECT release, policy_version, code_hash, results, created_at FROM owner_ai_regression_runs ORDER BY id DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0] || null
  const releasedAt = reg ? new Date(reg.created_at) : null
  const cases = m.cases
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || String(b.at).localeCompare(String(a.at)))
    .map(c => ({
      case_id: `C-${sha(`${c.conversation_id}:${c.at}:${c.kind}`)}`, severity: c.severity, kind: c.kind, reason: c.rule,
      at: c.at, session: c.session, inbound_excerpt: c.inbound, outbound_excerpt: c.outbound, stored_facts: c.stored,
      actual_action: 'SENT (legacy checklist flow)', expected_action: c.expected,
      produced_by: !releasedAt || new Date(c.at) < releasedAt ? 'pre-recalibration release (legacy checklist flow)' : `${reg.release} / ${reg.policy_version}`,
      secure_chat_ref: c.conversation_id ? `owner_auto_conversations:${c.conversation_id}` : null,
    }))
  const good = m.good.slice(0, 10).map(g => ({ case_id: `G-${sha(`${g.at}:${g.outbound}`)}`, kind: 'GOOD', reason: g.reason, at: g.at, inbound_excerpt: g.inbound, outbound_excerpt: g.outbound }))
  const counts = { P0: cases.filter(c => c.severity === 'P0').length, P1: cases.filter(c => c.severity === 'P1').length, P2: cases.filter(c => c.severity === 'P2').length }
  const reviewed = (await db.query(`SELECT decision, count(*)::int n FROM owner_ai_quality_reviews WHERE created_at >= $1 GROUP BY 1`, [range.from]).catch(() => ({ rows: [] }))).rows
  const report = {
    tenant_scope: '2906 (ARGUS owner conversations)',
    period: { from: p.from, to: p.to, timezone: TZ },
    runtime: {
      backend_release: process.env.ARGUS_RELEASE || 'owner-ai-recal-20261110',
      model_id: 'deterministic owner-decision (no model); legacy field phrasing: gemini-2.5-flash',
      prompt_hash: codeHash(), policy_version: POLICY_VERSION,
    },
    denominators: {
      conversations: m.conversations, eligible_owner_inbound_bursts: m.ownerBursts, auto_replies: m.botMessages,
      decision_layer_turns: m.decisions.reduce((s, r) => s + r.n, 0), manual_handoffs: indicators.human_handoffs,
    },
    indicators, previous_period: { indicators: prevIndicators, denominators: { eligible_owner_inbound_bursts: prev.ownerBursts, auto_replies: prev.botMessages } },
    severity_counts: counts,
    cases: cases.slice(0, 200),
    golden_examples: [...cases.slice(0, 10).map(c => ({ ...c, kind: `BAD:${c.kind}` })), ...good].slice(0, 20),
    review: { approved_corrections: reviewed.find(r => r.decision === 'correct')?.n || 0, approved: reviewed.find(r => r.decision === 'approve')?.n || 0, blocked: reviewed.find(r => r.decision === 'block')?.n || 0, pending: cases.length },
    regression: reg,
    release_decision: counts.P0 > 0 ? 'HOLD' : counts.P1 > 0 ? 'REVIEW_REQUIRED' : 'ELIGIBLE_AFTER_GATES',
  }
  const digest = `Owner AI: ${cases.length} issues need review; ${counts.P0} P0; ${good.length} good examples preserved (${p.from} – ${p.to}, ${m.ownerBursts} owner bursts, ${m.botMessages} automated replies).`
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO owner_ai_quality_reports (id, trigger, created_by, period_from, period_to, timezone, report, digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [id, trigger, createdBy, p.from, p.to, TZ, JSON.stringify(report), digest])
  return { id, digest, report }
}

// P0 cases do not wait for Monday: every 10 minutes the last 20 minutes are
// scanned and each P0 becomes one open incident (deduplicated by case key).
async function scanIncidents(now = new Date()) {
  const range = { from: new Date(now.getTime() - 20 * 60000), to: now }
  const m = await measure(range)
  let created = 0
  for (const c of m.cases.filter(x => x.severity === 'P0')) {
    const key = `C-${sha(`${c.conversation_id}:${c.at}:${c.kind}`)}`
    const r = await db.query(
      `INSERT INTO owner_ai_quality_incidents (severity, kind, conversation_id, session, detail, case_key) VALUES ('P0',$1,$2,$3,$4,$5)
       ON CONFLICT (case_key) DO NOTHING RETURNING id`, [c.kind, c.conversation_id, c.session, `${c.rule}: ${c.outbound}`.slice(0, 500), key]).catch(() => ({ rows: [] }))
    if (r.rows.length) created++
  }
  return { created }
}

// Called every minute by cron.js; generates at most once per due slot.
async function tick(now = new Date()) {
  if (now.getUTCMinutes() % 10 === 0) await scanIncidents(now).catch(err => log.warn('ownerQualityReport incident scan failed', { err: err.message }))
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const r = await client.query(`SELECT * FROM owner_ai_quality_schedule WHERE id='weekly_owner_ai' FOR UPDATE SKIP LOCKED`)
    const row = r.rows[0]
    if (!row || new Date(row.next_run_at) > now) { await client.query('ROLLBACK'); return { ran: false } }
    const next = nextMondayRun(now)
    await client.query(`UPDATE owner_ai_quality_schedule SET next_run_at=$1, last_run_at=NOW(), updated_at=NOW() WHERE id='weekly_owner_ai'`, [next])
    await client.query('COMMIT')
    const out = await generate({ now, trigger: 'scheduled', createdBy: 'schedule' })
    await db.query(`UPDATE owner_ai_quality_schedule SET last_report_id=$1 WHERE id='weekly_owner_ai'`, [out.id])
    log.info('ownerQualityReport: weekly report generated', { id: out.id, digest: out.digest })
    return { ran: true, id: out.id, next }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log.warn('ownerQualityReport tick failed', { err: err.message })
    return { ran: false, error: err.message }
  } finally { client.release() }
}

async function list(limit = 20) {
  const r = await db.query(`SELECT id, created_at, trigger, period_from, period_to, digest, report->'severity_counts' AS severity_counts, report->>'release_decision' AS release_decision FROM owner_ai_quality_reports ORDER BY created_at DESC LIMIT $1`, [limit])
  const s = (await db.query(`SELECT next_run_at, last_run_at, last_report_id, cron, timezone FROM owner_ai_quality_schedule WHERE id='weekly_owner_ai'`)).rows[0] || null
  const inc = (await db.query(`SELECT id, created_at, severity, kind, session, detail FROM owner_ai_quality_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`).catch(() => ({ rows: [] }))).rows
  return { reports: r.rows, schedule: s, open_incidents: inc }
}

async function get(id) {
  const r = await db.query(`SELECT * FROM owner_ai_quality_reports WHERE id=$1`, [id])
  if (!r.rows[0]) return null
  const reviews = (await db.query(`SELECT DISTINCT ON (case_id) case_id, decision, corrected_action, corrected_reply, note, reviewer, created_at FROM owner_ai_quality_reviews WHERE report_id=$1 ORDER BY case_id, created_at DESC`, [id])).rows
  return { ...r.rows[0], reviews }
}

async function review(id, caseId, { decision, correctedAction = null, correctedReply = null, note = null }, reviewer) {
  if (!['approve', 'correct', 'block'].includes(decision)) { const e = new Error('decision must be approve, correct or block'); e.status = 400; throw e }
  const rep = await get(id)
  if (!rep) { const e = new Error('report not found'); e.status = 404; throw e }
  const c = (rep.report.cases || []).find(x => x.case_id === caseId)
  if (!c) { const e = new Error('case not found in this report'); e.status = 404; throw e }
  const ins = await db.query(
    `INSERT INTO owner_ai_quality_reviews (report_id, case_id, decision, corrected_action, corrected_reply, note, reviewer) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [id, caseId, decision, correctedAction, correctedReply ? String(correctedReply).slice(0, 1000) : null, note ? String(note).slice(0, 1000) : null, reviewer])
  if (decision !== 'block') {
    const fixture = {
      id: `REVIEW-${caseId}`, group: c.kind, latest_inbound_burst: c.inbound_excerpt, relevant_prior_context: `Weekly report ${rep.period_from}..${rep.period_to}; stored facts ${JSON.stringify(c.stored_facts || {})}`,
      expected_action: (correctedAction || c.expected_action || '').split('/')[0] || 'HUMAN_HANDOFF', expected_reason_code: (correctedAction || c.expected_action || '').split('/')[1] || 'CONFLICT_REQUIRES_REVIEW',
      expected_fact_deltas: {}, reply_must_contain_any: [], reply_must_not_contain: c.outbound_excerpt ? [c.outbound_excerpt.slice(0, 60)] : [],
      expected_dispatch_blocked: ['NO_SEND', 'DEFER', 'DNC'].includes(((correctedAction || c.expected_action || '').split('/')[0])), review_notes: note || '', fixture_class: 'FOUNDER_WEEKLY_REVIEW',
      approved_reply: correctedReply || null,
    }
    await db.query(`INSERT INTO owner_ai_fixture_candidates (review_id, fixture) VALUES ($1,$2::jsonb)`, [ins.rows[0].id, JSON.stringify(fixture)])
  }
  return { id: ins.rows[0].id, created_at: ins.rows[0].created_at, case_id: caseId, decision }
}

// Anonymised export: no conversation ids, no sessions, no phone fragments.
function exportable(rep) {
  const r = rep.report
  return {
    report_id: rep.id, generated_at: rep.created_at, period: r.period, runtime: r.runtime, denominators: r.denominators,
    indicators: r.indicators, severity_counts: r.severity_counts, release_decision: r.release_decision,
    cases: (r.cases || []).map(({ secure_chat_ref, session, ...c }) => c),
    golden_examples: (r.golden_examples || []).map(({ secure_chat_ref, session, ...c }) => c),
    review: r.review,
  }
}

async function recordIncident({ severity = 'P0', kind, conversationId = null, session = null, detail = null }) {
  try { await db.query(`INSERT INTO owner_ai_quality_incidents (severity, kind, conversation_id, session, detail) VALUES ($1,$2,$3,$4,$5)`, [severity, kind, conversationId, session, detail ? String(detail).slice(0, 500) : null]) }
  catch (err) { log.warn('ownerQualityReport incident write failed', { err: err.message }) }
}

module.exports = { generate, tick, scanIncidents, list, get, review, exportable, recordIncident, periodFor, nextMondayRun, maltaMidnightUtc, analyseConversation, indicatorsFrom, codeHash }
