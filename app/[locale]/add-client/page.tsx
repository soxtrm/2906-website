'use client'

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { Slider } from '@/components/ui/slider'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const LOCATION_GROUPS = [
  { label: 'Central', items: ["Sliema", "St Julian's", "Gzira", "Msida", "Pieta", "Ta' Xbiex", "Swieqi", "Pembroke", "Madliena", "San Gwann", "Birkirkara"] },
  { label: 'North',   items: ["Mellieha", "Bugibba", "Qawra", "St Paul's Bay", "Mosta", "Naxxar", "Gharghur", "Attard", "Balzan", "Lija", "Iklin"] },
  { label: 'South',   items: ["Marsaskala", "Birzebbuga", "Zebbug", "Zejtun", "Valletta", "Floriana"] },
  { label: 'West',    items: ["Rabat", "Mdina", "Mtarfa", "Dingli", "Siggiewi"] },
  { label: 'Gozo',    items: ["Victoria", "Marsalforn", "Xlendi", "Nadur"] },
]

const FEATURES = [
  { key: 'pool', icon: '🏊', label: 'Pool' },
  { key: 'sea_view', icon: '🌊', label: 'Sea View' },
  { key: 'parking', icon: '🅿️', label: 'Parking' },
  { key: 'garden', icon: '🌳', label: 'Garden' },
  { key: 'lift', icon: '⬆️', label: 'Lift' },
  { key: 'pets', icon: '🐾', label: 'Pet Friendly' },
  { key: 'terrace', icon: '☀️', label: 'Terrace' },
  { key: 'ac', icon: '❄️', label: 'A/C' },
  { key: 'furnished', icon: '🛋️', label: 'Furnished' },
  { key: 'gym', icon: '🏋️', label: 'Gym' },
  { key: 'concierge', icon: '🛡️', label: 'Concierge' },
  { key: 'fireplace', icon: '🔥', label: 'Fireplace' },
]

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1', flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34', flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+41', flag: '🇨🇭' },
  { code: '+43', flag: '🇦🇹' }, { code: '+7', flag: '🇷🇺' }, { code: '+971', flag: '🇦🇪' },
  { code: '+91', flag: '🇮🇳' }, { code: '+86', flag: '🇨🇳' }, { code: '+61', flag: '🇦🇺' },
]

