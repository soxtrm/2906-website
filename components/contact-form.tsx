'use client'

import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { Slider } from '@/components/ui/slider'
import { Check, ChevronDown, MessageCircle, BedDouble, Bath, Sparkles, Home } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LocationSelector, type LocationSelectorValue } from '@/components/location-selector'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import ReactCountryFlag from 'react-country-flag'
import countriesData from 'world-countries'

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

// ── Country codes (phone dial) ────────────────────────────────────────────────
const COUNTRY_CODES = [
  { code: '+356', label: 'Malta',        flag: '🇲🇹' },
  { code: '+49',  label: 'Germany',      flag: '🇩🇪' },
  { code: '+44',  label: 'UK',           flag: '🇬🇧' },
  { code: '+1',   label: 'USA/CA',       flag: '🇺🇸' },
  { code: '+33',  label: 'France',       flag: '🇫🇷' },
  { code: '+39',  label: 'Italy',        flag: '🇮🇹' },
  { code: '+34',  label: 'Spain',        flag: '🇪🇸' },
  { code: '+31',  label: 'Netherlands',  flag: '🇳🇱' },
  { code: '+41',  label: 'Switzerland',  flag: '🇨🇭' },
  { code: '+43',  label: 'Austria',      flag: '🇦🇹' },
  { code: '+32',  label: 'Belgium',      flag: '🇧🇪' },
  { code: '+46',  label: 'Sweden',       flag: '🇸🇪' },
  { code: '+47',  label: 'Norway',       flag: '🇳🇴' },
  { code: '+45',  label: 'Denmark',      flag: '🇩🇰' },
  { code: '+358', label: 'Finland',      flag: '🇫🇮' },
  { code: '+48',  label: 'Poland',       flag: '🇵🇱' },
  { code: '+351', label: 'Portugal',     flag: '🇵🇹' },
  { code: '+30',  label: 'Greece',       flag: '🇬🇷' },
  { code: '+7',   label: 'Russia',       flag: '🇷🇺' },
  { code: '+380', label: 'Ukraine',      flag: '🇺🇦' },
  { code: '+90',  label: 'Turkey',       flag: '🇹🇷' },
  { code: '+971', label: 'UAE',          flag: '🇦🇪' },
  { code: '+966', label: 'Saudi Arabia', flag: '🇸🇦' },
  { code: '+972', label: 'Israel',       flag: '🇮🇱' },
  { code: '+91',  label: 'India',        flag: '🇮🇳' },
  { code: '+86',  label: 'China',        flag: '🇨🇳' },
  { code: '+82',  label: 'South Korea',  flag: '🇰🇷' },
  { code: '+81',  label: 'Japan',        flag: '🇯🇵' },
  { code: '+61',  label: 'Australia',    flag: '🇦🇺' },
  { code: '+55',  label: 'Brazil',       flag: '🇧🇷' },
]

// ── Property types ────────────────────────────────────────────────────────────
const PROPERTY_TYPES = [
  'Apartment', 'Penthouse', 'Maisonette', 'Townhouse', 'Villa', 'Farmhouse', 'House of Character',
]

// ── Features ──────────────────────────────────────────────────────────────────
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

// ── Professions ───────────────────────────────────────────────────────────────
const PROFESSIONS = [
  'Remote Worker', 'IT / Tech', 'Finance', 'Healthcare',
  'Education', 'Legal', 'Business', 'Student', 'Retired', 'Other',
]

const SORTED_COUNTRIES = [...countriesData].sort((a, b) => a.name.common.localeCompare(b.name.common))

// ── Slide animation ───────────────────────────────────────────────────────────
const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit:   (dir: number) => ({ x: dir > 0 ? -60 : 60, opacity: 0 }),
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface SharingPerson {
  name: string
  nationality: string
  professions: string[]
  professions_other: string
  age: string
}

