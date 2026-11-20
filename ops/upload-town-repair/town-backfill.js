'use strict'
// Listings saved without a town while the text reader was down (the emergency reader only knew a
// "Location:" line). The town is read from the listing's own first lines, and only a name the locality
// resolver knows is taken. Default: report only. APPLY=1 writes town + locality, nothing else.
const db = require('/app/db')
const resolver = require('/app/services/localityResolver')
const APPLY = process.env.APPLY === '1'

const clean = s => String(s || '').replace(/[*_!"“”()\[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
function candidates(description) {
  const lines = String(description || '').split(/\n/).map(clean).filter(Boolean).slice(0, 4)
  const out = []
  for (const line of lines) {
    const frags = line.split(/\s[–—-]\s|,|\||\/|\bnear\b|\bin\b|\bnext to\b|\bat\b/i).map(x => x.trim()).filter(x => x.length >= 3 && x.length <= 40)
    out.push(...frags.reverse(), ...frags)
    // the last one to three words of a headline: "... APARTMENT QAWRA", "... IN ST PAUL'S BAY"
    const words = line.split(' ')
    for (const n of [3, 2, 1]) if (words.length > n) out.push(words.slice(-n).join(' '))
    for (const n of [3, 2, 1]) if (words.length >= n) out.push(words.slice(0, n).join(' '))
  }
  return [...new Set(out)]
}

;(async () => {
  const rows = (await db.query(
    `SELECT id, ref, description, published, available_status FROM properties
      WHERE (town IS NULL OR btrim(town) = '') AND id > 29000 ORDER BY id`)).rows
  let found = 0, written = 0
  const tally = {}, missed = []
  for (const r of rows) {
    let hit = null
    for (const c of candidates(r.description)) {
      const res = await resolver.resolveLocality(c).catch(() => null)
      if (res && res.status === 'RESOLVED' && res.canonical_name) { hit = res; break }
    }
    if (!hit) { missed.push(`#${r.ref}: ${clean(String(r.description || '').split('\n')[0]).slice(0, 70)}`); continue }
    found++
    if (process.env.SAMPLE === '1' && found % 6 === 0) console.log(`  sample #${r.ref} -> ${hit.canonical_name} | ${String(r.description || '').split('\n').slice(0, 2).map(clean).join(' // ').slice(0, 110)}`)
    tally[hit.canonical_name] = (tally[hit.canonical_name] || 0) + 1
    if (APPLY) {
      const u = await db.query(
        `UPDATE properties SET town = $2, locality_id = COALESCE($3, locality_id), locality_resolution_status = $4, updated_at = NOW()
          WHERE id = $1 AND (town IS NULL OR btrim(town) = '') RETURNING id`,
        [r.id, hit.canonical_name, hit.locality_id || null, hit.status])
      written += u.rows.length
    }
  }
  console.log(`${rows.length} listings without a town; town readable for ${found}; ${APPLY ? `written ${written}` : 'nothing written (report only)'}`)
  console.log('towns:', Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '))
  console.log(`not readable (${missed.length}):`)
  for (const m of missed.slice(0, 20)) console.log('  ' + m)
  setTimeout(() => process.exit(0), 200)
})().catch(e => { console.log('FAILED', e.message); process.exit(1) })
