'use strict'
// ============================================================================
// services/websiteSync.js — the CRM → public website publish bridge.
//
// Kev, 2026-08-28: "die Website ist outdated, alle Listings mit guter
// Beschreibung und Bildern sollten da landen." Root cause found: the public
// site (routes/properties.js) reads ONLY from website_properties — a
// separate, denormalised table with its OWN uuid primary key and its OWN ref
// scheme (property_reference), last touched 2026-07-22. properties.published
// (the "Published (LIVE)" checkbox on /crm/property/[id]) has ALWAYS been a
// plain column flip with zero side effects — nothing has EVER synced a row
// created via !upload/!uploadlisting into website_properties. That is why
// the site has looked frozen for over a month while the CRM kept growing.
//
// This is the missing bridge, not a new publishing concept: same
// title/description/slug conventions services/webPost.js's legacy !postweb
// path already established for website_properties, just fed from a
// properties.id instead of a raw WhatsApp payload.
//
// UPSERT, not insert-only: property_reference has a UNIQUE partial index
// (idx_wp_ref), so a property that already has a website row gets updated
// in place — its slug (the public URL) is preserved across re-syncs, never
// regenerated, or every edit would break a bookmarked/shared link.
// ============================================================================

const db = require('../db')
const log = require('../logger')
const { buildWebsiteTitle, buildWebsiteDescription, makeSlug } = require('./webPost')

// Same three-way category split services/webPost.js already uses for
// !postweb — kept identical so a listing's category doesn't depend on which
// path put it on the website.
const COMMERCIAL_PROP_TYPES = ['Office', 'Retail', 'Warehouse', 'Commercial']

function categoryFor({ propertyType, isForSale, price }) {
  if (isForSale) return 'sales'
  if (COMMERCIAL_PROP_TYPES.some(t => String(propertyType || '').toLowerCase() === t.toLowerCase())) return 'commercial'
  if ((price || 0) >= 2500) return 'aesthetics'
  return 'letting'
}

// available_status has more states than the website needs to distinguish —
// anything that isn't genuinely offerable maps to 'rented' so a stale sync
// never shows a listing that has actually gone, rather than leaving it
// looking available.
function statusFor(availableStatus) {
  return (availableStatus === 'available' || availableStatus === 'available_confirmed') ? 'available' : 'rented'
}

async function loadProperty(propertyId) {
  const r = await db.query(
    `SELECT id, ref, property_type, town, sub_location, bedrooms, bathrooms, size_sqm,
            longlet_price, sale_price, available_status, available_date,
            available_until, rental_modes, lease_type, shortlet,
            description, public_payload, published, locality_id, feature_tags
       FROM properties WHERE id = $1`, [propertyId])
  return r.rows[0] || null
}

// Kev's own bar: "guter Beschreibung und Bildern" — a listing with no
// description text or no photos is not ready for a public page, whatever
// properties.published says. Checked here (not just left to the caller) so
// a stray published=TRUE on a half-filled draft can't put a broken card on
// the live site.
function isPublishReady(prop) {
  const images = Array.isArray(prop.public_payload?.images) ? prop.public_payload.images : []
  const description = prop.public_payload?.description_public || prop.description || ''
  return images.length > 0 && description.trim().length >= 20
}

/**
 * Syncs ONE property into website_properties. Returns:
 *   { ok: true, action: 'inserted'|'updated', id, slug }
 *   { ok: false, reason: 'not_found'|'not_ready', detail? }
 */
