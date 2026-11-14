'use strict'
// ============================================================================
// services/facebookPages/content.js — deterministic Facebook ad text from the
// listing's own facts. No AI dependency and no invented attributes: a line is
// written only when the field exists. No ARGUS branding and no agency CTA is
// inserted; the agent's own contact line appears only when they choose it.
//
// Built-in templates: "classic" (structured, emoji bullets), "short",
// "original" (the listing's existing public text). Agents can save custom
// templates with {{placeholders}}. Languages: en (default), mt, de.
// ============================================================================
const sanitizer = require('../sanitizer')

const LANGS = ['en', 'mt', 'de']
const MAX_MESSAGE = 5000   // well under Meta's limit; long posts read badly anyway

const T = {
  en: {
    rent: 'FOR RENT', sale: 'FOR SALE', month: 'month', bedroom: 'Bedroom', bedrooms: 'Bedrooms', bathroom: 'Bathroom', bathrooms: 'Bathrooms',
    studio: 'STUDIO', availableNow: 'Available now', availableFrom: 'Available from', availableUntil: 'until', shortLet: 'Short lets considered',
    cta: 'Contact us to arrange a viewing.', moreInfo: 'Details', contact: 'Contact',
    types: { apartment: 'apartment', penthouse: 'penthouse', maisonette: 'maisonette', studio: 'studio', house: 'house', townhouse: 'townhouse', villa: 'villa', room: 'room', office: 'office', shop: 'shop', retail: 'retail space', commercial: 'commercial property', garage: 'garage' },
    features: { air_conditioning: 'Air-conditioning', furnished: 'Furnished', unfurnished: 'Unfurnished', terrace: 'Terrace', sea_view: 'Sea view', balcony: 'Balcony', washing_machine: 'Washing machine', parking: 'Parking', dishwasher: 'Dishwasher', lift: 'Lift', garage: 'Garage', internet: 'Internet', garden: 'Garden', study: 'Study room', pool: 'Pool', jacuzzi: 'Jacuzzi', storage_room: 'Storage room', bathtub: 'Bathtub', double_glazing: 'Double glazing', gym: 'Gym', rooftop_access: 'Roof access', built_in_wardrobes: 'Built-in wardrobes', fireplace: 'Fireplace', solar_water_heater: 'Solar water heater', alarm_system: 'Alarm system', pets: 'Pets allowed' },
  },
  mt: {
    rent: 'GĦALL-KIRI', sale: 'GĦALL-BEJGĦ', month: 'xahar', bedroom: 'Kamra tas-sodda', bedrooms: 'Kmamar tas-sodda', bathroom: 'Kamra tal-banju', bathrooms: 'Kmamar tal-banju',
    studio: 'STUDIO', availableNow: 'Disponibbli issa', availableFrom: 'Disponibbli minn', availableUntil: 'sa', shortLet: 'Kiri għal żmien qasir jiġi kkunsidrat',
    cta: 'Ikkuntattjana biex tara l-propjetà.', moreInfo: 'Dettalji', contact: 'Kuntatt',
    types: { apartment: 'appartament', penthouse: 'penthouse', maisonette: 'maisonette', studio: 'studio', house: 'dar', townhouse: 'townhouse', villa: 'villa', room: 'kamra', office: 'uffiċċju', shop: 'ħanut', retail: 'ħanut', commercial: 'propjetà kummerċjali', garage: 'garaxx' },
    features: { air_conditioning: 'Arja kkundizzjonata', furnished: 'Mgħammar', unfurnished: 'Mhux mgħammar', terrace: 'Terrazzin', sea_view: 'Veduta tal-baħar', balcony: 'Gallarija', washing_machine: 'Magna tal-ħasil', parking: 'Parkeġġ', dishwasher: 'Magna tal-platti', lift: 'Lift', garage: 'Garaxx', internet: 'Internet', garden: 'Ġnien', study: 'Kamra tal-istudju', pool: 'Pixxina', jacuzzi: 'Jacuzzi', storage_room: 'Kamra tal-ħażna', bathtub: 'Banju', double_glazing: 'Twieqi doppji', gym: 'Gym', rooftop_access: 'Aċċess għall-bejt', built_in_wardrobes: 'Gwardarobbi mibnija', fireplace: 'Nar', solar_water_heater: 'Heater solari', alarm_system: 'Sistema ta\' allarm', pets: 'Annimali permessi' },
  },
  de: {
    rent: 'ZU VERMIETEN', sale: 'ZU VERKAUFEN', month: 'Monat', bedroom: 'Schlafzimmer', bedrooms: 'Schlafzimmer', bathroom: 'Badezimmer', bathrooms: 'Badezimmer',
    studio: 'STUDIO', availableNow: 'Sofort verfügbar', availableFrom: 'Verfügbar ab', availableUntil: 'bis', shortLet: 'Kurzzeitmiete möglich',
    cta: 'Kontaktieren Sie uns für eine Besichtigung.', moreInfo: 'Details', contact: 'Kontakt',
    types: { apartment: 'Wohnung', penthouse: 'Penthouse', maisonette: 'Maisonette', studio: 'Studio', house: 'Haus', townhouse: 'Stadthaus', villa: 'Villa', room: 'Zimmer', office: 'Büro', shop: 'Ladenlokal', retail: 'Ladenfläche', commercial: 'Gewerbeimmobilie', garage: 'Garage' },
    features: { air_conditioning: 'Klimaanlage', furnished: 'Möbliert', unfurnished: 'Unmöbliert', terrace: 'Terrasse', sea_view: 'Meerblick', balcony: 'Balkon', washing_machine: 'Waschmaschine', parking: 'Parkplatz', dishwasher: 'Geschirrspüler', lift: 'Aufzug', garage: 'Garage', internet: 'Internet', garden: 'Garten', study: 'Arbeitszimmer', pool: 'Pool', jacuzzi: 'Whirlpool', storage_room: 'Abstellraum', bathtub: 'Badewanne', double_glazing: 'Doppelverglasung', gym: 'Fitnessraum', rooftop_access: 'Dachzugang', built_in_wardrobes: 'Einbauschränke', fireplace: 'Kamin', solar_water_heater: 'Solar-Warmwasser', alarm_system: 'Alarmanlage', pets: 'Haustiere erlaubt' },
  },
}
const FEATURE_EMOJI = { air_conditioning: '❄️', furnished: '🛋', terrace: '🌿', sea_view: '🌊', balcony: '🌤', parking: '🚗', garage: '🚗', lift: '🛗', garden: '🌳', pool: '🏊', internet: '📶', pets: '🐾', washing_machine: '🧺', dishwasher: '🍽', study: '📚', jacuzzi: '🛁', gym: '🏋️' }

