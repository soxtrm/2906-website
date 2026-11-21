'use strict'
// ============================================================================
// services/ownerRecheck7d.js — the weekly owner recheck (Kev, 2026-11-18)
//
// Kev's rules, in his words, turned into code:
//   * Every listing is rechecked about every 7 days (6-8, stable per listing so a
//     backlog does not all land on one morning). Never on a Sunday. The clock is
//     the listing's own last owner confirmation, not "somebody wrote to this owner".
//   * One message per owner. An owner with several listings is asked once
//     "which of your properties are still available?" with a numbered list and
//     the 2906.estate link of each. The reply is matched by number, ref, town,
//     bedrooms or price; what is clearly recognised is applied, what is not goes
//     to Kev (owner_recheck_tasks + alert). Never a guess.
//   * Send from whatever account is up. The account the owner talked to is
//     preferred; when it is offline another account with history, then an
//     outreach account, sends it. No more waiting for one dead session.
//   * After "yes, still available": "how are the viewings going, lots or few?",
//     then the pitch ("what if I bring you exactly the tenants you want — what
//     would you want, and at what price?"), then the price is updated.
//     Asked at most once every 60 days per owner, so the weekly check stays short.
//   * An owner reply that answers us without saying it is rented counts as
//     "still available" (impliesAvailable, used by availability.js too).
//   * "No / nothing / sorry" with no data in it must not leave the chat unread.
//
// Safety rails kept: AVAILABILITY_AUTO_REACHOUT=1 (break-glass, else dry run),
// reachout_settings.daily_cap (0 = off), 09:00-19:00 Malta Mon-Sat, ownerSendGate
// (DNC, stop, human-active, cancelled chat), one open conversation per owner,
// published + active + not staging + not unverified intake only.
// ============================================================================

const db  = require('../db')
const log = require('../logger')

const ARMED = () => process.env.AVAILABILITY_AUTO_REACHOUT === '1'
const WINDOW_START = 9
const WINDOW_END = 19             // exclusive
const OWNERS_PER_PASS = 2
const ENV_CAP = () => Number(process.env.RECHECK7D_DAILY_CAP || 40)
const PITCH_EVERY_DAYS = 60
const THREAD_TIMEOUT_DAYS = 4     // an unanswered step stops blocking after this
const SOURCE = 'auto_inactivity'  // single-listing checks reuse the existing reply pipeline
const FIRST_CONTACT = (process.env.AV_FIRST_CONTACT_ACCOUNTS || 'Kevsecond,kevthirdd').split(',').map(s => s.trim()).filter(Boolean)
const LAST_RESORT = ['default']
const MAX_LIST = 8

