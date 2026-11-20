'use strict'
// Older property entries on the website that no system vouches for: no ARGUS listing behind them, nothing
// checks whether they are still available. They leave public search and stay in the database untouched
// (row, photos, reference, history). Not marked rented: nobody knows that.
//   node legacy-hide.js              report only
//   APPLY=1 node legacy-hide.js      hides them and writes each one to website_reconcile_log
// Left alone on purpose: entries already shown as rented (they claim nothing). "aesthetics" is the website's
// category for rentals from €2,500, so those are property listings like the rest.
const db = require('/app/db')
const APPLY = process.env.APPLY === '1'
;(async () => {
  const { rows } = await db.query(
    `SELECT w.id::text AS wid, w.property_reference AS ref, w.status, w.category, w.created_at, w.updated_at
       FROM website_properties w
      WHERE w.is_published = TRUE AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.ref = w.property_reference)`)
  const reasonFor = r => /^2906-[0-9]{4,}$/.test(r.ref || '') ? 'no ARGUS listing any more (deleted there): unverifiable'
    : /^2906-[A-Z0-9]{5}$/.test(r.ref || '') ? 'older website entry without an ARGUS listing: unverifiable'
    : 'website entry without an ARGUS listing, origin unclear: unverifiable'
  const hide = rows.filter(r => r.status !== 'rented')
  const kept = { shownAsRented: rows.filter(r => r.status === 'rented').length }
  const tally = hide.reduce((m, r) => (m[reasonFor(r)] = (m[reasonFor(r)] || 0) + 1, m), {})
  console.log(`${rows.length} website entries without an ARGUS listing; to hide: ${hide.length}`, JSON.stringify(tally), '| left as they are:', JSON.stringify(kept))
  if (!APPLY) { console.log('nothing changed (report only)'); return setTimeout(() => process.exit(0), 100) }
  const client = await db.connect()
  let done = 0
  try {
    await client.query('BEGIN')
    for (const r of hide) {
      const u = await client.query(`UPDATE website_properties SET is_published = FALSE WHERE id::text = $1 AND is_published = TRUE RETURNING id`, [r.wid])
      if (!u.rows.length) continue
      await client.query(
        `INSERT INTO website_reconcile_log (website_id, property_reference, action, reason, before_state, after_state) VALUES ($1, $2, 'hide', $3, $4, $5)`,
        [r.wid, r.ref, reasonFor(r), JSON.stringify({ is_published: true, status: r.status }), JSON.stringify({ is_published: false })])
      done++
    }
    await client.query('COMMIT')
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); client.release(); console.log('FAILED, nothing changed:', err.message); return process.exit(1) }
  client.release()
  console.log(`hidden: ${done}`)
  setTimeout(() => process.exit(0), 100)
})().catch(e => { console.log('FAILED', e.message); process.exit(1) })