interface FormData {
  name: string
  countryCode: string
  phone: string
  email: string
  nationality: string
  group_size: number
  group_size_other: string
  hasPets: boolean
  pets: string
  professions: string[]
  professions_other: string
  sharing_persons: SharingPerson[]
  budget_min: number
  budget_max: number
  bedrooms: string[]
  bathrooms: string[]
  bedrooms_other_value: string
  bathrooms_other_value: string
  property_types: string[]
  move_in: string
  move_in_custom: string
  locationValue: LocationSelectorValue
  open_to_suggestions: boolean
  features: string[]
  living_situation: '' | 'couple' | 'family' | 'sharing'
  wishes: string
  comments: string
}

const defaultForm: FormData = {
  name: '', countryCode: '+356', phone: '', email: '',
  nationality: '', group_size: 1, group_size_other: '',
  hasPets: false, pets: '',
  professions: [], professions_other: '',
  sharing_persons: [],
  budget_min: 1000, budget_max: 2500,
  bedrooms: [], bathrooms: [],
  bedrooms_other_value: '', bathrooms_other_value: '',
  property_types: [],
  move_in: '', move_in_custom: '',
  locationValue: { selectedAreas: [], preferredVillages: [], topPriorityVillages: [] },
  open_to_suggestions: false,
  features: [], living_situation: '', wishes: '', comments: '',
}

// ── Reusable UI ───────────────────────────────────────────────────────────────
function OptionCard({ active, onClick, children, className }: {
  active: boolean; onClick: () => void; children: React.ReactNode; className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'border rounded-lg px-3 py-2.5 text-sm font-medium transition-all select-none',
        active
          ? 'border-gold bg-gold/10 text-navy ring-1 ring-gold'
          : 'border-navy/10 bg-white text-navy/60 hover:border-navy/30 hover:text-navy',
        className
      )}
    >
      {children}
    </button>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-navy/50 uppercase tracking-widest mb-2">{children}</p>
}

// ── CountryPicker ─────────────────────────────────────────────────────────────
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
        <button
          type="button"
          className={cn(
            'w-full flex items-center gap-2 border rounded focus:outline-none focus:ring-2 focus:ring-gold/40 transition-colors text-left',
            small ? 'px-3 py-2 text-xs' : 'px-4 py-2.5 text-sm',
            error ? 'border-red-400' : 'border-navy/15',
            !selected ? 'text-navy/30' : 'text-navy'
          )}
        >
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
            <button
              key={c.cca2}
              type="button"
              onClick={() => { onChange(c.cca2); setOpen(false); setSearch('') }}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-sm hover:bg-navy/5 transition-colors text-left',
                c.cca2 === value && 'bg-gold/10 font-medium'
              )}
            >
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