// ── schema ───────────────────────────────────────────────────────────────────
let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS owner_recheck_threads (
      id BIGSERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      session TEXT,
      chat_id TEXT,
      stage TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'single',
      property_ids INTEGER[] NOT NULL DEFAULT '{}',
      confirmed_ids INTEGER[] NOT NULL DEFAULT '{}',
      rented_ids INTEGER[] NOT NULL DEFAULT '{}',
      snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      check_id INTEGER,
      prompt_text TEXT,
      last_reply TEXT,
      outcome TEXT,
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      sent_at TIMESTAMPTZ,
      step_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS owner_recheck_threads_owner_idx ON owner_recheck_threads(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS owner_recheck_threads_open_idx ON owner_recheck_threads(stage) WHERE closed_at IS NULL;
    CREATE TABLE IF NOT EXISTS owner_recheck_thread_events (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES owner_recheck_threads(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS owner_recheck_thread_events_idx ON owner_recheck_thread_events(thread_id, created_at);
  `)
  schemaReady = true
}

async function event(threadId, type, detail = {}) {
  await db.query(`INSERT INTO owner_recheck_thread_events(thread_id,event_type,detail) VALUES($1,$2,$3::jsonb)`,
    [threadId, type, JSON.stringify(detail)]).catch(err => log.warn('[recheck7d] event write failed', { err: err.message }))
}

// ── time ─────────────────────────────────────────────────────────────────────
function maltaParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', hour: '2-digit', hour12: false })
  const parts = Object.fromEntries(f.formatToParts(d).map(p => [p.type, p.value]))
  return { weekday: parts.weekday, hour: parseInt(parts.hour, 10) }
}
function sendWindow(d = new Date()) {
  const { weekday, hour } = maltaParts(d)
  if (weekday === 'Sun') return { ok: false, reason: 'sunday' }
  if (hour < WINDOW_START || hour >= WINDOW_END) return { ok: false, reason: 'outside_window' }
  return { ok: true }
}
function greeting(d = new Date()) {
  const { hour } = maltaParts(d)
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}
// 6.0-8.0 days, stable per listing (average 7).
function thresholdDays(propertyId) {
  const h = (Number(propertyId) * 2654435761) % 4294967296
  return 6 + (h % 1000) / 500
}

// ── text understanding ──────────────────────────────────────────────────────
const NEG_RE = /\b(?:rented|rent(?:ed)?\s+out|let\s+out|leased|taken|sold|gone|occupied|unavailable|not\s+available|no\s+longer|not\s+anymore|under\s+offer|withdrawn|off\s+the\s+market|nothing|none|nope|no|sorry|unfortunately|vermietet|nicht\s+mehr)\b/i
const STOP_RE = /\b(?:stop|unsubscribe|spam|irritating|annoying|don'?t\s+(?:contact|message|write|text|use)|do\s+not\s+(?:contact|message)|leave\s+me|remove\s+(?:me|my)|not\s+interested|who\s+gave\s+you|how\s+did\s+you\s+get)\b/i
const IDENTITY_RE = /\b(?:who\s+(?:is|are)\s+(?:this|you)|who'?s\s+this|wer\s+(?:ist|bist)|do\s+(?:i|we)\s+know\s+you|which\s+(?:agency|company))\b/i
const RENTED_RE = /\b(?:rented|rent(?:ed)?\s+out|let\s+out|leased|taken|sold|gone|occupied|not\s+available|unavailable|no\s+longer|under\s+offer|off\s+the\s+market|vermietet)\b/i
const ALL_RE = /\b(?:all(?:\s+of\s+them)?|both|every(?:one|thing)|alle|beide)\b/i
const EXCEPT_RE = /\b(?:except|apart\s+from|other\s+than|but\s+not|besides|ausser|außer)\b/i
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const DATA_RE = new RegExp(`\\d|€|\\b(?:${MONTHS}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|next\\s+(?:week|month|year)|later|soon|weeks?|months?|call|but|except|only|until|till|from|available\\s+(?:again|from)|maybe|perhaps)\\b|\\?`, 'i')
const QUIET_NEG_RE = /^(?:(?:hi|hello|hey|dear|kevin|kev|sorry|no|nope|nothing|none|not|thanks|thank\s+you|ok|okay|unfortunately|at|the|moment|now|right|currently|for|anything|available|nothing\s+available|all|rented|already|taken|gone|i|don'?t|do\s+not|have|we|it'?s|is|was|has|been|any|more|anymore|interested|sorry\s+kevin|bro|mate|sir|madam|man|regards|bye|good\s+luck|cheers|[.,!🙏👍🙂😊🙁😕👌]+)\s*)+$/i

// "No / nothing / sorry Kevin" — no date, no number, no property data, no question.
function isQuietNegative(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > 140) return false
  if (DATA_RE.test(raw)) return false
  if (!/\b(?:no|nope|nothing|none|sorry|unfortunately|rented|taken|gone|not\s+interested|don'?t\s+have)\b/i.test(raw)) return false
  if (/\b(?:yes|yeah|still\s+available|is\s+available|free|vacant)\b/i.test(raw)) return false
  return QUIET_NEG_RE.test(raw)
}

// An owner who answers our question without any negative signal: still on market.
function impliesAvailable(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > 600) return false
  if (NEG_RE.test(raw) || STOP_RE.test(raw) || IDENTITY_RE.test(raw)) return false
  return true
}

function parsePrice(text) {
  const raw = String(text || '').replace(/(\d)[,.](\d{3})\b/g, '$1$2')
  const found = new Set()
  const re = /(?:€|eur(?:o|os)?\s*)?\b(\d{3,5}(?:\.\d+)?)\s*(k)?\b(?:\s*(?:€|eur(?:o|os)?))?/gi
  let m
  while ((m = re.exec(raw))) {
    let n = Number(m[1]); if (m[2]) n *= 1000
    const ctx = raw.slice(Math.max(0, m.index - 12), m.index + m[0].length + 14).toLowerCase()
    if (/\b(?:sqm|m2|m²|square|years?|yrs?|beds?|bedrooms?|rooms?|people|persons?|weeks?|days?|deposit)\b/.test(ctx) && !/€|eur|price|rent|month|pm\b/.test(ctx)) continue
    if (n >= 300 && n <= 20000) found.add(Math.round(n))
  }
  const k = /\b(\d(?:\.\d)?)\s*k\b/i.exec(raw)
  if (k) { const n = Math.round(Number(k[1]) * 1000); if (n >= 300 && n <= 20000) found.add(n) }
  return [...found]
}

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, last: -1 }
const townKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[ħ]/g, 'h').replace(/[ġ]/g, 'g').replace(/[ż]/g, 'z').replace(/[ċ]/g, 'c')
  .replace(/\bst\.?\s*/g, 'st ').replace(/saint\s+/g, 'st ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const TOWN_ALIASES = { 'st julians': ['st julians', 'st julian', 'san giljan', 'paceville', 'spinola'], 'swieqi': ['swieqi', 'swiqi', 'zwieqi', 'zwicky', 'swicky'], 'gzira': ['gzira', 'gzirah'], 'msida': ['msida'], 'sliema': ['sliema', 'tas sliema'], 'pieta': ['pieta'], 'st pauls bay': ['st pauls bay', 'st pauls', 'bugibba', 'qawra'], 'marsaskala': ['marsaskala', 'marsascala'], 'birkirkara': ['birkirkara', 'bkara', 'b kara'], 'mellieha': ['mellieha'], 'mosta': ['mosta'], 'naxxar': ['naxxar'], 'rabat': ['rabat'], 'valletta': ['valletta', 'valetta'] }
function townVariants(town) {
  const k = townKey(town)
  if (!k) return []
  const set = new Set([k])
  for (const [base, list] of Object.entries(TOWN_ALIASES)) if (base === k || list.includes(k)) list.forEach(x => set.add(x))
  return [...set]
}

// Which items does this clause refer to? Returns item numbers (1-based).
function refsInClause(clause, items) {
  const c = ' ' + townKey(clause) + ' '
  const hits = new Set()
  // explicit list numbers "1", "nr 3", "number 2", "#2"
  for (const m of clause.matchAll(/(?:^|[^\d€.,])(\d{1,2})(?![\d.,]|\s*(?:bed|br|room|k\b|000))/gi)) {
    const n = Number(m[1]); if (n >= 1 && n <= items.length) hits.add(n)
  }
  for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\b`, 'i').test(clause)) hits.add(n === -1 ? items.length : n)
  // ref "2906-9123" / "9123"
  for (const it of items) {
    const tail = String(it.ref || '').split('-').pop()
    if (tail && tail.length >= 3 && new RegExp(`\\b${tail}\\b`).test(clause)) hits.add(it.number)
  }
  // town (unique among this owner's items)
  for (const it of items) {
    const vs = townVariants(it.town)
    if (!vs.some(v => c.includes(' ' + v + ' '))) continue
    const sameTown = items.filter(o => townVariants(o.town).some(v => vs.includes(v)))
    if (sameTown.length === 1) hits.add(it.number)
    else {
      // same town twice: bedrooms or price in the same clause can decide
      const narrowed = sameTown.filter(o => (o.bedrooms != null && new RegExp(`\\b${o.bedrooms}\\s*(?:-\\s*)?(?:bed|br|bedroom)`, 'i').test(clause))
        || (o.priceNum && parsePrice(clause).includes(o.priceNum)))
      if (narrowed.length === 1) hits.add(narrowed[0].number)
      else sameTown.forEach(o => hits.add(-o.number)) // marked ambiguous
    }
  }
  // bedrooms alone ("the 2 bedroom") when unique
  const bm = /\b(\d)\s*(?:-\s*)?(?:bed|br|bedroom)/i.exec(clause)
  if (bm) { const m2 = items.filter(o => Number(o.bedrooms) === Number(bm[1])); if (m2.length === 1) hits.add(m2[0].number) }
  // price alone ("the 1500 one") when unique
  for (const p of parsePrice(clause)) { const m3 = items.filter(o => o.priceNum === p); if (m3.length === 1) hits.add(m3[0].number) }
  return [...hits]
}

// Parse a reply to "which of your properties are still available?"
//   { available:[n], rented:[n], ambiguous:bool, understood:bool }
function parseMultiReply(text, items) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  const out = { available: new Set(), rented: new Set(), ambiguous: false, understood: false, kind: null }
  if (!raw) return { ...out, available: [], rented: [] }
  const all = items.map(i => i.number)
  // "all except the Sliema one" / "all available but 2 is rented"
  const exceptSplit = raw.split(EXCEPT_RE)
  if (ALL_RE.test(exceptSplit[0]) && exceptSplit.length > 1) {
    const excluded = refsInClause(exceptSplit.slice(1).join(' '), items)
    if (excluded.some(n => n < 0) || !excluded.length) return { available: [], rented: [], ambiguous: true, understood: false }
    const allRented = RENTED_RE.test(exceptSplit[0])
    for (const n of all) (excluded.includes(n) ? (allRented ? out.available : out.rented) : (allRented ? out.rented : out.available)).add(n)
    return { available: [...out.available], rented: [...out.rented], ambiguous: false, understood: true, kind: 'all_except' }
  }
  const clauses = raw.split(/[.;\n!]|,(?!\d{3})|\band\b|\bbut\b|\bwhile\b|\bwhereas\b|\bund\b|\baber\b/i).map(s => s.trim()).filter(Boolean)
  let lastPolarity = null
  for (const clause of clauses) {
    const refs = refsInClause(clause, items)
    const neg = RENTED_RE.test(clause) || /\b(?:no|not|nothing|none)\b/i.test(clause)
    const pos = /\b(?:available|free|still|yes|yeah|on\s+(?:the\s+)?market|vacant|verfügbar|frei)\b/i.test(clause) && !RENTED_RE.test(clause)
    if (refs.some(n => n < 0)) { out.ambiguous = true; continue }
    if (!refs.length) {
      // "both still available" / "all good"
      if (ALL_RE.test(clause) && (pos || !neg)) { all.forEach(n => (neg ? out.rented : out.available).add(n)); out.understood = true }
      if (pos || neg) lastPolarity = neg ? 'rented' : 'available'
      continue
    }
    const polarity = neg ? 'rented' : pos ? 'available' : null
    if (polarity) lastPolarity = polarity
    const target = polarity === 'rented' ? out.rented : polarity === 'available' ? out.available : (out.pending = out.pending || new Set())
    refs.forEach(n => target.add(n))
    out.understood = true
  }
  // "Sliema and Gzira are still available": the polarity sits in the last clause
  if (out.pending && out.pending.size) {
    const pol = lastPolarity || (impliesAvailable(raw) ? 'available' : null)
    if (!pol) out.ambiguous = true
    else for (const n of out.pending) (pol === 'rented' ? out.rented : out.available).add(n)
  }
  for (const n of out.rented) out.available.delete(n)
  return { available: [...out.available], rented: [...out.rented], ambiguous: out.ambiguous, understood: out.understood && !out.ambiguous }
}

