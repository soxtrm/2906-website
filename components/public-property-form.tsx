'use client'

import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SingleVillageSelector } from '@/components/single-village-selector'
import { Check, ChevronRight, ChevronLeft, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import Image from 'next/image'

const PROPERTY_TYPE_GROUPS = [
  {
    label: 'Residential',
    types: ['Apartment', 'Penthouse', 'Duplex Penthouse', 'Maisonette', 'Townhouse',
            'Terraced House', 'House of Character', 'Detached Villa', 'Semi-detached Villa', 'Farmhouse'],
  },
  { label: 'Special', types: ['Boathouse', 'Garage'] },
  { label: 'Commercial', types: ['Office', 'Retail', 'Commercial Garage', 'Restaurant/Canteen', 'Gym'] },
]

const FEATURES = [
  { key: 'pool', label: 'Pool' }, { key: 'balcony', label: 'Balcony' },
  { key: 'sea_view', label: 'Sea View' }, { key: 'garden', label: 'Garden' },
  { key: 'garage', label: 'Garage/Parking' }, { key: 'ac', label: 'AC' },
  { key: 'jacuzzi', label: 'Jacuzzi' }, { key: 'seafront', label: 'Seafront' },
  { key: 'roof_terrace', label: 'Roof Terrace' }, { key: 'pets_ok', label: 'Pet-Friendly' },
  { key: 'long_term', label: 'Long-Term Welcome' },
]

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1', flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34', flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+7', flag: '🇷🇺' },
  { code: '+971', flag: '🇦🇪' }, { code: '+380', flag: '🇺🇦' },
]

const STEPS = ['Your Details', 'Property', 'Pricing', 'Photos & Notes']