const defaultForm = {
  name: '', countryCode: '+356', phone: '', email: '',
  nationality: '', group_size: 1, hasPets: false, pets: '',
  profession: '', budget_min: 1000, budget_max: 2500,
  bedrooms: '', bathrooms: '', move_in: '',
  locations: [] as string[], features: [] as string[],
  wishes: '', comments: '', internal_notes: '',
  lead_agent: 'Kev', lead_agent_other: '',
  viewings_from: '',
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-1.5">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </p>
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

export default function AddClientPage() {
  const [form, setForm] = useState(defaultForm)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [lastAdded, setLastAdded] = useState<{ name: string; time: string } | null>(null)
  const [toast, setToast] = useState('')

  const set = useCallback(<K extends keyof typeof defaultForm>(key: K, val: (typeof defaultForm)[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setErrors(prev => { const e = { ...prev }; delete e[key]; return e })
  }, [])

  const toggleLoc = (loc: string) =>
    set('locations', form.locations.includes(loc) ? form.locations.filter(l => l !== loc) : [...form.locations, loc])
  const toggleFeat = (k: string) =>
    set('features', form.features.includes(k) ? form.features.filter(f => f !== k) : [...form.features, k])

  const validate = () => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Required'
    if (!form.phone.trim()) e.phone = 'Required'
    if (!form.lead_agent) e.lead_agent = 'Required'
    if (form.lead_agent === 'Other' && !form.lead_agent_other.trim()) e.lead_agent_other = 'Required'
    return e
  }

  const submit = async () => {
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }

    setSubmitting(true)
    try {
      const agentName = form.lead_agent === 'Other' ? form.lead_agent_other : form.lead_agent
      const payload = {
        name: form.name.trim(),
        phone: form.countryCode.replace('+', '') + form.phone.replace(/\D/g, ''),
        email: form.email || null,
        nationality: form.nationality || null,
        group_size: form.group_size > 1 ? form.group_size : null,
        pets: form.hasPets ? (form.pets || 'yes') : null,
        profession: form.profession || null,
        budget_min: form.budget_min,
        budget_max: form.budget_max,
        bedrooms: form.bedrooms || null,
        bathrooms: form.bathrooms || null,
        move_in: form.move_in || null,
        locations: form.locations,
        features: FEATURES.filter(f => form.features.includes(f.key)).map(f => f.label),
        wishes: form.wishes || null,
        comments: form.comments || null,
        internal_notes: form.internal_notes || null,
        lead_agent: agentName,
        viewings_from: form.viewings_from || null,
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
        setToast(`✓ Client added — Lead agent: ${agentName}`)
        setTimeout(() => setToast(''), 4000)
        setForm(defaultForm)
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

            {/* Form grid */}
            <div className="bg-white rounded-xl border border-navy/5 shadow-sm p-6 md:p-8">
              <div className="grid md:grid-cols-2 gap-6">

                {/* Name */}
                <Field label="Client Name" required>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => set('name', e.target.value)}
                    placeholder="Maria Borg"
                    className={cn('w-full px-4 py-2.5 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold',
                      errors.name ? 'border-red-400' : 'border-navy/15')}
                  />
                  {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
                </Field>

                {/* Phone */}
                <Field label="Phone" required>
                  <div className={cn('flex border rounded overflow-hidden focus-within:ring-2 focus-within:ring-gold/40 focus-within:border-gold',
                    errors.phone ? 'border-red-400' : 'border-navy/15')}>
                    <div className="relative shrink-0">
                      <select value={form.countryCode} onChange={e => set('countryCode', e.target.value)}
                        className="appearance-none h-full pl-3 pr-6 bg-navy/5 text-navy text-sm border-r border-navy/10 focus:outline-none cursor-pointer">
                        {COUNTRY_CODES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                      </select>
                      <ChevronDown className="w-3 h-3 text-navy/40 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                    <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)}
                      placeholder="9999 0001"
                      className="flex-1 px-3 py-2.5 text-navy placeholder:text-navy/30 focus:outline-none bg-transparent" />
                  </div>
                  {errors.phone && <p className="text-red-400 text-xs mt-1">{errors.phone}</p>}
                </Field>

                {/* Email */}
                <Field label="Email">
                  <input type="email" value={form.email} onChange={e => set('email', e.target.value)}
                    placeholder="client@email.com"
                    className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

                {/* Profession */}
                <Field label="Profession">
                  <input type="text" value={form.profession} onChange={e => set('profession', e.target.value)}
                    placeholder="e.g. Remote worker, Finance"
                    className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

                {/* Lead Agent */}
                <Field label="Lead Agent" required>
                  <div className="flex gap-2 mb-2">
                    {['Kev', 'Olga', 'Other'].map(a => (
                      <button key={a} type="button" onClick={() => set('lead_agent', a)}
                        className={cn('flex-1 py-2.5 rounded border text-sm font-medium transition-all',
                          form.lead_agent === a ? 'border-gold bg-gold/10 text-navy' : 'border-navy/15 text-navy/50 hover:border-navy/30')}>
                        {a}
                      </button>
                    ))}
                  </div>
                  {form.lead_agent === 'Other' && (
                    <input type="text" value={form.lead_agent_other}
                      onChange={e => set('lead_agent_other', e.target.value)}
                      placeholder="Agent name"
                      className={cn('w-full px-4 py-2.5 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40',
                        errors.lead_agent_other ? 'border-red-400' : 'border-navy/15')} />
                  )}
                  {errors.lead_agent && <p className="text-red-400 text-xs mt-1">{errors.lead_agent}</p>}
                </Field>

                {/* Group size + Pets */}
                <Field label="Group Size & Pets">
                  <div className="flex gap-2 mb-2">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button key={n} type="button" onClick={() => set('group_size', n)}
                        className={cn('flex-1 py-2 rounded border text-sm transition-all',
                          form.group_size === n ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {n === 5 ? '5+' : n}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 items-center">
                    <button type="button" onClick={() => set('hasPets', !form.hasPets)}
                      className={cn('px-3 py-1.5 rounded border text-xs transition-all',
                        form.hasPets ? 'border-gold bg-gold/10 text-navy' : 'border-navy/15 text-navy/50')}>
                      🐾 Pets
                    </button>
                    {form.hasPets && (
                      <input type="text" value={form.pets} onChange={e => set('pets', e.target.value)}
                        placeholder="e.g. 1 dog"
                        className="flex-1 px-3 py-1.5 border border-navy/15 rounded text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-gold/40" />
                    )}
                  </div>
                </Field>

                {/* Budget slider - spans full width */}
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-navy/50 uppercase tracking-wider">Monthly Budget</p>
                    <span className="font-serif text-navy font-semibold text-sm">
                      €{form.budget_min.toLocaleString()} – {form.budget_max >= 10000 ? '€10,000+' : `€${form.budget_max.toLocaleString()}`}
                      {form.budget_max >= 2500 && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 bg-gold/15 text-gold border border-gold/30 rounded-full">Premium</span>
                      )}
                    </span>
                  </div>
                  <Slider
                    value={[form.budget_min, form.budget_max]}
                    onValueChange={([min, max]) => { set('budget_min', min); set('budget_max', max) }}
                    min={500} max={10000} step={100}
                  />
                  <div className="flex justify-between text-xs text-navy/30 mt-1">
                    <span>€500</span><span>€2,500</span><span>€5,000</span><span>€10,000+</span>
                  </div>
                </div>

                {/* Bedrooms */}
                <Field label="Bedrooms">
                  <div className="flex gap-1.5 flex-wrap">
                    {['Studio', '1', '2', '3', '4+'].map(b => (
                      <button key={b} type="button"
                        onClick={() => set('bedrooms', form.bedrooms === b ? '' : b)}
                        className={cn('px-3 py-2 rounded border text-sm transition-all',
                          form.bedrooms === b ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* Bathrooms */}
                <Field label="Bathrooms">
                  <div className="flex gap-1.5">
                    {['1', '2', '3+'].map(b => (
                      <button key={b} type="button"
                        onClick={() => set('bathrooms', form.bathrooms === b ? '' : b)}
                        className={cn('px-4 py-2 rounded border text-sm transition-all',
                          form.bathrooms === b ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* Move in */}
                <Field label="Move-in Date">
                  <div className="flex gap-1.5 flex-wrap mb-2">
                    {['ASAP', 'Within 1 month', 'Within 3 months', 'Flexible'].map(o => (
                      <button key={o} type="button"
                        onClick={() => set('move_in', form.move_in === o ? '' : o)}
                        className={cn('text-xs px-2.5 py-1.5 rounded border transition-all',
                          form.move_in === o ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {o}
                      </button>
                    ))}
                  </div>
                  <input type="date" value={form.move_in.match(/^\d{4}/) ? form.move_in : ''}
                    onChange={e => set('move_in', e.target.value)}
                    className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

                {/* Viewings from */}
                <Field label="Viewings Available From">
                  <input type="date" value={form.viewings_from}
                    onChange={e => set('viewings_from', e.target.value)}
                    className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

                {/* Locations - full width */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                    Preferred Locations
                    {form.locations.length > 0 && <span className="ml-2 text-gold normal-case">{form.locations.length} selected</span>}
                  </p>
                  <div className="space-y-2">
                    {LOCATION_GROUPS.map(g => (
                      <div key={g.label} className="flex flex-wrap gap-1.5 items-center">
                        <span className="text-xs text-navy/30 w-12 shrink-0">{g.label}</span>
                        {g.items.map(loc => <Chip key={loc} active={form.locations.includes(loc)} onClick={() => toggleLoc(loc)}>{loc}</Chip>)}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Features - full width */}
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

                {/* Wishes */}
                <Field label="Client Wishes">
                  <textarea rows={2} value={form.wishes} onChange={e => set('wishes', e.target.value)}
                    placeholder="Quiet street, no ground floor, near expat areas..."
                    className="w-full px-4 py-2.5 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

                {/* Internal notes */}
                <Field label="Internal Notes (admin only)">
                  <textarea rows={2} value={form.internal_notes} onChange={e => set('internal_notes', e.target.value)}
                    placeholder="Spoke on WhatsApp, very motivated, flexible on location..."
                    className="w-full px-4 py-2.5 border border-navy/15 rounded resize-none text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

              </div>

              {/* Submit */}
              <div className="mt-8 pt-6 border-t border-navy/5">
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 py-4 bg-navy text-white rounded-lg font-semibold text-base hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {submitting ? (
                    <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving...</>
                  ) : (
                    <><Check className="w-5 h-5" />Add Client</>
                  )}
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
