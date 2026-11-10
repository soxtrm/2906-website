'use strict'
// All 486 synthetic ARGUS golden cases (recovery pack 2026-11-09) through the
// real ownerTurnRouter. Action correctness first: route, send/no-send, sender
// identity in the reply, forbidden interrogation. Selected facts are checked
// where the pack uses a canonical key; the rest of expected_facts is listed
// in the report, not asserted (keys vary per case).
//
// Thread context lives only in each case's prose (scenario). CONTEXT maps the
// seeds whose expected action depends on thread state to explicit flags.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { routeOwnerTurn } = require('../services/ownerTurnRouter')

const CASES = fs.readFileSync(path.join(__dirname, 'fixtures', 'argus-golden-cases-20261109.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

const TWO_REFS = ['#2906-9555', '#2906-9556']
const CONTEXT = {
  '007': { contactSourceVerified: true, contactSourceLabel: 'an approved publicly listed property advert (synthetic test source)' },
  '034': { threadPaused: true },
  '073': { numberedOptions: TWO_REFS }, '074': { numberedOptions: TWO_REFS }, '075': { numberedOptions: TWO_REFS },
  '083': { numberedOptions: ['#2906-9601', '#2906-9602', '#2906-9603'] },
  '132': { duplicateEvent: true },
  '134': { accountPaused: true },
  '135': { globallySuppressed: true },
  '136': { agentDrafting: true },
  '137': { sessionOnline: false },
  '138': { withinSendWindow: false },
}

const NO_SEND_ROUTES = new Set(['PRIVACY_STOP', 'HUMAN_REVIEW', 'HUMAN_HANDOFF', 'NO_REPLY', 'NO_REPLY_HUMAN_ACTIVE'])
const PERSONA_NAMES = ['Kevin', 'Cedric', 'Gabriela']
const INTERROGATION_RE = /\bhow many (?:bed|bath)rooms\b|\brent per month\b|\bwhat would the monthly rent\b/i

function identityFor(fixture) {
  return {
    persona: fixture.code, name: fixture.name, agency: fixture.agency, affiliationVerified: true,
    website: fixture.code === 'K' ? 'https://2906.estate' : null,
  }
}

function seedOf(id) { return id.split('-')[1] }

// expected_facts keys the router owns, mapped to its canonical names.
const FACT_KEYS = {
  bedrooms: 'bedrooms', beds: 'bedrooms', location: 'location', locality: 'location', type: 'type', floor: 'floor',
  rent: 'price', monthly_rent: 'price', price: 'price', asking_rent: 'price', global_suppress: 'global_suppress',
  private_draft: 'private_draft',
}

for (const c of CASES) {
  test(`${c.id} [${c.category}] ${c.expected_route}: ${c.inbound_messages.join(' / ').slice(0, 70)}`, () => {
    const persona = c.persona_fixture
    const context = { ...(CONTEXT[seedOf(c.id)] || {}), ...(c.id.endsWith('-H') ? { humanActive: true } : {}) }
    const identity = identityFor(persona)
    const d = routeOwnerTurn({ messages: c.inbound_messages, identity, context })

    assert.equal(d.route, c.expected_route, `route (hold=${d.holdReason})`)
    if (NO_SEND_ROUTES.has(c.expected_route)) assert.equal(d.shouldSend, false, 'must not send')
    if (d.shouldSend) {
      assert.ok(d.replyText, 'a send needs text')
      assert.doesNotMatch(d.replyText, INTERROGATION_RE, 'no property interrogation in an answer')
      for (const other of PERSONA_NAMES.filter(n => n !== persona.name)) {
        assert.doesNotMatch(d.replyText, new RegExp(`\\b${other}\\b`), `never speaks as ${other}`)
      }
    } else if (c.expected_route === 'ANSWER_QUESTION') {
      assert.ok(d.holdReason, 'an unanswered question must carry a hold reason')
    }
    if (d.shouldSend && d.questions.includes('identity')) {
      assert.match(d.replyText, new RegExp(`\\b${persona.name}\\b`), 'answers as the verified sender')
      assert.ok(d.replyText.includes(persona.agency), 'names the verified agency')
    }
    for (const [key, value] of Object.entries(c.expected_facts || {})) {
      const mapped = FACT_KEYS[key]
      if (!mapped || value === null || typeof value === 'object') continue
      if (mapped === 'location' && typeof value === 'string' && value.includes(' ')) continue   // prose ("Mosta street confirmed")
      if (mapped === 'type' && !['studio', 'penthouse', 'office', 'apartment'].includes(value)) continue
      assert.equal(String(d.factsDelta[mapped]).normalize('NFC'), String(value).normalize('NFC'), `fact ${key}`)
    }
  })
}