function Field({ label, children, required, error }: {
  label: string; children: React.ReactNode; required?: boolean; error?: string
}) {
  return (
    <div>
      <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </p>
      {children}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('text-xs px-2.5 py-1 rounded-full border transition-all',
        active ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/30')}>
      {children}
    </button>
  )
}

function inputCls(err?: string) {
  return cn(
    'w-full px-4 py-2.5 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm',
    err ? 'border-red-400' : 'border-navy/15'
  )
}

const defaultForm = {
  owner_name: '', dial: '+356', phone: '', email: '', preferred_contact: 'whatsapp',
  property_type: '', village_code: null as string | null, village_display: '',
  listing_type: 'For Rent', bedrooms: '', bathrooms: '', size_sqm: '',
  price_rent: '', price_sale: '', available_from: '',
  furnished: 'Fully Furnished', features: [] as string[],
  description: '', photos: [] as { url: string; thumbnail: string }[],
  notes: '',
}

export function PublicPropertyForm() {
  const [form, setForm] = useState(defaultForm)
  const [step, setStep] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key as string]; return e })
  }, [])

  const toggleFeature = (k: string) =>
    set('features', (form.features.includes(k) ? form.features.filter(f => f !== k) : [...form.features, k]) as typeof form.features)

  function validateStep(s: number): Record<string, string> {
    const e: Record<string, string> = {}
    if (s === 0) {
      if (!form.owner_name.trim()) e.owner_name = 'Required'
      if (!form.phone.trim()) e.phone = 'Required'
    }
    if (s === 1) {
      if (!form.property_type) e.property_type = 'Required'
      if (!form.village_code) e.village = 'Required'
    }
    if (s === 2) {
      if ((form.listing_type === 'For Rent' || form.listing_type === 'Both') && !form.price_rent) e.price_rent = 'Required'
      if ((form.listing_type === 'For Sale' || form.listing_type === 'Both') && !form.price_sale) e.price_sale = 'Required'
    }
    return e
  }

  function next() {
    const e = validateStep(step)
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({})
    setStep(s => Math.min(s + 1, STEPS.length - 1))
  }

  async function handlePhotos(files: FileList | null) {
    if (!files || !files.length) return
    setUploading(true)
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('photos', f))
      const res = await fetch('/api/property-submit/photos', { method: 'POST', body: fd })
      const data = await res.json()
      if (res.ok) set('photos', [...form.photos, ...data.photos] as typeof form.photos)
    } catch { /* noop */ }
    setUploading(false)
  }

  async function submit() {
    setSubmitting(true)
    try {
      const payload = {
        submitter_type: 'landlord',
        owner_name: form.owner_name,
        submitter_name: form.owner_name,
        submitter_phone: `${form.dial}${form.phone}`,
        submitter_email: form.email || null,
        preferred_contact: form.preferred_contact,
        property_type: form.property_type,
        village_code: form.village_code,
        location: form.village_display,
        regions: [],
        listing_type: form.listing_type,
        bedrooms: form.bedrooms ? parseInt(form.bedrooms) : null,
        bathrooms: form.bathrooms ? parseInt(form.bathrooms) : null,
        size_sqm: form.size_sqm ? parseInt(form.size_sqm) : null,
        price_rent: form.price_rent ? parseInt(form.price_rent) : null,
        price_sale: form.price_sale ? parseInt(form.price_sale) : null,
        available_from: form.available_from || null,
        furnished: form.furnished,
        features: form.features,
        description: form.description || null,
        photos: form.photos,
        notes: form.notes || null,
      }
      const res = await fetch('/api/property-submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) setDone(true)
      else alert('Something went wrong. Please try again.')
    } catch { alert('Network error.') }
    setSubmitting(false)
  }

  const isForRent = form.listing_type === 'For Rent' || form.listing_type === 'Both'
  const isForSale = form.listing_type === 'For Sale' || form.listing_type === 'Both'

  if (done) {
    return (
      <div className="text-center py-10">
        <div className="w-16 h-16 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="w-8 h-8 text-gold" />
        </div>
        <h3 className="font-serif text-2xl text-navy mb-2">Property Submitted!</h3>
        <p className="text-navy/50 text-sm mb-6">We&apos;ll review your property and be in touch within 24 hours.</p>
        <button onClick={() => { setForm(defaultForm); setStep(0); setDone(false) }}
          className="px-6 py-2.5 bg-navy text-white text-sm rounded hover:opacity-90 transition-opacity">
          Submit Another
        </button>
      </div>
    )
  }

  return (
    <div>
      {/* Progress */}
      <div className="flex gap-1 mb-6">
        {STEPS.map((_, i) => (
          <div key={i} className={cn('flex-1 h-1 rounded-full transition-all', i <= step ? 'bg-gold' : 'bg-navy/10')} />
        ))}
      </div>
      <p className="text-xs text-navy/40 -mt-4 mb-6">Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div key="s0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
            <Field label="Your Name" required error={errors.owner_name}>
              <input value={form.owner_name} onChange={e => set('owner_name', e.target.value)}
                placeholder="Maria Borg" className={inputCls(errors.owner_name)} />
            </Field>
            <Field label="Phone" required error={errors.phone}>
              <div className="flex gap-2">
                <select value={form.dial} onChange={e => set('dial', e.target.value)}
                  className="border border-navy/15 rounded px-2 py-2.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-gold/40">
                  {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                </select>
                <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)}
                  placeholder="79000000" className={cn(inputCls(errors.phone), 'flex-1')} />
              </div>
            </Field>
            <Field label="Email (optional)">
              <input type="email" value={form.email} onChange={e => set('email', e.target.value)}
                placeholder="you@email.com" className={inputCls()} />
            </Field>
            <Field label="Preferred Contact">
              <div className="flex gap-2">
                {['whatsapp', 'phone', 'email'].map(c => (
                  <Chip key={c} active={form.preferred_contact === c} onClick={() => set('preferred_contact', c)}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </Chip>
                ))}
              </div>
            </Field>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div key="s1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
            <Field label="Property Type" required error={errors.property_type}>
              <div className="space-y-3">
                {PROPERTY_TYPE_GROUPS.map(g => (
                  <div key={g.label}>
                    <p className="text-xs text-navy/30 mb-1.5">{g.label}</p>
                    <div className="flex flex-wrap gap-2">
                      {g.types.map(t => (
                        <Chip key={t} active={form.property_type === t} onClick={() => set('property_type', t)}>{t}</Chip>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Field>
            <Field label="Village / Town" required error={errors.village}>
              <SingleVillageSelector
                value={form.village_code}
                onChange={(code, display) => setForm(prev => ({ ...prev, village_code: code, village_display: display || '' }))}
                placeholder="Search village or town…"
              />
            </Field>
            <Field label="Available From">
              <input type="date" value={form.available_from} onChange={e => set('available_from', e.target.value)} className={inputCls()} />
            </Field>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="s2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
            <Field label="Listing Type">
              <div className="flex gap-2">
                {(['For Rent', 'For Sale', 'Both'] as const).map(t => (
                  <Chip key={t} active={form.listing_type === t} onClick={() => set('listing_type', t)}>{t}</Chip>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Bedrooms">
                <select value={form.bedrooms} onChange={e => set('bedrooms', e.target.value)} className={inputCls()}>
                  <option value="">—</option>
                  {['0', '1', '2', '3', '4', '5', '6+'].map(n => (
                    <option key={n} value={n}>{n === '0' ? 'Studio' : n}</option>
                  ))}
                </select>
              </Field>
              <Field label="Bathrooms">
                <select value={form.bathrooms} onChange={e => set('bathrooms', e.target.value)} className={inputCls()}>
                  <option value="">—</option>
                  {['1', '2', '3', '4', '5+'].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Size (m²)">
                <input type="number" value={form.size_sqm} onChange={e => set('size_sqm', e.target.value)} placeholder="85" className={inputCls()} />
              </Field>
            </div>
            {isForRent && (
              <Field label="Monthly Rent (€)" required error={errors.price_rent}>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40 text-sm">€</span>
                  <input type="number" value={form.price_rent} onChange={e => set('price_rent', e.target.value)}
                    placeholder="1500" className={cn(inputCls(errors.price_rent), 'pl-8')} />
                </div>
              </Field>
            )}
            {isForSale && (
              <Field label="Sale Price (€)" required error={errors.price_sale}>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40 text-sm">€</span>
                  <input type="number" value={form.price_sale} onChange={e => set('price_sale', e.target.value)}
                    placeholder="250000" className={cn(inputCls(errors.price_sale), 'pl-8')} />
                </div>
              </Field>
            )}
            <Field label="Furnished">
              <div className="flex flex-wrap gap-2">
                {['Fully Furnished', 'Semi Furnished', 'Unfurnished'].map(f => (
                  <Chip key={f} active={form.furnished === f} onClick={() => set('furnished', f)}>{f}</Chip>
                ))}
              </div>
            </Field>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div key="s3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
            <Field label="Features">
              <div className="flex flex-wrap gap-2">
                {FEATURES.map(f => (
                  <Chip key={f.key} active={form.features.includes(f.key)} onClick={() => toggleFeature(f.key)}>{f.label}</Chip>
                ))}
              </div>
            </Field>
            <Field label="Description">
              <textarea rows={4} value={form.description} onChange={e => set('description', e.target.value)}
                placeholder="Describe your property..."
                className={cn(inputCls(), 'resize-none')} />
            </Field>
            <Field label="Photos (optional)">
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => handlePhotos(e.target.files)} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                className="w-full border-2 border-dashed border-navy/15 rounded py-6 flex flex-col items-center gap-2 text-navy/40 hover:border-gold/40 transition-all disabled:opacity-50">
                <Upload className="w-5 h-5" />
                <span className="text-sm">{uploading ? 'Uploading…' : 'Click to upload'}</span>
              </button>
              {form.photos.length > 0 && (
                <div className="grid grid-cols-4 gap-2 mt-2">
                  {form.photos.map(p => (
                    <div key={p.url} className="relative aspect-square rounded overflow-hidden group">
                      <Image src={p.thumbnail || p.url} alt="" fill className="object-cover" />
                      <button type="button" onClick={() => set('photos', form.photos.filter(x => x.url !== p.url) as typeof form.photos)}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Additional Notes (optional)">
              <textarea rows={2} value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder="Any other details..."
                className={cn(inputCls(), 'resize-none')} />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex gap-3 mt-8 pt-6 border-t border-navy/5">
        {step > 0 && (
          <button type="button" onClick={() => { setErrors({}); setStep(s => s - 1) }}
            className="flex items-center gap-1.5 px-4 py-2.5 border border-navy/15 rounded text-navy/60 hover:text-navy text-sm transition-colors">
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={next}
            className="flex-1 flex items-center justify-center gap-1.5 py-3 bg-navy text-white rounded font-medium text-sm hover:opacity-90 transition-opacity">
            Continue <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={submitting}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-navy text-white rounded font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
            {submitting ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Submitting…</> : <><Check className="w-4 h-4" />Submit Property</>}
          </button>
        )}
      </div>
    </div>
  )
}
