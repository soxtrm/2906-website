'use strict'
// Listings saved without a town while the AI text reader was down. The town is read from the listing's own
// first lines. It is only taken when the resolver is sure of the name AND the text names exactly one town;
// two different towns, or none, leave the listing unchanged for a person to decide.
//   node town-backfill.js            report only
//   APPLY=1 OUT=/tmp/x node ...      writes town + locality for the sure ones, and a change log + undo file
// Only rows whose town is empty are touched; a town that is already there is never overwritten.
const fs = require('fs')
const path = require('path')
const db = require('/app/db')
const resolver = require('/app/services/localityResolver')
const APPLY = process.env.APPLY === '1'
const OUT = process.env.OUT || '/tmp'

const clean = s => String(s || '').replace(/[*_!"“”()\[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
function candidates(description) {
  const lines = String(description || '').split(/\n/).map(clean).filter(Boolean).slice(0, 4)
  const out = []
  for (const line of lines) {
    const frags = line.split(/\s[–—-]\s|,|\||\/|\bnear\b|\bin\b|\bnext to\b|\bat\b/i).map(x => x.trim()).filter(x => x.length >= 3 && x.length <= 40)
    out.push(...frags)
    const words = line.split(' ')
    for (const n of [3, 2, 1]) if (words.length > n) out.push(words.slice(-n).join(' '))
    for (const n of [3, 2, 1]) if (words.length >= n) out.push(words.slice(0, n).join(' '))
  }
  return [...new Set(out)]
}
async function townsIn(description) {
  const found = new Map()
  for (const c of candidates(description)) {
    const res = await resolver.resolveLocality(c).catch(() => null)
    if (res && res.status === 'RESOLVED' && res.canonical_name && res.confidence === 'high') found.set(res.canonical_name, res)
  }
  // "Ibragg, Swieqi": a neighbourhood and the town it belongs to are one place, not a contradiction
  const names = [...found.keys()]
  for (const n of names) {
    const parent = (n.match(/\(([^)]+)\)\s*$/) || [])[1]
    if (parent && found.has(parent)) found.delete(n)
  }
  return [...found.values()]
}

;(async () => {
  const rows = (await db.query(
    `SELECT id, ref, description, published, available_status FROM properties
      WHERE (town IS NULL OR btrim(town) = '') AND id > 29000 ORDER BY id`)).rows
  const changes = [], manual = []
  const tally = {}
  for (const r of rows) {
    const towns = await townsIn(r.description)
    const head = clean(String(r.description || '').split('\n')[0]).slice(0, 80)
    if (towns.length !== 1) {
      manual.push({ id: r.id, ref: r.ref, reason: towns.length ? `names ${towns.map(t => t.canonical_name).join(' and ')}` : (head ? 'no town in the text' : 'empty draft'), headline: head })
      continue
    }
    const hit = towns[0]
    tally[hit.canonical_name] = (tally[hit.canonical_name] || 0) + 1
    if (APPLY) {
      const u = await db.query(
        `UPDATE properties SET town = $2, locality_id = COALESCE($3, locality_id), locality_resolution_status = $4, updated_at = NOW()
          WHERE id = $1 AND (town IS NULL OR btrim(town) = '') RETURNING id`,
        [r.id, hit.canonical_name, hit.locality_id || null, hit.status])
      if (u.rows.length) changes.push({ id: r.id, ref: r.ref, town: hit.canonical_name, locality_id: hit.locality_id || null })
    } else changes.push({ id: r.id, ref: r.ref, town: hit.canonical_name })
  }
  console.log(`${rows.length} listings without a town; exactly one sure town for ${changes.length}; ${APPLY ? 'WRITTEN' : 'nothing written (report only)'}`)
  console.log('towns:', Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '))
  console.log(`left for a person (${manual.length}):`)
  for (const m of manual) console.log(`  #${m.ref || '(no ref, id ' + m.id + ')'}: ${m.reason}${m.headline ? ' | ' + m.headline : ''}`)
  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
    fs.writeFileSync(path.join(OUT, `town-backfill-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), changes, manual }, null, 1))
    fs.writeFileSync(path.join(OUT, `town-backfill-${stamp}.undo.sql`),
      `-- puts the ${changes.length} listings back to "no town"\nUPDATE properties SET town = NULL, locality_id = NULL, locality_resolution_status = 'UNKNOWN' WHERE id IN (${changes.map(c => c.id).join(', ') || 'NULL'});\n`)
    console.log('log:', `town-backfill-${stamp}.json`, '+ .undo.sql in', OUT)
  }
  setTimeout(() => process.exit(0), 200)
})().catch(e => { console.log('FAILED', e.message); process.exit(1) })