function viewingsMood(text) {
  const t = String(text || '').toLowerCase()
  if (/\b(?:not\s+(?:so\s+|that\s+|too\s+)?many|not\s+a\s+lot|few|quiet|slow|nobody|no\s+one|none|not\s+really|not\s+much|little|hardly|zero|nothing)\b/.test(t)) return 'few'
  if (/\b(?:a\s+lot|lots|many|loads|tons|plenty|busy|crazy|stress|stressed|too\s+many|so\s+many|every\s*day|non\s*stop|tired)\b/.test(t)) return 'many'
  return 'unknown'
}

// ── messages ────────────────────────────────────────────────────────────────
// prices under €100 are data-entry errors on the listing: never quote them to an owner
const money = n => (Number(n) >= 100 ? `€${Math.round(Number(n)).toLocaleString('en-GB')}` : null)
function describe(it) {
  const beds = it.bedrooms != null && Number(it.bedrooms) > 0 ? `${it.bedrooms}-bedroom` : (it.propertyType || 'property')
  return [`${beds} in ${it.town || 'Malta'}`, it.price].filter(Boolean).join(' · ')
}
function singleText(it, now = new Date()) {
  const facts = [it.bedrooms != null && Number(it.bedrooms) > 0 ? `${it.bedrooms}-bedroom` : null, it.price].filter(Boolean).join(', ')
  return `${greeting(now)}, I hope you're well! I just wanted to check if your property in ${it.town || 'Malta'}${facts ? ` (${facts})` : ''} is still available?` +
    (it.url ? `\n\nThis is the one I mean: ${it.url}` : '')
}
function multiText(items, now = new Date()) {
  const lines = items.map(it => `${it.number}. ${describe(it)}${it.url ? `\n${it.url}` : ''}`)
  const example = items.find(it => it.town) || items[0]
  return `${greeting(now)}, I hope you're well! I just wanted to check which of your properties are still available at the moment?\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `Just tell me which ones (for example "the ${example.town || 'first'} one" or the numbers) and I'll update everything on my side.`
}
const VIEWINGS_TEXT = 'Perfect, thank you! And how is it going with viewings at the moment, are you getting a lot of people or rather not so many?'
const PITCH_MANY = "I can imagine, that gets tiring. What if I bring you exactly the tenants you're looking for instead, a small, reliable group, single, couple, whatever suits you best? Just tell me straight what you would want, and what price you'd be happy with."
const PITCH_FEW = "Okay, then let's change that. What if I bring you exactly the tenants you're looking for, a small, reliable group, single, couple, whatever suits you best? Just tell me straight what you would want, and what price you'd be happy with."
const thanksText = price => price
  ? `Perfect, thank you! I've noted ${money(price)} and I'll only send you people who really fit.`
  : "Perfect, thank you! I'll keep that in mind and only send you people who really fit."
const ALL_TEXTS = [VIEWINGS_TEXT, PITCH_MANY, PITCH_FEW]

// ── sending ─────────────────────────────────────────────────────────────────
function av() { return require('./availability') }
async function liveName(dbName) { try { return await av().resolveLiveSession(dbName) } catch { return null } }

// Owner's account if it is up, else another account with history, else an outreach account.
async function pickSession(ownerId) {
  const r = await db.query(
    `SELECT wa.session_name AS s, (oal.last_reply_at IS NOT NULL) AS replied,
            GREATEST(oal.last_reply_at, oal.last_outreach_at, oal.last_we_sent_at, oal.created_at) AS touch
       FROM owner_account_labels oal
       JOIN whatsapp_accounts wa ON LOWER(wa.session_name)=LOWER(oal.account_session) AND wa.is_active
      WHERE oal.contact_id=$1 AND LOWER(oal.account_session) <> 'jasmine'
        AND (oal.source='first_contact' OR oal.last_outreach_at IS NOT NULL OR oal.last_reply_at IS NOT NULL OR oal.last_we_sent_at IS NOT NULL)
      ORDER BY replied DESC, touch DESC NULLS LAST`, [ownerId])
  const seen = new Set()
  const history = r.rows.filter(x => !seen.has(x.s.toLowerCase()) && seen.add(x.s.toLowerCase()))
  for (const [i, row] of history.entries()) {
    const live = await liveName(row.s)
    if (live) return { session: live, dbSession: row.s, reason: i === 0 ? 'owner_account' : 'other_account_with_history', history: history.length }
  }
  for (const name of [...FIRST_CONTACT, ...LAST_RESORT]) {
    const live = await liveName(name)
    if (live) return { session: live, dbSession: name, reason: history.length ? 'owner_account_offline_fallback' : 'first_contact', firstContact: !history.length, history: history.length }
  }
  return { session: null, reason: 'no_working_account' }
}

