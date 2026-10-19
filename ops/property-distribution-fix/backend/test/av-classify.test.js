'use strict'
// Exercises classifyReply's branch ORDER in isolation, by lifting the regexes and
// the two functions out of services/availability.js. The order is the whole
// point: "sorry, still available" must not be read as a negative, and a bare
// "no" must not be read as "rented".
const fs = require('fs')
const src = fs.readFileSync(process.argv[2] || '/app/services/availability.js', 'utf8')
const grab = (re, label) => {
  const m = src.match(re)
  if (!m) { console.error('could not lift ' + label); process.exit(1) }
  return m[0]
}
const code = [
  grab(/const MONTHS = [\s\S]*?\]/, 'MONTHS'),
  grab(/const MONTHS_SHORT = [\s\S]*?\]/, 'MONTHS_SHORT'),
  grab(/const POSITIVE = .*/, 'POSITIVE'),
  grab(/const NEGATIVE = .*/, 'NEGATIVE'),
  grab(/const RENTED_VERB = .*/, 'RENTED_VERB'),
  grab(/const UNCLEAR_TRIGGERS = .*/, 'UNCLEAR_TRIGGERS'),
  grab(/const NEGATED_AVAILABILITY =[\s\S]*?\/i\s*$/m, 'NEGATED_AVAILABILITY'),
  // Every const classifyReply closes over has to be lifted with it, or the
  // rebuilt function throws ReferenceError instead of failing an assertion.
  grab(/const BARE_RENT = .*/, 'BARE_RENT'),
  grab(/const LISTING_LINK_RE = .*/, 'LISTING_LINK_RE'),
  grab(/const NEGATED_RENTED =[\s\S]*?\/i\s*$/m, 'NEGATED_RENTED'),
  // Kev, 2026-09-14 (date-with-year parsing, spec item 1): extractTimeframe
  // is now a thin back-compat wrapper around extractTimeframeDetail, which
  // in turn calls three small date helpers — all lifted here, or the
  // rebuilt function throws ReferenceError instead of failing an assertion,
  // same reasoning as the BARE_RENT/NEGATED_RENTED comment above. Regexes
  // anchor on the literal '(' immediately after the function name so
  // 'extractTimeframe(' never also matches 'extractTimeframeDetail('.
  grab(/function monthIndex[\s\S]*?\n}/, 'monthIndex'),
  grab(/function monthLabel[\s\S]*?\n}/, 'monthLabel'),
  grab(/function resolveMonthDate[\s\S]*?\n}/, 'resolveMonthDate'),
  grab(/function extractTimeframeDetail[\s\S]*?\n}/, 'extractTimeframeDetail'),
  grab(/function extractTimeframe\([\s\S]*?\n}/, 'extractTimeframe'),
  grab(/function classifyReply[\s\S]*?\n}/, 'classifyReply'),
].join('\n')

const classify = new Function(code + '\nreturn classifyReply')()
const cases = [
  ['yes still available',                     'replied_available'],
  ['sorry for the late reply, still available','replied_available'],
  ['yes',                                     'replied_available'],
  ['it is rented',                            'replied_no'],
  ['no longer available',                     'replied_no'],
  ['sold last week',                          'replied_no'],
  ['already taken sorry',                     'replied_no'],
  ['no',                                      'replied_unclear'],
  ['nope',                                    'replied_unclear'],
  ['sorry, nothing at the moment',            'replied_unclear'],
  ['not really',                              'replied_unclear'],
  ['tenant until September',                  'replied_soon'],
  ['',                                        'unclear'],
  ['maybe',                                   'unclear'],

  // ── the 2026-08-16 holes, pinned ──────────────────────────────────────────
  // 1. A negated rented verb means the flat is FREE. Each of these used to come
  //    back 'replied_no': off the board, 😡 into the groups, and the owner
  //    thanked for finding tenants they had just said they had not found.
  ['still available, not rented',             'replied_available'],
  ['not rented yet',                          'replied_available'],
  ['still on the market, nobody rented it',   'replied_available'],
  // ...but a bare "no" is not a negator. This one is a real reply from the
  // table and must stay a NO.
  ['No sorry it is rented',                   'replied_no'],
  ['Sorry it has been rented already',        'replied_no'],

  // 2. Bare "rent" as the predicate. RENTED_VERB only knew the inflected form.
  ['the property is already rent sorry',      'replied_no'],
  ['it is rent',                              'replied_no'],
  // ...and the phrases that merely contain the word must not become NOs.
  ['I want to rent it out',                   'unclear'],

  // 3. Rented AND positive in one message: ask, never pick. Check id 45
  //    (property 167) is the shape — one flat rented, a different one offered
  //    as available — and it was filed as AVAILABLE while the flat was gone.
  ['the property is already rent, my next one available', 'replied_unclear'],
  ['Yes rented, no longer',                   'replied_unclear'],
]
let bad = 0
for (const [text, want] of cases) {
  const got = classify(text).status
  const ok = got === want
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'XX  '}${JSON.stringify(text)} → ${got}${ok ? '' : `  (want ${want})`}`)
}
console.log(bad ? `\n${bad} MISMATCH` : '\nevery case lands where it should')
process.exit(bad ? 1 : 0)
