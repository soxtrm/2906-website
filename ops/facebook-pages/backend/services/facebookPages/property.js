'use strict'
// ============================================================================
// services/facebookPages/property.js — which listings an agent may advertise,
// and the public-safe facts about them.
//
// FIREWALL: the SELECT below reads only what a public Facebook post may carry,
// plus the gating flags. Owner data, street/apt, internal notes, chat
// extractions, provenance and raw owner-written descriptions are never read
// here. The only description used is public_payload.description_public, the
// sanitised text ARGUS already publishes, and it is address-stripped again.
//
// Authorisation: an agent may publish the listings they list
// (properties.listed_by_agent_id); an ARGUS administrator may publish any
// agency listing. Publishing never changes listing ownership or attribution.
// ============================================================================
const db = require('../../db')
const sanitizer = require('../sanitizer')
const shareLinks = require('../shareLinks')
const { imageLimitForProperty } = require('../propertyImageLimit')

const MAX_IMAGES = 10   // our own cap per post (Meta documents no lower limit)

const PUBLIC_COLS = `p.id, p.ref, p.property_type, p.town, p.island, p.bedrooms, p.bathrooms, p.size_sqm,
  p.longlet_price, p.sale_price, p.shortlet, p.lease_type, p.rental_modes, p.available_status, p.available_date,
  p.available_until, p.pets_allowed, p.has_balcony, p.parking_available, p.feature_tags, p.images, p.image_ranking,
  p.public_payload->>'description_public' AS description_public, p.no_fb, p.system_online, p.is_staging, p.archived_at,
  p.lifecycle_state, p.verification_status, p.verified_at, p.listed_by_agent_id, p.last_confirmed_available_at, p.created_at`

const LIVE_STATUSES = ['available', 'available_confirmed', 'pending_check']
const FUTURE_STATUSES = ['upcoming', 'soon_available']

