'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SingleVillageSelector } from '@/components/single-village-selector'
import { Check, X, Upload, ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import Image from 'next/image'

// ── Constants ─────────────────────────────────────────────────────────────────

const PROPERTY_TYPE_GROUPS = [
  {
    label: 'Residential',
    types: [
      'Apartment', 'Penthouse', 'Duplex Penthouse', 'Maisonette',
      'Townhouse', 'Terraced House', 'House of Character',
      'Detached Villa', 'Semi-detached Villa', 'Farmhouse', 'Studio',
    ],
  },
  {
    label: 'Special',
    types: ['Boathouse', 'Garage'],
  },
  {
    label: 'Commercial',
    types: ['Office', 'Retail', 'Restaurant/Canteen', 'Gym', 'Commercial Garage', 'Warehouse', 'Other'],
  },
]

const COMMERCIAL_TYPES = new Set(PROPERTY_TYPE_GROUPS.find(g => g.label === 'Commercial')!.types)

function isCommercial(propertyType: string) {
  return COMMERCIAL_TYPES.has(propertyType)
}

const FEATURES = [
  { key: 'brand_new',    label: 'Brand New' },
  { key: 'pool',         label: 'Pool' },
  { key: 'balcony',      label: 'Balcony' },
  { key: 'sea_view',     label: 'Sea View' },
  { key: 'garden',       label: 'Garden' },
  { key: 'roof_terrace', label: 'Roof Terrace' },
  { key: 'jacuzzi',      label: 'Jacuzzi' },
  { key: 'seafront',     label: 'Seafront' },
  { key: 'bathtub',      label: 'Bathtub' },
  { key: 'rooftop',      label: 'Rooftop' },
  { key: 'garage',       label: 'Garage/Parking' },
  { key: 'ac',           label: 'AC' },
  { key: 'heating',      label: 'Heating' },
  { key: 'solar',        label: 'Solar Panels' },
  { key: 'pets_ok',      label: 'Pet-Friendly' },
  { key: 'long_term',    label: 'Long-Term Welcome' },
  { key: 'investment',   label: 'Investment Opportunity' },
  { key: 'new_build',    label: 'New Build' },
  { key: 'renovated',    label: 'Renovated' },
]

const FURNITURE_STYLES = ['Ultra Modern', 'Modern', 'Standard', 'Character', 'Cozy']

const BED_BATH_OPTIONS = ['1', '2', '3', '4', '5', '6+', 'Other']

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1',   flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34',  flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+7',  flag: '🇷🇺' },
  { code: '+971', flag: '🇦🇪' }, { code: '+380', flag: '🇺🇦' }, { code: '+48', flag: '🇵🇱' },
]

const STEPS = ['Your Details', 'Type & Location', 'Details', 'Features', 'Description', 'Review']
const TOTAL_STEPS = STEPS.length

// ── Auto-title ────────────────────────────────────────────────────────────────

function generateTitle(form: typeof defaultForm): string {
  const loc = form.village_display || form.location || 'Malta'
  const price = form.price_rent
    ? `€${Number(form.price_rent).toLocaleString()}/mo`
    : form.price_sale ? `€${Number(form.price_sale).toLocaleString()}` : ''

  if (isCommercial(form.property_type)) {
    const sqm = form.size_sqm ? `${form.size_sqm}sqm` : ''
    return [loc, price, sqm, form.property_type].filter(Boolean).join(' | ')
  }

  const bedsNum  = form.bedrooms  === 'Other' ? (form.bedrooms_other  || '') : form.bedrooms
  const bathsNum = form.bathrooms === 'Other' ? (form.bathrooms_other || '') : form.bathrooms
  const beds  = bedsNum  ? `${bedsNum} Bedroom${bedsNum !== '1' ? 's' : ''}` : ''
  const baths = bathsNum ? `${bathsNum} Bathroom${bathsNum !== '1' ? 's' : ''}` : ''
  const roomStr = beds && baths ? `${beds} - ${baths}` : beds || baths

  return [loc, price, roomStr].filter(Boolean).join(' | ')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-xs px-2.5 py-1 rounded-full border transition-all',
        active
          ? 'border-gold bg-gold/10 text-navy font-medium'
          : 'border-navy/15 text-navy/50 hover:border-navy/30 hover:text-navy'
      )}
    >
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

function ReviewRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-2 border-b border-navy/5 last:border-0">
      <span className="text-xs text-navy/40 uppercase tracking-wide w-36 shrink-0">{label}</span>
      <span className="text-sm text-navy">{value}</span>
    </div>
  )
}

// ── Default state ─────────────────────────────────────────────────────────────

const defaultForm = {
  owner_name:              '',
  dial:                    '+356',
  phone:                   '',
  owner_email:             '',
  preferred_contact:       'whatsapp',
  property_type:           '',
  location:                '',
  village_code:            null as string | null,
  village_display:         '',
  available_from_type:     'now' as 'now' | 'specific' | 'other',
  available_from_date:     '',
  available_from_comment:  '',
  listing_type:            'For Rent',
  bedrooms:                '',
  bedrooms_other:          '',
  bathrooms:               '',
  bathrooms_other:         '',
  size_sqm:                '',
  price_rent:              '',
  price_sale:              '',
  furnished:               'Fully Furnished',
  shell_form:              false,
  features:                [] as string[],
  furniture_style:         'Standard',
  description:             '',
  photos:                  [] as { url: string; thumbnail: string }[],
  notes:                   '',
  preferred_viewing_times: '',
  title:                   '',
}

// ── Main Component ────────────────────────────────────────────────────────────

