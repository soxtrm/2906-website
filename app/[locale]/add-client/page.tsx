'use client'

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { Slider } from '@/components/ui/slider'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

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

const PROPERTY_TYPES = [
  'Apartment', 'Penthouse', 'Maisonette', 'Townhouse', 'Villa', 'Farmhouse', 'House of Character',
]

const LOCATION_GROUPS = [
  { label: 'Central', items: ["Sliema", "St Julian's", "Gzira", "Msida", "Pieta", "Ta' Xbiex", "Swieqi", "Pembroke", "Madliena", "San Gwann", "Birkirkara"] },
  { label: 'North',   items: ["Mellieha", "Bugibba", "Qawra", "St Paul's Bay", "Mosta", "Naxxar", "Gharghur", "Attard", "Balzan", "Lija", "Iklin"] },
  { label: 'South',   items: ["Marsaskala", "Birzebbuga", "Zebbug", "Zejtun", "Valletta", "Floriana"] },
  { label: 'West',    items: ["Rabat", "Mdina", "Mtarfa", "Dingli", "Siggiewi"] },
  { label: 'Gozo',    items: ["Victoria", "Marsalforn", "Xlendi", "Nadur"] },
]

const FEATURES = [
  { key: 'ac',       icon: '❄️',  label: 'A/C' },
  { key: 'bathtub',  icon: '🛁',  label: 'Bathtub' },
  { key: 'concierge',icon: '🛡️', label: 'Concierge' },
  { key: 'fireplace',icon: '🔥',  label: 'Fireplace' },
  { key: 'furnished',icon: '🛋️', label: 'Furnished' },
  { key: 'garage',   icon: '🚗',  label: 'Garage/Parking' },
  { key: 'garden',   icon: '🌳',  label: 'Garden' },
  { key: 'gym',      icon: '🏋️', label: 'Gym' },
  { key: 'jacuzzi',  icon: '♨️',  label: 'Jacuzzi' },
  { key: 'lift',     icon: '⬆️',  label: 'Lift' },
  { key: 'parking',  icon: '🅿️', label: 'Parking' },
  { key: 'pets',     icon: '🐾',  label: 'Pet Friendly' },
  { key: 'pool',     icon: '🏊',  label: 'Pool' },
  { key: 'rooftop',  icon: '🏙️', label: 'Rooftop' },
  { key: 'sea_view', icon: '🌊',  label: 'Sea View' },
  { key: 'seafront', icon: '🌅',  label: 'Seafront' },
  { key: 'terrace',  icon: '☀️',  label: 'Terrace' },
]

const COUNTRY_CODES = [
  { code: '+356', flag: '🇲🇹' }, { code: '+49', flag: '🇩🇪' }, { code: '+44', flag: '🇬🇧' },
  { code: '+1', flag: '🇺🇸' }, { code: '+33', flag: '🇫🇷' }, { code: '+39', flag: '🇮🇹' },
  { code: '+34', flag: '🇪🇸' }, { code: '+31', flag: '🇳🇱' }, { code: '+41', flag: '🇨🇭' },
  { code: '+43', flag: '🇦🇹' }, { code: '+7', flag: '🇷🇺' }, { code: '+971', flag: '🇦🇪' },
  { code: '+91', flag: '🇮🇳' }, { code: '+86', flag: '🇨🇳' }, { code: '+61', flag: '🇦🇺' },
]

