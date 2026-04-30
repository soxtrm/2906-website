'use client'

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { Check, ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Constants ─────────────────────────────────────────────────────────────────

const PROPERTY_TYPE_GROUPS = [
  { label: 'Residential', types: ['Apartment', 'Penthouse', 'Duplex Penthouse', 'Studio', 'Maisonette', 'Townhouse', 'Terraced House', 'Detached Villa', 'Semi-detached Villa', 'Farmhouse'] },
  { label: 'Special',     types: ['Boathouse', 'Garage'] },
  { label: 'Commercial',  types: ['Office', 'Retail', 'Commercial Garage', 'Restaurant/Canteen', 'Gym'] },
]

const LOCATION_GROUPS = [
  { label: 'Central', items: ["Sliema", "St Julian's", "Gzira", "Msida", "Pieta", "Ta' Xbiex", "Swieqi", "Pembroke", "Madliena", "San Gwann", "Birkirkara"] },
  { label: 'North',   items: ["Mellieha", "Bugibba", "Qawra", "St Paul's Bay", "Mosta", "Naxxar", "Gharghur", "Attard", "Balzan", "Lija", "Iklin"] },
  { label: 'South',   items: ["Marsaskala", "Birzebbuga", "Zebbug", "Zejtun", "Valletta", "Floriana"] },
  { label: 'West',    items: ["Rabat", "Mdina", "Mtarfa", "Dingli", "Siggiewi"] },
  { label: 'Gozo',    items: ["Victoria", "Marsalforn", "Xlendi", "Nadur"] },
]

const FEATURES = [
  { key: 'ac',        icon: '❄️',  label: 'A/C' },
  { key: 'bathtub',   icon: '🛁',  label: 'Bathtub' },
  { key: 'concierge', icon: '🛡️', label: 'Concierge' },
  { key: 'fireplace', icon: '🔥',  label: 'Fireplace' },
  { key: 'furnished', icon: '🛋️', label: 'Furnished' },
  { key: 'garage',    icon: '🚗',  label: 'Garage/Parking' },
  { key: 'garden',    icon: '🌳',  label: 'Garden' },
  { key: 'gym',       icon: '🏋️', label: 'Gym' },
  { key: 'jacuzzi',   icon: '♨️',  label: 'Jacuzzi' },
  { key: 'lift',      icon: '⬆️',  label: 'Lift' },
  { key: 'parking',   icon: '🅿️', label: 'Parking' },
  { key: 'pets',      icon: '🐾',  label: 'Pet Friendly' },
  { key: 'pool',      icon: '🏊',  label: 'Pool' },
  { key: 'sea_view',  icon: '🌊',  label: 'Sea View' },
  { key: 'seafront',  icon: '🌅',  label: 'Seafront' },
  { key: 'terrace',   icon: '☀️',  label: 'Terrace' },
]

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1',   flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34',  flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+41', flag: '🇨🇭' },
  { code: '+43',  flag: '🇦🇹' }, { code: '+7',  flag: '🇷🇺' }, { code: '+971', flag: '🇦🇪' },
  { code: '+91',  flag: '🇮🇳' }, { code: '+86', flag: '🇨🇳' }, { code: '+61', flag: '🇦🇺' },
]

const STEPS = ['Your Info', 'Their Info', 'Budget & Type', 'Location', 'Features', 'Submit']
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
  // Referrer (the person filling the form)
  referrer_name:    '',
  referrer_dial:    '+356',
  referrer_phone:   '',
  referrer_email:   '',
  // Referral (the person being referred)
  referral_name:    '',
  referral_dial:    '+356',
  referral_phone:   '',
  referral_email:   '',
  referral_relation: '',
  // What they're looking for
  budget_min:        1000,
  budget_max:        2500,
  listing_type:      'For Rent' as string,
  property_types:    [] as string[],
  bedrooms:          [] as string[],
  move_in:           '',
  locations:         [] as string[],
  features:          [] as string[],
  notes:             '',
}

