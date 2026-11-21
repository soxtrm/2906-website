'use strict'
// NEXUS Rooms: the room inventory of ONE canonical property (2026-11-21, Kev: "one apartment, several rooms,
// one real booking logic"). ARGUS owns identity, rooms, shared spaces, prices, statuses, photos, the letting
// mode (whole apartment / room by room, with history) and the owner-confirmed 2.5D layout.
// NEXUS Booking owns dates, holds and conflicts; services/roomsBooking.js talks to it.
//
// Who may change a property's rooms:
//   - its owner in NEXUS Sync (verified link, confirmed claim; representatives with 'edit')
//   - ARGUS staff: an admin, or the agent who lists the property
// The public sees only published properties in room mode, rooms that are not off-market, and a layout only
// after the owner confirmed it. Owner and tenant contact data never appear in anything public.
const crypto = require('crypto')
const db = require('../db')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { audit } = L._internal
const err = (code, message, status = 400) => new LinkError(code, message, status)

const STATUSES = ['on_market', 'hold', 'off_market', 'occupied']
const SHARED = ['kitchen', 'living', 'bathroom', 'balcony', 'terrace', 'laundry', 'garden', 'other']
const FEATURES = ['double_bed', 'single_bed', 'two_beds', 'wardrobe', 'desk', 'window', 'balcony', 'private_bathroom', 'air_conditioning', 'heating', 'furnished', 'lock', 'tv', 'sea_view']
const MARKETS = ['long_let', 'short_let']
const MAX_ROOMS = 12, MAX_SHARED = 10, MAX_PHOTOS = 12
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const num = (v, lo, hi, label, int = false) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi) throw err('FIELD_INVALID', `${label} must be between ${lo} and ${hi}.`)
  return int ? Math.round(n) : Math.round(n * 100) / 100
}
const date = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null)

// ── who is acting ────────────────────────────────────────────────────────────
// actor = { kind: 'owner', S, account } | { kind: 'staff', agent }
async function property(actor, propertyId, perm = 'edit') {
  const id = Number(propertyId)
  if (!Number.isInteger(id) || id <= 0) throw err('PROPERTY_INVALID', 'Choose a home.')
  if (actor.kind === 'owner') {
    const p = (await actor.S.ownedProperties(actor.account, perm)).find(x => x.id === id)
    if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
  } else {
    const a = actor.agent
    const { rows: [p] } = await db.query(`SELECT listed_by_agent_id FROM properties WHERE id=$1`, [id])
    if (!p) throw err('PROPERTY_NOT_FOUND', 'Property not found.', 404)
    if (!(a && (a.role === 'admin' || (perm === 'view' && a.role !== 'board') || p.listed_by_agent_id === a.id))) throw err('FORBIDDEN', 'Only an admin or the listing agent can change these rooms.', 403)
  }
  const { rows: [p] } = await db.query(
    `SELECT id, ref, town, property_type, bedrooms, bathrooms, longlet_price, published, available_status, images, archived_at, COALESCE(is_staging,false) AS is_staging
       FROM properties WHERE id=$1`, [id])
  return p
}
const actorRef = actor => (actor.kind === 'owner' ? `sync:${actor.account.public_id}` : `agent:${actor.agent.id}`)

// ── read ─────────────────────────────────────────────────────────────────────
function unitView(u) {
  return {
    id: Number(u.id), kind: u.kind, position: u.position, label: u.label, sharedType: u.shared_type || null,
    status: u.status, priceMonth: u.price_month === null ? null : Number(u.price_month), priceNight: u.price_night === null ? null : Number(u.price_night),
    minStayMonths: u.min_stay_months, maxOccupants: u.max_occupants, sizeSqm: u.size_sqm === null ? null : Number(u.size_sqm), sizeVerified: !!u.size_verified,
    privateBathroom: !!u.private_bathroom, features: u.features || [], photos: u.photos || [], description: u.description || null,
    availableFrom: u.available_from ? (u.available_from instanceof Date ? u.available_from.toISOString().slice(0, 10) : String(u.available_from).slice(0, 10)) : null,
    span: u.kind === 'room' ? [u.position * 100, u.position * 100 + 100] : null,
    updatedAt: u.updated_at,
  }
}
async function snapshot(q, propertyId) {
  const [units, mode, layout] = await Promise.all([
    q.query(`SELECT * FROM property_units WHERE property_id=$1 AND retired_at IS NULL ORDER BY kind DESC, position`, [propertyId]),
    q.query(`SELECT mode, markets, valid_from, set_by FROM property_letting_modes WHERE property_id=$1 AND valid_to IS NULL`, [propertyId]),
    q.query(`SELECT layout, version, status, source, floor_plan, updated_at, confirmed_at FROM property_layouts WHERE property_id=$1`, [propertyId]),
  ])
  const all = units.rows.map(unitView)
  const m = mode.rows[0]
  const l = layout.rows[0]
  return {
    mode: m ? { mode: m.mode, markets: m.markets, since: m.valid_from } : { mode: 'whole', markets: ['long_let'], since: null },
    rooms: all.filter(u => u.kind === 'room'), shared: all.filter(u => u.kind === 'shared'),
    layout: l ? { ...l.layout, version: l.version, status: l.status, source: l.source, floorPlan: l.floor_plan || null, updatedAt: l.updated_at, confirmedAt: l.confirmed_at } : null,
  }
}
const facts = p => ({ id: p.id, ref: p.ref, town: p.town, type: p.property_type, bedrooms: p.bedrooms, bathrooms: p.bathrooms, rent: p.longlet_price === null ? null : Number(p.longlet_price), photos: Array.isArray(p.images) ? p.images.slice(0, 24) : [] })