function orderedImages(row) {
  const imgs = Array.isArray(row.images) ? row.images : []
  const list = imgs.map(i => (typeof i === 'string' ? { url: i, thumbnail: null } : i && i.url ? { url: i.url, thumbnail: i.thumbnail || null } : null)).filter(Boolean)
  const order = row.image_ranking && Array.isArray(row.image_ranking.order) ? row.image_ranking.order : null
  const ordered = order ? [...order.map(i => list[i]).filter(Boolean), ...list.filter((x, i) => !order.includes(i))] : list
  const seen = new Set()
  return ordered.filter(x => /^https:\/\//i.test(x.url) && !seen.has(x.url) && seen.add(x.url))
}

// Photos promoted from another website's listing are not cleared for external
// distribution unless the authorised source licensed its media.
async function imageRights(propertyId) {
  const { rows } = await db.query(
    `SELECT w.source_id, s.media_use FROM website_source_inventory w LEFT JOIN property_sources s ON s.id = w.source_id
      WHERE w.canonical_property_id = $1`, [propertyId])
  const unlicensed = rows.some(r => !r.source_id || String(r.media_use || '').toUpperCase() !== 'LICENSED')
  return unlicensed
    ? { allowed: false, reason: 'These photos were imported from another website and are not cleared for publishing on Facebook. You can still publish a text post with the link.' }
    : { allowed: true, reason: null }
}

function blockersFor(row, agent) {
  const out = []
  if (agent.role !== 'admin' && Number(row.listed_by_agent_id) !== Number(agent.id)) out.push({ code: 'not_yours', message: 'Only the listing agent can publish this property to Facebook.' })
  if (row.no_fb) out.push({ code: 'no_fb', message: 'This listing is marked "no Facebook". The owner does not want it advertised there.' })
  if (row.is_staging) out.push({ code: 'draft', message: 'This listing is still a draft in ARGUS.' })
  if (row.archived_at || row.lifecycle_state === 'archived') out.push({ code: 'archived', message: 'This listing is archived.' })
  if (row.system_online === false) out.push({ code: 'offline', message: 'This listing is offline in ARGUS.' })
  const st = row.available_status || 'available'
  if (!LIVE_STATUSES.includes(st) && !(FUTURE_STATUSES.includes(st) && row.available_date)) out.push({ code: 'unavailable', message: 'This property is not currently available, so it cannot be advertised.' })
  if (row.verification_status === 'unverified') out.push({ code: 'unverified', message: 'This listing is waiting for verification in Incoming Properties.' })
  if (row.verification_status === 'needs_correction') out.push({ code: 'needs_correction', message: 'This listing needs corrections before it can be published.' })
  if (!row.town) out.push({ code: 'no_location', message: 'Add the locality before publishing.' })
  if (!(Number(row.longlet_price) > 0) && !(Number(row.sale_price) > 0)) out.push({ code: 'no_price', message: 'Add a price before publishing.' })
  return out
}

async function publicLink(row) {
  if (row.ref) {
    const { rows: [w] } = await db.query(
      `SELECT slug FROM website_properties WHERE property_reference=$1 AND is_published IS TRUE ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [row.ref])
    if (w && w.slug) return { url: `https://2906.estate/property/${encodeURIComponent(w.slug)}`, kind: 'website' }
  }
  // Unlisted share page; it re-checks availability on every visit and says so when the property is gone.
  const link = await shareLinks.getOrCreatePropertyLink(row.id)
  return { url: link.url, kind: 'share' }
}

function withAttribution(url, token) {
  try {
    const u = new URL(url)
    u.searchParams.set('utm_source', 'facebook')
    u.searchParams.set('utm_medium', 'page_post')
    u.searchParams.set('utm_campaign', 'argus_page')
    u.searchParams.set('utm_content', token)
    return u.toString()
  } catch { return url }
}

function cleanDescription(row) {
  const raw = String(row.description_public || '')
  if (!raw.trim()) return ''
  let text = raw
  try { text = sanitizer.stripAddresses(text, row.town) } catch {}
  return text.replace(/\r/g, '').trim()
}

async function load(agent, propertyId, { createLink = true } = {}) {
  const id = Number(propertyId)
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Property not found.'), { status: 404 })
  const { rows: [row] } = await db.query(`SELECT ${PUBLIC_COLS} FROM properties p WHERE p.id=$1`, [id])
  if (!row) throw Object.assign(new Error('Property not found.'), { status: 404 })
  const blockers = blockersFor(row, agent)
  if (blockers.some(b => b.code === 'not_yours')) throw Object.assign(new Error(blockers[0].message), { status: 403 })
  const rights = await imageRights(id)
  const images = orderedImages(row).slice(0, Math.min(MAX_IMAGES, imageLimitForProperty(row) || MAX_IMAGES))
  const link = createLink && !blockers.length ? await publicLink(row) : null
  return {
    row,
    facts: {
      id: row.id, ref: row.ref, type: row.property_type, town: row.town, island: row.island,
      bedrooms: row.bedrooms, bathrooms: row.bathrooms, sizeSqm: row.size_sqm ? Number(row.size_sqm) : null,
      rent: Number(row.longlet_price) > 0 ? Number(row.longlet_price) : null, sale: Number(row.sale_price) > 0 ? Number(row.sale_price) : null,
      shortlet: !!row.shortlet, rentalModes: row.rental_modes || [], availableStatus: row.available_status || 'available',
      availableDate: row.available_date, availableUntil: row.available_until, featureTags: row.feature_tags || [],
      petsAllowed: row.pets_allowed, balcony: row.has_balcony, parking: row.parking_available,
      description: cleanDescription(row), verificationStatus: row.verification_status,
    },
    images: rights.allowed ? images : [],
    imagesAllowed: rights.allowed,
    imagesReason: rights.reason,
    allImageUrls: new Set(orderedImages(row).map(i => i.url)),
    link,
    blockers,
  }
}

module.exports = { load, blockersFor, orderedImages, withAttribution, imageRights, MAX_IMAGES, LIVE_STATUSES }