async function sendNow(session, chatId, text) {
  const res = await av().__sendTextAs(session, chatId, text)
  return res?.id?._serialized || res?.id || res?.key?.id || null
}
async function queueReply(thread, text, replyTo, label) {
  const humanDelay = require('./humanDelay')
  return humanDelay.queueOwnerMessage({
    session: thread.session, chatId: thread.chat_id, text,
    reactTo: replyTo || null, reactEmoji: replyTo ? '👍' : null,
    label, jobId: `recheck7d-${thread.id}-${label}`,
  })
}

// The website page must actually open (a few slugs 404): checked live, cached 24h.
async function pageWorks(url) {
  const redis = require('../redis')
  const key = `recheck7d:url:${url}`
  try { const c = await redis.get(key); if (c) return c === '1' } catch { /* soft */ }
  let ok = false
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000)
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal })
    clearTimeout(t); ok = res.status === 200
  } catch { ok = false }
  try { await redis.set(key, ok ? '1' : '0', 'EX', 24 * 3600) } catch { /* soft */ }
  return ok
}
async function publicLink(p) {
  if (p.slug) {
    const url = `https://2906.estate/property/${encodeURIComponent(p.slug)}`
    if (await pageWorks(url)) return url
  }
  try { return (await require('./shareLinks').getOrCreatePropertyLink(p.id))?.url || null } catch { return null }
}

// ── candidates ──────────────────────────────────────────────────────────────
async function dueListings(limit = 400) {
  const r = await db.query(
    `SELECT p.id, p.ref, p.owner_id, p.town, p.bedrooms, p.property_type, p.longlet_price, p.sale_price,
            p.available_status, p.last_confirmed_available_at, p.created_at,
            (SELECT w.slug FROM website_properties w WHERE w.property_reference=p.ref AND w.is_published IS TRUE
              ORDER BY w.updated_at DESC NULLS LAST LIMIT 1) AS slug,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(p.last_confirmed_available_at, p.created_at))) / 86400.0 AS age_days
       FROM properties p
       JOIN owner_contacts oc ON oc.id = p.owner_id
      WHERE COALESCE(p.available_status,'available') IN ('available','available_confirmed','upcoming')
        AND p.published = TRUE AND COALESCE(p.is_staging,false) = false
        AND COALESCE(p.verification_status,'verified') = 'verified'
        AND oc.phone_normalized IS NOT NULL AND btrim(oc.phone_normalized) <> ''
        AND COALESCE(oc.do_not_contact,false) = false
        AND (oc.owner_contact_paused_until IS NULL OR oc.owner_contact_paused_until <= CURRENT_DATE)
        AND (p.property_contact_paused_until IS NULL OR p.property_contact_paused_until <= CURRENT_DATE)
        AND (p.viewings_from_date IS NULL OR p.viewings_from_date <= CURRENT_DATE)
        AND COALESCE(p.auto_reachout_opt_out,false) = false
        -- nobody asked this listing in the last 5 days (any source)
        AND NOT EXISTS (SELECT 1 FROM availability_checks ac WHERE ac.property_id=p.id
                         AND COALESCE(ac.sent_at, ac.created_at) > NOW() - INTERVAL '5 days')
        AND NOT EXISTS (SELECT 1 FROM availability_checks ac WHERE ac.property_id=p.id
                         AND ac.status IN ('waiting_for_source_session','sending'))
      ORDER BY p.owner_id`, [])
  return r.rows.filter(x => Number(x.age_days) >= thresholdDays(x.id)).slice(0, limit)
}

