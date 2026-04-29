'use client'

import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
import { Check, X, Upload, ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import Image from 'next/image'

// ── Constants ─────────────────────────────────────────────────────────────────

const PROPERTY_TYPES = [
  'Apartment', 'Penthouse', 'Maisonette', 'Townhouse', 'Villa',
  'Farmhouse', 'House of Character', 'Office', 'Retail', 'Warehouse', 'Land',
]

const REGIONS = ['Central Malta', 'Northern Malta', 'Southern Malta', 'Western Malta', 'Gozo', 'Comino']

const LOCATION_GROUPS = [
  { label: 'Central', items: ["Sliema", "St Julian's", "Gzira", "Msida", "Pieta", "Ta' Xbiex", "Swieqi", "Pembroke", "Madliena", "San Gwann", "Birkirkara"] },
  { label: 'North',   items: ["Mellieha", "Bugibba", "Qawra", "St Paul's Bay", "Mosta", "Naxxar", "Gharghur", "Attard", "Balzan", "Lija", "Iklin"] },
  { label: 'South',   items: ["Marsaskala", "Birzebbuga", "Zebbug", "Zejtun", "Valletta", "Floriana"] },
  { label: 'West',    items: ["Rabat", "Mdina", "Mtarfa", "Dingli", "Siggiewi"] },
  { label: 'Gozo',    items: ["Victoria", "Marsalforn", "Xlendi", "Nadur"] },
]

const FEATURES = [
  { key: 'ac',         label: 'A/C' },
  { key: 'balcony',    label: 'Balcony' },
  { key: 'concierge',  label: 'Concierge' },
  { key: 'fireplace',  label: 'Fireplace' },
  { key: 'furnished',  label: 'Furnished' },
  { key: 'garage',     label: 'Garage' },
  { key: 'garden',     label: 'Garden' },
  { key: 'gym',        label: 'Gym' },
  { key: 'jacuzzi',    label: 'Jacuzzi' },
  { key: 'lift',       label: 'Lift' },
  { key: 'parking',    label: 'Parking' },
  { key: 'pets_ok',    label: 'Pet Friendly' },
  { key: 'pool',       label: 'Pool' },
  { key: 'rooftop',    label: 'Rooftop' },
  { key: 'sea_view',   label: 'Sea View' },
  { key: 'seafront',   label: 'Seafront' },
  { key: 'terrace',    label: 'Terrace' },
]

const AGENTS = ['Kevin', 'Olga', 'Inna', 'Oleg', 'Kevin Christian', 'Anselme', 'Isabel', 'Tatyana', 'Kseniia', 'Julia', 'Other']

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1', flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34', flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+41', flag: '🇨🇭' },
  { code: '+43', flag: '🇦🇹' }, { code: '+7', flag: '🇷🇺' }, { code: '+971', flag: '🇦🇪' },
  { code: '+91', flag: '🇮🇳' }, { code: '+86', flag: '🇨🇳' }, { code: '+61', flag: '🇦🇺' },
]

const STEPS = ['Type', 'Details', 'Location', 'Pricing', 'Features', 'Photos', 'Submitter']
const TOTAL_STEPS = STEPS.length

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

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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
    'w-full px-4 py-2.5 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold',
    err ? 'border-red-400' : 'border-navy/15'
  )
}

// ── Default state ─────────────────────────────────────────────────────────────

