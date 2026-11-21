'use client'
// Features of one home (2026-11-21). Everything is saved in ARGUS at once. Bedrooms and bathrooms are listing facts:
// a change goes to the agent for approval (the existing passport flow). Everything else is the owner's statement,
// shown with where it stands: waiting for the agency, confirmed, backed by a document, independently verified.
// "+ Add feature" first looks for the same feature in the dictionary (other words, other languages);
// a new term is kept as the owner wrote it and stays a candidate until 2906 reviews it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Minus, Plus, Search, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { sync } from '@/lib/owner/live'

type Entry = { key: string; label: string; group: string; kind: 'boolean' | 'count' | 'choice'; choices: string[]; status: string; filterable?: boolean }
type Feat = Entry & { value: unknown; originalText: string | null; source: 'owner' | 'agent' | 'import'; confirmation: 'declared' | 'agent_confirmed' | 'rejected'; verification: 'none' | 'document' | 'verified' }
type Data = { core: { bedrooms: number | null; bathrooms: number | null }; features: Feat[]; common: Entry[] }
type Suggestion = Entry & { score: number }

const COUNTERS = ['balconies', 'terraces', 'showers', 'bathtubs', 'parking_spaces']
const SWITCHES = ['air_conditioning', 'lift', 'sea_view', 'pool', 'garden', 'washing_machine', 'dishwasher', 'double_glazing', 'soundproof_windows', 'internet', 'storage_room', 'central_heating', 'solar_panels', 'step_free']
const CHOICE_LABEL: Record<string, string> = { furnished: 'Furnished', part_furnished: 'Part furnished', unfurnished: 'Unfurnished', walk_in: 'Walk-in', cabin: 'Cabin', over_bath: 'Over the bath', rain_shower: 'Rain shower' }
function badge(f: Feat) {
  if (f.verification === 'verified') return { t: 'Independently verified', c: 'ok' }
  if (f.verification === 'document') return { t: 'Backed by a document', c: 'ok' }
  if (f.confirmation === 'agent_confirmed') return { t: f.source === 'agent' ? 'Added by your agent' : 'Confirmed by the agency', c: 'ok' }
  return { t: 'Waiting for your agent', c: 'wait' }
}

