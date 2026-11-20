'use strict'
// Listings whose stored kind contradicts their own text (the upload wrote "apartment" by default).
//   node type-backfill.js                 report only
//   APPLY=1 OUT=/tmp node type-backfill.js   corrects the clear cases, writes a change log and an undo file
// Changed only when the text names exactly one kind and the stored one is "apartment" or empty.
// A stored penthouse/maisonette/house/villa/studio is never overwritten; unclear texts are listed for review.
const fs = require('fs'); const path = require('path'); const Module = require('module')
const db = require('/app/db')
const file = '/app/services/propertyTypeResolver.js'
let R
try { R = require(file) } catch { const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths('/app/services'); m._compile(fs.readFileSync('/tmp/propertyTypeResolver.js', 'utf8'), file); R = m.exports }
const APPLY = process.env.APPLY === '1'; const OUT = process.env.OUT || '/tmp'
;(async () => {
  const { rows } = await db.query(
    `SELECT id, ref, lower(nullif(btrim(property_type), '')) AS stored, description FROM properties
      WHERE system_online AND available_status IN ('available','available_confirmed','upcoming','pending_check')
        AND (property_type IS NULL OR btrim(property_type) = '' OR lower(property_type) = 'apartment')`)
  const changes = [], review = []
  for (const r of rows) {
    const seen = R.fromText(r.description)
    if (seen.type && seen.type !== r.stored) changes.push({ id: r.id, ref: r.ref, from: r.stored, to: seen.type, why: seen.why })
    else if (!seen.type && r.stored === 'apartment' && seen.why !== 'no text') review.push({ ref: r.ref, why: seen.why })
    else if (!seen.type && !r.stored) review.push({ ref: r.ref, why: seen.why })
  }
  const tally = changes.reduce((m, c) => (m[`${c.from || 'empty'} -> ${c.to}`] = (m[`${c.from || 'empty'} -> ${c.to}`] || 0) + 1, m), {})
  console.log(`${rows.length} listings stored as apartment or without a kind; text says otherwise for ${changes.length}:`, JSON.stringify(tally))
  console.log('sample:', changes.slice(0, 8).map(c => `#${c.ref} ${c.from || 'empty'}->${c.to}`).join(', '))
  const rv = review.reduce((m, c) => (m[c.why] = (m[c.why] || 0) + 1, m), {})
  console.log(`for review (${review.length}):`, JSON.stringify(rv))
  if (!APPLY) { console.log('nothing changed (report only)'); return setTimeout(() => process.exit(0), 100) }
  let done = 0
  for (const c of changes) {
    const u = await db.query(`UPDATE properties SET property_type = $2, updated_at = NOW() WHERE id = $1 AND (property_type IS NULL OR btrim(property_type) = '' OR lower(property_type) = 'apartment') RETURNING id`, [c.id, c.to])
    done += u.rows.length
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  fs.writeFileSync(path.join(OUT, `type-backfill-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), changes, review }, null, 1))
  fs.writeFileSync(path.join(OUT, `type-backfill-${stamp}.undo.sql`), changes.map(c => `UPDATE properties SET property_type = ${c.from ? `'${c.from}'` : 'NULL'} WHERE id = ${c.id};`).join('\n') + '\n')
  console.log(`corrected: ${done}; log + undo: type-backfill-${stamp}.*`)
  setTimeout(() => process.exit(0), 100)
})().catch(e => { console.log('FAILED', e.message); process.exit(1) })