const defaultForm = {
  submitter_type: 'agent' as 'agent' | 'landlord',
  listing_type: 'To Rent' as 'To Rent' | 'For Sale',
  property_type: '',
  bedrooms: '' as string,
  bathrooms: '' as string,
  size_sqm: '',
  region: '',
  location: '',
  price_rent: '',
  price_sale: '',
  available_from: '',
  furnished: 'unfurnished' as string,
  features: [] as string[],
  description: '',
  photos: [] as { url: string; thumbnail: string }[],
  submitter_name: '',
  submitter_phone: '',
  submitter_dial: '+356',
  submitter_email: '',
  preferred_contact: 'whatsapp' as string,
  lead_agent: 'Kevin',
  lead_agent_other: '',
  internal_notes: '',
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AddPropertyPage() {
  const [form, setForm] = useState(defaultForm)
  const [step, setStep] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState('')
  const [done, setDone] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key]; return e })
  }, [])

  const toggleFeature = (k: string) => {
    set('features', (form.features.includes(k)
      ? form.features.filter(f => f !== k)
      : [...form.features, k]) as typeof form.features)
  }

  // ── Per-step validation ────────────────────────────────────────────────────

  function validateStep(s: number): Record<string, string> {
    const e: Record<string, string> = {}
    if (s === 0) {
      if (!form.property_type) e.property_type = 'Required'
    }
    if (s === 1) {
      // bedrooms optional for commercial/land
    }
    if (s === 2) {
      if (!form.location.trim()) e.location = 'Required'
    }
    if (s === 3) {
      if (form.listing_type === 'To Rent' && !form.price_rent) e.price_rent = 'Required'
      if (form.listing_type === 'For Sale' && !form.price_sale) e.price_sale = 'Required'
    }
    if (s === 6) {
      if (form.submitter_type === 'landlord') {
        if (!form.submitter_name.trim()) e.submitter_name = 'Required'
        if (!form.submitter_email.trim()) e.submitter_email = 'Required'
        if (!form.submitter_phone.trim()) e.submitter_phone = 'Required'
      } else {
        if (!form.lead_agent) e.lead_agent = 'Required'
        if (form.lead_agent === 'Other' && !form.lead_agent_other.trim()) e.lead_agent_other = 'Required'
      }
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
    const e = validateStep(6)
    if (Object.keys(e).length) { setErrors(e); return }
    setSubmitting(true)
    try {
      const agentName = form.lead_agent === 'Other' ? form.lead_agent_other : form.lead_agent
      const payload = {
        submitter_type: form.submitter_type,
        listing_type: form.listing_type,
        property_type: form.property_type || null,
        bedrooms: form.bedrooms !== '' ? parseInt(form.bedrooms) : null,
        bathrooms: form.bathrooms !== '' ? parseInt(form.bathrooms) : null,
        size_sqm: form.size_sqm !== '' ? parseInt(form.size_sqm) : null,
        region: form.region || null,
        location: form.location.trim() || null,
        price_rent: form.price_rent !== '' ? parseInt(form.price_rent) : null,
        price_sale: form.price_sale !== '' ? parseInt(form.price_sale) : null,
        available_from: form.available_from || null,
        furnished: form.furnished,
        features: form.features,
        description: form.description.trim() || null,
        photos: form.photos,
        submitter_name: form.submitter_name.trim() || null,
        submitter_phone: form.submitter_phone.trim()
          ? `${form.submitter_dial}${form.submitter_phone.trim()}`
          : null,
        submitter_email: form.submitter_email.trim() || null,
        preferred_contact: form.preferred_contact,
        lead_agent: form.submitter_type === 'agent' ? agentName : null,
        internal_notes: form.internal_notes.trim() || null,
      }
      const res = await fetch('/api/property-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok) {
        setDone(true)
        setToast('Property submitted successfully!')
        setTimeout(() => setToast(''), 5000)
      } else {
        alert(data.error || 'Something went wrong')
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <meta name="robots" content="noindex,nofollow" />
      <main className="min-h-screen bg-off-white">
        <Header />

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-navy text-white px-5 py-3 rounded-lg shadow-lg flex items-center gap-2 text-sm"
            >
              <Check className="w-4 h-4 text-gold" />
              {toast}
            </motion.div>
          )}
        </AnimatePresence>

        <section className="pt-28 pb-16">
          <div className="container mx-auto px-4 lg:px-8 max-w-3xl">

            {/* Header */}
            <div className="mb-8">
              <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">2906 Internal</p>
              <h1 className="font-serif text-3xl text-navy">Submit Property</h1>
              <p className="text-navy/50 text-sm mt-1">
                {form.submitter_type === 'landlord' ? 'Landlord property submission' : 'Agent property intake'}
              </p>
            </div>

            {/* Done screen */}
            {done ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-xl border border-navy/5 shadow-sm p-10 text-center"
              >
                <div className="w-16 h-16 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Check className="w-8 h-8 text-gold" />
                </div>
                <h2 className="font-serif text-2xl text-navy mb-2">Property Submitted</h2>
                <p className="text-navy/50 text-sm mb-6">
                  {form.submitter_type === 'landlord'
                    ? 'We\'ll review your property and get back to you within 24 hours.'
                    : 'Property saved and team notified.'}
                </p>
                <button
                  onClick={reset}
                  className="px-6 py-2.5 bg-navy text-white text-sm rounded-lg hover:bg-navy/80 transition-colors"
                >
                  Submit Another
                </button>
              </motion.div>
            ) : (
              <div className="bg-white rounded-xl border border-navy/5 shadow-sm p-6 md:p-8">

                {/* Submitter type toggle */}
                <div className="flex gap-2 mb-6">
                  {(['agent', 'landlord'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => set('submitter_type', t)}
                      className={cn(
                        'flex-1 py-2 rounded-lg border text-sm font-medium transition-all',
                        form.submitter_type === t
                          ? 'border-gold bg-gold/10 text-navy'
                          : 'border-navy/15 text-navy/50 hover:border-navy/30'
                      )}
                    >
                      {t === 'agent' ? '👤 Agent Intake' : '🏠 Landlord Form'}
                    </button>
                  ))}
                </div>

                {/* Step progress */}
                <div className="flex items-center gap-1 mb-8">
                  {STEPS.map((label, i) => (
                    <div key={i} className="flex items-center gap-1 flex-1">
                      <div className={cn(
                        'flex-1 h-1 rounded-full transition-all',
                        i <= step ? 'bg-gold' : 'bg-navy/10'
                      )} />
                      {i === STEPS.length - 1 && null}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-navy/40 -mt-6 mb-6">
                  Step {step + 1} of {TOTAL_STEPS} — {STEPS[step]}
                </p>

                {/* ── Step 0: Type ── */}
                <AnimatePresence mode="wait">
                  {step === 0 && (
                    <motion.div key="step0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Listing Type" required>
                        <div className="flex gap-2">
                          {(['To Rent', 'For Sale'] as const).map(t => (
                            <button key={t} type="button" onClick={() => set('listing_type', t)}
                              className={cn('flex-1 py-2 rounded-lg border text-sm font-medium transition-all',
                                form.listing_type === t ? 'border-gold bg-gold/10 text-navy' : 'border-navy/15 text-navy/50 hover:border-navy/30')}>
                              {t}
                            </button>
                          ))}
                        </div>
                      </Field>
                      <Field label="Property Type" required error={errors.property_type}>
                        <div className="flex flex-wrap gap-2">
                          {PROPERTY_TYPES.map(t => (
                            <Chip key={t} active={form.property_type === t} onClick={() => set('property_type', t)}>{t}</Chip>
                          ))}
                        </div>
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 1: Details ── */}
                  {step === 1 && (
                    <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <div className="grid grid-cols-3 gap-4">
                        <Field label="Bedrooms">
                          <select value={form.bedrooms} onChange={e => set('bedrooms', e.target.value)} className={inputCls()}>
                            <option value="">—</option>
                            {['0', '1', '2', '3', '4', '5', '6+'].map(n => <option key={n} value={n}>{n === '0' ? 'Studio' : n}</option>)}
                          </select>
                        </Field>
                        <Field label="Bathrooms">
                          <select value={form.bathrooms} onChange={e => set('bathrooms', e.target.value)} className={inputCls()}>
                            <option value="">—</option>
                            {['1', '2', '3', '4', '5+'].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </Field>
                        <Field label="Size (m²)">
                          <input type="number" value={form.size_sqm} onChange={e => set('size_sqm', e.target.value)}
                            placeholder="e.g. 85" className={inputCls()} />
                        </Field>
                      </div>
                      <Field label="Furnished">
                        <div className="flex flex-wrap gap-2">
                          {['furnished', 'part-furnished', 'unfurnished'].map(f => (
                            <Chip key={f} active={form.furnished === f} onClick={() => set('furnished', f)}>
                              {f.charAt(0).toUpperCase() + f.slice(1)}
                            </Chip>
                          ))}
                        </div>
                      </Field>
                      <Field label="Available From">
                        <input type="date" value={form.available_from} onChange={e => set('available_from', e.target.value)} className={inputCls()} />
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 2: Location ── */}
                  {step === 2 && (
                    <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Region">
                        <div className="flex flex-wrap gap-2">
                          {REGIONS.map(r => (
                            <Chip key={r} active={form.region === r} onClick={() => set('region', r)}>{r}</Chip>
                          ))}
                        </div>
                      </Field>
                      <Field label="Town / Area" required error={errors.location}>
                        <div className="space-y-3">
                          <input type="text" value={form.location} onChange={e => set('location', e.target.value)}
                            placeholder="e.g. Sliema" className={inputCls(errors.location)} />
                          <div className="space-y-2">
                            {LOCATION_GROUPS.map(g => (
                              <div key={g.label}>
                                <p className="text-xs text-navy/30 mb-1">{g.label}</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {g.items.map(loc => (
                                    <button key={loc} type="button"
                                      onClick={() => set('location', loc)}
                                      className={cn('text-xs px-2 py-0.5 rounded border transition-all',
                                        form.location === loc
                                          ? 'border-gold bg-gold/10 text-navy font-medium'
                                          : 'border-navy/10 text-navy/40 hover:border-navy/25')}>
                                      {loc}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 3: Pricing ── */}
                  {step === 3 && (
                    <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      {form.listing_type === 'To Rent' ? (
                        <Field label="Monthly Rent (€)" required error={errors.price_rent}>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40">€</span>
                            <input type="number" value={form.price_rent} onChange={e => set('price_rent', e.target.value)}
                              placeholder="1500" className={cn(inputCls(errors.price_rent), 'pl-8')} />
                          </div>
                        </Field>
                      ) : (
                        <Field label="Sale Price (€)" required error={errors.price_sale}>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40">€</span>
                            <input type="number" value={form.price_sale} onChange={e => set('price_sale', e.target.value)}
                              placeholder="250000" className={cn(inputCls(errors.price_sale), 'pl-8')} />
                          </div>
                        </Field>
                      )}
                      <Field label="Description">
                        <textarea value={form.description} onChange={e => set('description', e.target.value)}
                          rows={4} placeholder="Brief description of the property..."
                          className={cn(inputCls(), 'resize-none')} />
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 4: Features ── */}
                  {step === 4 && (
                    <motion.div key="step4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Features & Amenities">
                        <div className="flex flex-wrap gap-2">
                          {FEATURES.map(f => (
                            <Chip key={f.key} active={form.features.includes(f.key)} onClick={() => toggleFeature(f.key)}>
                              {f.label}
                            </Chip>
                          ))}
                        </div>
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 5: Photos ── */}
                  {step === 5 && (
                    <motion.div key="step5" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Photos (optional)">
                        <div>
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
                              {form.photos.map((p) => (
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
                        </div>
                      </Field>
                      {form.submitter_type === 'agent' && (
                        <Field label="Internal Notes">
                          <textarea value={form.internal_notes} onChange={e => set('internal_notes', e.target.value)}
                            rows={3} placeholder="Notes for internal use..."
                            className={cn(inputCls(), 'resize-none')} />
                        </Field>
                      )}
                    </motion.div>
                  )}

                  {/* ── Step 6: Submitter ── */}
                  {step === 6 && (
                    <motion.div key="step6" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      {form.submitter_type === 'landlord' ? (
                        <>
                          <Field label="Your Name" required error={errors.submitter_name}>
                            <input type="text" value={form.submitter_name} onChange={e => set('submitter_name', e.target.value)}
                              placeholder="Maria Borg" className={inputCls(errors.submitter_name)} />
                          </Field>
                          <Field label="Email Address" required error={errors.submitter_email}>
                            <input type="email" value={form.submitter_email} onChange={e => set('submitter_email', e.target.value)}
                              placeholder="maria@example.com" className={inputCls(errors.submitter_email)} />
                          </Field>
                          <Field label="Phone Number" required error={errors.submitter_phone}>
                            <div className="flex gap-2">
                              <select value={form.submitter_dial} onChange={e => set('submitter_dial', e.target.value)}
                                className="border border-navy/15 rounded text-navy px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40">
                                {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                              </select>
                              <input type="tel" value={form.submitter_phone} onChange={e => set('submitter_phone', e.target.value)}
                                placeholder="79000000" className={cn(inputCls(errors.submitter_phone), 'flex-1')} />
                            </div>
                          </Field>
                          <Field label="Preferred Contact">
                            <div className="flex gap-2">
                              {['whatsapp', 'call', 'email'].map(c => (
                                <Chip key={c} active={form.preferred_contact === c} onClick={() => set('preferred_contact', c)}>
                                  {c.charAt(0).toUpperCase() + c.slice(1)}
                                </Chip>
                              ))}
                            </div>
                          </Field>
                        </>
                      ) : (
                        <>
                          <Field label="Lead Agent" required error={errors.lead_agent}>
                            <div className="flex flex-wrap gap-2">
                              {AGENTS.map(a => (
                                <Chip key={a} active={form.lead_agent === a} onClick={() => set('lead_agent', a)}>{a}</Chip>
                              ))}
                            </div>
                          </Field>
                          {form.lead_agent === 'Other' && (
                            <Field label="Agent Name" required error={errors.lead_agent_other}>
                              <input type="text" value={form.lead_agent_other} onChange={e => set('lead_agent_other', e.target.value)}
                                placeholder="Agent name" className={inputCls(errors.lead_agent_other)} />
                            </Field>
                          )}
                          <Field label="Owner Contact Name">
                            <input type="text" value={form.submitter_name} onChange={e => set('submitter_name', e.target.value)}
                              placeholder="Owner name (if known)" className={inputCls()} />
                          </Field>
                          <Field label="Owner Phone">
                            <div className="flex gap-2">
                              <select value={form.submitter_dial} onChange={e => set('submitter_dial', e.target.value)}
                                className="border border-navy/15 rounded text-navy px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40">
                                {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                              </select>
                              <input type="tel" value={form.submitter_phone} onChange={e => set('submitter_phone', e.target.value)}
                                placeholder="79000000" className={cn(inputCls(), 'flex-1')} />
                            </div>
                          </Field>
                        </>
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
            )}
          </div>
        </section>
      </main>
    </>
  )
}