export function FeaturesEditor({ propertyId, readOnly, externalId, nextVersion }: { propertyId: number; readOnly: boolean; externalId: string; nextVersion: number }) {
  const s = useOwner()
  const [d, setD] = useState<Data | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [core, setCore] = useState<{ bedrooms: number | null; bathrooms: number | null } | null>(null)
  const [q, setQ] = useState('')
  const [sug, setSug] = useState<{ suggestions: Suggestion[]; newCandidate: { label: string } | null } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const r = await sync<Data>('owner/features', { propertyId })
    if (r.ok) { setD({ core: r.core, features: r.features, common: r.common }); setCore(r.core); setFailed(null) } else setFailed(r.message)
  }, [propertyId])
  useEffect(() => { load() }, [load])

  const set = async (body: Record<string, unknown>, ok?: string) => {
    setBusy(true); const r = await sync<{ feature: Feat }>('owner/features/set', { propertyId, ...body }); setBusy(false)
    if (!r.ok) { s.say(r.message, 'err'); return false }
    if (ok) s.say(ok); await load(); return true
  }
  const remove = async (key: string) => {
    setBusy(true); const r = await sync('owner/features/remove', { propertyId, key }); setBusy(false)
    if (!r.ok) s.say(r.message, 'warn'); await load()
  }
  const sendCore = async () => {
    if (!core || !d) return
    const fields: Record<string, number> = {}
    if (core.bedrooms !== d.core.bedrooms && core.bedrooms != null) fields.bedrooms = core.bedrooms
    if (core.bathrooms !== d.core.bathrooms && core.bathrooms != null) fields.bathrooms = core.bathrooms
    if (!Object.keys(fields).length) return
    setBusy(true)
    await s.liveDo('owner/event', { eventType: 'property.owner_updated', data: { externalId, version: nextVersion, fields } }, 'Sent to your agent for approval. The listing changes once approved.')
    setBusy(false)
  }
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (q.trim().length < 2) { setSug(null); return }
    timer.current = setTimeout(async () => { const r = await sync<{ suggestions: Suggestion[]; newCandidate: { label: string } | null }>('owner/features/suggest', { text: q }); if (r.ok) setSug({ suggestions: r.suggestions, newCandidate: r.newCandidate }) }, 250)
  }, [q])

  if (failed) return <section className="lv-section"><p>{failed}</p><button className="lv-btn" onClick={load}>Try again</button></section>
  if (!d || !core) return <section className="lv-section"><p className="lv-faint">Loading features…</p></section>
  const has = (k: string) => d.features.find(f => f.key === k)
  const entry = (k: string) => d.common.find(c => c.key === k)
  const custom = d.features.filter(f => !COUNTERS.includes(f.key) && !SWITCHES.includes(f.key) && !['furnishing', 'shower_type'].includes(f.key))
  const coreChanged = core.bedrooms !== d.core.bedrooms || core.bathrooms !== d.core.bathrooms

  const Counter = ({ k, label, value, onChange }: { k: string; label: string; value: number; onChange: (n: number) => void }) => (
    <div className="ft-counter" data-key={k}>
      <span>{label}</span>
      <div><button aria-label={`Fewer ${label}`} disabled={busy || readOnly || value <= 0} onClick={() => onChange(value - 1)}><Minus size={16} /></button><b aria-live="polite">{value}</b><button aria-label={`More ${label}`} disabled={busy || readOnly || value >= 50} onClick={() => onChange(value + 1)}><Plus size={16} /></button></div>
      {has(k) && <small className={`ft-state ${badge(has(k) as Feat).c}`}>{badge(has(k) as Feat).t}</small>}
    </div>
  )

  return (
    <section className="lv-section ft">
      <h2>Features of this home</h2>
      <p className="lv-faint">Saved in ARGUS straight away. Your agent confirms what you add before it shows on the listing; nothing here is a quality seal.</p>

      <h3 className="ft-h">Rooms</h3>
      <div className="ft-counters">
        <Counter k="bedrooms" label="Bedrooms" value={core.bedrooms ?? 0} onChange={n => setCore(c => c && { ...c, bedrooms: n })} />
        <Counter k="bathrooms" label="Bathrooms" value={core.bathrooms ?? 0} onChange={n => setCore(c => c && { ...c, bathrooms: n })} />
        {COUNTERS.map(k => { const e = entry(k); if (!e) return null; const cur = Number(has(k)?.value ?? 0)
          return <Counter key={k} k={k} label={e.label} value={cur} onChange={n => (n === 0 && has(k)?.source === 'owner' ? remove(k) : set({ key: k, value: n }))} /> })}
      </div>
      {coreChanged && !readOnly && <button className="lv-btn ok" disabled={busy} onClick={sendCore}><Check size={18} />Send bedrooms / bathrooms for approval</button>}

      {(['furnishing', 'shower_type'] as const).map(k => { const e = entry(k); if (!e) return null; const cur = has(k)?.value
        return (
          <div key={k} className="ft-choice"><h3 className="ft-h">{e.label}</h3>
            <div className="lv-chips">{e.choices.map(c => <button key={c} aria-pressed={cur === c} disabled={busy || readOnly} onClick={() => (cur === c ? remove(k) : set({ key: k, value: c }))}>{CHOICE_LABEL[c] || c}</button>)}</div>
            {has(k) && <small className={`ft-state ${badge(has(k) as Feat).c}`}>{badge(has(k) as Feat).t}</small>}
          </div>)
      })}

      <h3 className="ft-h">Has</h3>
      <div className="lv-chips ft-switches">
        {SWITCHES.map(k => { const e = entry(k); if (!e) return null; const f = has(k); const on = f?.value === true
          return <button key={k} aria-pressed={on} disabled={busy || readOnly} title={f ? badge(f).t : undefined} onClick={() => (on ? (f?.source === 'owner' ? remove(k) : set({ key: k, value: false })) : set({ key: k, value: true }))}>{on && <Check size={14} />}{e.label}</button> })}
      </div>

      <h3 className="ft-h">More features</h3>
      {custom.length > 0 && <ul className="ft-list">{custom.map(f => (
        <li key={f.key}><span><b>{f.label}</b>{f.kind === 'count' ? ` · ${String(f.value)}` : ''}{f.status === 'candidate' && <em className="ft-new">new term</em>}<small className={`ft-state ${badge(f).c}`}>{badge(f).t}</small></span>
          {!readOnly && f.source === 'owner' && <button className="lv-btn quiet" aria-label={`Remove ${f.label}`} onClick={() => remove(f.key)}><X size={16} /></button>}</li>
      ))}</ul>}
      {!readOnly && (
        <div className="ft-add">
          <label className="ft-search"><Search size={16} aria-hidden="true" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="+ Add feature, e.g. soundproof windows, pizza oven" aria-label="Add a feature" maxLength={80} /></label>
          {sug && (
            <div className="ft-sug" role="listbox">
              {sug.suggestions.map(x => (
                <button key={x.key} role="option" aria-selected="false" disabled={busy || !!has(x.key)} onClick={async () => { if (await set({ key: x.key, value: x.kind === 'count' ? 1 : x.kind === 'choice' ? x.choices[0] : true }, `Added: ${x.label}`)) { setQ(''); setSug(null) } }}>
                  <b>{x.label}</b>{x.status === 'candidate' ? <small>suggested by other owners</small> : <small>{has(x.key) ? 'already added' : 'standard feature'}</small>}
                </button>))}
              {sug.newCandidate && <button className="ft-newbtn" disabled={busy} onClick={async () => { if (await set({ text: sug.newCandidate!.label }, 'Added as a new term. 2906 reviews new terms before they become search filters.')) { setQ(''); setSug(null) } }}>
                <Plus size={15} />Add “{sug.newCandidate.label}” as a new feature</button>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
