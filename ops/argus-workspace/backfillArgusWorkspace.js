'use strict'
const db = require('/app/db')
const geo = require('/app/services/geoTowns')
const rules = require('/app/services/listingRules')

async function main() {
  const villages = await db.query('SELECT id, code, display_name FROM villages')
  let villageUpdates = 0
  for (const village of villages.rows) {
    const key = geo.townKey(village.code) || geo.townKey(village.display_name)
    const point = key && geo.TOWNS[key]
    if (!point) continue
    await db.query(
      `UPDATE villages SET centroid_latitude=$2, centroid_longitude=$3
        WHERE id=$1 AND (centroid_latitude IS DISTINCT FROM $2 OR centroid_longitude IS DISTINCT FROM $3)`,
      [village.id, point.lat, point.lng])
    villageUpdates += 1
  }

  const properties = await db.query(`
    SELECT id, pets_allowed, sharing_allowed, subletting_considered,
           COALESCE(description, '') || ' ' ||
           COALESCE(public_payload->>'description_social', '') || ' ' ||
           COALESCE(public_payload->>'description_public', '') || ' ' ||
           COALESCE(public_payload->>'features', '') AS rules_text
      FROM properties
     WHERE is_staging IS NOT TRUE
       AND (pets_allowed IS NULL OR sharing_allowed IS NULL OR subletting_considered IS NULL)`)
  let propertyFacts = 0
  for (const row of properties.rows) {
    const inferred = rules.policiesFor(row.rules_text)
    const pets = row.pets_allowed == null ? inferred.petFriendly : null
    const sharing = row.sharing_allowed == null ? inferred.sharing : null
    const subletting = row.subletting_considered == null ? inferred.subletting : null
    if (pets == null && sharing == null && subletting == null) continue
    await db.query(`INSERT INTO argus_property_filter_facts
      (property_id,pets_allowed,pets_source,sharing_allowed,sharing_source,
       subletting_considered,subletting_source,derived_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (property_id) DO UPDATE SET
        pets_allowed=EXCLUDED.pets_allowed, pets_source=EXCLUDED.pets_source,
        sharing_allowed=EXCLUDED.sharing_allowed, sharing_source=EXCLUDED.sharing_source,
        subletting_considered=EXCLUDED.subletting_considered,
        subletting_source=EXCLUDED.subletting_source, derived_at=NOW()`,
      [row.id, pets, pets == null ? null : 'listing_text',
       sharing, sharing == null ? null : 'listing_text',
       subletting, subletting == null ? null : 'listing_text'])
    propertyFacts += 1
  }
  console.log(JSON.stringify({ villageUpdates, propertyFacts }))
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message)
  process.exit(1)
})
