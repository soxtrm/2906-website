'use client'

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { Slider } from '@/components/ui/slider'
import { LocationSelector, type LocationSelectorValue } from '@/components/location-selector'
import { Check, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Budget helpers ─────────────────────────────────────────────────────────────

function sliderToBudget(p: number): number {
  if (p <= 50) return 500 + (p / 50) * 1500
  return 2000 + ((p - 50) / 50) * 8000
}
function budgetToSlider(b: number): number {
  if (b <= 2000) return ((b - 500) / 1500) * 50
  return 50 + ((b - 2000) / 8000) * 50
}
function roundTo50(n: number): number { return Math.round(n / 50) * 50 }

// ── Constants ─────────────────────────────────────────────────────────────────

const PROPERTY_TYPE_GROUPS = [
  {
    label: 'Residential',
    types: ['Apartment', 'Penthouse', 'Duplex Penthouse', 'Maisonette', 'Townhouse',
            'Terraced House', 'House of Character', 'Detached Villa', 'Semi-detached Villa', 'Farmhouse'],
  },
  { label: 'Special',     types: ['Boathouse', 'Garage'] },
  { label: 'Commercial',  types: ['Office', 'Retail', 'Commercial Garage', 'Restaurant/Canteen', 'Gym'] },
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
  { key: 'rooftop',   icon: '🏙️', label: 'Rooftop' },
  { key: 'sea_view',  icon: '🌊',  label: 'Sea View' },
  { key: 'seafront',  icon: '🌅',  label: 'Seafront' },
  { key: 'terrace',   icon: '☀️',  label: 'Terrace' },
]

const FURNITURE_STYLES = ['Ultra Modern', 'Modern', 'Standard', 'Character', 'Cozy']

const MOVE_IN_OPTIONS = ['ASAP', 'In 10 Days', 'Within 1 month', 'Within 3 months', 'Flexible', 'Other']

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1',   flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34',  flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+41', flag: '🇨🇭' },
  { code: '+43',  flag: '🇦🇹' }, { code: '+7',  flag: '🇷🇺' }, { code: '+971', flag: '🇦🇪' },
  { code: '+380', flag: '🇺🇦' }, { code: '+91', flag: '🇮🇳' }, { code: '+86', flag: '🇨🇳' },
  { code: '+61',  flag: '🇦🇺' },
]

type GroupType = '' | 'single' | 'couple' | 'sharing' | 'family' | 'other'

interface SharingPerson {
  name: string; nationality: string; job: string; age: string
}

const defaultForm = {
  name: '', email: '', phone: '', dial: '+356',
  nationality: '',
  group_size: 1,
  hasPets: false, pets: '',
  group_type: '' as GroupType,
  group_type_comment: '',
  sharing_persons: [] as SharingPerson[],
  family_children_count: '',
  profession: '',
  occupation_location: '',
  description: '',
  budget_min: 1000, budget_max: 2500,
  bedrooms: [] as string[], bathrooms: [] as string[],
  property_types: [] as string[],
  move_in: '',
  movein_other_comment: '',
  viewings_type: 'now' as 'now' | 'specific' | 'virtual',
  viewings_specific_date: '',
  features: [] as string[],
  furniture_style: 'Standard',
  wishes: '',
  internal_notes: '',
}

