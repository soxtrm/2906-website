'use strict'
// Phase 0 audit of the upload/listing data. READ-ONLY: only SELECTs, no owner data printed.
const db = require('/app/db')
const q = async (sql, p) => (await db.query(sql, p)).rows
const LIVE = `system_online AND available_status IN ('available','available_confirmed')`
;(async () => {
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name='properties'`)).map(r => r.column_name)
  const has = c => cols.includes(c)
  const one = async (label, sql) => console.log(label.padEnd(58), JSON.stringify((await q(sql))[0]))

  console.log('== listings that count as available ==')
  await one('total / with ref / published', `SELECT count(*)::int total, count(*) FILTER (WHERE ref IS NOT NULL AND btrim(ref)<>'')::int with_ref, count(*) FILTER (WHERE published)::int published FROM properties WHERE ${LIVE}`)
  await one('missing facts', `SELECT count(*) FILTER (WHERE town IS NULL OR btrim(town)='')::int no_town, count(*) FILTER (WHERE bedrooms IS NULL)::int no_bedrooms, count(*) FILTER (WHERE bathrooms IS NULL)::int no_bathrooms, count(*) FILTER (WHERE longlet_price IS NULL AND sale_price IS NULL)::int no_price, count(*) FILTER (WHERE description IS NULL OR length(description) < 40)::int no_description, count(*) FILTER (WHERE property_type IS NULL OR btrim(property_type)='')::int no_type FROM properties WHERE ${LIVE}`)

  console.log('\n== classification ==')
  console.log('types'.padEnd(58), JSON.stringify(await q(`SELECT lower(coalesce(property_type,'(none)')) t, count(*)::int n FROM properties WHERE ${LIVE} GROUP BY 1 ORDER BY 2 DESC`)))
  // the headline (first line) names another type than the stored one
  const mism = await q(`
    WITH h AS (SELECT id, ref, lower(property_type) t, lower(split_part(coalesce(description,''), E'\\n', 1)) head FROM properties WHERE ${LIVE})
    SELECT t AS stored, CASE WHEN head ~ 'penthouse' THEN 'penthouse' WHEN head ~ 'maisonette' THEN 'maisonette' WHEN head ~ 'studio' THEN 'studio'
                             WHEN head ~ '(villa|townhouse|town house|house of character|farmhouse|bungalow)' THEN 'house' WHEN head ~ '(office|shop|retail|warehouse|garage|commercial)' THEN 'commercial'
                             WHEN head ~ '(apartment|flat)' THEN 'apartment' END AS headline, count(*)::int n
      FROM h GROUP BY 1, 2 HAVING count(*) > 0 ORDER BY 3 DESC`)
  const wrong = mism.filter(r => r.headline && r.stored !== r.headline && !(r.headline === 'house' && /villa|house|townhouse|bungalow|farmhouse/.test(r.stored || '')))
  console.log('headline names another type than stored'.padEnd(58), JSON.stringify(wrong), 'total', wrong.reduce((n, r) => n + r.n, 0))
  await one('bedrooms 0 or > 8, price < 200 (rent) ', `SELECT count(*) FILTER (WHERE bedrooms = 0)::int beds_0, count(*) FILTER (WHERE bedrooms > 8)::int beds_gt8, count(*) FILTER (WHERE longlet_price < 200)::int rent_lt_200, count(*) FILTER (WHERE longlet_price > 20000)::int rent_gt_20000 FROM properties WHERE ${LIVE}`)
  if (has('category')) console.log('category'.padEnd(58), JSON.stringify(await q(`SELECT coalesce(category::text,'(none)') c, count(*)::int n FROM properties WHERE ${LIVE} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`)))

  console.log('\n== images ==')
  await one('image counts', `SELECT count(*) FILTER (WHERE images IS NULL OR jsonb_typeof(images) <> 'array' OR jsonb_array_length(images) = 0)::int none, count(*) FILTER (WHERE jsonb_typeof(images)='array' AND jsonb_array_length(images) BETWEEN 1 AND 2)::int one_or_two, count(*) FILTER (WHERE jsonb_typeof(images)='array' AND jsonb_array_length(images) >= 3)::int three_plus, count(*) FILTER (WHERE published AND (images IS NULL OR jsonb_typeof(images) <> 'array' OR jsonb_array_length(images) = 0))::int published_without FROM properties WHERE ${LIVE}`)
  const imgs = await q(`SELECT id, ref, images FROM properties WHERE ${LIVE} AND jsonb_typeof(images)='array' AND jsonb_array_length(images) > 0 ORDER BY random() LIMIT 40`)
  const shapes = {}; const urls = []
  for (const r of imgs) for (const im of r.images.slice(0, 2)) {
    const u = typeof im === 'string' ? im : (im && (im.url || im.src || im.path)) || ''
    const kind = !u ? 'empty' : /^https?:\/\//.test(u) ? new URL(u).host : u.startsWith('/') ? 'relative path' : 'other'
    shapes[kind] = (shapes[kind] || 0) + 1
    if (/^https?:\/\//.test(u)) urls.push(u)
  }
  console.log('image sources in a sample of 40 listings'.padEnd(58), JSON.stringify(shapes))
  let ok = 0, bad = 0; const badHosts = {}
  for (const u of urls.slice(0, 40)) {
    try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000); const r = await fetch(u, { method: 'HEAD', signal: ctl.signal }); clearTimeout(t); if (r.ok) ok++; else { bad++; badHosts[new URL(u).host + ' ' + r.status] = (badHosts[new URL(u).host + ' ' + r.status] || 0) + 1 } }
    catch { bad++; badHosts[new URL(u).host + ' unreachable'] = (badHosts[new URL(u).host + ' unreachable'] || 0) + 1 }
  }
  console.log('image links answering (sample)'.padEnd(58), JSON.stringify({ ok, broken: bad, where: badHosts }))

  console.log('\n== duplicates ==')
  await one('same owner + town + bedrooms + rent, both available', `SELECT count(*)::int groups, coalesce(sum(n),0)::int listings FROM (SELECT count(*) n FROM properties WHERE ${LIVE} AND owner_id IS NOT NULL AND town IS NOT NULL AND longlet_price IS NOT NULL GROUP BY owner_id, lower(town), bedrooms, longlet_price HAVING count(*) > 1) x`)
  await one('identical description, both available', `SELECT count(*)::int groups, coalesce(sum(n),0)::int listings FROM (SELECT count(*) n FROM properties WHERE ${LIVE} AND length(coalesce(description,'')) > 80 GROUP BY md5(description) HAVING count(*) > 1) x`)
  await one('same ref more than once', `SELECT count(*)::int n FROM (SELECT ref FROM properties WHERE ref IS NOT NULL GROUP BY ref HAVING count(*) > 1) x`)

  console.log('\n== freshness ==')
  if (has('last_confirmed_available_at')) await one('available, last confirmed', `SELECT count(*) FILTER (WHERE last_confirmed_available_at IS NULL)::int never, count(*) FILTER (WHERE last_confirmed_available_at < NOW() - INTERVAL '30 days')::int older_30d, count(*) FILTER (WHERE last_confirmed_available_at >= NOW() - INTERVAL '30 days')::int within_30d FROM properties WHERE ${LIVE}`)
  await one('waiting in pending_check', `SELECT count(*)::int n, count(*) FILTER (WHERE updated_at < NOW() - INTERVAL '14 days')::int older_14d FROM properties WHERE system_online AND available_status='pending_check'`)

  console.log('\n== website copy vs ARGUS ==')
  await one('published on the website', `SELECT count(*)::int n FROM website_properties WHERE is_published`)
  await one('...but ARGUS says not available / not published / gone', `SELECT count(*) FILTER (WHERE p.id IS NULL)::int no_argus_listing, count(*) FILTER (WHERE p.id IS NOT NULL AND p.available_status NOT IN ('available','available_confirmed','upcoming'))::int argus_not_available, count(*) FILTER (WHERE p.id IS NOT NULL AND p.available_status IN ('available','available_confirmed') AND NOT p.published)::int argus_not_published FROM website_properties w LEFT JOIN properties p ON p.ref = w.property_reference WHERE w.is_published`)
  console.log('website status of the "not available in ARGUS" ones'.padEnd(58), JSON.stringify(await q(`SELECT w.status ws, p.available_status a, count(*)::int n FROM website_properties w JOIN properties p ON p.ref = w.property_reference WHERE w.is_published AND p.available_status NOT IN ('available','available_confirmed','upcoming') GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`)))
  await one('available + published in ARGUS but missing on the website', `SELECT count(*)::int n FROM properties p WHERE ${LIVE.replace(/available_status/g, 'p.available_status').replace('system_online', 'p.system_online')} AND p.published AND NOT EXISTS (SELECT 1 FROM website_properties w WHERE w.property_reference = p.ref AND w.is_published)`)
  await one('website price differs from ARGUS', `SELECT count(*)::int n FROM website_properties w JOIN properties p ON p.ref = w.property_reference WHERE w.is_published AND p.longlet_price IS NOT NULL AND w.price IS NOT NULL AND w.price::numeric <> p.longlet_price::numeric AND p.sale_price IS NULL`)
  setTimeout(() => process.exit(0), 200)
})().catch(e => { console.log('FAILED', e.message); process.exit(1) })
