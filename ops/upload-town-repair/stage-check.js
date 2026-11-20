'use strict'
// Read-only check of the patched reader inside a copy: the AI reader is switched off, the emergency
// reader must still return the town. Usage: node stage-check.js <path to patched uploadListing.js>
process.env.GEMINI_API_KEY = ''
const ul = require(process.argv[2])
const T = [
  ['MODERN 2-BEDROOM APARTMENT – SLIEMA\nSliema – Amery Street\n€1,500/month\n2 Bedrooms - 1 Bathroom\nCall 35699000000', 'Sliema'],
  ['EXCLUSIVE DEAL – 4 MODERN APARTMENTS IN ST PAUL’S BAY\n€975 /monthly\n1 Bedroom\n35699000000', "St Paul's Bay"],
  ['GREAT PRICE VALUE – 3-BEDROOM APARTMENT QAWRA\n€1,450/month\n3 Bedrooms - 2 Bathrooms\n35699000000', 'Qawra'],
  ['LUXURY 3-BEDROOM APARTMENT WITH HUGE TERRACE\n€2,000/month\n3 Bedrooms\n35699000000', ''],
]
;(async () => {
  let bad = 0
  for (const [text, want] of T) {
    const ex = await ul.extractListing(text, { allowNoOwner: true })
    const got = (ex && ex.property && ex.property.location) || ''
    const town = got ? await ul.matchLocation(got) : ''
    const ok = (town || '') === want
    if (!ok) bad++
    console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(text.split('\n')[0].slice(0, 50)), '->', JSON.stringify(town || got))
  }
  process.exit(bad ? 1 : 0)
})()
