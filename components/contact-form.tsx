'use client'

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { Slider } from '@/components/ui/slider'
import { Check, ChevronDown, MessageCircle, Users, BedDouble, Bath, MapPin, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Country codes ─────────────────────────────────────────────────────────────
const COUNTRY_CODES = [
  { code: '+356', label: 'Malta', flag: '🇲🇹' },
  { code: '+49', label: 'Germany', flag: '🇩🇪' },
  { code: '+44', label: 'UK', flag: '🇬🇧' },
  { code: '+1', label: 'USA/CA', flag: '🇺🇸' },
  { code: '+33', label: 'France', flag: '🇫🇷' },
  { code: '+39', label: 'Italy', flag: '🇮🇹' },
  { code: '+34', label: 'Spain', flag: '🇪🇸' },
  { code: '+31', label: 'Netherlands', flag: '🇳🇱' },
  { code: '+41', label: 'Switzerland', flag: '🇨🇭' },
  { code: '+43', label: 'Austria', flag: '🇦🇹' },
  { code: '+32', label: 'Belgium', flag: '🇧🇪' },
  { code: '+46', label: 'Sweden', flag: '🇸🇪' },
  { code: '+47', label: 'Norway', flag: '🇳🇴' },
  { code: '+45', label: 'Denmark', flag: '🇩🇰' },
  { code: '+358', label: 'Finland', flag: '🇫🇮' },
  { code: '+48', label: 'Poland', flag: '🇵🇱' },
  { code: '+351', label: 'Portugal', flag: '🇵🇹' },
  { code: '+30', label: 'Greece', flag: '🇬🇷' },
  { code: '+7', label: 'Russia', flag: '🇷🇺' },
  { code: '+380', label: 'Ukraine', flag: '🇺🇦' },
  { code: '+90', label: 'Turkey', flag: '🇹🇷' },
  { code: '+971', label: 'UAE', flag: '🇦🇪' },
  { code: '+966', label: 'Saudi Arabia', flag: '🇸🇦' },
  { code: '+972', label: 'Israel', flag: '🇮🇱' },
  { code: '+91', label: 'India', flag: '🇮🇳' },
  { code: '+86', label: 'China', flag: '🇨🇳' },
  { code: '+82', label: 'South Korea', flag: '🇰🇷' },
  { code: '+81', label: 'Japan', flag: '🇯🇵' },
  { code: '+61', label: 'Australia', flag: '🇦🇺' },
  { code: '+55', label: 'Brazil', flag: '🇧🇷' },
]

// ── Nationalities ─────────────────────────────────────────────────────────────
const NATIONALITIES = [
  { code: 'mt', label: 'Maltese', flag: '🇲🇹' },
  { code: 'de', label: 'German', flag: '🇩🇪' },
  { code: 'gb', label: 'British', flag: '🇬🇧' },
  { code: 'us', label: 'American', flag: '🇺🇸' },
  { code: 'fr', label: 'French', flag: '🇫🇷' },
  { code: 'it', label: 'Italian', flag: '🇮🇹' },
  { code: 'es', label: 'Spanish', flag: '🇪🇸' },
  { code: 'nl', label: 'Dutch', flag: '🇳🇱' },
  { code: 'ch', label: 'Swiss', flag: '🇨🇭' },
  { code: 'at', label: 'Austrian', flag: '🇦🇹' },
  { code: 'be', label: 'Belgian', flag: '🇧🇪' },
  { code: 'se', label: 'Swedish', flag: '🇸🇪' },
  { code: 'no', label: 'Norwegian', flag: '🇳🇴' },
  { code: 'dk', label: 'Danish', flag: '🇩🇰' },
  { code: 'fi', label: 'Finnish', flag: '🇫🇮' },
  { code: 'pl', label: 'Polish', flag: '🇵🇱' },
  { code: 'pt', label: 'Portuguese', flag: '🇵🇹' },
  { code: 'gr', label: 'Greek', flag: '🇬🇷' },
  { code: 'ru', label: 'Russian', flag: '🇷🇺' },
  { code: 'ua', label: 'Ukrainian', flag: '🇺🇦' },
  { code: 'tr', label: 'Turkish', flag: '🇹🇷' },
  { code: 'ae', label: 'Emirati', flag: '🇦🇪' },
  { code: 'sa', label: 'Saudi', flag: '🇸🇦' },
  { code: 'il', label: 'Israeli', flag: '🇮🇱' },
  { code: 'in', label: 'Indian', flag: '🇮🇳' },
  { code: 'cn', label: 'Chinese', flag: '🇨🇳' },
  { code: 'kr', label: 'Korean', flag: '🇰🇷' },
  { code: 'jp', label: 'Japanese', flag: '🇯🇵' },
  { code: 'au', label: 'Australian', flag: '🇦🇺' },
  { code: 'br', label: 'Brazilian', flag: '🇧🇷' },
]

// ── Locations by region ───────────────────────────────────────────────────────
const LOCATION_GROUPS = [
  {
    key: 'central',
    label: 'Central Malta',
    items: ["Sliema", "St Julian's", "Gzira", "Msida", "Pieta", "Ta' Xbiex", "Swieqi", "Pembroke", "Madliena", "San Gwann", "Birkirkara"],
  },
  {
    key: 'north',
    label: 'North',
    items: ["Mellieha", "Bugibba", "Qawra", "St Paul's Bay", "Mosta", "Naxxar", "Gharghur", "Attard", "Balzan", "Lija", "Iklin"],
  },
  {
    key: 'south',
    label: 'South',
    items: ["Marsaskala", "Birzebbuga", "Zebbug", "Zejtun", "Valletta", "Floriana"],
  },
  {
    key: 'west',
    label: 'West',
    items: ["Rabat", "Mdina", "Mtarfa", "Dingli", "Siggiewi"],
  },
  {
    key: 'gozo',
    label: 'Gozo',
    items: ["Victoria", "Marsalforn", "Xlendi", "Nadur"],
  },
]

// ── Features ──────────────────────────────────────────────────────────────────
const FEATURES = [
  { key: 'pool',      icon: '🏊', label: 'Pool' },
  { key: 'sea_view',  icon: '🌊', label: 'Sea View' },
  { key: 'parking',   icon: '🅿️', label: 'Parking' },
  { key: 'garden',    icon: '🌳', label: 'Garden' },
  { key: 'lift',      icon: '⬆️', label: 'Lift' },
  { key: 'pets',      icon: '🐾', label: 'Pet Friendly' },
  { key: 'terrace',   icon: '☀️', label: 'Terrace' },
  { key: 'ac',        icon: '❄️', label: 'A/C' },
  { key: 'furnished', icon: '🛋️', label: 'Furnished' },
  { key: 'gym',       icon: '🏋️', label: 'Gym' },
  { key: 'concierge', icon: '🛡️', label: 'Concierge' },
  { key: 'fireplace', icon: '🔥', label: 'Fireplace' },
]

// ── Slide animation ───────────────────────────────────────────────────────────
const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit:   (dir: number) => ({ x: dir > 0 ? -60 : 60, opacity: 0 }),
}