async function ownerBlocked(ownerId) {
  const r = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM owner_recheck_threads t WHERE t.owner_id=$1 AND t.closed_at IS NULL
               AND t.step_at > NOW() - INTERVAL '${THREAD_TIMEOUT_DAYS} days') AS open_thread,
       EXISTS (SELECT 1 FROM owner_recheck_threads t WHERE t.owner_id=$1 AND t.stage <> 'skipped' AND NOT t.dry_run
               AND t.created_at > NOW() - INTERVAL '5 days') AS asked_recently,
       EXISTS (SELECT 1 FROM owner_recheck_threads t WHERE t.owner_id=$1 AND t.stage='skipped'
               AND t.created_at > NOW() - INTERVAL '20 hours') AS skipped_recently,
       EXISTS (SELECT 1 FROM owner_portfolio_checks c WHERE c.owner_contact_id=$1 AND c.state='awaiting_reply') AS portfolio_open`,
    [ownerId]).catch(async () => (await db.query(
    `SELECT EXISTS (SELECT 1 FROM owner_recheck_threads t WHERE t.owner_id=$1 AND t.closed_at IS NULL AND t.step_at > NOW() - INTERVAL '${THREAD_TIMEOUT_DAYS} days') AS open_thread,
            EXISTS (SELECT 1 FROM owner_recheck_threads t WHERE t.owner_id=$1 AND t.stage <> 'skipped' AND NOT t.dry_run AND t.created_at > NOW() - INTERVAL '5 days') AS asked_recently,
            EXISTS (SELECT 1 FROM owner_recheck_threads t WHERE t.owner_id=$1 AND t.stage='skipped' AND t.created_at > NOW() - INTERVAL '20 hours') AS skipped_recently,
            FALSE AS portfolio_open`, [ownerId])))
  const x = r.rows[0]
  if (x.open_thread) return 'open_conversation'
  if (x.asked_recently) return 'asked_recently'
  if (x.skipped_recently) return 'skipped_recently'
  if (x.portfolio_open) return 'portfolio_check_open'
  return null
}

async function activePortfolio(ownerId) {
  return (await db.query(
    `SELECT p.id, p.ref, p.town, p.bedrooms, p.property_type, p.longlet_price, p.sale_price, p.available_status,
            (SELECT w.slug FROM website_properties w WHERE w.property_reference=p.ref AND w.is_published IS TRUE
              ORDER BY w.updated_at DESC NULLS LAST LIMIT 1) AS slug
       FROM properties p
      WHERE p.owner_id=$1 AND COALESCE(p.available_status,'available') IN ('available','available_confirmed','upcoming')
        AND p.published = TRUE AND COALESCE(p.is_staging,false)=false
        AND COALESCE(p.verification_status,'verified')='verified'
      ORDER BY p.created_at, p.id LIMIT ${MAX_LIST}`, [ownerId])).rows
}

async function sentToday() {
  return (await db.query(
    `SELECT COUNT(*)::int AS n FROM owner_recheck_threads
      WHERE stage <> 'skipped' AND NOT dry_run AND sent_at >= (date_trunc('day', NOW() AT TIME ZONE 'Europe/Malta') AT TIME ZONE 'Europe/Malta')`)).rows[0].n
}
async function dailyCap() {
  let cap = ENV_CAP()
  try { const r = await db.query('SELECT daily_cap FROM reachout_settings WHERE id=1'); if (r.rows[0]) cap = Math.min(cap, Number(r.rows[0].daily_cap)) } catch { cap = 0 }
  return cap
}

// ── one owner ───────────────────────────────────────────────────────────────
async function askOwner(ownerId, dueRows, { dryRun, now = new Date() }) {
  const ownerSendGate = require('./ownerSendGate')
  const props = await activePortfolio(ownerId)
  if (!props.length) return { status: 'skipped', why: 'no_active_listing' }
  const allowed = []
  let lastWhy = null
  for (const p of props) {
    const g = await ownerSendGate.checkOwnerSend({ ownerId, propertyId: p.id, kind: 'followup', automated: true })
    if (g.allow) allowed.push(p); else lastWhy = `gate:${g.reason}`
  }
  if (!allowed.length) return { status: 'skipped', why: lastWhy || 'gate' }
  const pick = await pickSession(ownerId)
  if (!pick.session) return { status: 'skipped', why: pick.reason }
  const phone = (await db.query('SELECT phone_normalized FROM owner_contacts WHERE id=$1', [ownerId])).rows[0].phone_normalized
  const chatId = `${String(phone).replace(/\D/g, '')}@c.us`

  // a single message per owner: one listing → the plain ask, several → the numbered list
  const items = []
  for (const p of allowed) {
    const priceNum = Number(p.longlet_price) > 0 ? Math.round(Number(p.longlet_price)) : Number(p.sale_price) > 0 ? Math.round(Number(p.sale_price)) : null
    items.push({ number: items.length + 1, propertyId: p.id, ref: p.ref, town: p.town, bedrooms: p.bedrooms, propertyType: p.property_type,
      price: money(priceNum), priceNum, status: p.available_status, url: await publicLink(p) })
  }
  const single = items.length === 1
  const text = single ? singleText(items[0], now) : multiText(items, now)
  const thread = (await db.query(
    `INSERT INTO owner_recheck_threads(owner_id,session,chat_id,stage,kind,property_ids,snapshot,prompt_text,dry_run)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
    [ownerId, pick.dbSession, chatId, single ? 'asked_single' : 'asked_multi', single ? 'single' : 'multi',
      items.map(i => i.propertyId), JSON.stringify(items), text, !!dryRun])).rows[0]
  const info = { ref: items.map(i => i.ref).join(','), via: pick.dbSession, viaReason: pick.reason, owner: ownerId, listings: items.length,
    due: dueRows.map(r => r.ref), threadId: thread.id }
  if (dryRun) {
    await db.query(`UPDATE owner_recheck_threads SET closed_at=NOW(), outcome='dry_run' WHERE id=$1`, [thread.id])
    return { status: 'would_send', info, text }
  }

  // single listing: an availability_checks row so the proven reply pipeline
  // (rented / soon / unclear / implicit yes) answers it
  let checkId = null
  if (single) {
    checkId = (await db.query(
      `INSERT INTO availability_checks(property_id,owner_id,account_session,owner_chat_id,sent_at,status,source,pending_question_type,pending_question_sent_at)
       VALUES($1,$2,$3,$4,NOW(),'awaiting',$5,'PROPERTY_AVAILABILITY',NOW()) RETURNING id`,
      [items[0].propertyId, ownerId, pick.dbSession, chatId, SOURCE])).rows[0].id
  }
  try {
    await sendNow(pick.session, chatId, text)
  } catch (err) {
    await db.query(`UPDATE owner_recheck_threads SET stage='send_failed', closed_at=NOW(), outcome=$2, updated_at=NOW() WHERE id=$1`, [thread.id, String(err.message).slice(0, 300)])
    if (checkId) await db.query(`UPDATE availability_checks SET status='send_failed', updated_at=NOW() WHERE id=$1`, [checkId])
    return { status: 'failed', why: 'send_failed', info }
  }
  await db.query(`UPDATE owner_recheck_threads SET sent_at=NOW(), step_at=NOW(), check_id=$2, updated_at=NOW() WHERE id=$1`, [thread.id, checkId])
  if (pick.firstContact) {
    await db.query(
      `INSERT INTO owner_account_labels(contact_id,account_session,label,source,last_we_sent_at,created_at,updated_at)
       SELECT $1,$2,'cold','first_contact',NOW(),NOW(),NOW()
        WHERE NOT EXISTS (SELECT 1 FROM owner_account_labels WHERE contact_id=$1 AND LOWER(account_session)=LOWER($2))`,
      [ownerId, pick.dbSession]).catch(() => {})
  }
  await event(thread.id, 'ASKED', { session: pick.dbSession, reason: pick.reason, items: items.length, checkId })
  for (const it of items) {
    await db.query(`INSERT INTO property_activities(property_id,activity_type,details,is_significant,created_at)
                    VALUES($1,'owner_recheck_7d_asked',$2::jsonb,FALSE,NOW())`,
      [it.propertyId, JSON.stringify({ thread_id: thread.id, session: pick.dbSession, listings_in_message: items.length })]).catch(() => {})
  }
  return { status: 'sent', info: { ...info, checkId } }
}

