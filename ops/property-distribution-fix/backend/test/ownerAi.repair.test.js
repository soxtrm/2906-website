'use strict'
// Kev, 2026-10-22 — ARGUS owner-AI P0 repair. Drives the REAL
// services/autoOwnerConversation.js processStep()/localExtract() with only the
// external boundaries stubbed (db rows, WAHA, Gemini, queues).
//   node test/ownerAi.repair.test.js [path/to/autoOwnerConversation.js]
// Cases are the real production conversations: #5598 (Argus5, agency asked
// twice), #5630 (Gabriela), #5587 (George Cachia, "Next vacancy July '26").
const assert = require('assert')
const path = require('path')
const Module = require('module')

const ADMIN = '35699270699'
const PERSONAS = { argus5: 'kev', kevthirdd: 'kev', cedric: 'cedric', gabriela: 'gabriela', olga: 'olga' }
const sent = []          // { session, to, text }
const sql = []
let convo = null          // the owner_auto_conversations row under test
let geminiReply = null    // what the classifier returns

const db = {
  query: async (q, p = []) => {
    const s = q.replace(/\s+/g, ' ')
    sql.push({ q: s, p })
    if (/automation_control/.test(s)) return { rows: [{ value: false }] }
    if (/FROM whatsapp_accounts/.test(s)) {
      const persona = PERSONAS[String(p[0] || '').toLowerCase()]
      return { rows: persona ? [{ account_persona: persona, id: 1, session_name: p[0], label: p[0] }] : [] }
    }
    if (/^UPDATE owner_auto_conversations SET processing_lock = NOW\(\)/.test(s.trim())) return { rows: convo ? [{ ...convo }] : [] }
    if (/SELECT status, automation_disabled, checklist FROM owner_auto_conversations/.test(s)) {
      return { rows: convo ? [{ status: convo.status, automation_disabled: false, checklist: convo.checklist }] : [] }
    }
    if (/^UPDATE owner_auto_conversations SET checklist=\$1/.test(s.trim()) || /UPDATE owner_auto_conversations SET status=/.test(s)) {
      if (convo) {
        const next = JSON.parse(p[0])
        convo.checklist = next
        const st = s.match(/SET status='([a-z_]+)'/)
        if (st) convo.status = st[1]
      }
      return { rows: [] }
    }
    if (/SET checklist = checklist \|\| \$1::jsonb/.test(s)) {
      if (convo) convo.checklist = { ...convo.checklist, ...JSON.parse(p[0]) }
      return { rows: [] }
    }
    return { rows: [] }
  },
}
const inert = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert })
const waha = new Proxy({
  sendText: async (session, to, text) => { sent.push({ session, to: String(to), text }); return { id: 'm' + sent.length } },
  markChatUnread: async () => {},
}, { get: (t, k) => (k in t ? t[k] : async () => {}) })
class FakeGenAI { constructor() { this.models = { generateContent: async () => ({ text: JSON.stringify(geminiReply || { intent: 'unclear', extracted: {} }) }) } } }

const original = Module._load
Module._load = function (request) {
  if (request === '../db') return db
  if (request === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === '../waha') return waha
  if (request === '../queues') return { addJob: async () => ({ id: 'job1' }), QUEUES: {} }
  if (request === '../config') return { automation: { testNumbers: [], autoPublishTimerMinutes: 10, autoPublishVariant: 5 }, admin: { botNumber: ADMIN }, waha: {} }
  if (request === './ownerSendGate') return { checkOwnerSend: async () => ({ allow: true }), handleFrustratedOwner: async () => {} }
  if (request === './conversationIntelligence') return { preflightOutbound: async () => ({ allow: true }) }
  if (['./agentIdentityRegistry', './canonical2906Renderer', './rentalModes'].includes(request)) return original.apply(this, arguments)
  if (request === '@google/genai') return { GoogleGenAI: FakeGenAI }
  if (request.startsWith('.') || ['ioredis', 'bullmq', 'axios', 'openai', 'cloudinary', 'sharp', 'node-cron'].includes(request)) return inert
  return original.apply(this, arguments)
}
process.env.GEMINI_API_KEY = 'test-key'
const aocPath = process.argv[2] || path.join(__dirname, '../services/autoOwnerConversation.js')
const aoc = require(aocPath)
const registry = require(path.join(path.dirname(aocPath), 'agentIdentityRegistry.js'))

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }

async function turn(session, text, checklist = {}) {
  if (registry._clearCache) registry._clearCache()
  sent.length = 0
  convo = { id: 9001, phone: '35679833081', session, status: 'active_collecting', automation_disabled: false,
    checklist: { ...checklist, _pending: [text] } }
  await aoc.processStep({ conversationId: 9001, phone: '35679833081', session })
  return { toOwner: sent.filter(m => m.to !== ADMIN).map(m => m.text), toAdmin: sent.filter(m => m.to === ADMIN).map(m => m.text) }
}

const INTAKE = /do you have a property available/i

;(async () => {
  console.log('=== owner AI repair 2026-10-22 ===')

  // ── identity ────────────────────────────────────────────────────────────
  await run('T01 Kevin account (Argus5) answers "name of your agency" immediately and correctly', async () => {
    const r = await turn('Argus5', 'Hello Kevin, \nwhat is the name of your agency please?')
    assert.deepStrictEqual(r.toOwner, ["Of course. I'm Kevin Eich, a real estate agent representing 2906 Estate in Malta."])
    assert.ok(!r.toAdmin.some(t => /couldn't determine intent|no approved persona/.test(t)), 'no escalation')
  })

  await run('T02 repeated agency question gets an answer again, never the questionnaire', async () => {
    const first = "Of course. I'm Kevin Eich, a real estate agent representing 2906 Estate in Malta."
    const r = await turn('Argus5', 'What is the name of the agency that you are representing?',
      { _log: [{ from: 'owner', text: 'what is the name of your agency please?' }, { from: 'bot', text: first }] })
    assert.strictEqual(r.toOwner.length, 1)
    assert.ok(/Kevin Eich/.test(r.toOwner[0]) && /2906 Estate/.test(r.toOwner[0]), r.toOwner[0])
    assert.ok(!INTAKE.test(r.toOwner[0]))
  })

  await run('T03 Cedric account → Cedric Reiter, QuickLets', async () => {
    const r = await turn('Cedric', 'Which agency are you with?')
    assert.deepStrictEqual(r.toOwner, ["Of course. I'm Cedric Reiter, a rental agent representing QuickLets in Malta."])
  })

  await run('T04 Gabriela account → Sotheby\'s (never 2906 Estate)', async () => {
    const r = await turn('Gabriela', 'What estate agency do you work for?')
    assert.deepStrictEqual(r.toOwner, ["Of course. I'm Gabriela, a real estate agent representing Sotheby's in Malta."])
  })

  await run('identity comes from whatsapp_accounts persona, not conversation text', async () => {
    const r = await turn('kevthirdd', 'Hi Cedric, which company is this?')
    assert.ok(/Kevin Eich/.test(r.toOwner[0]) && !/QuickLets/.test(r.toOwner[0]))
  })

  await run('persona without an approved identity (Olga) escalates instead of inventing one', async () => {
    const r = await turn('Olga', 'which agency?')
    assert.deepStrictEqual(r.toOwner, [])
    assert.ok(r.toAdmin.some(t => /AGENCY QUESTION/.test(t)))
  })

  await run('agency-question detector: real phrasings in, ordinary sentences out', async () => {
    for (const q of ['what is the name of your agency please?', 'What is the name of the agency that you are representing?',
      'What estate agency do you work for?', 'which agency pls ? or freelance?', 'who are you with?', 'Are you an agent?', 'which company is this'])
      assert.ok(aoc.AGENCY_QUESTION_RE.test(q), q)
    for (const s of ["I don't work with agencies", 'Our company works with many tenants', 'It is a 3 bedroom maisonette', 'No pets'])
      assert.ok(!aoc.AGENCY_QUESTION_RE.test(s), s)
  })

  await run('an unanswerable direct question goes to a human, not to the intake questionnaire', async () => {
    geminiReply = { intent: 'unclear', extracted: {} }
    const r = await turn('Argus5', 'Is the commission paid by the tenant?')
    assert.deepStrictEqual(r.toOwner, [])
    assert.ok(r.toAdmin.some(t => /DIRECT QUESTION/.test(t)))
    assert.ok(convo.checklist._owner_question_needs_human)
  })

  // ── price ───────────────────────────────────────────────────────────────
  await run("T05/T06 \"Next vacancy July '26\" answering the price question leaves price null (was €26,000)", async () => {
    const out = aoc.localExtract('price', "Next vacancy July '26")
    assert.strictEqual(out.price, undefined)
    assert.ok(!(out.notes || []).some(n => /shorthand/.test(n)))
  })

  await run('dates, years, postcodes, house/flat numbers and refs never become a price', async () => {
    for (const t of ['17, Triq Le Brun, L-IBRAG. SWQ2081', "Next vacancy July '26, so viewing around that time", 'available 21/10',
      'Apt 205', 'Block 1500 Triq il-Kbira', 'from March 2027', 'PD-5587', 'call me on 79 123 456', 'Maisonette L-Ibrag, 2 double, 1 single'])
      assert.strictEqual(aoc.localExtract('price', t).price, undefined, t)
    for (const t of ['Apt 205 in Sliema', '17, Triq Le Brun, L-IBRAG. SWQ2081'])
      assert.strictEqual(aoc.localExtractAll(t).price, undefined, t)
  })

  await run('genuine price answers still work (no regression)', async () => {
    const cases = { '1600': 1600, '€1,500': 1500, '1500 per month': 1500, 'around 1.6k': 1600, '2 bed 1 bath, 1600': 1600,
      'The rent is 1500, available from March': 1500, '1500 negotiable': 1500, '4': 4000, 'available 03.01.2027, €1,500/month': 1500 }
    for (const [t, want] of Object.entries(cases)) assert.strictEqual(aoc.localExtract('price', t).price, want, t)
    assert.strictEqual(aoc.localExtractAll('I have 2 studio flats available in st julians\ndesigner finished\n2.5k monthly').price, 2500)
  })

  // ── the George Cachia draft (#5587 / property 29496) ────────────────────
  const renderer = require(path.join(path.dirname(aocPath), 'canonical2906Renderer.js'))
  const GEORGE_NOTES = ['Maisonette', '2 double bedrooms, 1 single bedroom', '1 en-suite shower, 1 bath', 'back yard', 'barbecue area', 'interconnecting garage']
  const SAID_AT = new Date('2026-10-21T08:13:13Z')

  await run('T07 an explicitly stated but unusual rent is preserved and flagged for review, not replaced', async () => {
    const ev = aoc.buildPriceEvidence({ price: 26000, rawText: '€26,000 per month', notes: [], transactionType: 'rent' })
    assert.strictEqual(ev.parsed_amount, 26000)
    assert.strictEqual(ev.evidence, 'OWNER_STATED')
    assert.strictEqual(ev.verification, 'NEEDS_REVIEW')
    const normal = aoc.buildPriceEvidence({ price: 1600, rawText: '€1,600 per month', notes: [] })
    assert.strictEqual(normal.verification, 'VERIFIED')
    const merged = aoc.mergeExtracted({ _last_message_id: 'wamid-42' }, { price: 1600 }, 'the rent is 1600')
    assert.strictEqual(merged.price, 1600)
    assert.deepStrictEqual([merged._price_evidence.source_message_id, merged._price_evidence.currency, merged._price_evidence.billing_period,
      merged._price_evidence.source_text], ['wamid-42', 'EUR', 'month', 'the rent is 1600'])
  })

  await run('T08 no confirmed price → no price line, no price claim, review warning with the one targeted question', async () => {
    const c = { town: 'Ibrag', bedrooms: 3, bathrooms: 2, notes: GEORGE_NOTES, pets: 'no', sharing: 'no' }
    assert.strictEqual(aoc.priceVerification(c), 'MISSING')
    geminiReply = null
    const r = await renderer.render2906Listing(c)
    assert.ok(r.ok)
    assert.ok(/Price to be confirmed/.test(r.text) && !/€/.test(r.text), r.text)
    assert.ok(!/excellent price|great opportunity|opportunity/i.test(r.text), r.text)
    const w = aoc.buildSanityWarnings(c).join('\n')
    assert.ok(w.includes('The monthly asking rent for the 3-bedroom maisonette in Ibrag is still missing. Could you confirm the price?'), w)
  })

  await run('T08b the published €26,000 legacy draft is held: shorthand price is not printed and the cached "excellent price" copy is discarded', async () => {
    const legacy = { town: 'Ibrag', bedrooms: 3, bathrooms: 2, price: 26000, notes: ['Rent given as a bare "26" -- read as €26,000/month (Malta shorthand); please verify', ...GEORGE_NOTES] }
    assert.strictEqual(aoc.priceVerification(legacy), 'NEEDS_REVIEW')
    const r = await renderer.render2906Listing(legacy, { cachedCanonical: { fingerprint: 'x', intro: 'This 3-bedroom property offers a great opportunity.', closing: 'A great opportunity in Ibrag at an excellent price.' } })
    assert.ok(!/26,000|excellent price/i.test(r.text), r.text)
    assert.ok(aoc.buildSanityWarnings(legacy).some(w => /PRICE NEEDS VERIFICATION/.test(w)))
  })

  await run("T09 \"Next vacancy July '26\" said in Oct 2026 → no availability/viewing date, clarification instead (never silently July 2027)", async () => {
    assert.ok(aoc.pastStatedDate("Next vacancy July '26", SAID_AT))
    assert.strictEqual(aoc.pastStatedDate("Next vacancy July '27", SAID_AT), null)
    assert.strictEqual(aoc.pastStatedDate('from July', SAID_AT), null)   // no year: left as stated
    const c = aoc.mergeExtracted({}, { availableDate: 'July' }, "Next vacancy July '26")
    const c2 = aoc.mergeExtracted(c, { viewableDate: "Next vacancy July '26, so viewing around that time" }, "Next vacancy July '26, so viewing around that time")
    assert.strictEqual(c2.available_date, undefined)
    assert.strictEqual(c2.viewable_date, undefined)
    assert.ok(c2._date_clarification.available_date && c2._date_clarification.viewable_date)
    assert.strictEqual(aoc.countUnclearSignals(c2), 0, 'a chronology hold is not "unclear owner"')
    const r = await renderer.render2906Listing({ ...c2, town: 'Ibrag', bedrooms: 3, notes: GEORGE_NOTES })
    assert.ok(/Availability to be confirmed/.test(r.text) && !/Available from July|Viewings from July/.test(r.text), r.text)
    // the already-published legacy shape is not advertised either
    const legacy = await renderer.render2906Listing({ town: 'Ibrag', bedrooms: 3, available_date: 'July', viewable_date: 'July 2026', notes: GEORGE_NOTES })
    assert.ok(!/Viewings from July 2026/.test(legacy.text), legacy.text)
  })

  await run('T10 no photos → no appearance claims; unsupported luxury/pool/sea-view prose is rejected', async () => {
    const c = { town: 'Ibrag', bedrooms: 3, bathrooms: 2, price: 1600, notes: GEORGE_NOTES }
    geminiReply = { intro: 'Looking for luxury? This stunning maisonette in Ibrag offers sea views and a pool.', closing: 'An exceptional opportunity at an excellent price.' }
    const r = await renderer.render2906Listing(c)
    assert.ok(!/stunning|luxury|sea view|pool|excellent price|opportunity/i.test(r.text), r.text)
    geminiReply = { intro: 'Looking for space in Ibrag? This maisonette has three bedrooms, two bathrooms and an interconnecting garage.', closing: 'A practical family home with a back yard and barbecue area in Ibrag.' }
    const ok = await renderer.render2906Listing(c)
    assert.ok(/interconnecting garage/.test(ok.text) && /€1,600\/month/.test(ok.text), ok.text)
  })

  await run('T11/T12 no sharing persisted; company lease "we would discuss" is DISCUSSABLE, never approved', async () => {
    const said = "We'd have to discuss.  I've had one 2yr lease that was not too good. But I currently have a lease to a company, and it's going well .  So we would discuss"
    assert.strictEqual(aoc.extractSublettingMention(said), 'discuss')
    const c = aoc.mergeExtracted({ _asked_subletting: true, sharing: 'no', pets: 'no' }, {}, said)
    assert.strictEqual(c.subletting, 'discuss')
    const { rules, provenance } = aoc.draftRulesAndProvenance({ ...c, town: 'Ibrag' })
    assert.deepStrictEqual([rules.sharing_allowed, rules.pets_allowed, rules.subletting_allowed, rules.subletting_considered],
      [false, false, null, true])
    assert.ok(/DISCUSSABLE/.test(rules.subletting_note))
    assert.strictEqual(provenance.company_lease, 'DISCUSSABLE_NOT_APPROVED')
    assert.strictEqual(provenance.photos, 'NONE_RECEIVED')
    assert.strictEqual(provenance.price.verification, 'MISSING')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