// ── Form state ────────────────────────────────────────────────────────────────
interface FormData {
  name: string
  countryCode: string
  phone: string
  email: string
  nationality: string
  group_size: number
  hasPets: boolean
  pets: string
  profession: string
  budget_min: number
  budget_max: number
  bedrooms: string
  bathrooms: string
  move_in: string
  move_in_custom: string
  locations: string[]
  open_to_suggestions: boolean
  features: string[]
  wishes: string
  comments: string
}

const defaultForm: FormData = {
  name: '', countryCode: '+356', phone: '', email: '',
  nationality: '', group_size: 1, hasPets: false, pets: '',
  profession: '', budget_min: 1000, budget_max: 2500,
  bedrooms: '', bathrooms: '', move_in: '', move_in_custom: '',
  locations: [], open_to_suggestions: false,
  features: [], wishes: '', comments: '',
}

// ── Small reusable components ─────────────────────────────────────────────────
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

// ── Main component ────────────────────────────────────────────────────────────
export function ContactForm() {
  const t = useTranslations('form')
  const [step, setStep] = useState(1)
  const [dir, setDir] = useState(1)
  const [form, setForm] = useState<FormData>(defaultForm)
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const set = useCallback(<K extends keyof FormData>(key: K, val: FormData[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key]; return e })
  }, [])

  const toggleLocation = (loc: string) => {
    set('locations', form.locations.includes(loc)
      ? form.locations.filter(l => l !== loc)
      : [...form.locations, loc]
    )
  }

  const toggleFeature = (key: string) => {
    set('features', form.features.includes(key)
      ? form.features.filter(f => f !== key)
      : [...form.features, key]
    )
  }

  const validate1 = () => {
    const e: typeof errors = {}
    if (!form.name.trim()) e.name = t('required')
    if (!form.phone.trim()) e.phone = t('required')
    return e
  }

  const go = (next: number) => {
    if (next > step) {
      if (step === 1) {
        const e = validate1()
        if (Object.keys(e).length) { setErrors(e); return }
      }
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
      const payload = {
        name: form.name.trim(),
        phone: form.countryCode.replace('+', '') + form.phone.replace(/\D/g, ''),
        email: form.email || null,
        nationalities: form.nationality ? [form.nationality] : null,
        group_size: form.group_size > 1 ? form.group_size : null,
        pets: form.hasPets ? (form.pets || 'yes') : null,
        profession: form.profession || null,
        budget_min: form.budget_min,
        budget_max: form.budget_max,
        bedrooms: form.bedrooms || null,
        bathrooms: form.bathrooms || null,
        move_in: form.move_in_custom || form.move_in || null,
        locations: form.open_to_suggestions ? [...form.locations, 'Open to suggestions'] : form.locations,
        features: FEATURES.filter(f => form.features.includes(f.key)).map(f => f.label),
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
          {t('success_title').replace('{name}', form.name.split(' ')[0])}
        </h2>
        <p className="text-navy/60 text-lg mb-8">{t('success_desc')}</p>
        <a
          href={`https://wa.me/35699990001`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#25D366] text-white rounded font-medium hover:bg-[#20BD5A] transition-colors"
        >
          <MessageCircle className="w-5 h-5" />
          {t('wa_chat')}
        </a>
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
          {t('step').replace('{current}', String(step)).replace('{total}', '3')}
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
          {step === 1 && <Step1 form={form} set={set} errors={errors} t={t} />}
          {step === 2 && <Step2 form={form} set={set} t={t} />}
          {step === 3 && <Step3 form={form} set={set} toggleLocation={toggleLocation} toggleFeature={toggleFeature} t={t} />}
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
function Step1({ form, set, errors, t }: {
  form: FormData
  set: <K extends keyof FormData>(k: K, v: FormData[K]) => void
  errors: Partial<Record<keyof FormData, string>>
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

      {/* Phone with country code */}
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

      {/* Nationality */}
      <div>
        <Label>{t('nationality')}</Label>
        <div className="relative">
          <select
            value={form.nationality}
            onChange={e => set('nationality', e.target.value)}
            className="w-full appearance-none px-4 py-3 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold bg-white cursor-pointer"
          >
            <option value="">— {t('select')} —</option>
            {NATIONALITIES.map(n => (
              <option key={n.code} value={n.code}>{n.flag} {n.label}</option>
            ))}
          </select>
          <ChevronDown className="w-4 h-4 text-navy/40 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
      </div>

      {/* Group size */}
      <div>
        <Label>{t('group_size')}</Label>
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map(n => (
            <OptionCard
              key={n}
              active={form.group_size === n}
              onClick={() => set('group_size', n)}
              className="flex-1 flex flex-col items-center gap-1 py-3"
            >
              <span className="text-lg">{n === 5 ? '5+' : n === 1 ? '👤' : n === 2 ? '👫' : n === 3 ? '👨‍👩‍👦' : '👨‍👩‍👧‍👦'}</span>
              <span className="text-xs">{n === 5 ? '5+' : n}</span>
            </OptionCard>
          ))}
        </div>
      </div>

      {/* Pets */}
      <div>
        <Label>{t('pets')}</Label>
        <div className="flex gap-2 mb-2">
          <OptionCard active={!form.hasPets} onClick={() => set('hasPets', false)} className="flex-1">
            🚫 {t('no')}
          </OptionCard>
          <OptionCard active={form.hasPets} onClick={() => set('hasPets', true)} className="flex-1">
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

      {/* Profession */}
      <div>
        <Label>{t('profession')}</Label>
        <input
          type="text"
          value={form.profession}
          onChange={e => set('profession', e.target.value)}
          placeholder={t('profession_placeholder')}
          className="w-full px-4 py-3 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
        />
      </div>
    </div>
  )
}

// ── Step 2: Budget & Space ─────────────────────────────────────────────────────
function Step2({ form, set, t }: {
  form: FormData
  set: <K extends keyof FormData>(k: K, v: FormData[K]) => void
  t: (k: string) => string
}) {
  const isPremium = form.budget_max >= 2500

  return (
    <div className="space-y-7">
      {/* Budget slider */}
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
          value={[form.budget_min, form.budget_max]}
          onValueChange={([min, max]) => {
            set('budget_min', min)
            set('budget_max', max)
          }}
          min={500}
          max={10000}
          step={100}
          className="mt-2"
        />
        <div className="flex justify-between text-xs text-navy/40 mt-1.5">
          <span>€500</span>
          <span>€2,500</span>
          <span>€5,000</span>
          <span>€10,000+</span>
        </div>
      </div>

      {/* Bedrooms */}
      <div>
        <Label>{t('bedrooms')}</Label>
        <div className="flex gap-2 flex-wrap">
          {['Studio', '1', '2', '3', '4+'].map(b => (
            <OptionCard
              key={b}
              active={form.bedrooms === b}
              onClick={() => set('bedrooms', form.bedrooms === b ? '' : b)}
              className="flex flex-col items-center gap-1 px-4 py-3"
            >
              <BedDouble className="w-4 h-4" />
              <span>{b}</span>
            </OptionCard>
          ))}
        </div>
      </div>

      {/* Bathrooms */}
      <div>
        <Label>{t('bathrooms')}</Label>
        <div className="flex gap-2">
          {['1', '2', '3+'].map(b => (
            <OptionCard
              key={b}
              active={form.bathrooms === b}
              onClick={() => set('bathrooms', form.bathrooms === b ? '' : b)}
              className="flex flex-col items-center gap-1 px-5 py-3"
            >
              <Bath className="w-4 h-4" />
              <span>{b}</span>
            </OptionCard>
          ))}
        </div>
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
function Step3({ form, set, toggleLocation, toggleFeature, t }: {
  form: FormData
  set: <K extends keyof FormData>(k: K, v: FormData[K]) => void
  toggleLocation: (loc: string) => void
  toggleFeature: (key: string) => void
  t: (k: string) => string
}) {
  return (
    <div className="space-y-7">
      {/* Locations */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>{t('locations')}</Label>
          {form.locations.length > 0 && (
            <span className="text-xs text-gold">{form.locations.length} selected</span>
          )}
        </div>
        <div className="space-y-3">
          {LOCATION_GROUPS.map(group => (
            <div key={group.key}>
              <p className="text-xs text-navy/40 mb-1.5 flex items-center gap-1">
                <MapPin className="w-3 h-3" />{group.label}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {group.items.map(loc => (
                  <button
                    key={loc}
                    type="button"
                    onClick={() => toggleLocation(loc)}
                    className={cn(
                      'text-xs px-2.5 py-1 rounded-full border transition-all',
                      form.locations.includes(loc)
                        ? 'border-gold bg-gold/10 text-navy font-medium'
                        : 'border-navy/15 text-navy/50 hover:border-navy/30 hover:text-navy'
                    )}
                  >
                    {loc}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
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