const BUILT_IN = [
  { id: 'classic', name: 'Classic', description: 'Headline, key facts as a list, short description, call to action.' },
  { id: 'short', name: 'Short', description: 'Two or three lines with the essentials.' },
  { id: 'original', name: 'Listing text', description: 'The listing\'s existing public description.' },
]

const lang = l => (LANGS.includes(l) ? l : 'en')
const money = n => `€${Math.round(Number(n)).toLocaleString('en-US')}`
const date = (d, l) => {
  if (!d) return null
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toLocaleDateString(l === 'de' ? 'de-DE' : l === 'mt' ? 'mt-MT' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Malta' })
}
const title = s => String(s || '').toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())

function typeLabel(f, l) {
  const key = String(f.type || '').toLowerCase().trim()
  return T[l].types[key] || (key ? key : T[l].types.apartment)
}

// Every fact line. Each is null when the listing does not have the field.
function facts(f, l) {
  const t = T[l]
  const isSale = !f.rent && f.sale
  const typ = typeLabel(f, l)
  let headline
  if (String(f.type).toLowerCase() === 'studio') headline = `${t.studio} ${isSale ? t.sale : t.rent} — ${String(f.town || '').toUpperCase()}`
  else if (Number(f.bedrooms) > 0 && l === 'de') headline = `${f.bedrooms}-ZIMMER-${typ.toUpperCase()} ${isSale ? t.sale : t.rent} — ${String(f.town || '').toUpperCase()}`
  else if (Number(f.bedrooms) > 0 && l === 'mt') headline = `${typ.toUpperCase()} B'${f.bedrooms} ${f.bedrooms === 1 ? 'KAMRA' : 'KMAMAR'} ${isSale ? t.sale : t.rent} — ${String(f.town || '').toUpperCase()}`
  else if (Number(f.bedrooms) > 0) headline = `${f.bedrooms}-BEDROOM ${typ.toUpperCase()} ${isSale ? t.sale : t.rent} — ${String(f.town || '').toUpperCase()}`
  else headline = `${typ.toUpperCase()} ${isSale ? t.sale : t.rent} — ${String(f.town || '').toUpperCase()}`
  const island = f.island && /gozo|għawdex/i.test(f.island) ? 'Gozo' : 'Malta'
  const location = f.town ? `${title(f.town)}, ${island}` : null
  const price = f.rent ? `${money(f.rent)} / ${t.month}` : f.sale ? money(f.sale) : null
  const beds = Number(f.bedrooms) > 0 ? `${f.bedrooms} ${f.bedrooms === 1 ? t.bedroom : t.bedrooms}` : null
  const baths = Number(f.bathrooms) > 0 ? `${f.bathrooms} ${f.bathrooms === 1 ? t.bathroom : t.bathrooms}` : null
  const size = f.sizeSqm ? `${Math.round(f.sizeSqm)} m²` : null
  const tags = new Set((f.featureTags || []).map(x => String(x).toLowerCase()))
  if (f.balcony) tags.add('balcony')
  if (f.parking) tags.add('parking')
  if (f.petsAllowed) tags.add('pets')
  const order = ['furnished', 'unfurnished', 'air_conditioning', 'sea_view', 'terrace', 'balcony', 'garden', 'pool', 'lift', 'parking', 'garage', 'study', 'internet', 'washing_machine', 'dishwasher', 'pets', 'jacuzzi', 'storage_room', 'double_glazing', 'gym', 'rooftop_access', 'built_in_wardrobes', 'fireplace', 'solar_water_heater', 'bathtub', 'alarm_system']
  if (tags.has('furnished') && tags.has('unfurnished')) tags.delete('unfurnished')
  const features = order.filter(k => tags.has(k) && t.features[k]).map(k => ({ key: k, label: t.features[k], emoji: FEATURE_EMOJI[k] || '✔️' }))
  let availability = null
  const from = date(f.availableDate, l)
  if (from && new Date(f.availableDate).getTime() > Date.now()) availability = `${t.availableFrom} ${from}`
  else if (['available', 'available_confirmed'].includes(f.availableStatus)) availability = t.availableNow
  const until = date(f.availableUntil, l)
  if (availability && until) availability += ` ${t.availableUntil} ${until}`
  const shortLet = f.shortlet && f.rent ? t.shortLet : null
  return { headline, location, price, beds, baths, size, features, availability, shortLet }
}