// ── ProfessionPicker ──────────────────────────────────────────────────────────
function ProfessionPicker({ selected, onToggle, otherValue, onOtherChange, error, small }: {
  selected: string[]
  onToggle: (p: string) => void
  otherValue: string
  onOtherChange: (v: string) => void
  error?: string
  small?: boolean
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {PROFESSIONS.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => onToggle(p)}
            className={cn(
              'rounded border transition-all',
              small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              selected.includes(p)
                ? 'border-gold bg-gold/10 text-navy font-medium'
                : 'border-navy/15 text-navy/50 hover:border-navy/25 hover:text-navy'
            )}
          >
            {p}
          </button>
        ))}
      </div>
      {selected.includes('Other') && (
        <input
          type="text"
          value={otherValue}
          onChange={e => onOtherChange(e.target.value)}
          placeholder="Please specify..."
          className={cn(
            'w-full border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40',
            small ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm',
            'border-navy/15'
          )}
        />
      )}
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export function ContactForm() {
  const t = useTranslations('form')
  const [step, setStep] = useState(1)
  const [dir, setDir] = useState(1)
  const [form, setForm] = useState<FormData>(defaultForm)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const set = useCallback(<K extends keyof FormData>(key: K, val: FormData[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key as string]; return e })
  }, [])

  const toggleFeature = (key: string) => {
    set('features', form.features.includes(key)
      ? form.features.filter(f => f !== key)
      : [...form.features, key]
    )
  }

  const setHasPets = useCallback((val: boolean) => {
    setForm(prev => ({
      ...prev,
      hasPets: val,
      features: val
        ? prev.features.includes('pets') ? prev.features : [...prev.features, 'pets']
        : prev.features.filter(f => f !== 'pets'),
    }))
  }, [])

  const updateGroupSize = (n: number) => {
    const count = Math.max(0, n === 6 ? (parseInt(form.group_size_other) || 1) - 1 : n - 1)
    const persons = [...form.sharing_persons]
    while (persons.length < count) {
      persons.push({ name: '', nationality: '', professions: [], professions_other: '', age: '' })
    }
    setForm(prev => ({
      ...prev,
      group_size: n,
      group_size_other: n === 6 ? prev.group_size_other : '',
      sharing_persons: persons.slice(0, count),
    }))
  }

  const applyGroupSizeOther = (raw: string) => {
    const n = parseInt(raw)
    const count = isNaN(n) || n < 2 ? 0 : n - 1
    const persons = [...form.sharing_persons]
    while (persons.length < count) {
      persons.push({ name: '', nationality: '', professions: [], professions_other: '', age: '' })
    }
    setForm(prev => ({
      ...prev,
      group_size_other: raw,
      sharing_persons: persons.slice(0, count),
    }))
  }

  const updateSharingPerson = (i: number, field: keyof SharingPerson, val: string | string[]) => {
    const persons = form.sharing_persons.map((p, idx) =>
      idx === i ? { ...p, [field]: val } : p
    )
    setForm(prev => ({ ...prev, sharing_persons: persons }))
    setErrors(prev => {
      const e = { ...prev }
      delete e[`sharing_nationality_${i}`]
      delete e[`sharing_professions_${i}`]
      return e
    })
  }

  const validate1 = (): Record<string, string> => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = t('required')
    if (!form.phone.trim()) e.phone = t('required')
    if (form.professions.length === 0) e.professions = t('required')
    form.sharing_persons.forEach((p, i) => {
      if (!p.nationality) e[`sharing_nationality_${i}`] = t('required')
      if (p.professions.length === 0) e[`sharing_professions_${i}`] = t('required')
    })
    return e
  }

  const go = (next: number) => {
    if (next > step && step === 1) {
      const e = validate1()
      if (Object.keys(e).length) { setErrors(e); return }
    }
    setDir(next > step ? 1 : -1)
    setStep(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submit = async () => {
    const e = validate1()
    if (Object.keys(e).length) { setErrors(e); go(1); return }
    setSubmitting(true)
    try {
      const effectiveGroupSize = form.group_size === 6
        ? (parseInt(form.group_size_other) || 6)
        : form.group_size

      const buildProfession = (profs: string[], other: string) =>
        [...profs.filter(p => p !== 'Other'), ...(profs.includes('Other') && other ? [other] : [])].join(', ')

      const bedroomsFinal = form.bedrooms.includes('Any') ? null
        : form.bedrooms.filter(b => b !== 'Any').map(b =>
            b === 'Other' && form.bedrooms_other_value ? form.bedrooms_other_value : b
          )
      const bathroomsFinal = form.bathrooms.includes('Any') ? null
        : form.bathrooms.filter(b => b !== 'Any').map(b =>
            b === 'Other' && form.bathrooms_other_value ? form.bathrooms_other_value : b
          )

      const payload = {
        name: form.name.trim(),
        phone: form.countryCode.replace('+', '') + form.phone.replace(/\D/g, ''),
        email: form.email || null,
        nationalities: form.nationality ? [form.nationality] : null,
        group_size: effectiveGroupSize > 1 ? effectiveGroupSize : null,
        pets: form.hasPets ? (form.pets || 'yes') : null,
        profession: buildProfession(form.professions, form.professions_other) || null,
        sharing_persons: form.sharing_persons.length > 0 ? form.sharing_persons.map(p => ({
          name: p.name || null,
          nationality: p.nationality || null,
          profession: buildProfession(p.professions, p.professions_other) || null,
          age: p.age || null,
        })) : null,
        budget_min: form.budget_min,
        budget_max: form.budget_max,
        bedrooms: bedroomsFinal && bedroomsFinal.length > 0 ? bedroomsFinal.join(',') : null,
        bathrooms: bathroomsFinal && bathroomsFinal.length > 0 ? bathroomsFinal.join(',') : null,
        property_types: form.property_types.length > 0 ? form.property_types.join(',') : null,
        move_in: form.move_in_custom || form.move_in || null,
        preferred_regions: form.locationValue.selectedAreas.length > 0 ? form.locationValue.selectedAreas : null,
        locations: [
          ...Array.from(new Set([...form.locationValue.preferredVillages, ...form.locationValue.topPriorityVillages])),
          ...(form.open_to_suggestions ? ['Open to suggestions'] : []),
        ],
        features: FEATURES.filter(f => form.features.includes(f.key)).map(f => f.label),
        living_situation: form.living_situation || null,
        wishes: form.wishes || null,
        comments: form.comments || null,
        source: 'website',
      }

      const res = await fetch('/api/contact-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (res.ok) {
        setSuccess(true)
      } else {
        const d = await res.json()
        alert(d.error || 'Something went wrong. Please try again.')
      }
    } catch {
      alert('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Success screen ──────────────────────────────────────────────────────────
  if (success) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="text-center py-16 px-4"
      >
        <div className="w-20 h-20 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: 'spring', stiffness: 260, damping: 20 }}
          >
            <Check className="w-10 h-10 text-gold" />
          </motion.div>
        </div>
        <h2 className="font-serif text-3xl text-navy mb-3">
          Thanks {form.name.split(' ')[0]}!
        </h2>
        <p className="text-navy/60 text-lg mb-8">{t('success_desc')}</p>
        <a
          href="https://wa.me/35679010070?text=Hi%20Olga%2C%20I%20just%20submitted%20a%20request%20on%202906.estate"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#25D366] text-white rounded font-medium hover:bg-[#20BD5A] transition-colors"
        >
          <MessageCircle className="w-5 h-5" />
          {t('wa_chat')}
        </a>
        <p className="text-navy/40 text-sm mt-3">Or call/WhatsApp +356 7901 0070</p>
      </motion.div>
    )
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Progress bar */}
      <div className="flex items-center gap-2 mb-8">
        {[1, 2, 3].map(s => (
          <div key={s} className="flex-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => s < step && go(s)}
              className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all shrink-0',
                s < step ? 'bg-gold text-white cursor-pointer hover:opacity-80' :
                s === step ? 'bg-navy text-white' :
                'bg-navy/10 text-navy/40 cursor-default'
              )}
            >
              {s < step ? <Check className="w-3.5 h-3.5" /> : s}
            </button>
            <div className={cn(
              'flex-1 h-0.5 rounded-full transition-all',
              s < step ? 'bg-gold' : 'bg-navy/10'
            )} />
          </div>
        ))}
      </div>

      {/* Step label */}
      <div className="mb-6">
        <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">
          Step {step} of 3
        </p>
        <h3 className="font-serif text-2xl text-navy">
          {step === 1 ? t('step1_title') : step === 2 ? t('step2_title') : t('step3_title')}
        </h3>
      </div>

      {/* Step content */}
      <AnimatePresence mode="wait" custom={dir}>
        <motion.div
          key={step}
          custom={dir}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.25, ease: 'easeInOut' }}
        >
          {step === 1 && (
            <Step1
              form={form}
              set={set}
              setHasPets={setHasPets}
              errors={errors}
              updateGroupSize={updateGroupSize}
              applyGroupSizeOther={applyGroupSizeOther}
              updateSharingPerson={updateSharingPerson}
              t={t}
            />
          )}
          {step === 2 && <Step2 form={form} set={set} t={t} />}
          {step === 3 && (
            <Step3
              form={form}
              set={set}
              toggleFeature={toggleFeature}
              togglePropertyType={(pt: string) =>
                set('property_types', form.property_types.includes(pt)
                  ? form.property_types.filter(x => x !== pt)
                  : [...form.property_types, pt])
              }
              t={t}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex gap-3 mt-8">
        {step > 1 && (
          <button
            type="button"
            onClick={() => go(step - 1)}
            className="px-5 py-3 rounded border border-navy/20 text-navy/60 hover:border-navy/40 hover:text-navy transition-colors text-sm"
          >
            {t('back')}
          </button>
        )}
        {step < 3 ? (
          <button
            type="button"
            onClick={() => go(step + 1)}
            className="flex-1 flex items-center justify-center gap-2 px-6 py-3.5 bg-navy text-white rounded font-medium hover:opacity-90 transition-opacity"
          >
            {t('next')}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="flex-1 flex items-center justify-center gap-2 px-6 py-3.5 bg-gold text-white rounded font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 text-base"
          >
            {submitting ? (
              <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{t('submitting')}</>
            ) : t('submit')}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Step 1: About You ─────────────────────────────────────────────────────────
function Step1({ form, set, setHasPets, errors, updateGroupSize, applyGroupSizeOther, updateSharingPerson, t }: {
  form: FormData
  set: <K extends keyof FormData>(k: K, v: FormData[K]) => void
  setHasPets: (val: boolean) => void
  errors: Record<string, string>
  updateGroupSize: (n: number) => void
  applyGroupSizeOther: (raw: string) => void
  updateSharingPerson: (i: number, field: keyof SharingPerson, val: string | string[]) => void
  t: (k: string) => string
}) {
  return (
    <div className="space-y-5">
      {/* Name */}
      <div>
        <Label>{t('name')} *</Label>
        <input
          type="text"
          value={form.name}
          onChange={e => set('name', e.target.value)}
          placeholder="Maria Borg"
          className={cn(
            'w-full px-4 py-3 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors',
            errors.name ? 'border-red-400' : 'border-navy/15'
          )}
        />
        {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
      </div>

      {/* Phone */}
      <div>
        <Label>{t('phone')} *</Label>
        <div className={cn(
          'flex border rounded overflow-hidden focus-within:ring-2 focus-within:ring-gold/40 focus-within:border-gold transition-colors',
          errors.phone ? 'border-red-400' : 'border-navy/15'
        )}>
          <div className="relative shrink-0">
            <select
              value={form.countryCode}
              onChange={e => set('countryCode', e.target.value)}
              className="appearance-none h-full pl-3 pr-7 bg-navy/5 text-navy text-sm font-medium border-r border-navy/10 focus:outline-none cursor-pointer"
            >
              {COUNTRY_CODES.map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-navy/40 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <input
            type="tel"
            value={form.phone}
            onChange={e => set('phone', e.target.value)}
            placeholder="9999 0001"
            className="flex-1 px-4 py-3 text-navy placeholder:text-navy/30 focus:outline-none bg-transparent"
          />
        </div>
        {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone}</p>}
      </div>

      {/* Email */}
      <div>
        <Label>{t('email')}</Label>
        <input
          type="email"
          value={form.email}
          onChange={e => set('email', e.target.value)}
          placeholder="you@email.com"
          className="w-full px-4 py-3 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
        />
      </div>

      {/* Nationality — CountryPicker with SVG flags */}
      <div>
        <Label>{t('nationality')}</Label>
        <CountryPicker
          value={form.nationality}
          onChange={v => set('nationality', v)}
          placeholder="Select your nationality..."
        />
      </div>

      {/* Group size: 1,2,3,4,5,Other */}
      <div>
        <Label>{t('group_size')}</Label>
        <div className="flex gap-2 flex-wrap">
          {[1, 2, 3, 4, 5].map(n => (
            <OptionCard
              key={n}
              active={form.group_size === n}
              onClick={() => updateGroupSize(n)}
              className="flex-1 flex flex-col items-center gap-1 py-3 min-w-[3rem]"
            >
              <span className="text-lg">
                {n === 1 ? '👤' : n === 2 ? '👫' : n === 3 ? '👨‍👩‍👦' : n === 4 ? '👨‍👩‍👧‍👦' : '👥'}
              </span>
              <span className="text-xs">{n}</span>
            </OptionCard>
          ))}
          <OptionCard
            active={form.group_size === 6}
            onClick={() => updateGroupSize(6)}
            className="flex-1 flex flex-col items-center gap-1 py-3 min-w-[3rem]"
          >
            <span className="text-lg">👥</span>
            <span className="text-xs">Other</span>
          </OptionCard>
        </div>
        {form.group_size === 6 && (
          <input
            type="number"
            min="2"
            max="50"
            value={form.group_size_other}
            onChange={e => applyGroupSizeOther(e.target.value)}
            placeholder="How many people?"
            className="mt-2 w-48 px-4 py-2.5 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 text-sm"
          />
        )}
      </div>

      {/* Profession — multi-select, mandatory */}
      <div>
        <Label>Profession *</Label>
        <ProfessionPicker
          selected={form.professions}
          onToggle={p => set('professions', form.professions.includes(p)
            ? form.professions.filter(x => x !== p)
            : [...form.professions, p]
          )}
          otherValue={form.professions_other}
          onOtherChange={v => set('professions_other', v)}
          error={errors.professions}
        />
      </div>

      {/* Sharing sub-form: shown when group_size ≥ 2 */}
      {form.sharing_persons.length > 0 && (
        <div>
          <Label>Additional Person Details</Label>
          <div className="border border-navy/10 rounded-lg p-4 space-y-5 bg-navy/[0.02]">
            {form.sharing_persons.map((p, i) => (
              <div key={i} className="space-y-2">
                <p className="text-xs text-navy/40 font-semibold uppercase tracking-wide">Person {i + 2}</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={p.name}
                    onChange={e => updateSharingPerson(i, 'name', e.target.value)}
                    placeholder="Name (optional)"
                    className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40"
                  />
                  <CountryPicker
                    value={p.nationality}
                    onChange={v => updateSharingPerson(i, 'nationality', v)}
                    error={!!errors[`sharing_nationality_${i}`]}
                    placeholder="Nationality *"
                    small
                  />
                  <input
                    type="number"
                    min="10"
                    max="120"
                    value={p.age}
                    onChange={e => updateSharingPerson(i, 'age', e.target.value)}
                    placeholder="Age (optional)"
                    className="px-3 py-2 border border-navy/15 rounded text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40"
                  />
                </div>
                {errors[`sharing_nationality_${i}`] && (
                  <p className="text-red-500 text-xs">{errors[`sharing_nationality_${i}`]}</p>
                )}
                <ProfessionPicker
                  selected={p.professions}
                  onToggle={prof => updateSharingPerson(i, 'professions',
                    p.professions.includes(prof)
                      ? p.professions.filter(x => x !== prof)
                      : [...p.professions, prof]
                  )}
                  otherValue={p.professions_other}
                  onOtherChange={v => updateSharingPerson(i, 'professions_other', v)}
                  error={errors[`sharing_professions_${i}`]}
                  small
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pets */}
      <div>
        <Label>{t('pets')}</Label>
        <div className="flex gap-2 mb-2">
          <OptionCard active={!form.hasPets} onClick={() => setHasPets(false)} className="flex-1">
            🚫 {t('no')}
          </OptionCard>
          <OptionCard active={form.hasPets} onClick={() => setHasPets(true)} className="flex-1">
            🐾 {t('yes')}
          </OptionCard>
        </div>
        {form.hasPets && (
          <input
            type="text"
            value={form.pets}
            onChange={e => set('pets', e.target.value)}
            placeholder={t('pets_placeholder')}
            className="w-full px-4 py-3 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
          />
        )}
      </div>

      {/* Living situation */}
      <div>
        <Label>Living Situation</Label>
        <div className="flex gap-2">
          {(['couple', 'family', 'sharing'] as const).map(opt => (
            <OptionCard
              key={opt}
              active={form.living_situation === opt}
              onClick={() => set('living_situation', form.living_situation === opt ? '' : opt)}
              className="flex-1"
            >
              {opt === 'couple' ? '👫 Couple' : opt === 'family' ? '👨‍👩‍👦 Family' : '🏠 Sharing'}
            </OptionCard>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Step 2: Budget & Space ────────────────────────────────────────────────────
function Step2({ form, set, t }: {
  form: FormData
  set: <K extends keyof FormData>(k: K, v: FormData[K]) => void
  t: (k: string) => string
}) {
  const isPremium = form.budget_min >= 2500

  const toggleBedroom = (b: string) => {
    if (b === 'Any') {
      set('bedrooms', form.bedrooms.includes('Any') ? [] : ['Any'])
    } else {
      const next = form.bedrooms.includes(b)
        ? form.bedrooms.filter(x => x !== b)
        : [...form.bedrooms.filter(x => x !== 'Any'), b]
      set('bedrooms', next)
    }
  }

  const toggleBathroom = (b: string) => {
    if (b === 'Any') {
      set('bathrooms', form.bathrooms.includes('Any') ? [] : ['Any'])
    } else {
      const next = form.bathrooms.includes(b)
        ? form.bathrooms.filter(x => x !== b)
        : [...form.bathrooms.filter(x => x !== 'Any'), b]
      set('bathrooms', next)
    }
  }

  return (
    <div className="space-y-7">
      {/* Budget slider — non-linear: 0%=€500, 50%=€2,000, 100%=€10,000 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <Label>{t('budget_range')}</Label>
          <div className="flex items-center gap-2">
            <span className="font-serif text-navy font-semibold">
              €{form.budget_min.toLocaleString()} – {form.budget_max >= 10000 ? '€10,000+' : `€${form.budget_max.toLocaleString()}`}
            </span>
            {isPremium && (
              <span className="text-xs px-2 py-0.5 bg-gold/15 text-gold border border-gold/30 rounded-full font-medium">
                {t('premium_badge')}
              </span>
            )}
          </div>
        </div>
        <Slider
          value={[budgetToSlider(form.budget_min), budgetToSlider(form.budget_max)]}
          onValueChange={([p1, p2]) => {
            set('budget_min', roundTo50(sliderToBudget(p1)))
            set('budget_max', roundTo50(sliderToBudget(p2)))
          }}
          min={0}
          max={100}
          step={1}
          className="mt-2"
        />
        <div className="relative mt-1.5 h-4 text-xs text-navy/40">
          <span className="absolute left-0">€0</span>
          <span className="absolute left-1/4 -translate-x-1/2">1K</span>
          <span className="absolute left-1/2 -translate-x-1/2">2K</span>
          <span className="absolute left-3/4 -translate-x-1/2">5K</span>
          <span className="absolute right-0">10K+</span>
        </div>
      </div>

      {/* Bedrooms */}
      <div>
        <Label>{t('bedrooms')}</Label>
        <div className="flex gap-2 flex-wrap">
          {['1', '2', '3', '4', 'Other', 'Any'].map(b => (
            <OptionCard
              key={b}
              active={form.bedrooms.includes(b)}
              onClick={() => toggleBedroom(b)}
              className="flex flex-col items-center gap-1 px-4 py-3"
            >
              {b !== 'Any' && b !== 'Other' && <BedDouble className="w-4 h-4" />}
              <span>{b}</span>
            </OptionCard>
          ))}
        </div>
        {form.bedrooms.includes('Other') && (
          <input
            type="number"
            min="1"
            max="20"
            value={form.bedrooms_other_value}
            onChange={e => set('bedrooms_other_value', e.target.value)}
            placeholder="Enter number..."
            className="mt-2 w-48 px-4 py-2.5 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 text-sm"
          />
        )}
      </div>

      {/* Bathrooms */}
      <div>
        <Label>{t('bathrooms')}</Label>
        <div className="flex gap-2 flex-wrap">
          {['1', '2', '3', '4', 'Other', 'Any'].map(b => (
            <OptionCard
              key={b}
              active={form.bathrooms.includes(b)}
              onClick={() => toggleBathroom(b)}
              className="flex flex-col items-center gap-1 px-4 py-3"
            >
              {b !== 'Any' && b !== 'Other' && <Bath className="w-4 h-4" />}
              <span>{b}</span>
            </OptionCard>
          ))}
        </div>
        {form.bathrooms.includes('Other') && (
          <input
            type="number"
            min="1"
            max="20"
            value={form.bathrooms_other_value}
            onChange={e => set('bathrooms_other_value', e.target.value)}
            placeholder="Enter number..."
            className="mt-2 w-48 px-4 py-2.5 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 text-sm"
          />
        )}
      </div>

      {/* Move-in */}
      <div>
        <Label>{t('move_in')}</Label>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {['ASAP', 'Within 1 month', 'Within 3 months', 'Flexible'].map(opt => (
            <OptionCard
              key={opt}
              active={form.move_in === opt && !form.move_in_custom}
              onClick={() => { set('move_in', opt); set('move_in_custom', '') }}
            >
              {opt}
            </OptionCard>
          ))}
        </div>
        <input
          type="date"
          value={form.move_in_custom}
          onChange={e => { set('move_in_custom', e.target.value); set('move_in', '') }}
          className="w-full px-4 py-3 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
          placeholder={t('move_in_specific')}
        />
      </div>
    </div>
  )
}

// ── Step 3: Where & What ──────────────────────────────────────────────────────
function Step3({ form, set, toggleFeature, togglePropertyType, t }: {
  form: FormData
  set: <K extends keyof FormData>(k: K, v: FormData[K]) => void
  toggleFeature: (key: string) => void
  togglePropertyType: (pt: string) => void
  t: (k: string) => string
}) {
  return (
    <div className="space-y-7">
      {/* Property type */}
      <div>
        <Label>Property Type</Label>
        <div className="flex flex-wrap gap-1.5">
          {PROPERTY_TYPES.map(pt => (
            <button
              key={pt}
              type="button"
              onClick={() => togglePropertyType(pt)}
              className={cn(
                'text-xs px-3 py-1.5 rounded-full border transition-all flex items-center gap-1.5',
                form.property_types.includes(pt)
                  ? 'border-gold bg-gold/10 text-navy font-medium'
                  : 'border-navy/15 text-navy/50 hover:border-navy/30 hover:text-navy'
              )}
            >
              <Home className="w-3 h-3" />
              {pt}
            </button>
          ))}
        </div>
      </div>

      {/* Location Selector */}
      <div>
        <Label>{t('locations')}</Label>
        <LocationSelector
          value={form.locationValue}
          onChange={v => set('locationValue', v)}
          showPriority={false}
        />
        <div className="mt-3">
          <button
            type="button"
            onClick={() => set('open_to_suggestions', !form.open_to_suggestions)}
            className={cn(
              'text-sm px-4 py-2 rounded-full border transition-all flex items-center gap-2',
              form.open_to_suggestions
                ? 'border-gold bg-gold/10 text-navy font-medium'
                : 'border-navy/15 text-navy/50 hover:border-navy/30'
            )}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {t('open_to_suggestions')}
          </button>
        </div>
      </div>

      {/* Features */}
      <div>
        <Label>{t('features')}</Label>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {FEATURES.map(f => (
            <button
              key={f.key}
              type="button"
              onClick={() => toggleFeature(f.key)}
              className={cn(
                'flex flex-col items-center gap-1 p-2.5 rounded-lg border text-center transition-all',
                form.features.includes(f.key)
                  ? 'border-gold bg-gold/10 text-navy'
                  : 'border-navy/10 text-navy/50 hover:border-navy/25 hover:text-navy'
              )}
            >
              <span className="text-xl leading-none">{f.icon}</span>
              <span className="text-xs">{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Wishes */}
      <div>
        <Label>{t('wishes')}</Label>
        <textarea
          rows={2}
          value={form.wishes}
          onChange={e => set('wishes', e.target.value)}
          placeholder={t('wishes_placeholder')}
          className="w-full px-4 py-3 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
        />
      </div>

      {/* Comments */}
      <div>
        <Label>{t('comments')}</Label>
        <textarea
          rows={2}
          value={form.comments}
          onChange={e => set('comments', e.target.value)}
          placeholder={t('comments_placeholder')}
          className="w-full px-4 py-3 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
        />
      </div>
    </div>
  )
}
