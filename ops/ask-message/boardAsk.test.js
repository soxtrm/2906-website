'use strict'

const assert = require('node:assert/strict')
const boardAsk = require('./boardAsk')

const raw = `Hi, would you consider a russian Couple Working in IT?

their budget is more like 1600-1700€ but maybe we can come together if you like each other`

const morning = new Date('2026-10-10T06:30:00.000Z') // 08:30 Malta (CEST)
const afternoon = new Date('2026-10-10T11:00:00.000Z') // 13:00 Malta
const evening = new Date('2026-10-10T18:00:00.000Z') // 20:00 Malta

assert.equal(boardAsk.maltaGreeting(morning), 'Good morning')
assert.equal(boardAsk.maltaGreeting(afternoon), 'Good afternoon')
assert.equal(boardAsk.maltaGreeting(evening), 'Good evening')

const first = boardAsk.fallbackMessage({
  mode: 'owner', ref: '2906-9416', recipientName: null,
  rawNote: raw, isReachout: false, now: afternoon,
})
assert.match(first, /^Good afternoon, I hope you're well\./)
assert.match(first, /Russian/i)
assert.match(first, /couple/i)
assert.match(first, /IT\b/i)
assert.match(first, /1600/)
assert.match(first, /1700/)
assert.ok(boardAsk.preservesCriticalFacts(raw, first))

const followUp = boardAsk.fallbackMessage({
  mode: 'owner', ref: '2906-9416', recipientName: null,
  rawNote: raw, isReachout: true, now: afternoon,
})
assert.doesNotMatch(followUp, /^Good (morning|afternoon|evening)/)
assert.ok(boardAsk.preservesCriticalFacts(raw, followUp))

assert.equal(boardAsk.preservesCriticalFacts(raw,
  'Regarding #2906-9416, I have a Russian couple working in IT interested. Would you consider this profile?'), false)
assert.equal(boardAsk.preservesCriticalFacts(raw,
  'Regarding #2906-9416, would you consider a Russian couple working in IT with a budget of €1,600–€1,700?'), true)

const prompt = boardAsk.buildPrompt({
  mode: 'owner', ref: '2906-9416', agentName: 'Kevin', recipientName: null,
  rawNote: raw, isReachout: false, now: afternoon,
})
assert.match(prompt, /Begin exactly with "Good afternoon, I hope you're well\."/)
assert.match(prompt, /budget\/range, nationality, profession\/job/)
assert.match(prompt, /client's budget is NOT internal/)

console.log('boardAsk fact-preservation and Malta greeting tests passed')