// The opening paragraph of the listing's own public description, without
// lines that just repeat the headline, price, town or bullet facts.
function descriptionParagraph(text, f) {
  const paras = String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const town = String(f.town || '').toLowerCase()
  for (const p of paras) {
    const plain = p.replace(/[*_#]+/g, '').trim()
    if (plain.length < 60) continue
    if (/^[-•✔️✅\d]/u.test(plain)) continue
    if (plain === plain.toUpperCase()) continue
    if (plain.toLowerCase() === town) continue
    return plain.length > 480 ? plain.slice(0, 480).replace(/\s+\S*$/, '') + '…' : plain
  }
  return ''
}

function contactLine(agent, l) {
  const name = [agent.display_name || agent.name || null].filter(Boolean)[0]
  const phone = agent.public_phone || null
  if (!name && !phone) return null
  return `${T[l].contact}: ${[name, phone].filter(Boolean).join(' · ')}`
}

function render({ template = 'classic', custom = null, facts: f, link = null, language = 'en', emojis = true, cta = null, includeContact = false, agent = {} }) {
  const l = lang(language)
  const x = facts(f, l)
  const e = (sym, s) => (s ? (emojis ? `${sym} ${s}` : s) : null)
  const callToAction = (cta && String(cta).trim()) || T[l].cta
  const contact = includeContact ? contactLine(agent, l) : null
  const desc = descriptionParagraph(f.description, f)
  let lines
  if (custom) {
    const vars = {
      headline: x.headline, location: x.location || '', price: x.price || '', bedrooms: x.beds || '', bathrooms: x.baths || '',
      size: x.size || '', features: x.features.map(k => (emojis ? `${k.emoji} ${k.label}` : `• ${k.label}`)).join('\n'),
      availability: x.availability || '', description: desc, link: link || '', cta: callToAction, contact: contact || '',
    }
    const body = String(custom).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : ''))
    return tidy(body)
  }
  if (template === 'original') {
    let original = String(f.description || '').trim()
    if (original.length > 3000) original = original.slice(0, 3000).replace(/\s+\S*$/, '') + '…'
    lines = [original || e('🏡', x.headline), '', e('📩', callToAction), contact ? e('📞', contact) : null, link ? e('🔗', link) : null]
  } else if (template === 'short') {
    const bits = [x.beds, x.baths, x.size].filter(Boolean).join(' · ')
    lines = [e('🏡', x.headline), [x.price, bits].filter(Boolean).join(' · '), x.availability, '', e('📩', callToAction), contact ? e('📞', contact) : null, link ? e('🔗', link) : null]
  } else {
    lines = [
      e('🏡', x.headline), '',
      e('📍', x.location), e('💶', x.price), e('🛏', x.beds), e('🛁', x.baths), e('📐', x.size),
      ...x.features.slice(0, 8).map(k => (emojis ? `${k.emoji} ${k.label}` : `• ${k.label}`)),
      e('📅', x.availability), e('🗓', x.shortLet),
      desc ? '' : null, desc || null, '',
      e('📩', callToAction), contact ? e('📞', contact) : null, link ? e('🔗', link) : null,
    ]
  }
  return tidy(lines.filter(v => v !== null && v !== undefined).join('\n'))
}