async function rooms(actor, { propertyId }) {
  const p = await property(actor, propertyId, 'view')
  return { property: facts(p), ...(await snapshot(db, p.id)), canEdit: true }
}

// ── write: rooms and shared spaces in one call (create, update, retire) ─────
async function saveUnits(actor, { propertyId, rooms: inRooms, shared: inShared }) {
  const p = await property(actor, propertyId, 'edit')
  if (!Array.isArray(inRooms) || inRooms.length > MAX_ROOMS) throw err('ROOMS_INVALID', `Up to ${MAX_ROOMS} rooms.`)
  if (inShared !== undefined && (!Array.isArray(inShared) || inShared.length > MAX_SHARED)) throw err('SHARED_INVALID', `Up to ${MAX_SHARED} shared spaces.`)
  const by = actorRef(actor)
  const q = await db.connect()
  try {
    await q.query('BEGIN')
    await q.query('SELECT pg_advisory_xact_lock(290624, $1)', [p.id])
    const { rows: existing } = await q.query(`SELECT * FROM property_units WHERE property_id=$1 ORDER BY position`, [p.id])
    const next = { room: Math.max(0, ...existing.filter(u => u.kind === 'room').map(u => u.position)) + 1, shared: Math.max(0, ...existing.filter(u => u.kind === 'shared').map(u => u.position)) + 1 }
    const keep = new Set()
    const write = async (kind, x) => {
      const label = clean(x.label, 40)
      if (!label) throw err('FIELD_INVALID', 'Every room needs a name or number.')
      const v = {
        label,
        shared_type: kind === 'shared' ? (SHARED.includes(x.sharedType) ? x.sharedType : 'other') : null,
        status: kind === 'shared' ? 'off_market' : (STATUSES.includes(x.status) ? x.status : 'off_market'),
        price_month: kind === 'room' ? num(x.priceMonth, 50, 20000, 'Monthly price') : null,
        price_night: kind === 'room' ? num(x.priceNight, 10, 2000, 'Nightly price') : null,
        min_stay_months: kind === 'room' ? num(x.minStayMonths, 1, 36, 'Minimum stay', true) : null,
        max_occupants: kind === 'room' ? num(x.maxOccupants, 1, 6, 'Occupants', true) : null,
        size_sqm: num(x.sizeSqm, 2, 200, 'Size'),
        private_bathroom: kind === 'room' && x.privateBathroom === true,
        features: JSON.stringify(kind === 'room' ? [...new Set((Array.isArray(x.features) ? x.features : []).filter(f => FEATURES.includes(f)))] : []),
        description: clean(x.description, 1200) || null,
        available_from: kind === 'room' ? date(x.availableFrom) : null,
      }
      if (v.status === 'on_market' && v.price_month === null && v.price_night === null) throw err('PRICE_REQUIRED', `${label}: add a price before putting it on the market.`)
      const cur = x.id ? existing.find(u => Number(u.id) === Number(x.id) && u.kind === kind && !u.retired_at) : null
      if (x.id && !cur) throw err('UNIT_NOT_FOUND', `${label} was not found on this home.`, 404)
      if (cur) {
        await q.query(
          `UPDATE property_units SET label=$2, shared_type=$3, status=$4, price_month=$5, price_night=$6, min_stay_months=$7, max_occupants=$8, size_sqm=$9,
                  size_verified=false, private_bathroom=$10, features=$11::jsonb, description=$12, available_from=$13, updated_at=now() WHERE id=$1`,
          [cur.id, v.label, v.shared_type, v.status, v.price_month, v.price_night, v.min_stay_months, v.max_occupants, v.size_sqm, v.private_bathroom, v.features, v.description, v.available_from])
        keep.add(Number(cur.id))
      } else {
        const pos = next[kind]++
        if (pos > 99) throw err('ROOMS_INVALID', 'Too many rooms over time.')
        const { rows: [n] } = await q.query(
          `INSERT INTO property_units (property_id, kind, position, label, shared_type, status, price_month, price_night, min_stay_months, max_occupants, size_sqm, private_bathroom, features, description, available_from, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16) RETURNING id`,
          [p.id, kind, pos, v.label, v.shared_type, v.status, v.price_month, v.price_night, v.min_stay_months, v.max_occupants, v.size_sqm, v.private_bathroom, v.features, v.description, v.available_from, by])
        keep.add(Number(n.id))
      }
    }
    for (const x of inRooms) await write('room', x || {})
    for (const x of (inShared || [])) await write('shared', x || {})
    // units left out are retired (never deleted): bookings and history keep their unit id
    const gone = existing.filter(u => !u.retired_at && !keep.has(Number(u.id)) && (inShared !== undefined || u.kind === 'room'))
    if (gone.length) await q.query(`UPDATE property_units SET retired_at=now(), status='off_market', updated_at=now() WHERE id = ANY($1::bigint[])`, [gone.map(u => u.id)])
    await q.query('COMMIT')
    await audit(db, actor.kind === 'staff' ? actor.agent : null, 'ROOMS_SAVED', { by, rooms: inRooms.length, shared: (inShared || []).length, retired: gone.length }, { id: p.id, ref: p.ref })
  } catch (e) { await q.query('ROLLBACK').catch(() => {}); throw e } finally { q.release() }
  return { property: facts(p), ...(await snapshot(db, p.id)) }
}

