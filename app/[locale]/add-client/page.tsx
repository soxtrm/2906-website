'use client'

import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { Slider } from '@/components/ui/slider'
import { LocationSelector, type LocationSelectorValue } from '@/components/location-selector'
import { Check, Info, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import ReactCountryFlag from 'react-country-flag'
import countriesData from 'world-countries'

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
  { label: 'Special',    types: ['Boathouse', 'Garage'] },
  { label: 'Commercial', types: ['Office', 'Retail', 'Commercial Garage', 'Restaurant/Canteen', 'Gym'] },
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
  { code: '+356', flag: '🇲🇹', name: 'Malta' },
  { code: '+49',  flag: '🇩🇪', name: 'Germany' },
  { code: '+44',  flag: '🇬🇧', name: 'UK' },
  { code: '+1',   flag: '🇺🇸', name: 'USA' },
  { code: '+33',  flag: '🇫🇷', name: 'France' },
  { code: '+39',  flag: '🇮🇹', name: 'Italy' },
  { code: '+34',  flag: '🇪🇸', name: 'Spain' },
  { code: '+31',  flag: '🇳🇱', name: 'Netherlands' },
  { code: '+41',  flag: '🇨🇭', name: 'Switzerland' },
  { code: '+43',  flag: '🇦🇹', name: 'Austria' },
  { code: '+7',   flag: '🇷🇺', name: 'Russia' },
  { code: '+971', flag: '🇦🇪', name: 'UAE' },
  { code: '+380', flag: '🇺🇦', name: 'Ukraine' },
  { code: '+91',  flag: '🇮🇳', name: 'India' },
  { code: '+86',  flag: '🇨🇳', name: 'China' },
  { code: '+61',  flag: '🇦🇺', name: 'Australia' },
]

const AGENTS = ['Kev', 'Olga', 'Tatyana', 'Inna', 'Oleg', 'Kevin Christian', 'Anselme', 'Julia', 'Ksenia', 'Isabel', 'Other']

const STEPS = [
  { label: 'Contact',      title: 'Contact & Agent' },
  { label: 'Profile',      title: 'Client Profile' },
  { label: 'Requirements', title: 'Search Requirements' },
  { label: 'Details',      title: 'Preferences & Notes' },
]

const SORTED_COUNTRIES = [...countriesData].sort((a, b) => a.name.common.localeCompare(b.name.common))

type GroupType = '' | 'single' | 'couple' | 'sharing' | 'family' | 'other'

interface SharingPerson {
  name: string; nationality: string; job: string; age: string
}