function tidy(s) {
  return String(s).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Final gate for any text about to leave ARGUS (generated or edited by the agent).
// Street addresses and map links are refused. Phone numbers and e-mails are
// refused unless they are the publishing agent's own public contact details.
function validateMessage(message, { agent = {} } = {}) {
  const s = String(message || '')
  if (!s.trim()) return { ok: false, message: 'Write the post text before publishing.' }
  if (s.length > MAX_MESSAGE) return { ok: false, message: `The post is too long. Keep it under ${MAX_MESSAGE} characters.` }
  if (sanitizer.findAddress && sanitizer.findAddress(s)) return { ok: false, message: 'The text contains what looks like a street address. Only the locality may be published.' }
  if (sanitizer.findMapsLink && sanitizer.findMapsLink(s)) return { ok: false, message: 'Remove the map link: the exact location is not published.' }
  let rest = s
  for (const own of [agent.public_phone, agent.whatsapp_phone, agent.email].filter(Boolean)) {
    const raw = String(own)
    rest = rest.split(raw).join(' ')
    const digits = raw.replace(/\D/g, '')
    // Full international form first, then the national 8-digit form (Malta) the agent may type.
    for (const d of [digits, digits.slice(-8)]) {
      if (d.length < 8) continue
      rest = rest.replace(new RegExp('(?:\\+|00)?(?:\\d{1,3}[\\s\\-().]*)?' + d.split('').join('[\\s\\-().]*'), 'g'), m => (m.replace(/\D/g, '').endsWith(d) ? ' ' : m))
    }
  }
  try { sanitizer.assertNoLeaks(rest, 'facebook page post') } catch (e) {
    return { ok: false, message: /email/i.test(e.message)
      ? 'The text contains an e-mail address that is not your own. Remove it before publishing.'
      : 'The text contains a phone number that is not your public contact number. Remove it before publishing.' }
  }
  return { ok: true }
}

module.exports = { render, facts, validateMessage, descriptionParagraph, BUILT_IN, LANGS, MAX_MESSAGE }
