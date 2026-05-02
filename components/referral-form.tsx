'use client'

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Slider } from '@/components/ui/slider'
import { Check, ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1', flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34', flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+7', flag: '🇷🇺' },
  { code: '+380', flag: '🇺🇦' }, { code: '+971', flag: '🇦🇪' },
]

const PROPERTY_TYPES = ['Apartment', 'Penthouse', 'Maisonette', 'Townhouse', 'House of Character', 'Detached Villa', 'Semi-detached Villa']

function sliderToBudget(p: number): number {
  if (p <= 50) return 500 + (p / 50) * 1500
  return 2000 + ((p - 50) / 50) * 8000
}
function budgetToSlider(b: number): number {
  if (b <= 2000) return ((b - 500) / 1500) * 50
  return 50 + ((b - 2000) / 8000) * 50
}
function roundTo50(n: number): number { return Math.round(n / 50) * 50 }

function inputCls(err?: string) {
  return cn(
    'w-full px-4 py-2.5 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm',
    err ? 'border-red-400' : 'border-navy/15'
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

const STEPS = ['Commission', 'Your Details', 'About Them', 'Criteria']

const defaultForm = {
  referrer_name: '', referrer_dial: '+356', referrer_phone: '', referrer_email: '',
  add_to_groups: true,
  referral_name: '', referral_dial: '+356', referral_phone: '', referral_email: '',
  referral_relation: '',
  budget_min: 1000, budget_max: 2500,
  listing_type: 'For Rent',
  property_types: [] as string[],
  bedrooms: [] as string[],
  move_in: 'ASAP',
  notes: '',
}

export function ReferralForm() {
  const [form, setForm] = useState(defaultForm)
  const [step, setStep] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key as string]; return e })
  }, [])

  function validateStep(s: number) {
    const e: Record<string, string> = {}
    if (s === 1) {
      if (!form.referrer_name.trim()) e.referrer_name = 'Required'
      if (!form.referrer_email.trim()) e.referrer_email = 'Required'
      if (!form.referrer_phone.trim()) e.referrer_phone = 'Required'
    }
    if (s === 2) {
      if (!form.referral_name.trim()) e.referral_name = 'Required'
      if (!form.referral_phone.trim()) e.referral_phone = 'Required'
    }
    return e
  }

  function next() {
    const e = validateStep(step)
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({})
    setStep(s => Math.min(s + 1, STEPS.length - 1))
  }

  async function submit() {
    setSubmitting(true)
    try {
      const payload = {
        referrer_name: form.referrer_name, referrer_phone: `${form.referrer_dial}${form.referrer_phone}`,
        referrer_email: form.referrer_email || null, add_to_groups: form.add_to_groups,
        referral_name: form.referral_name, referral_phone: `${form.referral_dial}${form.referral_phone}`,
        referral_email: form.referral_email || null, referral_relation: form.referral_relation || null,
        budget_min: form.budget_min, budget_max: form.budget_max,
        listing_type: form.listing_type,
        property_types: form.property_types.join(',') || null,
        bedrooms: form.bedrooms.join(',') || null,
        move_in: form.move_in || null,
        notes: form.notes || null,
      }
      const res = await fetch('/api/referrals/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) setDone(true)
      else alert('Something went wrong. Please try again.')
    } catch { alert('Network error.') }
    setSubmitting(false)
  }

  if (done) {
    return (
      <div className="text-center py-10">
        <div className="w-16 h-16 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="w-8 h-8 text-gold" />
        </div>
        <h3 className="font-serif text-2xl text-navy mb-2">Referral Submitted!</h3>
        <p className="text-navy/50 text-sm mb-2">Thank you {form.referrer_name.split(' ')[0]}!</p>
        <p className="text-navy/50 text-sm">We&apos;ll be in touch once the deal closes. You&apos;ll earn 10% commission.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex gap-1 mb-6">
        {STEPS.map((_, i) => <div key={i} className={cn('flex-1 h-1 rounded-full transition-all', i <= step ? 'bg-gold' : 'bg-navy/10')} />)}
      </div>
      <p className="text-xs text-navy/40 -mt-4 mb-6">Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div key="s0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
            <div className="bg-gold/5 border border-gold/20 rounded-xl p-5">
              <div className="text-3xl mb-3">🎯</div>
              <h3 className="font-serif text-xl text-navy mb-2">Earn 10% Commission</h3>
              <p className="text-navy/60 text-sm leading-relaxed mb-3">
                Know someone looking for property in Malta? Refer them to 2906 and earn 10% of our agent commission on every successful deal.
              </p>
              <ul className="space-y-1.5 text-sm text-navy/60">
                {['No cap on earnings — refer as many people as you want', 'Paid within 30 days of deal completion', 'Track your referrals in real time', 'Join our exclusive deal-share groups'].map(item => (
                  <li key={item} className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-gold shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div key="s1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
                Your Name <span className="text-red-400">*</span>
              </p>
              <input value={form.referrer_name} onChange={e => set('referrer_name', e.target.value)}
                placeholder="Your full name" className={inputCls(errors.referrer_name)} />
              {errors.referrer_name && <p className="text-xs text-red-400 mt-1">{errors.referrer_name}</p>}
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
                Your Email <span className="text-red-400">*</span>
              </p>
              <input type="email" value={form.referrer_email} onChange={e => set('referrer_email', e.target.value)}
                placeholder="you@email.com" className={inputCls(errors.referrer_email)} />
              {errors.referrer_email && <p className="text-xs text-red-400 mt-1">{errors.referrer_email}</p>}
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
                Your Phone <span className="text-red-400">*</span>
              </p>
              <div className="flex gap-2">
                <select value={form.referrer_dial} onChange={e => set('referrer_dial', e.target.value)}
                  className="border border-navy/15 rounded px-2 py-2.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-gold/40">
                  {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                </select>
                <input type="tel" value={form.referrer_phone} onChange={e => set('referrer_phone', e.target.value)}
                  placeholder="79000000" className={cn(inputCls(errors.referrer_phone), 'flex-1')} />
              </div>
              {errors.referrer_phone && <p className="text-xs text-red-400 mt-1">{errors.referrer_phone}</p>}
            </div>
            <label className="flex items-center gap-3 p-3 border border-navy/10 rounded-lg cursor-pointer hover:bg-navy/[0.02]">
              <input type="checkbox" checked={form.add_to_groups}
                onChange={e => set('add_to_groups', e.target.checked as unknown as typeof form.add_to_groups)}
                className="w-4 h-4 accent-gold" />
              <span className="text-sm text-navy">Add me to deal-share groups</span>
            </label>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="s2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
                Their Name <span className="text-red-400">*</span>
              </p>
              <input value={form.referral_name} onChange={e => set('referral_name', e.target.value)}
                placeholder="Full name" className={inputCls(errors.referral_name)} />
              {errors.referral_name && <p className="text-xs text-red-400 mt-1">{errors.referral_name}</p>}
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
                Their Phone <span className="text-red-400">*</span>
              </p>
              <div className="flex gap-2">
                <select value={form.referral_dial} onChange={e => set('referral_dial', e.target.value)}
                  className="border border-navy/15 rounded px-2 py-2.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-gold/40">
                  {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                </select>
                <input type="tel" value={form.referral_phone} onChange={e => set('referral_phone', e.target.value)}
                  placeholder="79000000" className={cn(inputCls(errors.referral_phone), 'flex-1')} />
              </div>
              {errors.referral_phone && <p className="text-xs text-red-400 mt-1">{errors.referral_phone}</p>}
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">Their Email (optional)</p>
              <input type="email" value={form.referral_email} onChange={e => set('referral_email', e.target.value)}
                placeholder="their@email.com" className={inputCls()} />
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">Your Relationship (optional)</p>
              <input value={form.referral_relation} onChange={e => set('referral_relation', e.target.value)}
                placeholder="e.g. Friend, colleague, family" className={inputCls()} />
            </div>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div key="s3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-navy/50 uppercase tracking-wider">Their Monthly Budget</p>
                <span className="font-serif text-navy text-sm font-semibold">
                  €{form.budget_min.toLocaleString()} – {form.budget_max >= 10000 ? '€10,000+' : `€${form.budget_max.toLocaleString()}`}
                </span>
              </div>
              <Slider
                value={[budgetToSlider(form.budget_min), budgetToSlider(form.budget_max)]}
                onValueChange={([p1, p2]) => { set('budget_min', roundTo50(sliderToBudget(p1))); set('budget_max', roundTo50(sliderToBudget(p2))) }}
                min={0} max={100} step={1}
              />
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Listing Type</p>
              <div className="flex gap-2">
                {['For Rent', 'For Sale', 'Either'].map(t => (
                  <Chip key={t} active={form.listing_type === t} onClick={() => set('listing_type', t)}>{t}</Chip>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Property Types (optional)</p>
              <div className="flex flex-wrap gap-1.5">
                {PROPERTY_TYPES.map(t => (
                  <Chip key={t} active={form.property_types.includes(t)}
                    onClick={() => set('property_types', (form.property_types.includes(t) ? form.property_types.filter(x => x !== t) : [...form.property_types, t]) as typeof form.property_types)}>
                    {t}
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Bedrooms (optional)</p>
              <div className="flex gap-2">
                {['1', '2', '3', '4+'].map(b => (
                  <Chip key={b} active={form.bedrooms.includes(b)}
                    onClick={() => set('bedrooms', (form.bedrooms.includes(b) ? form.bedrooms.filter(x => x !== b) : [...form.bedrooms, b]) as typeof form.bedrooms)}>
                    {b}
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">Move-in</p>
              <div className="flex flex-wrap gap-1.5">
                {['ASAP', 'In 10 Days', 'Within 1 month', 'Within 3 months', 'Flexible'].map(o => (
                  <Chip key={o} active={form.move_in === o} onClick={() => set('move_in', o)}>{o}</Chip>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">Additional Notes (optional)</p>
              <textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder="Anything else we should know..."
                className={cn(inputCls(), 'resize-none')} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
            {step === 0 ? 'Get Started' : 'Continue'} <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={submitting}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-gold text-white rounded font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
            {submitting ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Submitting…</> : <><Check className="w-4 h-4" />Submit Referral</>}
          </button>
        )}
      </div>
    </div>
  )
}
