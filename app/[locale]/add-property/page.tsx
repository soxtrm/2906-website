'use client'

import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
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
      'Detached Villa', 'Semi-detached Villa', 'Farmhouse',
    ],
  },
  {
    label: 'Special',
    types: ['Boathouse', 'Garage'],
  },
  {
    label: 'Commercial',
    types: ['Office', 'Retail', 'Commercial Garage', 'Restaurant/Canteen', 'Gym'],
  },
]

const REGIONS = [
  'Central Malta', 'Northern Malta', 'Southern Malta',
  'Western Malta', 'Valletta', 'Gozo', 'Comino',
]

const LOCATION_GROUPS = [
  { label: 'Central', items: ["Sliema", "St Julian's", "Gzira", "Msida", "Pieta", "Ta' Xbiex", "Swieqi", "Pembroke", "Madliena", "San Gwann", "Birkirkara"] },
  { label: 'North',   items: ["Mellieha", "Bugibba", "Qawra", "St Paul's Bay", "Mosta", "Naxxar", "Gharghur", "Attard", "Balzan", "Lija", "Iklin"] },
  { label: 'South',   items: ["Marsaskala", "Birzebbuga", "Zebbug", "Zejtun", "Valletta", "Floriana"] },
  { label: 'West',    items: ["Rabat", "Mdina", "Mtarfa", "Dingli", "Siggiewi"] },
  { label: 'Gozo',    items: ["Victoria", "Marsalforn", "Xlendi", "Nadur"] },
]

const FEATURES = [
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

const AGENTS = ['Kevin', 'Olga', 'Inna', 'Oleg', 'Kevin Christian', 'Anselme', 'Isabel', 'Tatyana', 'Kseniia', 'Julia', 'Other']

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1',   flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34',  flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+41', flag: '🇨🇭' },
  { code: '+43',  flag: '🇦🇹' }, { code: '+7',  flag: '🇷🇺' }, { code: '+971', flag: '🇦🇪' },
  { code: '+91',  flag: '🇮🇳' }, { code: '+86', flag: '🇨🇳' }, { code: '+61', flag: '🇦🇺' },
]

const STEPS = ['Contact', 'Type & Location', 'Details', 'Features', 'Photos', 'Review']
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