function sliderToBudget(p: number): number {
  if (p <= 50) return 500 + (p / 50) * 1500
  return 2000 + ((p - 50) / 50) * 8000
}
function budgetToSlider(b: number): number {
  if (b <= 2000) return ((b - 500) / 1500) * 50
  return 50 + ((b - 2000) / 8000) * 50
}
function roundTo50(n: number): number {
  return Math.round(n / 50) * 50
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ReferralPage() {
  const [form, setForm]           = useState(defaultForm)
  const [step, setStep]           = useState(0)
  const [errors, setErrors]       = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]           = useState(false)

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key as string]; return e })
  }, [])

  const toggleLoc  = (loc: string) =>
    set('locations', (form.locations.includes(loc) ? form.locations.filter(l => l !== loc) : [...form.locations, loc]) as typeof form.locations)
  const toggleFeat = (k: string) =>
    set('features', (form.features.includes(k) ? form.features.filter(f => f !== k) : [...form.features, k]) as typeof form.features)
  const toggleType = (t: string) =>
    set('property_types', (form.property_types.includes(t) ? form.property_types.filter(x => x !== t) : [...form.property_types, t]) as typeof form.property_types)
  const toggleBed  = (b: string) =>
    set('bedrooms', (form.bedrooms.includes(b) ? form.bedrooms.filter(x => x !== b) : [...form.bedrooms, b]) as typeof form.bedrooms)

  function validateStep(s: number): Record<string, string> {
    const e: Record<string, string> = {}
    if (s === 0) {
      if (!form.referrer_name.trim())  e.referrer_name  = 'Required'
      if (!form.referrer_phone.trim()) e.referrer_phone = 'Required'
    }
    if (s === 1) {
      if (!form.referral_name.trim())  e.referral_name  = 'Required'
      if (!form.referral_phone.trim()) e.referral_phone = 'Required'
    }
    return e
  }

  function next() {
    const e = validateStep(step)
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({})
    setStep(s => Math.min(s + 1, TOTAL_STEPS - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function back() {
    setErrors({})
    setStep(s => Math.max(s - 1, 0))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function submit() {
    setSubmitting(true)
    try {
      const payload = {
        referrer_name:    form.referrer_name.trim(),
        referrer_phone:   `${form.referrer_dial}${form.referrer_phone.trim()}`,
        referrer_email:   form.referrer_email.trim() || null,
        referral_name:    form.referral_name.trim(),
        referral_phone:   `${form.referral_dial}${form.referral_phone.trim()}`,
        referral_email:   form.referral_email.trim() || null,
        referral_relation: form.referral_relation.trim() || null,
        budget_min:       form.budget_min,
        budget_max:       form.budget_max,
        listing_type:     form.listing_type,
        property_types:   form.property_types.length > 0 ? form.property_types.join(',') : null,
        bedrooms:         form.bedrooms.length > 0 ? form.bedrooms.join(',') : null,
        move_in:          form.move_in || null,
        locations:        form.locations,
        features:         FEATURES.filter(f => form.features.includes(f.key)).map(f => f.label),
        notes:            form.notes.trim() || null,
      }

      const res = await fetch('/api/referrals/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok) {
        setDone(true)
        window.scrollTo({ top: 0, behavior: 'smooth' })
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
    <main className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="pt-28 pb-12 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 text-center max-w-3xl">
          <p className="text-gold text-xs tracking-[0.2em] uppercase mb-4">Earn With Us</p>
          <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-5 leading-tight">
            Referral Program
          </h1>
          <p className="text-white/70 text-base md:text-lg leading-relaxed mb-3">
            Know someone looking for a property in Malta? Refer them to 2906 and earn 10% of our commission when they sign.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 mt-6">
            <div className="flex items-center gap-2 text-white/70 text-sm">
              <span className="w-6 h-6 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center text-gold text-xs font-bold">1</span>
              Fill in their details
            </div>
            <span className="text-white/20">→</span>
            <div className="flex items-center gap-2 text-white/70 text-sm">
              <span className="w-6 h-6 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center text-gold text-xs font-bold">2</span>
              We contact them
            </div>
            <span className="text-white/20">→</span>
            <div className="flex items-center gap-2 text-white/70 text-sm">
              <span className="w-6 h-6 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center text-gold text-xs font-bold">3</span>
              You earn 10%
            </div>
          </div>
        </div>
      </section>

      {/* Form */}
      <section className="py-12 bg-off-white">
        <div className="container mx-auto px-4 lg:px-8 max-w-2xl">

          {done ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white rounded-xl border border-navy/5 shadow-sm p-10 text-center"
            >
              <div className="w-16 h-16 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8 text-gold" />
              </div>
              <h2 className="font-serif text-2xl text-navy mb-2">Referral Submitted!</h2>
              <p className="text-navy/50 text-sm mb-2">
                Thanks {form.referrer_name.split(' ')[0]}! We&apos;ll reach out to {form.referral_name.split(' ')[0]} shortly.
              </p>
              <p className="text-navy/40 text-xs mb-6">
                We&apos;ll keep you posted when they sign — your 10% commission will be confirmed at that point.
              </p>
              <button
                onClick={reset}
                className="px-6 py-2.5 bg-navy text-white text-sm rounded-lg hover:bg-navy/80 transition-colors"
              >
                Refer Another Person
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

                {/* ── Step 0: Your Info (referrer) ── */}
                {step === 0 && (
                  <motion.div key="step0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                    <div>
                      <h3 className="font-serif text-lg text-navy mb-1">About You</h3>
                      <p className="text-sm text-navy/50">We need your details so we can credit your referral fee.</p>
                    </div>

                    <Field label="Your Name" required error={errors.referrer_name}>
                      <input
                        type="text"
                        value={form.referrer_name}
                        onChange={e => set('referrer_name', e.target.value)}
                        placeholder="Maria Borg"
                        className={inputCls(errors.referrer_name)}
                      />
                    </Field>

                    <Field label="Your Phone" required error={errors.referrer_phone}>
                      <div className="flex gap-2">
                        <select
                          value={form.referrer_dial}
                          onChange={e => set('referrer_dial', e.target.value)}
                          className="border border-navy/15 rounded text-navy px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
                        >
                          {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                        </select>
                        <input
                          type="tel"
                          value={form.referrer_phone}
                          onChange={e => set('referrer_phone', e.target.value)}
                          placeholder="79000000"
                          className={cn(inputCls(errors.referrer_phone), 'flex-1')}
                        />
                      </div>
                    </Field>

                    <Field label="Your Email (optional)">
                      <input
                        type="email"
                        value={form.referrer_email}
                        onChange={e => set('referrer_email', e.target.value)}
                        placeholder="you@email.com"
                        className={inputCls()}
                      />
                    </Field>
                  </motion.div>
                )}

                {/* ── Step 1: Their Info (referral) ── */}
                {step === 1 && (
                  <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                    <div>
                      <h3 className="font-serif text-lg text-navy mb-1">About Them</h3>
                      <p className="text-sm text-navy/50">Tell us about the person you&apos;re referring.</p>
                    </div>

                    <Field label="Their Name" required error={errors.referral_name}>
                      <input
                        type="text"
                        value={form.referral_name}
                        onChange={e => set('referral_name', e.target.value)}
                        placeholder="John Smith"
                        className={inputCls(errors.referral_name)}
                      />
                    </Field>

                    <Field label="Their Phone" required error={errors.referral_phone}>
                      <div className="flex gap-2">
                        <select
                          value={form.referral_dial}
                          onChange={e => set('referral_dial', e.target.value)}
                          className="border border-navy/15 rounded text-navy px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
                        >
                          {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                        </select>
                        <input
                          type="tel"
                          value={form.referral_phone}
                          onChange={e => set('referral_phone', e.target.value)}
                          placeholder="79000000"
                          className={cn(inputCls(errors.referral_phone), 'flex-1')}
                        />
                      </div>
                    </Field>

                    <Field label="Their Email (optional)">
                      <input
                        type="email"
                        value={form.referral_email}
                        onChange={e => set('referral_email', e.target.value)}
                        placeholder="them@email.com"
                        className={inputCls()}
                      />
                    </Field>

                    <Field label="Your Relationship (optional)">
                      <input
                        type="text"
                        value={form.referral_relation}
                        onChange={e => set('referral_relation', e.target.value)}
                        placeholder="e.g. Friend, Colleague, Family"
                        className={inputCls()}
                      />
                    </Field>
                  </motion.div>
                )}

                {/* ── Step 2: Budget & Type ── */}
                {step === 2 && (
                  <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                    <div>
                      <h3 className="font-serif text-lg text-navy mb-1">Budget &amp; Property Type</h3>
                      <p className="text-sm text-navy/50">What are they looking for? (optional — but helps us match faster)</p>
                    </div>

                    {/* Listing type */}
                    <Field label="Looking To">
                      <div className="flex gap-2">
                        {(['For Rent', 'For Sale', 'Either'] as const).map(t => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => set('listing_type', t)}
                            className={cn(
                              'flex-1 py-2 rounded-lg border text-sm font-medium transition-all',
                              form.listing_type === t ? 'border-gold bg-gold/10 text-navy' : 'border-navy/15 text-navy/50 hover:border-navy/30'
                            )}
                          >
                            {t === 'For Rent' ? 'Rent' : t === 'For Sale' ? 'Buy' : 'Either'}
                          </button>
                        ))}
                      </div>
                    </Field>

                    {/* Budget slider */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-medium text-navy/50 uppercase tracking-wider">
                          {form.listing_type === 'For Sale' ? 'Purchase Budget' : 'Monthly Budget'}
                        </p>
                        <span className="font-serif text-navy font-semibold text-sm">
                          €{form.budget_min.toLocaleString()} – {form.budget_max >= 10000 ? '€10,000+' : `€${form.budget_max.toLocaleString()}`}
                          {form.budget_min >= 2500 && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 bg-gold/15 text-gold border border-gold/30 rounded-full">Premium</span>
                          )}
                        </span>
                      </div>
                      <div className="relative h-2 bg-navy/10 rounded-full">
                        <input
                          type="range"
                          min={0} max={100} step={1}
                          value={budgetToSlider(form.budget_min)}
                          onChange={e => {
                            const v = roundTo50(sliderToBudget(Number(e.target.value)))
                            if (v < form.budget_max) set('budget_min', v)
                          }}
                          className="absolute inset-0 w-full opacity-0 cursor-pointer h-2"
                        />
                        <input
                          type="range"
                          min={0} max={100} step={1}
                          value={budgetToSlider(form.budget_max)}
                          onChange={e => {
                            const v = roundTo50(sliderToBudget(Number(e.target.value)))
                            if (v > form.budget_min) set('budget_max', v)
                          }}
                          className="absolute inset-0 w-full opacity-0 cursor-pointer h-2"
                        />
                        <div
                          className="absolute h-2 bg-gold rounded-full"
                          style={{
                            left: `${budgetToSlider(form.budget_min)}%`,
                            right: `${100 - budgetToSlider(form.budget_max)}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-between text-xs text-navy/30 mt-1">
                        <span>€500</span><span>€2,000</span><span>€6,000</span><span>€10,000+</span>
                      </div>
                    </div>

                    {/* Bedrooms */}
                    <Field label="Bedrooms (optional)">
                      <div className="flex gap-1.5 flex-wrap">
                        {['Studio', '1', '2', '3', '4+'].map(b => (
                          <button
                            key={b}
                            type="button"
                            onClick={() => toggleBed(b)}
                            className={cn(
                              'px-3 py-2 rounded border text-sm transition-all',
                              form.bedrooms.includes(b) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25'
                            )}
                          >
                            {b}
                          </button>
                        ))}
                      </div>
                    </Field>

                    {/* Move-in */}
                    <Field label="Move-in (optional)">
                      <div className="flex gap-1.5 flex-wrap mb-2">
                        {['ASAP', 'Within 1 month', 'Within 3 months', 'Flexible'].map(o => (
                          <button
                            key={o}
                            type="button"
                            onClick={() => set('move_in', form.move_in === o ? '' : o)}
                            className={cn(
                              'text-xs px-2.5 py-1.5 rounded border transition-all',
                              form.move_in === o ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25'
                            )}
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    </Field>

                    {/* Property types */}
                    <div>
                      <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                        Property Type (optional)
                        {form.property_types.length > 0 && <span className="ml-2 text-gold normal-case">{form.property_types.length} selected</span>}
                      </p>
                      <div className="space-y-2">
                        {PROPERTY_TYPE_GROUPS.map(g => (
                          <div key={g.label}>
                            <p className="text-xs text-navy/30 mb-1">{g.label}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {g.types.map(pt => (
                                <button
                                  key={pt}
                                  type="button"
                                  onClick={() => toggleType(pt)}
                                  className={cn(
                                    'text-xs px-2.5 py-1.5 rounded-full border transition-all',
                                    form.property_types.includes(pt) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25 hover:text-navy'
                                  )}
                                >
                                  {pt}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* ── Step 3: Location ── */}
                {step === 3 && (
                  <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                    <div>
                      <h3 className="font-serif text-lg text-navy mb-1">Location Preferences</h3>
                      <p className="text-sm text-navy/50">Where are they looking? Select as many as apply.</p>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                        Towns &amp; Villages
                        {form.locations.length > 0 && <span className="ml-2 text-gold normal-case">{form.locations.length} selected</span>}
                      </p>
                      <div className="space-y-2">
                        {LOCATION_GROUPS.map(g => (
                          <div key={g.label} className="flex flex-wrap gap-1.5 items-center">
                            <span className="text-xs text-navy/30 w-12 shrink-0">{g.label}</span>
                            {g.items.map(loc => (
                              <Chip key={loc} active={form.locations.includes(loc)} onClick={() => toggleLoc(loc)}>
                                {loc}
                              </Chip>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* ── Step 4: Features ── */}
                {step === 4 && (
                  <motion.div key="step4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                    <div>
                      <h3 className="font-serif text-lg text-navy mb-1">Features &amp; Preferences</h3>
                      <p className="text-sm text-navy/50">What features matter to them? (optional)</p>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                        Features
                        {form.features.length > 0 && <span className="ml-2 text-gold normal-case">{form.features.length} selected</span>}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {FEATURES.map(f => (
                          <button
                            key={f.key}
                            type="button"
                            onClick={() => toggleFeat(f.key)}
                            className={cn(
                              'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border transition-all',
                              form.features.includes(f.key) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25'
                            )}
                          >
                            {f.icon} {f.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Field label="Additional Notes (optional)">
                      <textarea
                        rows={3}
                        value={form.notes}
                        onChange={e => set('notes', e.target.value)}
                        placeholder="Anything else we should know about their search..."
                        className={cn(inputCls(), 'resize-none')}
                      />
                    </Field>
                  </motion.div>
                )}

                {/* ── Step 5: Submit (Review) ── */}
                {step === 5 && (
                  <motion.div key="step5" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                    <div>
                      <h3 className="font-serif text-lg text-navy mb-1">Ready to Submit</h3>
                      <p className="text-sm text-navy/50">Review your referral before sending.</p>
                    </div>

                    <div className="space-y-4 text-sm">
                      <div className="bg-navy/[0.02] border border-navy/8 rounded-lg p-4">
                        <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Your Details</p>
                        <p className="text-navy font-medium">{form.referrer_name}</p>
                        <p className="text-navy/60">{form.referrer_dial}{form.referrer_phone}</p>
                        {form.referrer_email && <p className="text-navy/60">{form.referrer_email}</p>}
                      </div>

                      <div className="bg-gold/[0.04] border border-gold/20 rounded-lg p-4">
                        <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">Person Being Referred</p>
                        <p className="text-navy font-medium">{form.referral_name}</p>
                        <p className="text-navy/60">{form.referral_dial}{form.referral_phone}</p>
                        {form.referral_email && <p className="text-navy/60">{form.referral_email}</p>}
                        {form.referral_relation && <p className="text-navy/50 text-xs mt-1">{form.referral_relation}</p>}
                      </div>

                      <div className="bg-navy/[0.02] border border-navy/8 rounded-lg p-4 space-y-1">
                        <p className="text-xs font-medium text-navy/40 uppercase tracking-wide mb-2">What They&apos;re Looking For</p>
                        <p className="text-navy/70">
                          <span className="text-navy/40">Looking to:</span> {form.listing_type === 'Either' ? 'Rent or Buy' : form.listing_type}
                        </p>
                        <p className="text-navy/70">
                          <span className="text-navy/40">Budget:</span> €{form.budget_min.toLocaleString()} – {form.budget_max >= 10000 ? '€10,000+' : `€${form.budget_max.toLocaleString()}`}
                        </p>
                        {form.bedrooms.length > 0 && (
                          <p className="text-navy/70"><span className="text-navy/40">Bedrooms:</span> {form.bedrooms.join(', ')}</p>
                        )}
                        {form.move_in && (
                          <p className="text-navy/70"><span className="text-navy/40">Move-in:</span> {form.move_in}</p>
                        )}
                        {form.property_types.length > 0 && (
                          <p className="text-navy/70"><span className="text-navy/40">Types:</span> {form.property_types.join(', ')}</p>
                        )}
                        {form.locations.length > 0 && (
                          <p className="text-navy/70"><span className="text-navy/40">Locations:</span> {form.locations.join(', ')}</p>
                        )}
                        {form.features.length > 0 && (
                          <p className="text-navy/70">
                            <span className="text-navy/40">Features:</span> {FEATURES.filter(f => form.features.includes(f.key)).map(f => f.label).join(', ')}
                          </p>
                        )}
                        {form.notes && (
                          <p className="text-navy/70"><span className="text-navy/40">Notes:</span> {form.notes}</p>
                        )}
                      </div>
                    </div>

                    <div className="bg-gold/5 border border-gold/20 rounded-lg p-4 text-center">
                      <p className="text-sm text-navy/70">
                        By submitting, you confirm that <strong>{form.referral_name.split(' ')[0]}</strong> is aware of this referral and consents to being contacted by 2906 Real Estate.
                      </p>
                      <p className="text-xs text-navy/40 mt-1">
                        Your 10% commission is paid upon successful rental/sale agreement.
                      </p>
                    </div>
                  </motion.div>
                )}

              </AnimatePresence>

              {/* Navigation */}
              <div className="flex justify-between mt-8 pt-6 border-t border-navy/5">
                <button
                  type="button"
                  onClick={back}
                  disabled={step === 0}
                  className="flex items-center gap-1.5 text-sm text-navy/40 hover:text-navy disabled:opacity-0 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                {step < TOTAL_STEPS - 1 ? (
                  <button
                    type="button"
                    onClick={next}
                    className="flex items-center gap-1.5 px-5 py-2.5 bg-navy text-white text-sm rounded-lg hover:bg-navy/80 transition-colors"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={submitting}
                    className="flex items-center gap-1.5 px-6 py-2.5 bg-gold text-white text-sm font-medium rounded-lg hover:bg-gold/80 transition-colors disabled:opacity-50"
                  >
                    {submitting ? 'Submitting…' : 'Submit Referral'}
                    {!submitting && <Check className="w-4 h-4" />}
                  </button>
                )}
              </div>

            </div>
          )}
        </div>
      </section>

      <Footer />
    </main>
  )
}
