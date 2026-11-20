'use strict'
// Read-only check of the patched reader inside a copy: the AI reader is switched off, the emergency reader
// must return the town when the text names exactly one, and nothing when it is missing or unclear.
// Usage: node stage-check.js <path to patched uploadListing.js>
process.env.GEMINI_API_KEY = ''
const ul = require(process.argv[2])
const tail = '\n€1,500/month\n2 Bedrooms - 1 Bathroom\nCall 35699000000'
const T = [
  // one town, the ways agents write it
  ['MODERN 2-BEDROOM APARTMENT – SLIEMA\nSliema – Amery Street' + tail, 'Sliema'],
  ['EXCLUSIVE DEAL – 4 MODERN APARTMENTS IN ST PAUL’S BAY' + tail, "St Paul's Bay"],
  ['GREAT PRICE VALUE – 3-BEDROOM APARTMENT QAWRA' + tail, 'Qawra'],
  ['Pieta' + tail, 'Pieta'],
  ['📍 Gżira, near the seafront\nBright apartment' + tail, 'Gzira'],
  ['STUNNING CORNER PENTHOUSE – ST JULIAN’S / PORTOMASO' + tail, "St Julian's"],
  ['IBRAGG, SWIEQI | €2,900/month | 3 Bedrooms 2 Bathrooms\nCall 35699000000', 'Swieqi'],
  ['Location: Mosta\nLovely maisonette' + tail, 'Mosta'],
  // no town at all
  ['LUXURY 3-BEDROOM APARTMENT WITH HUGE TERRACE' + tail, ''],
  ['A stunning seafront apartment combining beautiful modern interiors' + tail, ''],
  ['Brand new, fully furnished, ready to move into' + tail, ''],
  // two different towns: unclear, stays unknown
  ['2-BEDROOM MAISONETTE – BUĠIBBA / QAWRA' + tail, ''],
  ['APARTMENT – SLIEMA\nGzira – Rue d’Argens' + tail, ''],
  ['Between Msida and Pieta, close to everything' + tail, ''],
  // words that only look like a place
  ['MODERN APARTMENT WITH SEA VIEW – CENTRAL LOCATION' + tail, ''],
  ['Marina view penthouse, top floor' + tail, ''],
  // a town named only deep in the text is not the listing's town
  ['Bright and modern apartment\nFully furnished\nLarge terrace\nAir conditioning\nOnly 10 minutes by car from Valletta' + tail, ''],
]
;(async () => {
  let bad = 0
  for (const [text, want] of T) {
    const ex = await ul.extractListing(text, { allowNoOwner: true })
    const got = (ex && ex.property && ex.property.location) || ''
    const town = got ? ((await ul.matchLocation(got)) || got) : ''
    const ok = town === want
    if (!ok) bad++
    console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(text.split('\n').slice(0, 2).join(' // ').slice(0, 62)), '->', JSON.stringify(town), ok ? '' : `(expected ${JSON.stringify(want)})`)
  }
  console.log(bad ? `${bad} FAILED` : `ALL ${T.length} PASSED`)
  process.exit(bad ? 1 : 0)
})()