const defaultForm = {
  name: '', email: '',
  nationality: '', group_size: 1, hasPets: false, pets: '',
  profession: '', budget_min: 1000, budget_max: 2500,
  bedrooms: [] as string[], bathrooms: [] as string[],
  property_types: [] as string[],
  move_in: '',
  preferred_regions: [] as string[], locations: [] as string[], features: [] as string[],
  wishes: '', comments: '', internal_notes: '',
  lead_agent: 'Kevin', lead_agent_other: '',
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
        email: form.email || null,
        nationality: form.nationality || null,
        group_size: form.group_size > 1 ? form.group_size : null,
        pets: form.hasPets ? (form.pets || 'yes') : null,
        profession: form.profession || null,
        budget_min: form.budget_min,
        budget_max: form.budget_max,
        bedrooms: form.bedrooms.length > 0 ? form.bedrooms.join(',') : null,
        bathrooms: form.bathrooms.length > 0 ? form.bathrooms.join(',') : null,
        property_types: form.property_types.length > 0 ? form.property_types.join(',') : null,
        move_in: form.move_in || null,
        preferred_regions: form.preferred_regions.length > 0 ? form.preferred_regions : null,
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
                  <select
                    value={form.lead_agent}
                    onChange={e => set('lead_agent', e.target.value)}
                    className={cn('w-full px-4 py-2.5 border rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold bg-white',
                      errors.lead_agent ? 'border-red-400' : 'border-navy/15')}
                  >
                    {['Kevin', 'Olga', 'Inna', 'Oleg', 'Kevin Christian', 'Anselme', 'Isabel', 'Tatyana', 'Kseniia', 'Julia', 'Other'].map(a => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                  {form.lead_agent === 'Other' && (
                    <input type="text" value={form.lead_agent_other}
                      onChange={e => set('lead_agent_other', e.target.value)}
                      placeholder="Agent name"
                      className={cn('w-full mt-2 px-4 py-2.5 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40',
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

                {/* Budget slider - non-linear, spans full width */}
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

                {/* Bedrooms — multi-select */}
                <Field label="Bedrooms">
                  <div className="flex gap-1.5 flex-wrap">
                    {['Studio', '1', '2', '3', '4+'].map(b => (
                      <button key={b} type="button"
                        onClick={() => set('bedrooms', form.bedrooms.includes(b) ? form.bedrooms.filter(x => x !== b) : [...form.bedrooms, b])}
                        className={cn('px-3 py-2 rounded border text-sm transition-all',
                          form.bedrooms.includes(b) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25')}>
                        {b}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* Bathrooms — multi-select */}
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

                {/* Property type — multi-select, spans full width */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                    Property Type
                    {form.property_types.length > 0 && <span className="ml-2 text-gold normal-case">{form.property_types.length} selected</span>}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {PROPERTY_TYPES.map(pt => (
                      <button key={pt} type="button"
                        onClick={() => set('property_types', form.property_types.includes(pt) ? form.property_types.filter(x => x !== pt) : [...form.property_types, pt])}
                        className={cn('text-xs px-2.5 py-1.5 rounded-full border transition-all',
                          form.property_types.includes(pt) ? 'border-gold bg-gold/10 text-navy font-medium' : 'border-navy/15 text-navy/50 hover:border-navy/25 hover:text-navy')}>
                        {pt}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Viewings from */}
                <Field label="Viewings Available From">
                  <input type="date" value={form.viewings_from}
                    onChange={e => set('viewings_from', e.target.value)}
                    className="w-full px-4 py-2.5 border border-navy/15 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold" />
                </Field>

                {/* Regions - full width */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                    Regions (optional)
                    {form.preferred_regions.length > 0 && <span className="ml-2 text-gold normal-case">{form.preferred_regions.length} selected</span>}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {['Central', 'Central + Surroundings', 'North', 'Central-West', 'South-East', 'South', 'Gozo'].map(r => (
                      <Chip key={r} active={form.preferred_regions.includes(r)} onClick={() => set('preferred_regions', form.preferred_regions.includes(r) ? form.preferred_regions.filter(x => x !== r) : [...form.preferred_regions, r])}>
                        {r}
                      </Chip>
                    ))}
                  </div>
                </div>

                {/* Locations - full width */}
                <div className="md:col-span-2">
                  <p className="text-xs font-medium text-navy/50 uppercase tracking-wider mb-2">
                    Specific villages/towns
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