// ── letting mode (history, never edited in place) ────────────────────────────
async function setMode(actor, { propertyId, mode, markets }) {
  const p = await property(actor, propertyId, 'edit')
  if (!['whole', 'rooms'].includes(mode)) throw err('MODE_INVALID', 'Choose whole apartment or room by room.')
  const mk = [...new Set((Array.isArray(markets) && markets.length ? markets : ['long_let']).filter(m => MARKETS.includes(m)))]
  if (!mk.length) throw err('MODE_INVALID', 'Choose long let and/or short let.')
  if (mode === 'rooms') {
    const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int n FROM property_units WHERE property_id=$1 AND kind='room' AND retired_at IS NULL`, [p.id])
    if (n < 1) throw err('ROOMS_REQUIRED', 'Add the rooms first.')
  }
  const q = await db.connect()
  try {
    await q.query('BEGIN')
    await q.query('SELECT pg_advisory_xact_lock(290624, $1)', [p.id])
    const { rows: [cur] } = await q.query(`SELECT id, mode, markets FROM property_letting_modes WHERE property_id=$1 AND valid_to IS NULL FOR UPDATE`, [p.id])
    if (!(cur && cur.mode === mode && JSON.stringify([...cur.markets].sort()) === JSON.stringify([...mk].sort()))) {
      if (cur) await q.query(`UPDATE property_letting_modes SET valid_to=now() WHERE id=$1`, [cur.id])
      await q.query(`INSERT INTO property_letting_modes (property_id, mode, markets, set_by) VALUES ($1,$2,$3::text[],$4)`, [p.id, mode, mk, actorRef(actor)])
    }
    await q.query('COMMIT')
  } catch (e) { await q.query('ROLLBACK').catch(() => {}); throw e } finally { q.release() }
  await audit(db, actor.kind === 'staff' ? actor.agent : null, 'ROOMS_MODE', { by: actorRef(actor), mode, markets: mk }, { id: p.id, ref: p.ref })
  return { property: facts(p), ...(await snapshot(db, p.id)) }
}

// ── photos: a room uses the home's own photos or new uploads (public listing photos, like the home's) ──
let uploader = async (buffer, mime, folder) => {
  const cld = require('cloudinary').v2
  if (!process.env.CLOUDINARY_CLOUD_NAME) throw err('UPLOAD_UNAVAILABLE', 'Photo upload is not configured.', 503)
  cld.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true })
  const r = await cld.uploader.upload(`data:${mime};base64,${buffer.toString('base64')}`, { folder, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] })
  return r.secure_url
}
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}
async function photo(actor, { propertyId, unitId, dataBase64, url, remove }) {
  const p = await property(actor, propertyId, 'edit')
  const { rows: [u] } = await db.query(`SELECT id, photos FROM property_units WHERE id=$1 AND property_id=$2 AND retired_at IS NULL`, [Number(unitId) || 0, p.id])
  if (!u) throw err('UNIT_NOT_FOUND', 'Room not found.', 404)
  let list = Array.isArray(u.photos) ? u.photos.slice() : []
  if (remove) list = list.filter(x => x !== remove)
  else if (url) {
    // one of the home's own photos (already public on the listing)
    if (!(Array.isArray(p.images) && p.images.includes(url))) throw err('PHOTO_INVALID', 'Choose one of this home\'s photos or upload a new one.')
    if (!list.includes(url)) list.push(url)
  } else {
    const buf = Buffer.from(String(dataBase64 || ''), 'base64')
    if (buf.length < 1000 || buf.length > 6 * 1024 * 1024) throw err('PHOTO_INVALID', 'Photos up to 6 MB.')
    const mime = imageType(buf)
    if (!mime) throw err('PHOTO_INVALID', 'JPG, PNG or WebP only.')
    if (list.length >= MAX_PHOTOS) throw err('PHOTO_LIMIT', `Up to ${MAX_PHOTOS} photos per room.`)
    list.push(await uploader(buf, mime, '2906-properties/rooms'))
  }
  if (list.length > MAX_PHOTOS) throw err('PHOTO_LIMIT', `Up to ${MAX_PHOTOS} photos per room.`)
  await db.query(`UPDATE property_units SET photos=$2::jsonb, updated_at=now() WHERE id=$1`, [u.id, JSON.stringify(list)])
  return { unitId: Number(u.id), photos: list }
}

// ── layout: approximate blocks on a grid, confirmed by the owner before the public sees it ──
function cleanLayout(raw, units) {
  const L0 = raw && typeof raw === 'object' ? raw : {}
  const gw = num(L0.grid?.w ?? 24, 6, 60, 'Grid width', true), gh = num(L0.grid?.h ?? 16, 6, 60, 'Grid height', true)
  const ids = new Set(units.map(u => Number(u.id)))
  const blocks = (Array.isArray(L0.blocks) ? L0.blocks : []).slice(0, 40).map(b => {
    const x = num(b.x, 0, gw - 1, 'Position', true), y = num(b.y, 0, gh - 1, 'Position', true)
    const w = num(b.w, 1, gw, 'Width', true), h = num(b.h, 1, gh, 'Depth', true)
    if (x + w > gw || y + h > gh) throw err('LAYOUT_INVALID', 'A room reaches outside the plan.')
    const unitId = b.unitId ? Number(b.unitId) : null
    if (unitId !== null && !ids.has(unitId)) throw err('LAYOUT_INVALID', 'A block points to a room that is not on this home.')
    const furniture = (Array.isArray(b.furniture) ? b.furniture : []).filter(f => ['bed', 'double_bed', 'wardrobe', 'desk', 'sofa', 'table', 'kitchen', 'bath', 'shower', 'plant'].includes(f)).slice(0, 6)
    return { id: clean(b.id, 24) || crypto.randomBytes(4).toString('hex'), unitId, label: clean(b.label, 40) || null, x, y, w, h, furniture }
  })
  const used = blocks.filter(b => b.unitId).map(b => b.unitId)
  if (new Set(used).size !== used.length) throw err('LAYOUT_INVALID', 'Each room can be placed once.')
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i], c = blocks[j]
    if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) throw err('LAYOUT_INVALID', 'Two rooms overlap on the plan.')
  }
  return { grid: { w: gw, h: gh }, blocks, note: 'Approximate layout drawn by the owner. Not a measured floor plan.' }
}
async function saveLayout(actor, { propertyId, layout, confirm }) {
  const p = await property(actor, propertyId, 'edit')
  const { rows: units } = await db.query(`SELECT id FROM property_units WHERE property_id=$1 AND retired_at IS NULL`, [p.id])
  const L1 = cleanLayout(layout, units)
  const status = confirm === true ? 'owner_confirmed' : 'draft'
  if (status === 'owner_confirmed' && actor.kind !== 'owner' && !(actor.agent && actor.agent.role === 'admin')) throw err('FORBIDDEN', 'The owner confirms the layout.', 403)
  await db.query(
    `INSERT INTO property_layouts (property_id, layout, status, source, updated_by, updated_at, confirmed_at) VALUES ($1,$2::jsonb,$3,'manual',$4,now(), CASE WHEN $3='owner_confirmed' THEN now() END)
     ON CONFLICT (property_id) DO UPDATE SET layout=EXCLUDED.layout, version=property_layouts.version+1, status=EXCLUDED.status, updated_by=EXCLUDED.updated_by, updated_at=now(),
            confirmed_at=CASE WHEN EXCLUDED.status='owner_confirmed' THEN now() ELSE NULL END`,
    [p.id, JSON.stringify(L1), status, actorRef(actor)])
  await audit(db, actor.kind === 'staff' ? actor.agent : null, 'ROOMS_LAYOUT', { by: actorRef(actor), status, blocks: L1.blocks.length }, { id: p.id, ref: p.ref })
  return { property: facts(p), ...(await snapshot(db, p.id)) }
}

// ── public (Marketplace) ─────────────────────────────────────────────────────
const PUBLIC_WHERE = `p.published = true AND p.archived_at IS NULL AND NOT COALESCE(p.is_staging,false)`
function publicUnit(u) {
  const v = unitView(u)
  return { id: v.id, kind: v.kind, position: v.position, label: v.label, sharedType: v.sharedType, status: v.status, priceMonth: v.priceMonth, priceNight: v.priceNight,
    minStayMonths: v.minStayMonths, maxOccupants: v.maxOccupants, sizeSqm: v.sizeSqm, sizeVerified: v.sizeVerified, privateBathroom: v.privateBathroom,
    features: v.features, photos: v.photos, description: v.description, availableFrom: v.availableFrom, span: v.span }
}
async function publicList({ demo = false } = {}) {
  const where = demo ? `p.archived_at IS NULL AND COALESCE(p.is_staging,false) AND p.ref LIKE 'DEMO-%'` : PUBLIC_WHERE
  const { rows } = await db.query(
    `SELECT p.id, p.ref, p.town, p.property_type, p.bedrooms, p.bathrooms, p.images, m.markets,
            json_agg(u.* ORDER BY u.kind DESC, u.position) AS units
       FROM properties p JOIN property_letting_modes m ON m.property_id=p.id AND m.valid_to IS NULL AND m.mode='rooms'
       JOIN property_units u ON u.property_id=p.id AND u.retired_at IS NULL
      WHERE ${where} GROUP BY p.id, m.markets ORDER BY p.id DESC LIMIT 200`)
  return { homes: rows.map(r => {
    const units = (r.units || []).map(publicUnit)
    const rooms = units.filter(u => u.kind === 'room' && u.status !== 'off_market')
    return { propertyId: r.id, ref: r.ref, town: r.town, type: r.property_type, bedrooms: r.bedrooms, bathrooms: r.bathrooms, photos: Array.isArray(r.images) ? r.images.slice(0, 8) : [],
      markets: r.markets, rooms, shared: units.filter(u => u.kind === 'shared'), demo }
  }).filter(h => h.rooms.length) }
}
async function publicHome(ref, { demo = false } = {}) {
  const where = demo ? `p.archived_at IS NULL AND COALESCE(p.is_staging,false) AND p.ref LIKE 'DEMO-%'` : PUBLIC_WHERE
  const { rows: [p] } = await db.query(`SELECT p.id, p.ref, p.town, p.property_type, p.bedrooms, p.bathrooms, p.images FROM properties p WHERE p.ref=$1 AND ${where}`, [String(ref || '').slice(0, 40)])
  if (!p) throw err('NOT_FOUND', 'This home is not listed.', 404)
  const s = await snapshot(db, p.id)
  if (s.mode.mode !== 'rooms') throw err('NOT_FOUND', 'This home is not let room by room.', 404)
  const raw = (await db.query(`SELECT * FROM property_units WHERE property_id=$1 AND retired_at IS NULL ORDER BY kind DESC, position`, [p.id])).rows.map(publicUnit)
  return {
    propertyId: p.id, ref: p.ref, town: p.town, type: p.property_type, bedrooms: p.bedrooms, bathrooms: p.bathrooms, photos: Array.isArray(p.images) ? p.images.slice(0, 24) : [], demo,
    markets: s.mode.markets, rooms: raw.filter(u => u.kind === 'room' && u.status !== 'off_market'), shared: raw.filter(u => u.kind === 'shared'),
    wholeSpan: [0, 1000000],
    layout: s.layout && s.layout.status === 'owner_confirmed' ? { grid: s.layout.grid, blocks: s.layout.blocks, note: s.layout.note, confirmedAt: s.layout.confirmedAt } : null,
  }
}

module.exports = { rooms, saveUnits, setMode, photo, saveLayout, publicList, publicHome, property, actorRef, FEATURES, SHARED, _test: { setUploader: fn => { uploader = fn }, cleanLayout, imageType } }