async function syncPropertyToWebsite(propertyId) {
  const prop = await loadProperty(propertyId)
  if (!prop) return { ok: false, reason: 'not_found' }
  if (!isPublishReady(prop)) {
    return { ok: false, reason: 'not_ready', detail: 'needs at least one photo and a real description before it can go live' }
  }

  const isForSale = prop.sale_price != null && prop.longlet_price == null
  const price = isForSale ? Number(prop.sale_price) : Number(prop.longlet_price || 0)
  const priceType = isForSale ? 'total' : 'month'
  const listingType = isForSale ? 'For Sale' : 'To Rent'
  const location = [prop.sub_location, prop.town].filter(Boolean).join(' / ') || prop.town || null
  const category = categoryFor({ propertyType: prop.property_type, isForSale, price })
  const featured = category === 'aesthetics' || category === 'letting'
  const images = Array.isArray(prop.public_payload?.images) ? prop.public_payload.images : []
  const features = Array.isArray(prop.public_payload?.features) ? prop.public_payload.features : []
  const description = prop.public_payload?.description_public || prop.description || ''
  const title = buildWebsiteTitle({ location, price, bedrooms: prop.bedrooms, bathrooms: prop.bathrooms }) || `Property #${prop.ref}`
  const summary = buildWebsiteDescription(description).slice(0, 250) || null
  // The website description must carry the term too (2026-09-21): the same line the
  // category groups and Facebook get ("❄️ Winter let, available until April"), from
  // the same function, read live from the row. The summary (card teaser) is untouched.
  const rentalModesSvc = require('./rentalModes')
  const leaseTxt = rentalModesSvc.leaseLine(prop)
  const descriptionOut = leaseTxt ? `${String(description).trim()}\n\n${leaseTxt}` : description
  // CANONICAL LOCALITY + FEATURE TAGS (Kev, 2026-09-23, ARGUS property
  // intelligence item 3/4): structured, filterable columns alongside the
  // existing free-text `location`/`features` — routes/properties.js filters
  // on these, not on ILIKE/array-overlap against the free text.
  const localityId = prop.locality_id ?? null
  const featureTagsOut = Array.isArray(prop.feature_tags) ? prop.feature_tags : null
  // effectiveModes() derives from legacy lease_type/shortlet when
  // rental_modes was never set explicitly — same "always resolvable" rule
  // leaseLine() above already relies on, so the website filter and the
  // website description text can never disagree with each other.
  // { implied: false } (2026-09-24): the public site states only what was set
  // explicitly — the internal winter→short classification never becomes a
  // public "short let available" claim (same rule as leaseLine()).
  const rentalModesOut = rentalModesSvc.effectiveModes(prop, { implied: false })

  const existing = await db.query(
    `SELECT id, slug FROM website_properties WHERE property_reference = $1`, [prop.ref])
  const slug = existing.rows[0] ? existing.rows[0].slug : makeSlug(title)

  const r = await db.query(
    `INSERT INTO website_properties
       (title, slug, listing_type, price, price_type, bedrooms, bathrooms,
        size, area, property_type, category, location, status, images,
        summary, description, full_description, features,
        available_from, property_reference, featured, is_published,
        locality_id, feature_tags, rental_modes,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,TRUE,$22,$23,$24,NOW(),NOW())
     -- idx_wp_ref is a PARTIAL unique index (WHERE property_reference IS NOT
     -- NULL) — ON CONFLICT (property_reference) alone doesn't match a
     -- partial index ("no unique or exclusion constraint matching"); the
     -- WHERE clause here has to mirror the index's exactly.
     ON CONFLICT (property_reference) WHERE property_reference IS NOT NULL DO UPDATE SET
       title = EXCLUDED.title, listing_type = EXCLUDED.listing_type,
       price = EXCLUDED.price, price_type = EXCLUDED.price_type,
       bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms,
       size = EXCLUDED.size, area = EXCLUDED.area,
       property_type = EXCLUDED.property_type, category = EXCLUDED.category,
       location = EXCLUDED.location, status = EXCLUDED.status,
       images = EXCLUDED.images, summary = EXCLUDED.summary,
       description = EXCLUDED.description, full_description = EXCLUDED.full_description,
       features = EXCLUDED.features, available_from = EXCLUDED.available_from,
       featured = EXCLUDED.featured, is_published = TRUE, updated_at = NOW(),
       locality_id = EXCLUDED.locality_id, feature_tags = EXCLUDED.feature_tags,
       rental_modes = EXCLUDED.rental_modes
       -- slug is deliberately NOT in this SET list: it is the public URL and
       -- must survive re-syncs unchanged.
     RETURNING id, slug`,
    [title, slug, listingType, price, priceType, prop.bedrooms, prop.bathrooms,
     // size (int) and area (numeric) are DIFFERENT column types — reusing one
     // placeholder for both ("inconsistent types deduced for parameter $8")
     // is why the very first live run of this failed on every row. Two
     // distinct params, same source value, no shared placeholder.
     prop.size_sqm, prop.size_sqm,
     prop.property_type, category, location, statusFor(prop.available_status),
     // images/features are native Postgres ARRAY columns, NOT jsonb — the pg
     // driver serialises a plain JS array correctly on its own; JSON.stringify
     // here would send a text blob into an array column and fail.
     images, summary,
     // description (text) and full_description (text) share a type, but keep
     // them as separate params too — consistent with size/area above, and
     // one less thing to re-diagnose if either column's type ever changes.
     descriptionOut, descriptionOut,
     features, prop.available_date, prop.ref, featured,
     localityId, featureTagsOut, rentalModesOut])

  const action = existing.rows.length ? 'updated' : 'inserted'
  log.info('websiteSync: synced', { ref: prop.ref, action, slug: r.rows[0].slug })
  return { ok: true, action, id: r.rows[0].id, slug: r.rows[0].slug }
}

// Removes a property from the public site WITHOUT touching properties.
// is_published=FALSE, not a DELETE — the same "nothing is deleted" rule the
// rest of this codebase's board/lifecycle actions follow. Used when
// properties.published flips back to false, or the listing goes off-market.
async function unpublishFromWebsite(ref) {
  const r = await db.query(
    `UPDATE website_properties SET is_published = FALSE, updated_at = NOW()
      WHERE property_reference = $1 RETURNING id`, [ref])
  return { ok: true, found: r.rowCount > 0 }
}

module.exports = { syncPropertyToWebsite, unpublishFromWebsite, isPublishReady, categoryFor, statusFor }
