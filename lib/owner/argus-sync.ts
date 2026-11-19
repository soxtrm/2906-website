// Sends a home an owner adds in SYNC straight into ARGUS, through the same
// public intake the 2906.estate contact form already uses
// (/api/property-submit/photos, then /api/public/property-submit). ARGUS puts it
// into "needs verification" like every owner upload, so nothing goes public
// before an agent has checked it. Never called in the demo.
import { MODE_LABEL, MODE_PERIOD, termsLine, type OfferTerms, type OperatingMode } from './model.ts'

export interface SyncInput {
  owner: { name: string; phone: string; email?: string }
  propertyType: string; town: string; address: string; bedrooms: number; bathrooms: number; sizeSqm?: number
  offers: { mode: OperatingMode; price: number; terms?: OfferTerms }[]
  availableFrom?: string; furnished: string; features: string[]; description: string; photos: string[]
}

const RENT: OperatingMode[] = ['long_let', 'rooms', 'shortlet', 'winter_let', 'summer_let', 'commercial']
const SALE: OperatingMode[] = ['sale', 'commercial_sale']

/** the payload the existing intake expects (same fields as components/public-property-form.tsx) */
export function intakePayload(n: SyncInput, photos: unknown[]) {
  const rent = n.offers.find(o => RENT.includes(o.mode) && MODE_PERIOD[o.mode] === 'month') || n.offers.find(o => RENT.includes(o.mode))
  const sale = n.offers.find(o => SALE.includes(o.mode))
  const listingType = rent && sale ? 'Both' : sale ? 'For Sale' : 'For Rent'
  const offersText = n.offers.map(o => {
    const per = MODE_PERIOD[o.mode] === 'month' ? '/month' : MODE_PERIOD[o.mode] === 'night' ? '/night' : ''
    const t = termsLine(o.mode, o.terms)
    return `${MODE_LABEL[o.mode]} €${o.price}${per}${t ? ` (${t})` : ''}`
  }).join('; ')
  return {
    submitter_type: 'landlord',
    owner_name: n.owner.name.trim(),
    owner_phone: n.owner.phone.trim(),
    owner_email: n.owner.email?.trim() || null,
    preferred_contact: 'whatsapp',
    property_type: n.propertyType || null,
    listing_type: listingType,
    village_code: null,
    location: n.town.trim() || null,
    bedrooms: n.bedrooms ? String(n.bedrooms) : null,
    bathrooms: n.bathrooms ? String(n.bathrooms) : null,
    size_sqm: n.sizeSqm || null,
    price_rent: rent ? Math.round(rent.price) : null,
    price_sale: sale ? Math.round(sale.price) : null,
    available_from_type: n.availableFrom ? 'specific' : 'now',
    available_from_date: n.availableFrom || new Date().toISOString().slice(0, 10),
    available_from_comment: null,
    furnished: n.furnished === 'Part' ? 'Semi Furnished' : n.furnished === 'Unfurnished' ? 'Unfurnished' : 'Fully Furnished',
    shell_form: false,
    features: n.features,
    furniture_style: null,
    // the intake needs at least 30 characters; a short owner text gets a plain sentence added
    description: (n.description.trim().length >= 30 ? n.description.trim()
      : `${n.description.trim() ? `${n.description.trim()} ` : ''}${n.propertyType} in ${n.town}${n.bedrooms ? ` with ${n.bedrooms} bedroom${n.bedrooms > 1 ? 's' : ''}` : ''}, added by the owner in NEXUS SYNC.`).slice(0, 2000),
    notes: [`Added by the owner in NEXUS SYNC.`, `Offers: ${offersText}.`, n.address ? `Street: ${n.address}.` : ''].filter(Boolean).join(' '),
    photos,
    preferred_viewing_times: null,
    title: null,
  }
}

function dataUrlToFile(d: string, i: number) {
  const [head, b64] = d.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg'
  const bin = atob(b64); const arr = new Uint8Array(bin.length)
  for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k)
  return new File([arr], `photo-${i + 1}.jpg`, { type: mime })
}

export async function sendToArgus(n: SyncInput): Promise<{ ok: true; ref?: string } | { ok: false; error: string }> {
  try {
    let uploaded: unknown[] = []
    const files = n.photos.filter(p => p.startsWith('data:')).slice(0, 10)
    if (files.length) {
      const fd = new FormData()
      files.forEach((p, i) => fd.append('photos', dataUrlToFile(p, i)))
      const r = await fetch('/api/property-submit/photos', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: d.error || 'The photos could not be uploaded.' }
      uploaded = d.photos || []
    }
    const r = await fetch('/api/public/property-submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intakePayload(n, uploaded)) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || d.success === false) return { ok: false, error: d.error || 'ARGUS did not accept it. Please try again.' }
    return { ok: true, ref: d.submission_id ? String(d.submission_id) : undefined }
  } catch {
    return { ok: false, error: 'No connection to ARGUS. Please try again.' }
  }
}
