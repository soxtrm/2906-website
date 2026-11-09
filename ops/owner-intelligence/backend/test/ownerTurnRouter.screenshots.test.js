'use strict'
// Held-out checks for ownerTurnRouter: the four production screenshots
// (2026-11-08/09, owner names removed) word for word, plus paraphrases that are
// NOT in the golden pack. Uses the real agentIdentityRegistry personas, so a
// wrong or unverified affiliation fails here.
const test = require('node:test')
const assert = require('node:assert/strict')
const { routeOwnerTurn } = require('../services/ownerTurnRouter')
const { PERSONA_IDENTITIES } = require('../services/agentIdentityRegistry')

const KEVIN = PERSONA_IDENTITIES.kev
const CEDRIC = PERSONA_IDENTITIES.cedric
const GABRIELA = PERSONA_IDENTITIES.gabriela
const route = (messages, identity, context = {}) => routeOwnerTurn({ messages, identity, context })
const INTERROGATION_RE = /\bbed(?:room)?s?\b|\bbath(?:room)?s?\b|\brent per month\b/i

test('screenshot Cedric 1: auto-responder + "are u an agent n malta / or u have ur own properties" → identity answer as Cedric/QuickLets', () => {
  const d = route(['Thank you for contacting Gabriella!\nPlease let us know how we can help you.', 'are u an agent n malta', 'or u have ur own properties'], CEDRIC)
  assert.equal(d.route, 'ANSWER_QUESTION')
  assert.equal(d.shouldSend, true)
  assert.match(d.replyText, /\bCedric\b/)
  assert.match(d.replyText, /QuickLets/)
  assert.doesNotMatch(d.replyText, /Gabriel+a|Kevin/)
  assert.doesNotMatch(d.replyText, INTERROGATION_RE)
})

test('screenshot Cedric 2: "i am agent also … i asked u a questions lol / r u an agent or urs" → acknowledges the miss, no questionnaire', () => {
  const d = route(['i am agent also', 'and we have a variety', 'of clients', 'i asked u a questions lol', 'r u an agent or urs'], CEDRIC)
  assert.equal(d.route, 'ANSWER_QUESTION')
  assert.match(d.replyText, /missed your question/)
  assert.match(d.replyText, /agent too/)
  assert.doesNotMatch(d.replyText, INTERROGATION_RE)
})

test('screenshot Gabriela 1: "who you represent … nothing for sale but might have for rent" → identity answer, never the decline closure', () => {
  const d = route(["Good evening Gabriela. I believe we haven't had contact before. Please let me who you represent or if you are by your own?\nHave at this time nothing for sale but might have for rent.\nRegards\nOwner Name"], GABRIELA)
  assert.equal(d.route, 'ANSWER_QUESTION')
  assert.match(d.replyText, /Sotheby's/)
  assert.doesNotMatch(d.replyText, /no worries|keep me posted/i)
})

test('screenshot Gabriela 2: "not answer my question. That\'s not a good start." → human handoff, no automatic reply', () => {
  const d = route(['No worries??\nYes it is worries as you are unknown and not answer my question.\nThat’s not a good start.'], GABRIELA)
  assert.equal(d.route, 'HUMAN_HANDOFF')
  assert.equal(d.shouldSend, false)
})

test('screenshot Kevin: "obtained my number illegally … remove my details from your database" → privacy stop, nothing sent', () => {
  const d = route(['Sorry not interested.\nEspecially if an agent uses AI to respond to there messages.\nYou should even be contacting me as you obtained my number illegally.\nPlease remove my details from your database.'], KEVIN)
  assert.equal(d.route, 'PRIVACY_STOP')
  assert.equal(d.shouldSend, false)
  assert.equal(d.factsDelta.global_suppress, true)
})

test('privacy stop wins over a human takeover and over a paused thread', () => {
  for (const context of [{ humanActive: true }, { threadPaused: true }, { accountPaused: true }]) {
    assert.equal(route(['please delete my number from your list'], KEVIN, context).route, 'PRIVACY_STOP')
  }
})

test('paraphrases not in the pack', () => {
  const cases = [
    [['which company r u with?'], 'ANSWER_QUESTION'],
    [['Are you from an agency or private?'], 'ANSWER_QUESTION'],
    [['who are you exactly?'], 'ANSWER_QUESTION'],
    [['what is the name of your agency please?'], 'ANSWER_QUESTION'],
    [['not interested, do not message me again'], 'PRIVACY_STOP'],
    [['Remove this number from your contacts please'], 'PRIVACY_STOP'],
    [['how much commission do you take?'], 'HUMAN_REVIEW'],
    [['I have a 3 bedroom maisonette in Naxxar, available from March'], 'PROPERTY_DRAFT'],
    [['Thanks!'], 'NO_REPLY'],
  ]
  for (const [messages, expected] of cases) {
    assert.equal(route(messages, KEVIN).route, expected, messages.join(' / '))
  }
})

test('an unverified affiliation holds instead of naming a firm', () => {
  const unverified = { ...CEDRIC, affiliationVerified: false }
  const d = route(['Which agency do you work for?'], unverified)
  assert.equal(d.route, 'ANSWER_QUESTION')
  assert.equal(d.shouldSend, false)
  assert.equal(d.holdReason, 'sender_affiliation_unverified')
  assert.equal(route(['Which agency do you work for?'], null).holdReason, 'sender_persona_unknown')
})

test('a clear offer during human takeover is still a private draft, with no send', () => {
  const d = route(['I have a two bedroom apartment in Sliema available in December.'], KEVIN, { humanActive: true })
  assert.equal(d.route, 'NO_REPLY_HUMAN_ACTIVE')
  assert.equal(d.shouldSend, false)
  assert.equal(d.factsDelta.private_draft, true)
  assert.equal(d.factsDelta.bedrooms, 2)
  assert.equal(d.factsDelta.location, 'Sliema')
})