export function PublicPropertyForm() {
  const [form, setForm]             = useState(defaultForm)
  const [step, setStep]             = useState(0)
  const [errors, setErrors]         = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]             = useState(false)
  const [uploading, setUploading]   = useState(false)
  const [uploadErr, setUploadErr]   = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key as string]; return e })
  }, [])

  const toggleFeature = (k: string) =>
    set('features', (form.features.includes(k)
      ? form.features.filter(f => f !== k)
      : [...form.features, k]) as typeof form.features)

  // Auto-generate title when reaching review step
  useEffect(() => {
    if (step === TOTAL_STEPS - 1 && !form.title) {
      const t = generateTitle(form)
      if (t) setForm(prev => ({ ...prev, title: t }))
    }
  }, [step]) // eslint-disable-line

  // ── Validation ────────────────────────────────────────────────────────────

  function validateStep(s: number): Record<string, string> {
    const e: Record<string, string> = {}
    if (s === 0) {
      if (!form.owner_name.trim()) e.owner_name = 'Required'
      if (!form.phone.trim())      e.phone = 'Required'
    }
    if (s === 1) {
      if (!form.property_type)                                           e.property_type = 'Required'
      if (!form.village_code && !form.location.trim())                  e.location = 'Required'
      if (form.available_from_type === 'specific' && !form.available_from_date) e.available_from_date = 'Required'
    }
    if (s === 2) {
      const commercial = isCommercial(form.property_type)
      const rent = form.listing_type === 'For Rent' || form.listing_type === 'Both'
      const sale = form.listing_type === 'For Sale' || form.listing_type === 'Both'
      if (rent && !form.price_rent) e.price_rent = 'Required'
      if (sale && !form.price_sale) e.price_sale = 'Required'
      if (commercial) {
        if (!form.size_sqm) e.size_sqm = 'Required'
      } else {
        if (!form.bedrooms)  e.bedrooms  = 'Required'
        if (!form.bathrooms) e.bathrooms = 'Required'
      }
    }
    if (s === 4) {
      if (!form.description.trim())                    e.description = 'Required'
      else if (form.description.trim().length < 30)    e.description = 'Minimum 30 characters'
      else if (form.description.trim().length > 2000)  e.description = 'Maximum 2000 characters'
    }
    return e
  }

  function next() {
    const e = validateStep(step)
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({})
    setStep(s => Math.min(s + 1, TOTAL_STEPS - 1))
  }

  function back() {
    setErrors({})
    setStep(s => Math.max(s - 1, 0))
  }

  // ── Photo upload ───────────────────────────────────────────────────────────

  async function handlePhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setUploadErr('')
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('photos', f))
      const res = await fetch('/api/property-submit/photos', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      set('photos', [...form.photos, ...data.photos] as typeof form.photos)
    } catch (err: unknown) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function removePhoto(url: string) {
    set('photos', form.photos.filter(p => p.url !== url) as typeof form.photos)
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function submit() {
    const e = validateStep(4)
    if (Object.keys(e).length) { setErrors(e); return }

    setSubmitting(true)
    try {
      const availableFrom = form.available_from_type === 'specific'
        ? form.available_from_date
        : form.available_from_type === 'now'
          ? new Date().toISOString().slice(0, 10)
          : null

      const bedroomsVal  = form.bedrooms  === 'Other' ? (form.bedrooms_other  || null) : (form.bedrooms  || null)
      const bathroomsVal = form.bathrooms === 'Other' ? (form.bathrooms_other || null) : (form.bathrooms || null)
      const autoTitle    = generateTitle(form)

      const payload = {
        submitter_type:          'landlord',
        owner_name:              form.owner_name.trim(),
        owner_phone:             `${form.dial}${form.phone}`.trim(),
        owner_email:             form.owner_email || null,
        preferred_contact:       form.preferred_contact,
        property_type:           form.property_type || null,
        listing_type:            form.listing_type,
        village_code:            form.village_code || null,
        location:                form.village_display || form.location.trim() || null,
        bedrooms:                bedroomsVal,
        bathrooms:               bathroomsVal,
        size_sqm:                form.size_sqm !== '' ? parseInt(form.size_sqm) : null,
        price_rent:              form.price_rent !== '' ? parseInt(form.price_rent) : null,
        price_sale:              form.price_sale !== '' ? parseInt(form.price_sale) : null,
        available_from_type:     form.available_from_type,
        available_from_date:     availableFrom,
        available_from_comment:  form.available_from_comment || null,
        furnished:               form.shell_form ? null : form.furnished,
        shell_form:              form.shell_form,
        features:                form.features,
        furniture_style:         form.shell_form ? null : form.furniture_style,
        description:             form.description.trim(),
        notes:                   form.notes.trim() || null,
        photos:                  form.photos,
        preferred_viewing_times: form.preferred_viewing_times.trim() || null,
        title:                   form.title.trim() || autoTitle || null,
      }

      const res = await fetch('/api/public/property-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setDone(true)
      } else {
        alert(data.error || 'Something went wrong. Please try again.')
      }
    } catch {
      alert('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setForm(defaultForm)
    setStep(0)
    setErrors({})
    setDone(false)
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const isForSale  = form.listing_type === 'For Sale' || form.listing_type === 'Both'
  const isForRent  = form.listing_type === 'For Rent' || form.listing_type === 'Both'
  const commercial = isCommercial(form.property_type)

  // ── Success screen ────────────────────────────────────────────────────────

  if (done) {
    return (
      <div className="text-center py-10">
        <div className="w-16 h-16 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="w-8 h-8 text-gold" />
        </div>
        <h3 className="font-serif text-2xl text-navy mb-2">Property Submitted!</h3>
        <p className="text-navy/50 text-sm mb-6">
          We&apos;ll review your listing and be in touch within 24 hours.
        </p>
        <button onClick={reset}
          className="px-6 py-2.5 bg-navy text-white text-sm rounded hover:opacity-90 transition-opacity">
          Submit Another
        </button>
      </div>
    )
  }

  return (
    <div>
      {/* Progress bar */}
      <div className="flex gap-1 mb-6">
        {STEPS.map((_, i) => (
          <div key={i} className={cn('flex-1 h-1 rounded-full transition-all', i <= step ? 'bg-gold' : 'bg-navy/10')} />
        ))}
      </div>
      <p className="text-xs text-navy/40 -mt-4 mb-6">
        Step {step + 1} of {TOTAL_STEPS} — {STEPS[step]}
      </p>

      <AnimatePresence mode="wait">

        {/* ── Step 0: Your Details ── */}
        {step === 0 && (
          <motion.div key="s0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
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
              <input type="email" value={form.owner_email} onChange={e => set('owner_email', e.target.value)}
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

        {/* ── Step 1: Type & Location ── */}
        {step === 1 && (
          <motion.div key="s1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
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

            <Field label="Village / Town" required error={errors.location}>
              <SingleVillageSelector
                value={form.village_code}
                onChange={(code, display) => {
                  setForm(prev => ({ ...prev, village_code: code, village_display: display || '', location: display || '' }))
                  setErrors(prev => { const e = { ...prev }; delete e.location; return e })
                }}
                placeholder="Search village or town…"
              />
              {errors.location && <p className="text-xs text-red-400 mt-1">{errors.location}</p>}
            </Field>

            <Field label="Available From" error={errors.available_from_date}>
              <div className="flex gap-2 mb-2">
                {([
                  { key: 'now',      label: 'Now' },
                  { key: 'specific', label: 'Specific date' },
                  { key: 'other',    label: 'Other' },
                ] as const).map(opt => (
                  <button key={opt.key} type="button"
                    onClick={() => set('available_from_type', opt.key)}
                    className={cn('px-3 py-1.5 rounded border text-sm transition-all',
                      form.available_from_type === opt.key
                        ? 'border-gold bg-gold/10 text-navy font-medium'
                        : 'border-navy/15 text-navy/50 hover:border-navy/30')}>
                    {opt.label}
                  </button>
                ))}
              </div>
              {form.available_from_type === 'specific' && (
                <input type="date" value={form.available_from_date}
                  onChange={e => set('available_from_date', e.target.value)}
                  className={inputCls(errors.available_from_date)} />
              )}
              {form.available_from_type === 'other' && (
                <input type="text" value={form.available_from_comment}
                  onChange={e => set('available_from_comment', e.target.value)}
                  placeholder="e.g. After renovation, End of summer…"
                  className={inputCls()} />
              )}
              {form.available_from_type === 'now' && (
                <p className="text-xs text-navy/35">Available immediately — today&apos;s date will be used.</p>
              )}
            </Field>
          </motion.div>
        )}

        {/* ── Step 2: Details ── */}
        {step === 2 && (
          <motion.div key="s2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
            <Field label="Listing Type" required>
              <div className="flex gap-2">
                {(['For Rent', 'For Sale', 'Both'] as const).map(t => (
                  <button key={t} type="button" onClick={() => set('listing_type', t)}
                    className={cn('flex-1 py-2 rounded-lg border text-sm font-medium transition-all',
                      form.listing_type === t ? 'border-gold bg-gold/10 text-navy' : 'border-navy/15 text-navy/50 hover:border-navy/30')}>
                    {t}
                  </button>
                ))}
              </div>
            </Field>

            {!commercial && (
              <>
                <Field label="Bedrooms" required error={errors.bedrooms}>
                  <div className="flex flex-wrap gap-2">
                    {BED_BATH_OPTIONS.map(b => (
                      <button key={b} type="button" onClick={() => set('bedrooms', b)}
                        className={cn('px-3 py-1.5 rounded border text-sm transition-all',
                          form.bedrooms === b ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                  </div>
                  {form.bedrooms === 'Other' && (
                    <input type="number" min="1" max="50" value={form.bedrooms_other}
                      onChange={e => set('bedrooms_other', e.target.value)}
                      placeholder="Enter number…"
                      className="mt-2 w-32 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                  )}
                </Field>

                <Field label="Bathrooms" required error={errors.bathrooms}>
                  <div className="flex flex-wrap gap-2">
                    {BED_BATH_OPTIONS.map(b => (
                      <button key={b} type="button" onClick={() => set('bathrooms', b)}
                        className={cn('px-3 py-1.5 rounded border text-sm transition-all',
                          form.bathrooms === b ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                  </div>
                  {form.bathrooms === 'Other' && (
                    <input type="number" min="1" max="20" value={form.bathrooms_other}
                      onChange={e => set('bathrooms_other', e.target.value)}
                      placeholder="Enter number…"
                      className="mt-2 w-32 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                  )}
                </Field>
              </>
            )}

            <Field label={commercial ? 'Size (m²) *' : 'Size (m²)'} error={errors.size_sqm}>
              <input type="number" value={form.size_sqm} onChange={e => set('size_sqm', e.target.value)}
                placeholder="e.g. 85" className={inputCls(errors.size_sqm)} />
            </Field>

            {isForRent && (
              <Field label="Monthly Rent (€)" required error={errors.price_rent}>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40">€</span>
                  <input type="number" value={form.price_rent} onChange={e => set('price_rent', e.target.value)}
                    placeholder="1500" className={cn(inputCls(errors.price_rent), 'pl-8')} />
                </div>
              </Field>
            )}

            {isForSale && (
              <Field label="Sale Price (€)" required error={errors.price_sale}>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40">€</span>
                  <input type="number" value={form.price_sale} onChange={e => set('price_sale', e.target.value)}
                    placeholder="250000" className={cn(inputCls(errors.price_sale), 'pl-8')} />
                </div>
              </Field>
            )}

            {isForSale && (
              <label className="flex items-center gap-3 p-3 border border-navy/10 rounded-lg cursor-pointer hover:bg-navy/[0.02] transition-colors">
                <input type="checkbox" checked={form.shell_form}
                  onChange={e => set('shell_form', e.target.checked as unknown as typeof form.shell_form)}
                  className="w-4 h-4 accent-gold" />
                <span className="text-sm text-navy">
                  Shell Form
                  <span className="text-navy/40 text-xs ml-2">— buyer finishes interior</span>
                </span>
              </label>
            )}

            {!form.shell_form && !commercial && (
              <Field label="Furnished">
                <div className="flex flex-wrap gap-2">
                  {['Fully Furnished', 'Semi Furnished', 'Unfurnished'].map(f => (
                    <Chip key={f} active={form.furnished === f} onClick={() => set('furnished', f)}>{f}</Chip>
                  ))}
                </div>
              </Field>
            )}
          </motion.div>
        )}

        {/* ── Step 3: Features ── */}
        {step === 3 && (
          <motion.div key="s3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
            <Field label="Features & Amenities">
              <div className="flex flex-wrap gap-2">
                {FEATURES.map(f => (
                  <Chip key={f.key} active={form.features.includes(f.key)} onClick={() => toggleFeature(f.key)}>
                    {f.label}
                  </Chip>
                ))}
              </div>
            </Field>

            {!form.shell_form && (
              <Field label="Furniture Style">
                <div className="flex flex-wrap gap-2">
                  {FURNITURE_STYLES.map(s => (
                    <Chip key={s} active={form.furniture_style === s} onClick={() => set('furniture_style', s)}>{s}</Chip>
                  ))}
                </div>
              </Field>
            )}
          </motion.div>
        )}

        {/* ── Step 4: Description & Photos ── */}
        {step === 4 && (
          <motion.div key="s4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
            <Field label="Description" required error={errors.description}>
              <textarea
                value={form.description}
                onChange={e => set('description', e.target.value)}
                rows={5}
                maxLength={2000}
                placeholder="Describe your property in detail — location highlights, condition, special features..."
                className={cn(inputCls(errors.description), 'resize-none')}
              />
              <div className="flex justify-between mt-1">
                {form.description.length > 0 && form.description.length < 30
                  ? <span className="text-xs text-orange-400">{30 - form.description.length} more chars needed</span>
                  : <span />}
                <span className="text-xs text-navy/35 ml-auto">{form.description.length}/2000</span>
              </div>
            </Field>

            <Field label="Photos (optional)">
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => handlePhotos(e.target.files)} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                className="w-full border-2 border-dashed border-navy/15 rounded-lg py-8 flex flex-col items-center gap-2 text-navy/40 hover:border-gold/40 hover:text-navy/60 transition-all disabled:opacity-50">
                <Upload className="w-6 h-6" />
                <span className="text-sm">{uploading ? 'Uploading…' : 'Click to upload photos'}</span>
                <span className="text-xs">JPEG, PNG, WebP • Max 10 files</span>
              </button>
              {uploadErr && <p className="text-xs text-red-400 mt-1">{uploadErr}</p>}
              {form.photos.length > 0 && (
                <div className="grid grid-cols-3 gap-2 mt-3">
                  {form.photos.map(p => (
                    <div key={p.url} className="relative aspect-square rounded-lg overflow-hidden group">
                      <Image src={p.thumbnail || p.url} alt="" fill className="object-cover" />
                      <button type="button" onClick={() => removePhoto(p.url)}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Field>

            <Field label="Preferred Viewing Times (optional)">
              <textarea value={form.preferred_viewing_times}
                onChange={e => set('preferred_viewing_times', e.target.value)}
                rows={2} maxLength={200}
                placeholder="e.g. Weekends only, Evenings after 18:00, Flexible"
                className={cn(inputCls(), 'resize-none')} />
              <p className="text-xs text-navy/35 mt-1 text-right">{form.preferred_viewing_times.length}/200</p>
            </Field>
          </motion.div>
        )}

        {/* ── Step 5: Review ── */}
        {step === 5 && (
          <motion.div key="s5" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
            <Field label="Property Title">
              <input type="text" value={form.title} onChange={e => set('title', e.target.value)}
                placeholder="Auto-generated from property details"
                className={inputCls()} />
              <p className="text-xs text-navy/35 mt-1">Pre-filled automatically — edit if needed</p>
            </Field>

            <h3 className="text-sm font-medium text-navy">Review your submission</h3>

            <div>
              <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Your Details</p>
              <ReviewRow label="Name"    value={form.owner_name} />
              <ReviewRow label="Phone"   value={`${form.dial}${form.phone}`} />
              <ReviewRow label="Email"   value={form.owner_email || undefined} />
              <ReviewRow label="Contact" value={form.preferred_contact} />
            </div>

            <div>
              <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Property</p>
              <ReviewRow label="Type"      value={form.property_type} />
              <ReviewRow label="Listing"   value={form.listing_type} />
              <ReviewRow label="Location"  value={form.village_display || form.location} />
              <ReviewRow label="Available" value={
                form.available_from_type === 'now'      ? 'Now' :
                form.available_from_type === 'specific' ? form.available_from_date :
                form.available_from_comment || 'Other'
              } />
              {!commercial && <ReviewRow label="Bedrooms"  value={form.bedrooms === 'Other' ? form.bedrooms_other : form.bedrooms} />}
              {!commercial && <ReviewRow label="Bathrooms" value={form.bathrooms === 'Other' ? form.bathrooms_other : form.bathrooms} />}
              <ReviewRow label="Size"      value={form.size_sqm ? `${form.size_sqm} m²` : undefined} />
              {isForRent && <ReviewRow label="Rent/mo"    value={form.price_rent ? `€${Number(form.price_rent).toLocaleString()}` : undefined} />}
              {isForSale && <ReviewRow label="Sale Price" value={form.price_sale ? `€${Number(form.price_sale).toLocaleString()}` : undefined} />}
              {form.shell_form && <ReviewRow label="Shell Form" value="Yes" />}
              {!form.shell_form && !commercial && <ReviewRow label="Furnished" value={form.furnished} />}
              {!form.shell_form && <ReviewRow label="Style" value={form.furniture_style} />}
              {form.features.length > 0 && <ReviewRow label="Features" value={form.features.join(', ')} />}
            </div>

            {form.description && (
              <div>
                <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Description</p>
                <p className="text-sm text-navy/70 leading-relaxed">{form.description}</p>
              </div>
            )}

            {(form.notes || form.preferred_viewing_times) && (
              <div>
                <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Notes</p>
                <ReviewRow label="Viewing Times" value={form.preferred_viewing_times || undefined} />
              </div>
            )}

            {form.photos.length > 0 && (
              <div>
                <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Photos ({form.photos.length})</p>
                <div className="grid grid-cols-4 gap-2">
                  {form.photos.slice(0, 8).map(p => (
                    <div key={p.url} className="aspect-square rounded-lg overflow-hidden">
                      <Image src={p.thumbnail || p.url} alt="" width={80} height={80} className="object-cover w-full h-full" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}

      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between mt-8 pt-6 border-t border-navy/5">
        <button type="button" onClick={back} disabled={step === 0}
          className="flex items-center gap-1.5 text-sm text-navy/40 hover:text-navy disabled:opacity-0 transition-colors">
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        {step < TOTAL_STEPS - 1 ? (
          <button type="button" onClick={next}
            className="flex items-center gap-1.5 px-5 py-2.5 bg-navy text-white text-sm rounded-lg hover:bg-navy/80 transition-colors">
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={submitting}
            className="flex items-center gap-1.5 px-6 py-2.5 bg-gold text-white text-sm font-medium rounded-lg hover:bg-gold/80 transition-colors disabled:opacity-50">
            {submitting ? 'Submitting…' : 'Submit Property'}
            {!submitting && <Check className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  )
}