const defaultLocations: LocationSelectorValue = {
  selectedAreas: [],
  preferredVillages: [],
  topPriorityVillages: [],
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function Field({ label, children, required, hint }: {
  label: string; children: React.ReactNode; required?: boolean; hint?: string
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <p className="text-xs font-medium text-navy/50 uppercase tracking-wider">
          {label}{required && <span className="text-red-400 ml-1">*</span>}
        </p>
        {hint && (
          <div className="relative group">
            <Info className="w-3 h-3 text-navy/30 cursor-help" />
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 bg-navy text-white text-[10px] rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
              {hint}
            </div>
          </div>
        )}
      </div>
      {children}
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
        active ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/30 hover:text-navy'
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AddClientPage() {
  const [form, setForm] = useState(defaultForm)
  const [locations, setLocations] = useState<LocationSelectorValue>(defaultLocations)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [lastAdded, setLastAdded] = useState<{ name: string; time: string } | null>(null)
  const [toast, setToast] = useState('')

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key]; return e })
  }, [])

  const toggleFeat = (k: string) =>
    set('features', form.features.includes(k) ? form.features.filter(f => f !== k) : [...form.features, k])

  const setHasPets = (val: boolean) => {
    setForm(prev => ({
      ...prev,
      hasPets: val,
      features: val
        ? prev.features.includes('pets') ? prev.features : [...prev.features, 'pets']
        : prev.features.filter(f => f !== 'pets'),
    }))
  }

  // Sync sharing_persons array length with group_size when in sharing mode
  const updateGroupSize = (n: number) => {
    set('group_size', n)
    if (form.group_type === 'sharing') {
      const persons = [...form.sharing_persons]
      while (persons.length < n) persons.push({ name: '', nationality: '', job: '', age: '' })
      setForm(prev => ({ ...prev, group_size: n, sharing_persons: persons.slice(0, n) }))
    }
  }

  const updateGroupType = (gt: GroupType) => {
    const next: typeof form = { ...form, group_type: gt, group_type_comment: '', sharing_persons: [], family_children_count: '' }
    if (gt === 'sharing') {
      next.sharing_persons = Array.from({ length: form.group_size }, () => ({ name: '', nationality: '', job: '', age: '' }))
    }
    setForm(next)
  }

  const updateSharingPerson = (i: number, field: keyof SharingPerson, val: string) => {
    const persons = [...form.sharing_persons]
    persons[i] = { ...persons[i], [field]: val }
    setForm(prev => ({ ...prev, sharing_persons: persons }))
  }

  const validate = () => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Required'
    if (!form.profession.trim()) e.profession = 'Required'
    if (!form.description.trim()) e.description = 'Required'
    else if (form.description.trim().length < 50) e.description = 'Minimum 50 characters'
    return e
  }

  const submit = async () => {
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); window.scrollTo({ top: 0, behavior: 'smooth' }); return }

    setSubmitting(true)
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email || null,
        phone: form.phone ? `${form.dial}${form.phone}` : null,
        nationality: form.nationality || null,
        group_size: form.group_size > 1 ? form.group_size : null,
        pets: form.hasPets ? (form.pets || 'yes') : null,
        group_type: form.group_type || null,
        group_type_comment: form.group_type_comment || null,
        sharing_persons: form.group_type === 'sharing' ? form.sharing_persons : null,
        family_children_count: form.group_type === 'family' && form.family_children_count ? parseInt(form.family_children_count) : null,
        movein_other_comment: form.move_in === 'Other' ? form.movein_other_comment : null,
        profession: form.profession || null,
        occupation_location: form.occupation_location || null,
        description: form.description || null,
        budget_min: form.budget_min,
        budget_max: form.budget_max,
        bedrooms: form.bedrooms.length > 0 ? form.bedrooms.join(',') : null,
        bathrooms: form.bathrooms.length > 0 ? form.bathrooms.join(',') : null,
        property_types: form.property_types.length > 0 ? form.property_types.join(',') : null,
        move_in: form.move_in !== 'Other' ? form.move_in : 'Other',
        viewings_type: form.viewings_type,
        viewings_specific_date: form.viewings_type === 'specific' ? form.viewings_specific_date : null,
        selected_areas: locations.selectedAreas,
        preferred_villages: locations.preferredVillages,
        top_priority_villages: locations.topPriorityVillages,
        locations: [...locations.preferredVillages, ...locations.topPriorityVillages],
        preferred_regions: locations.selectedAreas,
        features: FEATURES.filter(f => form.features.includes(f.key)).map(f => f.label),
        furniture_style: form.furniture_style,
        wishes: form.wishes || null,
        internal_notes: form.internal_notes || null,
        source: 'agent',
      }

      const res = await fetch('/api/contact-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok) {
        const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        setLastAdded({ name: form.name.split(' ')[0], time: now })
        setToast('✓ Client added')
        setTimeout(() => setToast(''), 4000)
        setForm(defaultForm)
        setLocations(defaultLocations)
        setErrors({})
      } else {
        alert(data.error || 'Something went wrong')
      }
    } catch {
      alert('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const showStudio = form.bedrooms.includes('1')

  return (
    <>
      <main className="min-h-screen bg-off-white">
        <Header />

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-navy text-white px-5 py-3 rounded-lg shadow-lg flex items-center gap-2 text-sm"
            >
              <Check className="w-4 h-4 text-gold" /> {toast}
            </motion.div>
          )}
        </AnimatePresence>

        <section className="pt-28 pb-16">
          <div className="container mx-auto px-4 lg:px-8 max-w-4xl">
            {/* Header */}
            <div className="mb-8">
              <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">2906 Internal</p>
              <h1 className="font-serif text-3xl text-navy">Add Client</h1>
              <p className="text-navy/50 text-sm mt-1">Quick client intake for agents</p>
              {lastAdded && (
                <p className="text-sm text-navy/50 mt-2 bg-gold/10 border border-gold/20 rounded px-3 py-1.5 inline-block">
                  Last added: <strong>{lastAdded.name}</strong> at {lastAdded.time}
                </p>
              )}
            </div>

            <div className="bg-white rounded-xl border border-navy/5 shadow-sm p-6 md:p-8">
              <div className="grid md:grid-cols-2 gap-6">

                {/* ── Name ── */}
                <Field label="Client Name" required>
                  <input
                    type="text" value={form.name} onChange={e => set('name', e.target.value)}
                    placeholder="Maria Borg"
                    className={cn(inputCls(errors.name))}
                  />
                  {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
                </Field>

                {/* ── Email ── */}
                <Field label="Email">
                  <input type="email" value={form.email} onChange={e => set('email', e.target.value)}
                    placeholder="client@email.com" className={inputCls()} />
                </Field>

                {/* ── Phone (optional) ── */}
                <Field label="Phone (optional)">
                  <div className="flex gap-2">
                    <select value={form.dial} onChange={e => set('dial', e.target.value)}
                      className="border border-navy/15 rounded text-navy px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40">
                      {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                    </select>
                    <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)}
                      placeholder="79000000" className={cn(inputCls(), 'flex-1')} />
                  </div>
                </Field>

                {/* ── Nationality ── */}
                <Field label="Nationality">
                  <input type="text" value={form.nationality} onChange={e => set('nationality', e.target.value)}
                    placeholder="e.g. German, British" className={inputCls()} />
                </Field>

                {/* ── Profession (required) ── */}
                <Field label="Profession" required>
                  <input type="text" value={form.profession} onChange={e => set('profession', e.target.value)}
                    placeholder="e.g. Remote worker, Finance"
                    className={inputCls(errors.profession)} />
                  {errors.profession && <p className="text-red-400 text-xs mt-1">{errors.profession}</p>}
                </Field>

                {/* ── Occupation Location ── */}
                <Field label="Occupation Location" hint="City/area where they work — useful for commute planning">
                  <input type="text" value={form.occupation_location} onChange={e => set('occupation_location', e.target.value)}
                    placeholder="e.g. Valletta, Qormi" className={inputCls()} />
                </Field>

                {/* ── Group Size + Pets ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Group Size & Pets</p>
                  <div className="flex gap-2 mb-2">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button key={n} type="button" onClick={() => updateGroupSize(n)}
                        className={cn('flex-1 py-2 rounded border text-sm transition-all',
                          form.group_size === n ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {n === 5 ? '5+' : n}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 items-center">
                    <button type="button" onClick={() => setHasPets(!form.hasPets)}
                      className={cn('px-3 py-1.5 rounded border text-xs transition-all',
                        form.hasPets ? 'border-gold bg-gold/10 text-navy' : 'border-navy/15 text-navy/50')}>
                      🐾 Pets
                    </button>
                    {form.hasPets && (
                      <input type="text" value={form.pets} onChange={e => set('pets', e.target.value)}
                        placeholder="e.g. 1 dog, 2 cats"
                        className="flex-1 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                    )}
                  </div>
                </div>

                {/* ── Group Type ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Group Type</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {(['single', 'couple', 'sharing', 'family', 'other'] as GroupType[]).map(gt => (
                      <button key={gt} type="button" onClick={() => updateGroupType(gt === form.group_type ? '' : gt)}
                        className={cn('px-3 py-1.5 rounded border text-sm transition-all capitalize',
                          form.group_type === gt ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {gt === 'single' ? '🧍 Single' : gt === 'couple' ? '👫 Couple' : gt === 'sharing' ? '🏠 Sharing' : gt === 'family' ? '👨‍👩‍👦 Family' : '💬 Other'}
                      </button>
                    ))}
                  </div>

                  {/* Sharing sub-form */}
                  {form.group_type === 'sharing' && form.sharing_persons.length > 0 && (
                    <div className="border border-navy/10 rounded-lg p-4 space-y-3 bg-navy/[0.02]">
                      <p className="text-xs text-navy/40 mb-2">Person details (optional)</p>
                      {form.sharing_persons.map((p, i) => (
                        <div key={i} className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <input value={p.name} onChange={e => updateSharingPerson(i, 'name', e.target.value)}
                            placeholder={`Person ${i + 1} name`}
                            className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                          <input value={p.nationality} onChange={e => updateSharingPerson(i, 'nationality', e.target.value)}
                            placeholder="Nationality"
                            className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                          <input value={p.job} onChange={e => updateSharingPerson(i, 'job', e.target.value)}
                            placeholder="Job"
                            className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                          <input value={p.age} onChange={e => updateSharingPerson(i, 'age', e.target.value)}
                            placeholder="Age"
                            className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Family sub-form */}
                  {form.group_type === 'family' && (
                    <div className="flex items-center gap-3">
                      <label className="text-sm text-navy/60">Number of children:</label>
                      <input type="number" min="0" max="10" value={form.family_children_count}
                        onChange={e => set('family_children_count', e.target.value)}
                        className="w-20 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy focus:outline-none focus:ring-1 focus:ring-gold/40" />
                    </div>
                  )}

                  {/* Other sub-form */}
                  {form.group_type === 'other' && (
                    <textarea rows={2} value={form.group_type_comment}
                      onChange={e => set('group_type_comment', e.target.value)}
                      placeholder="Describe the group..."
                      className="w-full px-3 py-2 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40 resize-none" />
                  )}
                </div>

                {/* ── Budget slider ── */}
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-navy/50 uppercase tracking-wider">Monthly Budget</p>
                    <span className="font-serif text-navy font-semibold text-sm">
                      €{form.budget_min.toLocaleString()} – {form.budget_max >= 10000 ? '€10,000+' : `€${form.budget_max.toLocaleString()}`}
                      {form.budget_min >= 2500 && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 bg-gold/15 text-gold border border-gold/30 rounded-full">Premium</span>
                      )}
                    </span>
                  </div>
                  <Slider
                    value={[budgetToSlider(form.budget_min), budgetToSlider(form.budget_max)]}
                    onValueChange={([p1, p2]) => { set('budget_min', roundTo50(sliderToBudget(p1))); set('budget_max', roundTo50(sliderToBudget(p2))) }}
                    min={0} max={100} step={1}
                  />
                  <div className="flex justify-between text-xs text-navy/30 mt-1">
                    <span>€500</span><span>€2,000</span><span>€6,000</span><span>€10,000+</span>
                  </div>
                </div>

                {/* ── Bedrooms ── */}
                <Field label="Bedrooms">
                  <div className="flex gap-1.5 flex-wrap">
                    {['1', '2', '3', '4+'].map(b => (
                      <button key={b} type="button"
                        onClick={() => set('bedrooms', form.bedrooms.includes(b) ? form.bedrooms.filter(x => x !== b) : [...form.bedrooms, b])}
                        className={cn('px-3 py-2 rounded border text-sm transition-all',
                          form.bedrooms.includes(b) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                    {/* Studio only when 1 bedroom selected */}
                    {showStudio && (
                      <button type="button"
                        onClick={() => set('bedrooms', form.bedrooms.includes('Studio') ? form.bedrooms.filter(x => x !== 'Studio') : [...form.bedrooms, 'Studio'])}
                        className={cn('px-3 py-2 rounded border text-sm transition-all',
                          form.bedrooms.includes('Studio') ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        Studio
                      </button>
                    )}
                  </div>
                </Field>

                {/* ── Bathrooms ── */}
                <Field label="Bathrooms">
                  <div className="flex gap-1.5">
                    {['1', '2', '3+'].map(b => (
                      <button key={b} type="button"
                        onClick={() => set('bathrooms', form.bathrooms.includes(b) ? form.bathrooms.filter(x => x !== b) : [...form.bathrooms, b])}
                        className={cn('px-4 py-2 rounded border text-sm transition-all',
                          form.bathrooms.includes(b) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* ── Move-in Date ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Move-in Date</p>
                  <div className="flex gap-1.5 flex-wrap mb-2">
                    {MOVE_IN_OPTIONS.map(o => (
                      <button key={o} type="button"
                        onClick={() => set('move_in', form.move_in === o ? '' : o)}
                        className={cn('text-xs px-2.5 py-1.5 rounded border transition-all',
                          form.move_in === o ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {o}
                      </button>
                    ))}
                  </div>
                  {/* Specific date (non-keyword) */}
                  {!MOVE_IN_OPTIONS.filter(o => o !== 'Other').includes(form.move_in) && form.move_in !== 'Other' && (
                    <input type="date" value={form.move_in.match(/^\d{4}/) ? form.move_in : ''}
                      onChange={e => set('move_in', e.target.value)}
                      className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                  )}
                  {form.move_in === 'Other' && (
                    <input type="text" value={form.movein_other_comment} onChange={e => set('movein_other_comment', e.target.value)}
                      placeholder="Describe timing..."
                      className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy text-sm placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                  )}
                </div>

                {/* ── Property Types ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                    Property Type
                    {form.property_types.length > 0 && <span className="ml-2 text-gold normal-case">{form.property_types.length} selected</span>}
                  </p>
                  <div className="space-y-2">
                    {PROPERTY_TYPE_GROUPS.map(g => (
                      <div key={g.label}>
                        <p className="text-xs text-navy/30 mb-1">{g.label}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {g.types.map(pt => (
                            <button key={pt} type="button"
                              onClick={() => set('property_types', form.property_types.includes(pt) ? form.property_types.filter(x => x !== pt) : [...form.property_types, pt])}
                              className={cn('text-xs px-2.5 py-1.5 rounded-full border transition-all',
                                form.property_types.includes(pt) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25 hover:text-navy')}>
                              {pt}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Available for Viewings ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Available for Viewings</p>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {[
                      { key: 'now', label: 'Now' },
                      { key: 'specific', label: 'From specific date' },
                      { key: 'virtual', label: 'Virtual Viewings' },
                    ].map(opt => (
                      <button key={opt.key} type="button"
                        onClick={() => set('viewings_type', opt.key as typeof form.viewings_type)}
                        className={cn('px-3 py-1.5 rounded border text-sm transition-all',
                          form.viewings_type === opt.key ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {form.viewings_type === 'specific' && (
                    <input type="date" value={form.viewings_specific_date}
                      onChange={e => set('viewings_specific_date', e.target.value)}
                      className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                  )}
                </div>

                {/* ── LocationSelector ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Locations</p>
                  <LocationSelector value={locations} onChange={setLocations} />
                </div>

                {/* ── Features ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Features</p>
                  <div className="flex flex-wrap gap-1.5">
                    {FEATURES.map(f => (
                      <button key={f.key} type="button" onClick={() => toggleFeat(f.key)}
                        className={cn('flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border transition-all',
                          form.features.includes(f.key) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {f.icon} {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Furniture Style ── */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Furniture Style Preference</p>
                  <div className="flex flex-wrap gap-2">
                    {FURNITURE_STYLES.map(s => (
                      <button key={s} type="button" onClick={() => set('furniture_style', s)}
                        className={cn('px-3 py-1.5 rounded border text-sm transition-all',
                          form.furniture_style === s ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Description (required) ── */}
                <div className="md:col-span-2">
                  <Field label="Description" required>
                    <textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)}
                      placeholder="Describe the client's search — what they're looking for, why Malta, any specific requirements... (min 50 characters)"
                      className={cn('w-full px-4 py-2.5 border rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm',
                        errors.description ? 'border-red-400' : 'border-navy/15')} />
                    <div className="flex justify-between items-center mt-1">
                      {errors.description
                        ? <p className="text-red-400 text-xs">{errors.description}</p>
                        : <span />}
                      <span className={cn('text-xs', form.description.length < 50 ? 'text-navy/30' : 'text-green-600')}>
                        {form.description.length}/50 min
                      </span>
                    </div>
                  </Field>
                </div>

                {/* ── Client Wishes ── */}
                <Field label="Client Wishes">
                  <textarea rows={2} value={form.wishes} onChange={e => set('wishes', e.target.value)}
                    placeholder="Quiet street, no ground floor, near expat areas..."
                    className="w-full px-4 py-2.5 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm" />
                </Field>

                {/* ── Internal Notes ── */}
                <Field label="Internal Notes (admin only)">
                  <textarea rows={2} value={form.internal_notes} onChange={e => set('internal_notes', e.target.value)}
                    placeholder="Spoke on WhatsApp, very motivated, flexible on location..."
                    className="w-full px-4 py-2.5 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm" />
                </Field>

              </div>

              {/* Submit */}
              <div className="mt-8 pt-6 border-t border-navy/5">
                {Object.keys(errors).length > 0 && (
                  <p className="text-red-400 text-sm mb-4">Please fix the errors above before submitting.</p>
                )}
                <button type="button" onClick={submit} disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 py-4 bg-navy text-white rounded-lg font-semibold text-base hover:opacity-90 transition-opacity disabled:opacity-50">
                  {submitting
                    ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving...</>
                    : <><Check className="w-5 h-5" />Add Client</>}
                </button>
              </div>
            </div>
          </div>
        </section>

        <Footer />
      </main>
    </>
  )
}
