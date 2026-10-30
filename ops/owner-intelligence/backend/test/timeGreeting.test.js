'use strict'
// Kev, 2026-10-30: time-of-day wording at the moment of sending. Drives the
// REAL waha.sendText (only the HTTP call to WAHA is captured) and the real
// services/timeGreeting.js. No WhatsApp message leaves the machine.
//   node --test test/timeGreeting.test.js
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const ROOT = path.join(__dirname, '..')
const stubs = {
  config: { waha: { url: 'http://waha.invalid', apiKey: 'test' } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  telegram: { sendAlert: async () => {} },
  'services/sessionRoles': {},
  'services/wahaMediaPager': { collectMessagePages: async () => [] },
  'services/outreachIdentity': { assertOutboundIdentity: async () => {} },
  'services/contactTouch': { recordOutbound: async () => {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.startsWith(ROOT) && request.startsWith('.')) {
    const rel = path.relative(ROOT, path.resolve(path.dirname(parent.filename), request)).replace(/\\/g, '/').replace(/\.js$/, '')
    if (stubs[rel]) return stubs[rel]
  }
  return origLoad.apply(this, arguments)
}

const sent = []
global.fetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) })
  return { ok: true, status: 201, json: async () => ({ id: 'true_x@c.us_ABC123' }), text: async () => '' }
}

const waha = require(path.join(ROOT, 'waha'))
const { fixTimeWording, fixForSend } = require(path.join(ROOT, 'services/timeGreeting'))
const { maltaLocalToUTC } = require(path.join(ROOT, 'services/outreachSchedule'))
const at = (day, hhmm) => maltaLocalToUTC(day, hhmm)

// Freeze the clock for sendText (it reads `new Date()` at the send).
function withClock(date, fn) {
  const Real = Date
  global.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [date.getTime()])) }
    static now() { return date.getTime() }
  }
  return Promise.resolve().then(fn).finally(() => { global.Date = Real })
}

test.beforeEach(() => { sent.length = 0 })

test('Test A: a reply sent at 12:53 Malta never starts with "Good evening" (real waha.sendText)', async () => {
  await withClock(at('2026-10-30', '12:53'), () =>
    waha.sendText('default', '35699811819', 'Good evening! Thanks for getting back to me about the flat.'))
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].body.text, 'Good afternoon! Thanks for getting back to me about the flat.')
})

test('the fixed FALL1 decline text ("have a good evening") follows the send time', async () => {
  const fall1 = 'No worries, thank you for your feedback, please keep me posted regarding updates, have a good evening'
  await withClock(at('2026-10-30', '12:53'), () => waha.sendText('default', '35699811819', fall1))
  assert.match(sent[0].body.text, /have a good afternoon$/)
  await withClock(at('2026-10-30', '09:10'), () => waha.sendText('default', '35699811819', fall1))
  assert.match(sent[1].body.text, /have a good day$/)
  await withClock(at('2026-10-30', '20:15'), () => waha.sendText('default', '35699811819', fall1))
  assert.strictEqual(sent[2].body.text, fall1)
})

test('boundaries 11:59 / 12:00 / 17:59 / 18:00 and the DST change', () => {
  const g = (d, t) => fixTimeWording('Good morning, quick question.', at(d, t)).text.split(',')[0]
  assert.deepStrictEqual(
    [g('2026-10-30', '11:59'), g('2026-10-30', '12:00'), g('2026-10-30', '17:59'), g('2026-10-30', '18:00')],
    ['Good morning', 'Good afternoon', 'Good afternoon', 'Good evening'])
  // 25 Oct 2026: clocks go back. 12:30 Malta on both sides is afternoon.
  assert.strictEqual(g('2026-10-24', '12:30'), 'Good afternoon')
  assert.strictEqual(g('2026-10-26', '12:30'), 'Good afternoon')
})

test('only real greetings and time-bound wishes change; everything else stays byte-identical', () => {
  const noon = at('2026-10-30', '13:00')
  const keep = [
    'Evening viewings are possible after 18:00.',
    'Morning, I can do Tuesday.', // bare word: not a greeting we rewrite
    'Have a great weekend!',
    'Enjoy the rest of your week.',
    'The owner said good evening to the tenants yesterday and left.',
    'Rent is €1,200, available from 1 December.',
  ]
  for (const t of keep) assert.strictEqual(fixTimeWording(t, noon).text, t, t)
  assert.strictEqual(fixTimeWording('Hi, good evening! Is it still available?', noon).text, 'Hi, good afternoon! Is it still available?')
  assert.strictEqual(fixTimeWording('Thanks a lot — have a lovely evening!', noon).text, 'Thanks a lot — have a lovely afternoon!')
  assert.strictEqual(fixTimeWording('Thanks, good night', noon).text, 'Thanks, have a nice afternoon')
  assert.strictEqual(fixTimeWording('Speak soon, have a nice day!', at('2026-10-30', '19:00')).text, 'Speak soon, have a nice evening!')
})

test('groups, broadcasts and newsletters are never rewritten', async () => {
  const noon = at('2026-10-30', '12:53')
  for (const id of ['120363000000000000@g.us', 'status@broadcast', '1203630000@newsletter']) {
    assert.strictEqual(fixForSend(id, 'Good evening everyone', noon), 'Good evening everyone')
  }
  await withClock(noon, () => waha.sendText('default', '120363000000000000@g.us', 'Good evening everyone'))
  assert.strictEqual(sent[0].body.text, 'Good evening everyone')
})

test('captions to owners are corrected too', async () => {
  await withClock(at('2026-10-30', '12:53'), () =>
    waha.sendImage('default', '35699811819', 'aGVsbG8=', 'image/jpeg', 'Good evening, here are the photos.'))
  assert.strictEqual(sent[0].body.caption || sent[0].body.file?.caption, 'Good afternoon, here are the photos.')
})