const defaultForm = {
  name: '', email: '', phone: '', dial: '+356',
  nationality: '',
  lead_agent: '',
  lead_agent_other: '',
  group_size: 1,
  pets: '',
  group_type: '' as GroupType,
  group_type_comment: '',
  sharing_persons: [] as SharingPerson[],
  family_children_count: '',
  profession: '',
  occupation_location: '',
  description: '',
  budget_min: 1000, budget_max: 2500,
  bedrooms: [] as string[], bathrooms: [] as string[],
  bedrooms_other_value: '', bathrooms_other_value: '',
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

function DialCodePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const current = COUNTRY_CODES.find(c => c.code === value) ?? COUNTRY_CODES[0]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button"
          className="flex items-center gap-1 border border-navy/15 rounded px-2.5 py-2.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 hover:border-navy/30 transition-colors whitespace-nowrap">
          <span className="text-base leading-none">{current.flag}</span>
          <span className="text-xs text-navy/70">{current.code}</span>
          <ChevronDown className="w-3 h-3 text-navy/40" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1.5 max-h-64 overflow-y-auto">
        {COUNTRY_CODES.map(c => (
          <button key={c.code} type="button" onClick={() => onChange(c.code)}
            className={cn('w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-navy/5 transition-colors text-left',
              c.code === value && 'bg-gold/10 font-medium')}>
            <span className="text-base leading-none">{c.flag}</span>
            <span className="text-navy/70 text-xs">{c.code}</span>
            <span className="text-navy/50 text-xs ml-auto">{c.name}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function CountryPicker({ value, onChange, error, placeholder, small }: {
  value: string; onChange: (v: string) => void; error?: boolean; placeholder?: string; small?: boolean
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() =>
    SORTED_COUNTRIES.filter(c =>
      c.name.common.toLowerCase().includes(search.toLowerCase()) ||
      c.cca2.toLowerCase().includes(search.toLowerCase())
    ),
    [search]
  )

  const selected = SORTED_COUNTRIES.find(c => c.cca2 === value)

  return (
    <Popover open={open} onOpenChange={v => { setOpen(v); if (!v) setSearch('') }}>
      <PopoverTrigger asChild>
        <button type="button"
          className={cn(
            'w-full flex items-center gap-2 border rounded focus:outline-none focus:ring-2 focus:ring-gold/40 transition-colors text-left',
            small ? 'px-3 py-2 text-xs' : 'px-4 py-2.5 text-sm',
            error ? 'border-red-400' : 'border-navy/15',
            !selected ? 'text-navy/30' : 'text-navy'
          )}>
          {selected ? (
            <>
              <ReactCountryFlag countryCode={value} svg style={{ width: '1.1rem', height: '0.8rem', flexShrink: 0 }} />
              <span className="truncate">{selected.name.common}</span>
            </>
          ) : (
            <span className="truncate">{placeholder ?? 'Select country...'}</span>
          )}
          <ChevronDown className="w-3 h-3 ml-auto text-navy/40 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" onOpenAutoFocus={e => e.preventDefault()}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search country..."
          className="w-full px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40 mb-1"
          autoFocus
        />
        <div className="max-h-52 overflow-y-auto space-y-0.5">
          {filtered.map(c => (
            <button key={c.cca2} type="button"
              onClick={() => { onChange(c.cca2); setOpen(false); setSearch('') }}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-sm hover:bg-navy/5 transition-colors text-left',
                c.cca2 === value && 'bg-gold/10 font-medium'
              )}>
              <ReactCountryFlag countryCode={c.cca2} svg style={{ width: '1.25rem', height: '0.875rem', flexShrink: 0 }} />
              <span className="text-navy/80 truncate">{c.name.common}</span>
              <span className="text-navy/30 text-xs ml-auto shrink-0">{c.cca2}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
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
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
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

  const toggleFeat = (k: string) => {
    if (form.features.includes(k)) {
      const next = form.features.filter(f => f !== k)
      if (k === 'pets') setForm(prev => ({ ...prev, features: next, pets: '' }))
      else set('features', next)
    } else {
      set('features', [...form.features, k])
    }
  }

  const updateGroupSize = (n: number) => {
    if (form.group_type === 'sharing') {
      const count = Math.max(0, n - 1)
      const persons = [...form.sharing_persons]
      while (persons.length < count) persons.push({ name: '', nationality: form.nationality, job: '', age: '' })
      setForm(prev => ({ ...prev, group_size: n, sharing_persons: persons.slice(0, count) }))
    } else {
      set('group_size', n)
    }
  }

  const updateGroupType = (gt: GroupType) => {
    const next: typeof form = { ...form, group_type: gt, group_type_comment: '', sharing_persons: [], family_children_count: '' }
    if (gt === 'sharing') {
      const count = Math.max(0, form.group_size - 1)
      next.sharing_persons = Array.from({ length: count }, () => ({ name: '', nationality: form.nationality, job: '', age: '' }))
    }
    setForm(next)
  }

  const updateSharingPerson = (i: number, field: keyof SharingPerson, val: string) => {
    const persons = [...form.sharing_persons]
    persons[i] = { ...persons[i], [field]: val }
    setForm(prev => ({ ...prev, sharing_persons: persons }))
    setErrors(prev => {
      const e = { ...prev }
      delete e[`sharing_nationality_${i}`]
      delete e[`sharing_job_${i}`]
      return e
    })
  }

  const validateStep = (s: number): Record<string, string> => {
    const e: Record<string, string> = {}
    if (s === 0) {
      if (!form.name.trim()) e.name = 'Required'
      if (!form.lead_agent.trim()) e.lead_agent = 'Required'
    }
    if (s === 1) {
      if (!form.nationality) e.nationality = 'Required'
      if (!form.profession.trim()) e.profession = 'Required'
      if (form.group_type === 'sharing') {
        form.sharing_persons.forEach((p, i) => {
          if (!p.nationality) e[`sharing_nationality_${i}`] = 'Required'
          if (!p.job.trim()) e[`sharing_job_${i}`] = 'Required'
        })
      }
    }
    return e
  }

  const goNext = () => {
    const e = validateStep(step)
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({})
    setDirection(1)
    setStep(s => s + 1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const goBack = () => {
    setErrors({})
    setDirection(-1)
    setStep(s => s - 1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submit = async () => {
    const e = validateStep(3)
    if (Object.keys(e).length) { setErrors(e); return }

    setSubmitting(true)
    try {
      const bedroomsFinal = form.bedrooms.map(b => b === 'Other' && form.bedrooms_other_value ? form.bedrooms_other_value : b)
      const bathroomsFinal = form.bathrooms.map(b => b === 'Other' && form.bathrooms_other_value ? form.bathrooms_other_value : b)

      const payload = {
        name: form.name.trim(),
        email: form.email || null,
        phone: form.phone ? `${form.dial}${form.phone}` : null,
        nationality: form.nationality || null,
        lead_agent: form.lead_agent === 'Other' ? (form.lead_agent_other || 'Other') : (form.lead_agent || null),
        group_size: form.group_size > 1 ? form.group_size : null,
        pets: form.features.includes('pets') ? (form.pets || 'yes') : null,
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
        bedrooms: bedroomsFinal.length > 0 ? bedroomsFinal.join(',') : null,
        bathrooms: bathroomsFinal.length > 0 ? bathroomsFinal.join(',') : null,
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
        setStep(0)
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

  // ── Step renderers ────────────────────────────────────────────────────────────

  const renderStep = () => {
    switch (step) {

      case 0: return (
        <div className="grid md:grid-cols-2 gap-6">
          <Field label="Client Name" required>
            <input type="text" value={form.name} onChange={e => set('name', e.target.value)}
              placeholder="Maria Borg" className={inputCls(errors.name)} />
            {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
          </Field>

          <Field label="Lead Agent" required>
            <div className="flex flex-wrap gap-1.5">
              {AGENTS.map(a => (
                <button key={a} type="button" onClick={() => { set('lead_agent', a); set('lead_agent_other', '') }}
                  className={cn('px-3 py-1.5 rounded border text-sm transition-all',
                    form.lead_agent === a ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25 hover:text-navy')}>
                  {a}
                </button>
              ))}
            </div>
            {form.lead_agent === 'Other' && (
              <input type="text" value={form.lead_agent_other} onChange={e => set('lead_agent_other', e.target.value)}
                placeholder="Name eingeben..." className={cn(inputCls(), 'mt-2')} />
            )}
            {errors.lead_agent && <p className="text-red-400 text-xs mt-1">{errors.lead_agent}</p>}
          </Field>

          <Field label="Email">
            <input type="email" value={form.email} onChange={e => set('email', e.target.value)}
              placeholder="client@email.com" className={inputCls()} />
          </Field>

          <Field label="Phone (optional)">
            <div className="flex gap-2">
              <DialCodePicker value={form.dial} onChange={v => set('dial', v)} />
              <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)}
                placeholder="79000000" className={cn(inputCls(), 'flex-1')} />
            </div>
          </Field>
        </div>
      )

      case 1: return (
        <div className="grid md:grid-cols-2 gap-6">
          <Field label="Nationality" required>
            <CountryPicker
              value={form.nationality}
              onChange={v => set('nationality', v)}
              error={!!errors.nationality}
              placeholder="Select nationality..."
            />
            {errors.nationality && <p className="text-red-400 text-xs mt-1">{errors.nationality}</p>}
          </Field>

          <Field label="Profession" required>
            <input type="text" value={form.profession} onChange={e => set('profession', e.target.value)}
              placeholder="e.g. Remote worker, Finance" className={inputCls(errors.profession)} />
            {errors.profession && <p className="text-red-400 text-xs mt-1">{errors.profession}</p>}
          </Field>

          <Field label="Occupation Location" hint="City/area where they work — useful for commute planning">
            <input type="text" value={form.occupation_location} onChange={e => set('occupation_location', e.target.value)}
              placeholder="e.g. Valletta, Qormi" className={inputCls()} />
          </Field>

          <div className="md:col-span-2">
            <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Group Size</p>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" onClick={() => updateGroupSize(n)}
                  className={cn('flex-1 py-2 rounded border text-sm transition-all',
                    form.group_size === n ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                  {n === 5 ? '5+' : n}
                </button>
              ))}
            </div>
          </div>

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

            {form.group_type === 'sharing' && form.sharing_persons.length > 0 && (
              <div className="border border-navy/10 rounded-lg p-4 space-y-3 bg-navy/[0.02]">
                <p className="text-xs text-navy/40 mb-2">Additional person details <span className="text-red-400">*</span></p>
                {form.sharing_persons.map((p, i) => (
                  <div key={i} className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <input value={p.name} onChange={e => updateSharingPerson(i, 'name', e.target.value)}
                      placeholder={`Person ${i + 2} name`}
                      className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                    <CountryPicker
                      value={p.nationality}
                      onChange={v => updateSharingPerson(i, 'nationality', v)}
                      error={!!errors[`sharing_nationality_${i}`]}
                      placeholder="Nationality *"
                      small
                    />
                    <input value={p.job} onChange={e => updateSharingPerson(i, 'job', e.target.value)}
                      placeholder="Job *"
                      className={cn(
                        'px-3 py-2 border rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40',
                        errors[`sharing_job_${i}`] ? 'border-red-400' : 'border-navy/15'
                      )} />
                    <input value={p.age} onChange={e => updateSharingPerson(i, 'age', e.target.value)}
                      placeholder="Age"
                      className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                  </div>
                ))}
              </div>
            )}

            {form.group_type === 'family' && (
              <div className="flex items-center gap-3">
                <label className="text-sm text-navy/60">Number of children:</label>
                <input type="number" min="0" max="10" value={form.family_children_count}
                  onChange={e => set('family_children_count', e.target.value)}
                  className="w-20 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy focus:outline-none focus:ring-1 focus:ring-gold/40" />
              </div>
            )}

            {form.group_type === 'other' && (
              <textarea rows={2} value={form.group_type_comment}
                onChange={e => set('group_type_comment', e.target.value)}
                placeholder="Describe the group..."
                className="w-full px-3 py-2 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40 resize-none" />
            )}
          </div>
        </div>
      )

      case 2: return (
        <div className="space-y-6">
          <div>
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

          <div className="grid md:grid-cols-2 gap-6">
            <Field label="Bedrooms">
              <div className="flex gap-1.5 flex-wrap">
                {['1', '2', '3', '4', 'Other'].map(b => (
                  <button key={b} type="button"
                    onClick={() => set('bedrooms', form.bedrooms.includes(b) ? form.bedrooms.filter(x => x !== b) : [...form.bedrooms, b])}
                    className={cn('px-3 py-2 rounded border text-sm transition-all',
                      form.bedrooms.includes(b) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                    {b}
                  </button>
                ))}
                {showStudio && (
                  <button type="button"
                    onClick={() => set('bedrooms', form.bedrooms.includes('Studio') ? form.bedrooms.filter(x => x !== 'Studio') : [...form.bedrooms, 'Studio'])}
                    className={cn('px-3 py-2 rounded border text-sm transition-all',
                      form.bedrooms.includes('Studio') ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                    Studio
                  </button>
                )}
              </div>
              {form.bedrooms.includes('Other') && (
                <input
                  type="number" min="1" max="20"
                  value={form.bedrooms_other_value}
                  onChange={e => set('bedrooms_other_value', e.target.value)}
                  placeholder="Enter number..."
                  className="mt-2 w-32 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40"
                />
              )}
            </Field>

            <Field label="Bathrooms">
              <div className="flex gap-1.5 flex-wrap">
                {['1', '2', '3', '4', 'Other'].map(b => (
                  <button key={b} type="button"
                    onClick={() => set('bathrooms', form.bathrooms.includes(b) ? form.bathrooms.filter(x => x !== b) : [...form.bathrooms, b])}
                    className={cn('px-4 py-2 rounded border text-sm transition-all',
                      form.bathrooms.includes(b) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                    {b}
                  </button>
                ))}
              </div>
              {form.bathrooms.includes('Other') && (
                <input
                  type="number" min="1" max="20"
                  value={form.bathrooms_other_value}
                  onChange={e => set('bathrooms_other_value', e.target.value)}
                  placeholder="Enter number..."
                  className="mt-2 w-32 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40"
                />
              )}
            </Field>
          </div>

          <div>
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

          <div>
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

          <div>
            <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Available for Viewings</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {[
                { key: 'now',      label: 'Now' },
                { key: 'specific', label: 'From specific date' },
                { key: 'virtual',  label: 'Virtual Viewings' },
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

          <div>
            <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Locations</p>
            <LocationSelector value={locations} onChange={setLocations} />
          </div>
        </div>
      )

      default: return (
        <div className="space-y-6">
          <div>
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
            {form.features.includes('pets') && (
              <div className="mt-3">
                <input type="text" value={form.pets} onChange={e => set('pets', e.target.value)}
                  placeholder="e.g. 1 dog, 2 cats (optional)"
                  className="w-full md:w-72 px-3 py-2 border border-gold/30 bg-gold/5 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
              </div>
            )}
          </div>

          <div>
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

          <div className="grid md:grid-cols-2 gap-6">
            <Field label="Client Wishes">
              <textarea rows={3} value={form.wishes} onChange={e => set('wishes', e.target.value)}
                placeholder="Quiet street, no ground floor, near expat areas..."
                className="w-full px-4 py-2.5 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm" />
            </Field>

            <Field label="Internal Notes (admin only)">
              <textarea rows={3} value={form.internal_notes} onChange={e => set('internal_notes', e.target.value)}
                placeholder="Spoke on WhatsApp, very motivated, flexible on location..."
                className="w-full px-4 py-2.5 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm" />
            </Field>
          </div>
        </div>
      )
    }
  }

  return (
    <>
      <main className="min-h-screen bg-off-white">
        <Header />

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
          <div className="container mx-auto px-4 lg:px-8 max-w-3xl">

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

            <div className="mb-6 flex items-center">
              {STEPS.map((s, i) => (
                <div key={i} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all',
                      i < step ? 'bg-gold text-white' : i === step ? 'bg-navy text-white' : 'bg-navy/10 text-navy/40'
                    )}>
                      {i < step ? <Check className="w-4 h-4" /> : i + 1}
                    </div>
                    <span className={cn('text-xs mt-1 hidden sm:block', i === step ? 'text-navy font-medium' : 'text-navy/40')}>
                      {s.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={cn('flex-1 h-0.5 mx-2 mb-3 transition-all', i < step ? 'bg-gold' : 'bg-navy/10')} />
                  )}
                </div>
              ))}
            </div>

            <div className="bg-white rounded-xl border border-navy/5 shadow-sm p-6 md:p-8">
              <h2 className="font-serif text-lg text-navy mb-6 pb-4 border-b border-navy/5">
                {STEPS[step].title}
              </h2>

              <AnimatePresence mode="wait">
                <motion.div key={step}
                  initial={{ opacity: 0, x: direction * 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -direction * 24 }}
                  transition={{ duration: 0.18 }}>
                  {renderStep()}
                </motion.div>
              </AnimatePresence>

              <div className="mt-8 pt-6 border-t border-navy/5 flex items-center justify-between">
                {step > 0 ? (
                  <button type="button" onClick={goBack}
                    className="flex items-center gap-1.5 px-5 py-2.5 border border-navy/15 text-navy/60 rounded-lg hover:border-navy/30 hover:text-navy transition-all text-sm">
                    <ChevronLeft className="w-4 h-4" /> Back
                  </button>
                ) : <div />}

                {step < STEPS.length - 1 ? (
                  <button type="button" onClick={goNext}
                    className="flex items-center gap-1.5 px-7 py-2.5 bg-navy text-white rounded-lg font-medium hover:opacity-90 transition-opacity text-sm">
                    Next <ChevronRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button type="button" onClick={submit} disabled={submitting}
                    className="flex items-center gap-2 px-7 py-2.5 bg-navy text-white rounded-lg font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 text-sm">
                    {submitting
                      ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving...</>
                      : <><Check className="w-4 h-4" />Add Client</>}
                  </button>
                )}
              </div>
            </div>

          </div>
        </section>

        <Footer />
      </main>
    </>
  )
}