function Chip({ active, onClick, disabled, children }: {
  active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        'text-xs px-2.5 py-1 rounded-full border transition-all',
        active
          ? 'border-gold bg-gold/10 text-navy font-medium'
          : disabled
            ? 'border-navy/8 text-navy/20 cursor-not-allowed'
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
  submitter_type:          'agent' as 'agent' | 'landlord',
  lead_agent:              'Kevin',
  lead_agent_other:        '',
  owner_name:              '',
  submitter_phone:         '',
  submitter_dial:          '+356',
  submitter_email:         '',
  preferred_contact:       'whatsapp',
  property_type:           '',
  region:                  '',
  location:                '',
  viewings_from:           '',
  listing_type:            'For Rent',
  bedrooms:                '' as string,
  bathrooms:               '' as string,
  size_sqm:                '',
  price_rent:              '',
  price_sale:              '',
  available_from:          '',
  furnished:               'Fully Furnished',
  shell_form:              false,
  features:                [] as string[],
  furniture_style:         'Standard',
  description:             '',
  photos:                  [] as { url: string; thumbnail: string }[],
  notes:                   '',
  preferred_viewing_times: '',
  village_code:            null as string | null,
  village_display:         '',
  title:                   '',
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AddPropertyPage() {
  const [form, setForm]           = useState(defaultForm)
  const [step, setStep]           = useState(0)
  const [errors, setErrors]       = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast]         = useState('')
  const [done, setDone]           = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => {
      const next = { ...prev, [key]: val }
      // Auto-fill viewings_from from available_from when not yet set
      if (key === 'available_from' && !prev.viewings_from) {
        next.viewings_from = val as string
      }
      // Default furnished = Fully Furnished when switching to rental
      if (key === 'listing_type' && (val === 'For Rent' || val === 'Both')) {
        if (!prev.furnished || prev.furnished === 'Unfurnished') {
          next.furnished = 'Fully Furnished'
        }
      }
      return next
    })
    setErrors(prev => { const e = { ...prev }; delete e[key as string]; return e })
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
      if (form.submitter_type === 'agent') {
        if (!form.lead_agent) e.lead_agent = 'Required'
        if (form.lead_agent === 'Other' && !form.lead_agent_other.trim()) e.lead_agent_other = 'Required'
      } else {
        if (!form.owner_name.trim())      e.owner_name = 'Required'
        if (!form.submitter_phone.trim()) e.submitter_phone = 'Required'
      }
    }
    if (s === 1) {
      if (!form.property_type)        e.property_type = 'Required'
      if (!form.village_code && !form.location.trim()) e.location = 'Required'
      if (form.viewings_from && form.available_from && form.viewings_from > form.available_from) {
        e.viewings_from = 'Must be on or before Available From'
      }
    }
    if (s === 2) {
      const rent = form.listing_type === 'For Rent' || form.listing_type === 'Both'
      const sale = form.listing_type === 'For Sale' || form.listing_type === 'Both'
      if (rent && !form.price_rent) e.price_rent = 'Required'
      if (sale && !form.price_sale) e.price_sale = 'Required'
    }
    if (s === 4) {
      if (!form.description.trim())                    e.description = 'Required'
      else if (form.description.trim().length < 50)    e.description = 'Minimum 50 characters'
      else if (form.description.trim().length > 1000)  e.description = 'Maximum 1000 characters'
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
    setSubmitting(true)
    try {
      const agentName = form.lead_agent === 'Other' ? form.lead_agent_other : form.lead_agent
      const payload = {
        submitter_type:          form.submitter_type,
        lead_agent:              form.submitter_type === 'agent' ? agentName : null,
        owner_name:              form.owner_name || null,
        submitter_name:          form.owner_name || null,
        submitter_phone:         form.submitter_phone.trim()
                                   ? `${form.submitter_dial}${form.submitter_phone.trim()}` : null,
        submitter_email:         form.submitter_email.trim() || null,
        preferred_contact:       form.preferred_contact,
        property_type:           form.property_type || null,
        regions:                 [],
        location:                form.village_display || form.location.trim() || null,
        village_code:            form.village_code || null,
        title:                   form.title.trim() || (form.description.trim() ? form.description.trim().slice(0, 60) : null),
        viewings_from:           form.viewings_from || null,
        listing_type:            form.listing_type,
        bedrooms:                form.bedrooms !== '' ? parseInt(form.bedrooms) : null,
        bathrooms:               form.bathrooms !== '' ? parseInt(form.bathrooms) : null,
        size_sqm:                form.size_sqm !== '' ? parseInt(form.size_sqm) : null,
        price_rent:              form.price_rent !== '' ? parseInt(form.price_rent) : null,
        price_sale:              form.price_sale !== '' ? parseInt(form.price_sale) : null,
        available_from:          form.available_from || null,
        furnished:               form.shell_form ? null : form.furnished,
        shell_form:              form.shell_form,
        features:                form.features,
        furniture_style:         form.shell_form ? null : form.furniture_style,
        description:             form.description.trim() || null,
        photos:                  form.photos,
        notes:                   form.notes.trim() || null,
        preferred_viewing_times: form.preferred_viewing_times.trim() || null,
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

  const isForSale = form.listing_type === 'For Sale' || form.listing_type === 'Both'
  const isForRent = form.listing_type === 'For Rent' || form.listing_type === 'Both'
  const agentLabel = form.lead_agent === 'Other' ? (form.lead_agent_other || 'Other') : form.lead_agent

  return (
    <>
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
              <div className="flex items-center gap-2 mt-1">
                <p className="text-navy/50 text-sm">
                  {form.submitter_type === 'landlord' ? 'Landlord property submission' : 'Agent property intake'}
                </p>
                {step > 0 && (
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full border',
                    form.submitter_type === 'agent'
                      ? 'border-blue-300/50 bg-blue-50 text-blue-700'
                      : 'border-gold/30 bg-gold/5 text-gold'
                  )}>
                    {form.submitter_type === 'agent' ? `Agent: ${agentLabel}` : 'Landlord Form'}
                  </span>
                )}
              </div>
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
                    ? "We'll review your property and get back to you within 24 hours."
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

                {/* Step progress */}
                <div className="flex gap-1 mb-8">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={cn('flex-1 h-1 rounded-full transition-all', i <= step ? 'bg-gold' : 'bg-navy/10')}
                    />
                  ))}
                </div>
                <p className="text-xs text-navy/40 -mt-6 mb-6">
                  Step {step + 1} of {TOTAL_STEPS} — {STEPS[step]}
                </p>

                <AnimatePresence mode="wait">

                  {/* ── Step 0: Contact ── */}
                  {step === 0 && (
                    <motion.div key="step0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <div className="flex gap-2">
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

                      {form.submitter_type === 'agent' ? (
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
                              <input type="text" value={form.lead_agent_other}
                                onChange={e => set('lead_agent_other', e.target.value)}
                                placeholder="Agent name" className={inputCls(errors.lead_agent_other)} />
                            </Field>
                          )}
                          <p className="text-xs text-navy/40 bg-navy/[0.03] border border-navy/8 rounded-lg px-3 py-2">
                            Property will be marketed under your name.
                          </p>
                        </>
                      ) : (
                        <>
                          <Field label="Owner Name" required error={errors.owner_name}>
                            <input type="text" value={form.owner_name}
                              onChange={e => set('owner_name', e.target.value)}
                              placeholder="Maria Borg" className={inputCls(errors.owner_name)} />
                          </Field>
                          <Field label="Phone Number" required error={errors.submitter_phone}>
                            <div className="flex gap-2">
                              <select value={form.submitter_dial}
                                onChange={e => set('submitter_dial', e.target.value)}
                                className="border border-navy/15 rounded text-navy px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40">
                                {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                              </select>
                              <input type="tel" value={form.submitter_phone}
                                onChange={e => set('submitter_phone', e.target.value)}
                                placeholder="79000000" className={cn(inputCls(errors.submitter_phone), 'flex-1')} />
                            </div>
                          </Field>
                          <Field label="Email Address">
                            <input type="email" value={form.submitter_email}
                              onChange={e => set('submitter_email', e.target.value)}
                              placeholder="maria@example.com (optional)" className={inputCls()} />
                          </Field>
                          <Field label="Preferred Contact">
                            <div className="flex gap-2">
                              {['whatsapp', 'phone', 'email'].map(c => (
                                <Chip key={c} active={form.preferred_contact === c}
                                  onClick={() => set('preferred_contact', c)}>
                                  {c.charAt(0).toUpperCase() + c.slice(1)}
                                </Chip>
                              ))}
                            </div>
                          </Field>
                        </>
                      )}
                    </motion.div>
                  )}

                  {/* ── Step 1: Type & Location ── */}
                  {step === 1 && (
                    <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Property Type" required error={errors.property_type}>
                        <div className="space-y-3">
                          {PROPERTY_TYPE_GROUPS.map(g => (
                            <div key={g.label}>
                              <p className="text-xs text-navy/30 mb-1.5">{g.label}</p>
                              <div className="flex flex-wrap gap-2">
                                {g.types.map(t => (
                                  <Chip key={t} active={form.property_type === t}
                                    onClick={() => set('property_type', t)}>{t}</Chip>
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

                      <Field label="Viewings From" error={errors.viewings_from}>
                        <input type="date" value={form.viewings_from}
                          onChange={e => set('viewings_from', e.target.value)}
                          className={inputCls(errors.viewings_from)} />
                        <p className="text-xs text-navy/35 mt-1">
                          Can be earlier than Available From for pre-move-out viewings
                        </p>
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 2: Details ── */}
                  {step === 2 && (
                    <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
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

                      <div className="grid grid-cols-3 gap-4">
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
                          <input type="number" value={form.size_sqm}
                            onChange={e => set('size_sqm', e.target.value)}
                            placeholder="e.g. 85" className={inputCls()} />
                        </Field>
                      </div>

                      {isForRent && (
                        <Field label="Monthly Rent (€)" required error={errors.price_rent}>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40">€</span>
                            <input type="number" value={form.price_rent}
                              onChange={e => set('price_rent', e.target.value)}
                              placeholder="1500" className={cn(inputCls(errors.price_rent), 'pl-8')} />
                          </div>
                        </Field>
                      )}

                      {isForSale && (
                        <Field label="Sale Price (€)" required error={errors.price_sale}>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-navy/40">€</span>
                            <input type="number" value={form.price_sale}
                              onChange={e => set('price_sale', e.target.value)}
                              placeholder="250000" className={cn(inputCls(errors.price_sale), 'pl-8')} />
                          </div>
                        </Field>
                      )}

                      <Field label="Available From">
                        <input type="date" value={form.available_from}
                          onChange={e => set('available_from', e.target.value)} className={inputCls()} />
                      </Field>

                      {isForSale && (
                        <label className="flex items-center gap-3 p-3 border border-navy/10 rounded-lg cursor-pointer hover:bg-navy/[0.02] transition-colors">
                          <input
                            type="checkbox"
                            checked={form.shell_form}
                            onChange={e => set('shell_form', e.target.checked as unknown as typeof form.shell_form)}
                            className="w-4 h-4 accent-gold"
                          />
                          <span className="text-sm text-navy">
                            Shell Form
                            <span className="text-navy/40 text-xs ml-2">— buyer finishes interior</span>
                          </span>
                        </label>
                      )}

                      {!form.shell_form && (
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
                    <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Features & Amenities">
                        <div className="flex flex-wrap gap-2">
                          {FEATURES.map(f => (
                            <Chip key={f.key} active={form.features.includes(f.key)}
                              onClick={() => toggleFeature(f.key)}>
                              {f.label}
                            </Chip>
                          ))}
                        </div>
                      </Field>

                      {!form.shell_form && (
                        <Field label="Furniture Style">
                          <div className="flex flex-wrap gap-2">
                            {FURNITURE_STYLES.map(s => (
                              <Chip key={s} active={form.furniture_style === s}
                                onClick={() => set('furniture_style', s)}>{s}</Chip>
                            ))}
                          </div>
                        </Field>
                      )}
                    </motion.div>
                  )}

                  {/* ── Step 4: Photos ── */}
                  {step === 4 && (
                    <motion.div key="step4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Description" required error={errors.description}>
                        <textarea
                          value={form.description}
                          onChange={e => set('description', e.target.value)}
                          rows={5}
                          maxLength={1000}
                          placeholder="Describe the property in detail..."
                          className={cn(inputCls(errors.description), 'resize-none')}
                        />
                        <div className="flex justify-between mt-1">
                          {form.description.length > 0 && form.description.length < 50
                            ? <span className="text-xs text-orange-400">{50 - form.description.length} more chars needed</span>
                            : <span />}
                          <span className="text-xs text-navy/35 ml-auto">{form.description.length}/1000</span>
                        </div>
                      </Field>

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

                      <Field label="Notes (optional)">
                        <textarea
                          value={form.notes}
                          onChange={e => set('notes', e.target.value)}
                          rows={3}
                          maxLength={500}
                          placeholder="Internal notes — not shown to public (e.g., 'available for clients only', 'flexible on price')"
                          className={cn(inputCls(), 'resize-none')}
                        />
                        <p className="text-xs text-navy/35 mt-1 text-right">{form.notes.length}/500</p>
                      </Field>

                      <Field label="Preferred Viewing Times (optional)">
                        <textarea
                          value={form.preferred_viewing_times}
                          onChange={e => set('preferred_viewing_times', e.target.value)}
                          rows={2}
                          maxLength={200}
                          placeholder="e.g., 'Weekends only', 'Evenings after 18:00', 'Flexible'"
                          className={cn(inputCls(), 'resize-none')}
                        />
                        <p className="text-xs text-navy/35 mt-1 text-right">{form.preferred_viewing_times.length}/200</p>
                      </Field>
                    </motion.div>
                  )}

                  {/* ── Step 5: Review ── */}
                  {step === 5 && (
                    <motion.div key="step5" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                      <Field label="Property Title (optional)">
                        <input type="text" value={form.title}
                          onChange={e => set('title', e.target.value)}
                          placeholder={form.description ? form.description.slice(0, 60) : '2BR Apartment in Sliema — Modern Furnished'}
                          className={inputCls()} />
                        <p className="text-xs text-navy/35 mt-1">Leave blank to auto-generate from description</p>
                      </Field>
                      <h3 className="text-sm font-medium text-navy">Review your submission</h3>

                      <div>
                        <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Submitter</p>
                        <ReviewRow label="Type"
                          value={form.submitter_type === 'agent' ? `Agent: ${agentLabel}` : 'Landlord'} />
                        {form.owner_name && <ReviewRow label="Owner" value={form.owner_name} />}
                        {form.submitter_phone && (
                          <ReviewRow label="Phone" value={`${form.submitter_dial}${form.submitter_phone}`} />
                        )}
                        {form.submitter_email && <ReviewRow label="Email" value={form.submitter_email} />}
                      </div>

                      <div>
                        <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Property</p>
                        <ReviewRow label="Type"     value={form.property_type} />
                        <ReviewRow label="Listing"  value={form.listing_type} />
                        <ReviewRow label="Location" value={[form.location, form.region].filter(Boolean).join(', ')} />
                        <ReviewRow label="Bedrooms" value={form.bedrooms || undefined} />
                        <ReviewRow label="Bathrooms" value={form.bathrooms || undefined} />
                        <ReviewRow label="Size"     value={form.size_sqm ? `${form.size_sqm} m²` : undefined} />
                        {isForRent && (
                          <ReviewRow label="Rent/mo"
                            value={form.price_rent ? `€${Number(form.price_rent).toLocaleString()}` : undefined} />
                        )}
                        {isForSale && (
                          <ReviewRow label="Sale Price"
                            value={form.price_sale ? `€${Number(form.price_sale).toLocaleString()}` : undefined} />
                        )}
                        <ReviewRow label="Available" value={form.available_from || undefined} />
                        <ReviewRow label="Viewings From" value={form.viewings_from || undefined} />
                        {form.shell_form && <ReviewRow label="Shell Form" value="Yes" />}
                        {!form.shell_form && <ReviewRow label="Furnished" value={form.furnished} />}
                        {!form.shell_form && <ReviewRow label="Style" value={form.furniture_style} />}
                        {form.features.length > 0 && (
                          <ReviewRow label="Features" value={form.features.join(', ')} />
                        )}
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
                          <ReviewRow label="Notes"         value={form.notes || undefined} />
                          <ReviewRow label="Viewing Times" value={form.preferred_viewing_times || undefined} />
                        </div>
                      )}

                      {form.photos.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">
                            Photos ({form.photos.length})
                          </p>
                          <div className="grid grid-cols-4 gap-2">
                            {form.photos.slice(0, 8).map(p => (
                              <div key={p.url} className="aspect-square rounded-lg overflow-hidden">
                                <Image src={p.thumbnail || p.url} alt="" width={80} height={80}
                                  className="object-cover w-full h-full" />
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
                      {submitting
                        ? 'Submitting…'
                        : form.submitter_type === 'landlord'
                          ? 'Submit & Get Verified'
                          : 'Submit Property'}
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