// ── the scheduled pass (called from cron.js every 30 min) ──────────────────
async function runScheduled({ trigger = 'daily_cron', dryRun = !ARMED(), force = false, now = new Date(), perPass = OWNERS_PER_PASS, pace = true } = {}) {
  await ensureSchema()
  const client = await db.connect()
  let locked = false, runId = null
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(7314, 7) AS a')).rows[0].a === true
    if (!locked) return { skipped: 'already_running', sent: [], waiting: [], refused: [] }
    runId = (await client.query(
      `INSERT INTO owner_availability_refresh_runs(trigger, armed, dry_run, status) VALUES($1,$2,$3,'running') RETURNING id`,
      [trigger, ARMED(), dryRun])).rows[0].id
    const result = { rule: 'recheck_7d', dryRun, sent: [], wouldSend: [], waiting: [], refused: [], candidates: 0 }
    const win = sendWindow(now)
    const cap = await dailyCap()
    const already = await sentToday()
    if (!force && !win.ok) result.skipped = win.reason
    else if (!(cap > 0)) result.skipped = 'daily_cap_zero'
    else if (already >= cap) result.skipped = 'daily_cap_reached'
    else {
      const due = await dueListings()
      const byOwner = new Map()
      for (const row of due) { if (!byOwner.has(row.owner_id)) byOwner.set(row.owner_id, []); byOwner.get(row.owner_id).push(row) }
      // most overdue owner first
      const owners = [...byOwner.entries()].sort((a, b) => Math.max(...b[1].map(x => x.age_days)) - Math.max(...a[1].map(x => x.age_days)))
      result.candidates = owners.length
      result.dueListings = due.length
      const room = Math.min(perPass, cap - already)
      let done = 0
      for (const [ownerId, rows] of owners) {
        if (done >= room) break
        const blocked = await ownerBlocked(ownerId)
        if (blocked) { if (blocked !== 'skipped_recently' && blocked !== 'asked_recently') result.refused.push({ ref: rows[0].ref, why: blocked }); continue }
        const r = await askOwner(ownerId, rows, { dryRun, now })
        if (r.status === 'skipped') {
          if (!dryRun) await db.query(`INSERT INTO owner_recheck_threads(owner_id,stage,outcome,closed_at,property_ids) VALUES($1,'skipped',$2,NOW(),$3)`,
            [ownerId, r.why, rows.map(x => x.id)])
          result.refused.push({ ref: rows[0].ref, why: r.why }); continue
        }
        if (r.status === 'would_send') { result.wouldSend.push({ ...r.info, text: r.text }); done++; continue }
        if (r.status === 'failed') { result.refused.push({ ref: r.info.ref, why: r.why }); continue }
        result.sent.push({ ...r.info, checkId: r.info.checkId || null })
        done++
        if (pace && done < room) await new Promise(res => setTimeout(res, 40_000 + Math.floor(Math.random() * 50_000)))
      }
    }
    await client.query(
      `UPDATE owner_availability_refresh_runs SET finished_at=NOW(), status='completed', candidates=$2, sent=$3, waiting=0, refused=$4, gave_up=0, detail=$5::jsonb WHERE id=$1`,
      [runId, result.candidates, result.sent.length, result.refused.length, JSON.stringify(result)])
    log.info('[recheck7d] pass complete', { runId, dryRun, skipped: result.skipped || null, candidates: result.candidates, sent: result.sent.length, refused: result.refused.length })
    return { runId, ...result }
  } catch (err) {
    if (runId) await client.query(`UPDATE owner_availability_refresh_runs SET finished_at=NOW(), status='failed', error=$2 WHERE id=$1`, [runId, String(err.message).slice(0, 500)]).catch(() => {})
    throw err
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(7314, 7)').catch(() => {})
    client.release()
  }
}

// ── confirm / rented helpers ─────────────────────────────────────────────────
async function confirmAvailable(propertyId, reason) {
  const boardAction = require('./boardAction')
  const cur = (await db.query('SELECT available_status FROM properties WHERE id=$1', [propertyId])).rows[0]
  if (!cur || ['rented', 'archived', 'not_available', 'sold'].includes(cur.available_status)) return false
  const plan = cur.available_status === 'upcoming'
    ? await boardAction.markUpcoming({ propertyId, agentId: null, changedBy: 'owner_reply', availableDate: null, reason, oldStatus: cur.available_status })
    : await boardAction.checkIn({ propertyId, agentId: null, changedBy: 'owner_reply', method: 'owner_confirmed', oldStatus: cur.available_status })
  if (!plan.ok) return false
  const upd = await db.query(plan.update.sql, plan.update.params)
  if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
  return upd.rows.length > 0
}

async function reviewTask(thread, propertyId, reason, replyText) {
  const sourceId = `recheck7d:${thread.id}:${propertyId || 'owner'}`
  await db.query(
    `INSERT INTO owner_recheck_tasks(owner_contact_id,owner_phone,topic,state,decision,reason,property_id,source_type,source_id,context_snapshot,proposed_action,context_hash)
     SELECT $1,phone_normalized,'recheck_7d','DECISION_REQUIRED','OWNER_REPLY_NEEDS_KEV',$2,$3,'owner_recheck_7d',$4,$5::jsonb,'REVIEW_OWNER_REPLY',md5($4::text || $5::text)
       FROM owner_contacts WHERE id=$1
        AND NOT EXISTS (SELECT 1 FROM owner_recheck_tasks WHERE source_type='owner_recheck_7d' AND source_id=$4)`,
    [thread.owner_id, reason, propertyId || null, sourceId, JSON.stringify({ threadId: thread.id, reply: String(replyText || '').slice(0, 500), snapshot: thread.snapshot })])
}

async function alertKev(text) {
  try { await require('../handlers/uploadListing').alertKev(text) } catch (err) { log.warn('[recheck7d] alert failed', { err: err.message }) }
}

// ── after a single-listing "yes" (called from availability.js onStillAvailable) ──
async function pitchDueForOwner(ownerId) {
  const r = await db.query(
    `SELECT 1 FROM owner_recheck_threads WHERE owner_id=$1 AND stage IN ('asked_viewings','asked_terms','done_terms')
       AND step_at > NOW() - INTERVAL '${PITCH_EVERY_DAYS} days' LIMIT 1`, [ownerId])
  return !r.rows.length
}
async function afterSingleAvailable(check, { ownerSession, ownerChat } = {}) {
  await ensureSchema()
  const thread = (await db.query(
    `SELECT * FROM owner_recheck_threads WHERE check_id=$1 AND closed_at IS NULL ORDER BY id DESC LIMIT 1`, [check.id])).rows[0]
  if (!thread) return { started: false, reason: 'not_a_recheck_thread' }
  await db.query(`UPDATE owner_recheck_threads SET confirmed_ids=$2, last_reply=$3, updated_at=NOW() WHERE id=$1`,
    [thread.id, [check.property_id], String(check.reply_text || '').slice(0, 2000)])
  await event(thread.id, 'CONFIRMED_AVAILABLE', { propertyId: check.property_id })
  return startViewingsStep({ ...thread, session: thread.session, chat_id: ownerChat || thread.chat_id }, [check.property_id], null)
}

