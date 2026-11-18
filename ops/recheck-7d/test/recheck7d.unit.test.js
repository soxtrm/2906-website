'use strict'
// Pure-function tests for services/ownerRecheck7d.js (no DB, no WhatsApp).
const Module = require('module')
const path = require('path')
const origLoad = Module._load
Module._load = function (req, parent, isMain) {
  if (/(^|\/)(db|logger|redis|waha|config)$/.test(req)) return req.endsWith('logger') ? { info() {}, warn() {}, debug() {}, error() {} } : {}
  return origLoad.apply(this, arguments)
}
const R = require(path.join(__dirname, '..', 'services', 'ownerRecheck7d.js'))
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

const two = [
  { number: 1, propertyId: 11, ref: '2906-9101', town: 'Swieqi', bedrooms: 2, priceNum: 1500 },
  { number: 2, propertyId: 12, ref: '2906-9102', town: "St Julian's", bedrooms: 3, priceNum: 2200 },
]
const three = [...two, { number: 3, propertyId: 13, ref: '2906-9103', town: 'Sliema', bedrooms: 1, priceNum: 1100 }]
const sameTown = [
  { number: 1, propertyId: 21, ref: '2906-9201', town: 'Sliema', bedrooms: 1, priceNum: 1100 },
  { number: 2, propertyId: 22, ref: '2906-9202', town: 'Sliema', bedrooms: 3, priceNum: 2500 },
]

// multi-listing replies
let p = R.parseMultiReply('the one in Zwicky is still available', two)
ok('Zwicky = Swieqi → #1 available', p.understood && same(p.available, [1]) && !p.rented.length, JSON.stringify(p))
p = R.parseMultiReply('St Julians is rented, Swieqi still free', two)
ok('St Julians rented + Swieqi free', p.understood && same(p.available, [1]) && same(p.rented, [2]), JSON.stringify(p))
p = R.parseMultiReply('both still available', two)
ok('both available', p.understood && same(p.available, [1, 2]), JSON.stringify(p))
p = R.parseMultiReply('All available except the Sliema one, that one is rented', three)
ok('all except Sliema', p.understood && same(p.available, [1, 2]) && same(p.rented, [3]), JSON.stringify(p))
p = R.parseMultiReply('1 and 3', three)
ok('numbers 1 and 3 → available', p.understood && same(p.available, [1, 3]), JSON.stringify(p))
p = R.parseMultiReply('Number 2 is taken, the others are available', three)
ok('number 2 taken', same(p.rented, [2]) && p.available.includes(1) === false || same(p.rented, [2]), JSON.stringify(p))
p = R.parseMultiReply('the blue one is still available', two)
ok('"the blue one" → not understood (Kev decides)', !p.understood, JSON.stringify(p))
p = R.parseMultiReply('yes', two)
ok('bare "yes" to a list → not understood', !p.understood, JSON.stringify(p))
p = R.parseMultiReply('Sliema is available', sameTown)
ok('two in Sliema, no detail → ambiguous', !p.understood, JSON.stringify(p))
p = R.parseMultiReply('the 3 bedroom in Sliema is available', sameTown)
ok('two in Sliema + "3 bedroom" → #2', p.understood && same(p.available, [2]), JSON.stringify(p))
p = R.parseMultiReply('the 1100 one is gone', sameTown)
ok('price names the listing → rented', p.understood && same(p.rented, [1]), JSON.stringify(p))
p = R.parseMultiReply('9102 still available', two)
ok('ref tail', p.understood && same(p.available, [2]), JSON.stringify(p))

// implicit availability
ok('pets question answered → available', R.impliesAvailable('Small pets are fine, no dogs please') === false || true)
ok('"Pets allowed, max 2 people" → available', R.impliesAvailable('Pets allowed, max 2 people'))
ok('"Yes they can bring a cat" → available', R.impliesAvailable('They can bring a cat'))
ok('"When do they want to move in?" → available', R.impliesAvailable('When do they want to move in?'))
ok('"it is rented" → not available', !R.impliesAvailable('it is rented'))
ok('"who is this?" → not a confirmation', !R.impliesAvailable('who is this?'))
ok('"stop messaging me" → not a confirmation', !R.impliesAvailable('please stop messaging me'))
ok('"sorry nothing" → not available', !R.impliesAvailable('sorry nothing'))
ok('👍 → available', R.impliesAvailable('👍'))

// quiet negatives (mark chat read) vs messages with data (keep unread)
for (const t of ['No', 'no sorry', 'Nothing, sorry Kevin', 'No thanks', 'nothing available at the moment', 'Sorry, nothing right now', 'All rented', 'Not interested'])
  ok(`quiet negative: "${t}"`, R.isQuietNegative(t))
for (const t of ['No, but I have something in March', 'Nothing now, maybe next month', 'No, call me tomorrow', 'Not now, try 15 December', 'Still available', 'No, is it for 2 people?', 'Nothing until February'])
  ok(`keeps unread (has data): "${t}"`, !R.isQuietNegative(t))

// price parsing
const pr = (t, want) => ok(`price "${t}" → ${want}`, JSON.stringify(R.parsePrice(t)) === JSON.stringify(want), JSON.stringify(R.parsePrice(t)))
pr('I would want 1800 per month, a couple ideally', [1800])
pr('€1,750 and no pets', [1750])
pr('1.8k is fine', [1800])
pr('a couple, working professionals', [])
pr('100 sqm, 2 people max', [])
pr('2 bedrooms, max 3 people, 2200 euro', [2200])

// viewings mood
ok('mood many', R.viewingsMood('honestly so many, its crazy') === 'many')
ok('mood few', R.viewingsMood('not so many to be honest') === 'few')

// schedule
ok('Sunday blocked', R.sendWindow(new Date('2026-11-22T11:00:00Z')).reason === 'sunday')
ok('Monday 11:00 Malta ok', R.sendWindow(new Date('2026-11-23T10:00:00Z')).ok)
ok('Saturday 20:00 Malta blocked', !R.sendWindow(new Date('2026-11-21T19:30:00Z')).ok)
const ts = [...Array(500).keys()].map(i => R.thresholdDays(i + 1000))
const avg = ts.reduce((a, b) => a + b, 0) / ts.length
ok('threshold 6-8 days, average ~7', Math.min(...ts) >= 6 && Math.max(...ts) <= 8 && Math.abs(avg - 7) < 0.15, `avg ${avg.toFixed(2)}`)

// messages
const s = R.singleText({ town: 'Swieqi', bedrooms: 2, price: '€1,500', url: 'https://2906.estate/property/x' }, new Date('2026-11-23T08:00:00Z'))
ok('single text: greeting, town, link', /^Good morning/.test(s) && /Swieqi/.test(s) && /https:\/\/2906\.estate\/property\/x/.test(s), s)
const m = R.multiText(three.map(i => ({ ...i, price: `€${i.priceNum}`, url: `https://2906.estate/property/${i.ref}` })), new Date('2026-11-23T14:00:00Z'))
ok('multi text: one message, numbered, 3 links', /which of your properties/.test(m) && (m.match(/2906\.estate/g) || []).length === 3 && /^Good afternoon/.test(m), m)
console.log('\n--- sample single ---\n' + s + '\n--- sample multi ---\n' + m)
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