async function startViewingsStep(thread, confirmedIds, replyTo) {
  if (!(await pitchDueForOwner(thread.owner_id))) {
    await db.query(`UPDATE owner_recheck_threads SET stage='done', outcome='confirmed', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
    return { started: false, reason: 'pitched_recently' }
  }
  const live = await liveName(thread.session)
  if (!live) {
    await db.query(`UPDATE owner_recheck_threads SET stage='done', outcome='confirmed_no_session', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
    return { started: false, reason: 'session_offline' }
  }
  await db.query(`UPDATE owner_recheck_threads SET stage='asked_viewings', confirmed_ids=$2, step_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id, confirmedIds])
  await queueReply({ ...thread, session: live }, VIEWINGS_TEXT, replyTo, 'viewings')
  await event(thread.id, 'ASKED_VIEWINGS', {})
  return { started: true }
}

// ── inbound (called from availability.js handleWebhookMessage for every owner DM) ──
async function findOwnerForChat(session, chatId, senderPhone) {
  const digits = v => String(v || '').replace(/\D/g, '')
  let phone = digits(senderPhone)
  if ((!phone || phone.length > 13) && chatId) {
    try { phone = digits(await require('./ownerSendGate').resolveChatPhone(session, chatId)) } catch { /* soft */ }
  }
  if (!phone) return null
  return (await db.query(
    `SELECT id, phone_normalized FROM owner_contacts
      WHERE right(regexp_replace(COALESCE(phone_normalized,''),'\\D','','g'),9)=$1 ORDER BY id DESC LIMIT 1`, [phone.slice(-9)])).rows[0] || null
}

const QUIET_KEY = (session, chat) => `recheck7d:quiet:${String(session || '').toLowerCase()}:${String(chat || '').replace(/\D/g, '').slice(-9)}`

async function noteQuietNegative({ session, chatId, senderPhone, text }) {
  const redis = require('../redis')
  const keys = [QUIET_KEY(session, chatId), QUIET_KEY(session, senderPhone)]
  if (isQuietNegative(text)) {
    for (const k of keys) await redis.set(k, '1', 'EX', 6 * 3600).catch(() => {})
    const waha = require('../waha')
    setTimeout(() => { waha.sendSeen(session, chatId).catch?.(() => {}) }, 20_000)
    return true
  }
  for (const k of keys) await redis.del(k).catch(() => {})
  return false
}

// waha.markChatUnread asks this first: the owner's last message was a plain "no".
async function shouldStayRead(session, phoneOrChat) {
  try { return (await require('../redis').get(QUIET_KEY(session, phoneOrChat))) === '1' } catch { return false }
}

async function handleInbound({ payload, session, text, senderPhone, chatId }) {
  await ensureSchema()
  if (payload?.fromMe) return { handled: false }
  const t = String(text || '').trim()
  try { await noteQuietNegative({ session, chatId, senderPhone, text: t }) } catch (err) { log.debug('[recheck7d] quiet note failed', { err: err.message }) }
  if (!t) return { handled: false }
  const owner = await findOwnerForChat(session, chatId, senderPhone)
  if (!owner) return { handled: false }

  // Owner answering an agent's board question in the last 4 days, without a
  // negative word: that listing is still on the market. Silent, no message.
  await confirmFromBoardQuestion(owner.id, t).catch(err => log.debug('[recheck7d] board-question confirm skipped', { err: err.message }))

  const thread = (await db.query(
    `SELECT * FROM owner_recheck_threads
      WHERE owner_id=$1 AND closed_at IS NULL AND stage IN ('asked_multi','asked_viewings','asked_terms')
        AND step_at > NOW() - INTERVAL '${THREAD_TIMEOUT_DAYS} days'
      ORDER BY id DESC LIMIT 1`, [owner.id])).rows[0]
  if (!thread) return { handled: false }
  const replyTo = payload?.id || null
  await db.query(`UPDATE owner_recheck_threads SET last_reply=$2, updated_at=NOW() WHERE id=$1`, [thread.id, t.slice(0, 2000)])
  thread.chat_id = chatId || thread.chat_id
  thread.session = (await liveName(thread.session)) || session

  // "nothing / all rented" belongs to the owner-wide rule in availability.js
  if (require('./ownerScopeReply').classifyOwnerScope?.(t)?.scope === 'owner_all_unavailable') {
    await db.query(`UPDATE owner_recheck_threads SET stage='closed', outcome='nothing_available', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
    await event(thread.id, 'OWNER_NOTHING_AVAILABLE', {})
    return { handled: false }
  }
  if (STOP_RE.test(t)) {
    await db.query(`UPDATE owner_recheck_threads SET stage='closed', outcome='owner_stop', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
    await event(thread.id, 'OWNER_STOP', {})
    return { handled: false }
  }

  if (thread.stage === 'asked_multi') return onMultiReply(thread, t, replyTo)
  if (thread.stage === 'asked_viewings') return onViewingsReply(thread, t, replyTo)
  if (thread.stage === 'asked_terms') return onTermsReply(thread, t, replyTo)
  return { handled: false }
}

async function onMultiReply(thread, text, replyTo) {
  const items = Array.isArray(thread.snapshot) ? thread.snapshot : []
  const parsed = parseMultiReply(text, items)
  const byNum = n => items.find(i => i.number === n)
  if (!parsed.understood || (!parsed.available.length && !parsed.rented.length)) {
    // a plain "yes" / "still available" to a list question with no hint which one
    await db.query(`UPDATE owner_recheck_threads SET stage='needs_kev', outcome='reply_not_understood', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
    await reviewTask(thread, null, 'Owner answered the weekly recheck list but it is not clear which listings are meant', text)
    await event(thread.id, 'NEEDS_KEV', { reply: text.slice(0, 300) })
    await alertKev(`❓ Weekly recheck — owner reply not clear, please confirm in ARGUS:\n"${text.slice(0, 300)}"\n\n` +
      items.map(i => `${i.number}. #${i.ref} · ${i.town || ''} ${i.price || ''}`).join('\n'))
    return { handled: true, understood: false }
  }
  const confirmed = [], rented = []
  for (const n of parsed.available) { const it = byNum(n); if (it && await confirmAvailable(it.propertyId, 'Owner confirmed in weekly recheck')) confirmed.push(it.propertyId) }
  for (const n of parsed.rented) {
    const it = byNum(n); if (!it) continue
    try {
      await av().applyRentedVerdictFromOwnerChat({ propertyId: it.propertyId, ownerId: thread.owner_id, ref: it.ref,
        ownerSession: thread.session, ownerChat: thread.chat_id, replyMsgId: replyTo, replyText: text })
      rented.push(it.propertyId)
    } catch (err) { log.warn('[recheck7d] rented verdict failed', { ref: it.ref, err: err.message }) }
  }
  const unmentioned = items.filter(i => !parsed.available.includes(i.number) && !parsed.rented.includes(i.number))
  for (const it of unmentioned) await reviewTask(thread, it.propertyId, `Owner did not mention #${it.ref} in the weekly recheck reply`, text)
  await db.query(`UPDATE owner_recheck_threads SET confirmed_ids=$2, rented_ids=$3, updated_at=NOW() WHERE id=$1`, [thread.id, confirmed, rented])
  await event(thread.id, 'MULTI_APPLIED', { confirmed, rented, unmentioned: unmentioned.map(i => i.propertyId) })
  if (confirmed.length) {
    const r = await startViewingsStep(thread, confirmed, replyTo)
    if (!r.started) await queueReply(thread, 'Perfect, thank you for the update!', replyTo, 'thanks')
  } else {
    await db.query(`UPDATE owner_recheck_threads SET stage='done', outcome='all_rented', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
  }
  return { handled: true, understood: true, confirmed, rented, unmentioned: unmentioned.length }
}

async function onViewingsReply(thread, text, replyTo) {
  if (RENTED_RE.test(text) && !/\b(?:viewing|people|calls?)\b/i.test(text)) {
    // "actually it got rented" → hand to the normal rented path for a single confirmed listing
    const ids = thread.confirmed_ids || []
    if (ids.length === 1) {
      const p = (await db.query('SELECT ref FROM properties WHERE id=$1', [ids[0]])).rows[0]
      await av().applyRentedVerdictFromOwnerChat({ propertyId: ids[0], ownerId: thread.owner_id, ref: p?.ref, ownerSession: thread.session, ownerChat: thread.chat_id, replyMsgId: replyTo, replyText: text }).catch(() => {})
    }
    await db.query(`UPDATE owner_recheck_threads SET stage='done', outcome='rented_during_followup', closed_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
    return { handled: true }
  }
  const mood = viewingsMood(text)
  await db.query(`UPDATE owner_recheck_threads SET stage='asked_terms', step_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
  await queueReply(thread, mood === 'many' ? PITCH_MANY : PITCH_FEW, replyTo, 'pitch')
  await event(thread.id, 'PITCHED', { mood })
  for (const pid of thread.confirmed_ids || []) {
    await db.query(`INSERT INTO property_activities(property_id,activity_type,details,is_significant,created_at) VALUES($1,'owner_viewings_feedback',$2::jsonb,FALSE,NOW())`,
      [pid, JSON.stringify({ mood, reply: text.slice(0, 500), thread_id: thread.id })]).catch(() => {})
  }
  return { handled: true, mood }
}

async function onTermsReply(thread, text, replyTo) {
  const ids = thread.confirmed_ids || []
  const prices = parsePrice(text)
  let updated = null
  let target = ids.length === 1 ? ids[0] : null
  if (!target && ids.length > 1) {
    const items = (Array.isArray(thread.snapshot) ? thread.snapshot : []).filter(i => ids.includes(i.propertyId))
    const refs = refsInClause(text, items).filter(n => n > 0)
    if (refs.length === 1) target = items.find(i => i.number === refs[0])?.propertyId || null
  }
  const note = `Owner wishes (${new Date().toISOString().slice(0, 10)}): ${text.replace(/\s+/g, ' ').slice(0, 300)}`
  for (const pid of ids) {
    await db.query(`UPDATE properties SET internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2), updated_at=NOW() WHERE id=$1`, [pid, note]).catch(() => {})
  }
  if (prices.length === 1 && target) {
    const cur = (await db.query('SELECT ref, longlet_price, sale_price FROM properties WHERE id=$1', [target])).rows[0]
    const isSale = !(Number(cur?.longlet_price) > 0) && Number(cur?.sale_price) > 0
    if (cur && !isSale && Number(cur.longlet_price) !== prices[0]) {
      await db.query(`UPDATE properties SET longlet_price=$2, updated_at=NOW() WHERE id=$1`, [target, prices[0]])
      await db.query(`INSERT INTO property_activities(property_id,activity_type,details,is_significant,created_at) VALUES($1,'owner_price_update',$2::jsonb,TRUE,NOW())`,
        [target, JSON.stringify({ old: Number(cur.longlet_price) || null, new: prices[0], source: 'owner_recheck_7d', reply: text.slice(0, 500), thread_id: thread.id })])
      updated = prices[0]
    } else if (cur && !isSale) updated = prices[0]
  } else if (prices.length) {
    await reviewTask(thread, target, `Owner named a price in the weekly recheck but it is not clear for which listing: "${text.slice(0, 160)}"`, text)
  }
  await db.query(`UPDATE owner_recheck_threads SET stage='done_terms', outcome=$2, closed_at=NOW(), step_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [thread.id, updated ? `price_${updated}` : 'terms_noted'])
  await queueReply(thread, thanksText(updated), replyTo, 'thanks')
  await event(thread.id, 'TERMS', { prices, updated, target })
  return { handled: true, priceUpdated: updated }
}

async function confirmFromBoardQuestion(ownerId, text) {
  if (!impliesAvailable(text)) return null
  const r = await db.query(
    `SELECT DISTINCT l.property_id FROM owner_contact_log l
       JOIN properties p ON p.id=l.property_id
      WHERE l.owner_contact_id=$1 AND l.kind='question' AND l.status='sent'
        AND COALESCE(l.scheduled_for, l.created_at) > NOW() - INTERVAL '4 days'
        AND COALESCE(p.available_status,'available') IN ('available','available_confirmed','upcoming')
        AND (p.last_confirmed_available_at IS NULL OR p.last_confirmed_available_at < COALESCE(l.scheduled_for, l.created_at))`, [ownerId])
  if (r.rows.length !== 1) return null
  const ok = await confirmAvailable(r.rows[0].property_id, 'Owner answered an agent question')
  if (ok) log.info('[recheck7d] owner answered an agent question → still available', { propertyId: r.rows[0].property_id })
  return ok
}

// availability.js owner-wide "nothing available" path: close the conversation, mark the chat read
async function onOwnerWideUnavailable({ ownerId, session, chatId }) {
  await ensureSchema()
  await db.query(`UPDATE owner_recheck_threads SET stage='closed', outcome='nothing_available', closed_at=NOW(), updated_at=NOW()
                   WHERE owner_id=$1 AND closed_at IS NULL`, [ownerId])
  try { await require('../redis').set(QUIET_KEY(session, chatId), '1', 'EX', 6 * 3600) } catch { /* soft */ }
  setTimeout(() => { require('../waha').sendSeen(session, chatId).catch?.(() => {}) }, 25_000)
}

async function status() {
  await ensureSchema()
  const [due, today, open, recent] = await Promise.all([
    dueListings(1000),
    sentToday(),
    db.query(`SELECT stage, COUNT(*)::int n FROM owner_recheck_threads WHERE closed_at IS NULL GROUP BY 1`),
    db.query(`SELECT id, owner_id, stage, kind, outcome, session, sent_at, closed_at FROM owner_recheck_threads ORDER BY id DESC LIMIT 30`),
  ])
  return { dueListings: due.length, dueOwners: new Set(due.map(d => d.owner_id)).size, sentToday: today, cap: await dailyCap(), open: open.rows, recent: recent.rows }
}

module.exports = {
  ensureSchema, runScheduled, handleInbound, afterSingleAvailable, onOwnerWideUnavailable, shouldStayRead, status,
  // pure, exported for tests
  impliesAvailable, isQuietNegative, parseMultiReply, parsePrice, viewingsMood, sendWindow, thresholdDays,
  singleText, multiText, refsInClause, pickSession, dueListings, ALL_TEXTS,
  VIEWINGS_TEXT, PITCH_MANY, PITCH_FEW,
}
