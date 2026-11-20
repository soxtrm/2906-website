'use client'
// House rules for one home (Property Passport, 2026-11-21). The server is the only source:
// every change is written to ARGUS at once, with the version the screen showed, so an
// older device never overwrites a newer rule. Suggestions ARGUS read in the owner's
// messages stay suggestions until the owner accepts them. Nothing here is sent to agencies.
import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, Sparkles, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { sync } from '@/lib/owner/live'

type Status = 'allowed' | 'not_allowed' | 'conditional' | 'unknown'
interface Details { chips?: string[]; insurance?: 'required' | 'not_required' | 'unknown'; maxCount?: number; kinds?: string; minMonths?: number; maxMonths?: number; maxPeople?: number; noticeHours?: number; items?: string[]; exceptions?: string }
interface Cond { id: number; key: string; status: Status; details: Details; note: string | null; source: 'owner' | 'ai' | 'agent'; state: string; version: number; at: string; evidence?: { quote: string | null } }
interface Hint { field: string; value: string; scope: 'owner' | 'property' }
interface Data { conditions: Cond[]; proposals: Cond[]; hints: Hint[] }

const TOPICS: { key: string; label: string; hint: string }[] = [
  { key: 'pets_dogs', label: 'Dogs', hint: 'Size, number, deposit, insurance' },
  { key: 'pets_cats', label: 'Cats', hint: 'Number, deposit, insurance' },
  { key: 'pets_other', label: 'Other pets', hint: 'Birds, fish, rabbits …' },
  { key: 'smoking', label: 'Smoking', hint: 'Inside, balcony, outside' },
  { key: 'tenancy_duration', label: 'Length of stay', hint: 'Shortest and longest' },
  { key: 'occupancy', label: 'Who lives there', hint: 'Number of people, sharing, company lets' },
  { key: 'viewing', label: 'Viewings', hint: 'Notice, who is present' },
  { key: 'other', label: 'Your own rules', hint: 'Anything else tenants should know' },
]
const STATUS: { v: Status; label: string }[] = [
  { v: 'allowed', label: 'Allowed' }, { v: 'not_allowed', label: 'Not allowed' }, { v: 'conditional', label: 'Conditional' }, { v: 'unknown', label: 'Not sure' },
]
const CHIP: Record<string, string> = {
  small_only: 'Small only', one_only: 'Only one', extra_deposit: 'Extra deposit', meet_pet_first: 'Meet the pet first', cleaning_at_end: 'Cleaning at the end',
  owner_approval_each_time: 'I approve each one', renewal_possible: 'Renewal possible', fixed_end_date: 'Fixed end date', short_lets_ok: 'Short lets OK',
  sharing_ok: 'Flat sharing OK', company_let_ok: 'Company let OK', no_subletting: 'No subletting', couples_ok: 'Couples OK',
  outside_only: 'Outside only', balcony_only: 'Balcony only', no_vaping: 'No vaping inside', owner_present: 'I want to be there',
  tenant_present: 'Current tenant present', weekdays_only: 'Weekdays only', daytime_only: 'Daytime only', id_before_viewing: 'ID before the viewing',
}
const CHIPS: Record<string, string[]> = {
  pets_dogs: ['small_only', 'one_only', 'extra_deposit', 'meet_pet_first', 'cleaning_at_end', 'owner_approval_each_time'],
  pets_cats: ['one_only', 'extra_deposit', 'meet_pet_first', 'cleaning_at_end', 'owner_approval_each_time'],
  pets_other: ['small_only', 'extra_deposit', 'owner_approval_each_time'],
  tenancy_duration: ['renewal_possible', 'fixed_end_date', 'short_lets_ok'],
  occupancy: ['sharing_ok', 'company_let_ok', 'couples_ok', 'no_subletting'],
  smoking: ['outside_only', 'balcony_only', 'no_vaping'],
  viewing: ['owner_present', 'tenant_present', 'weekdays_only', 'daytime_only', 'id_before_viewing'],
  other: [],
}
const isPet = (k: string) => k.startsWith('pets_')
const label = (k: string) => TOPICS.find(t => t.key === k)?.label || k
const statusLabel = (s: Status) => STATUS.find(x => x.v === s)?.label || s

function summary(c: Cond) {
  const d = c.details, bits: string[] = []
  if (d.minMonths || d.maxMonths) bits.push(d.minMonths && d.maxMonths ? `${d.minMonths}–${d.maxMonths} months` : d.minMonths ? `at least ${d.minMonths} months` : `up to ${d.maxMonths} months`)
  if (d.maxPeople) bits.push(`up to ${d.maxPeople} people`)
  if (d.maxCount) bits.push(`up to ${d.maxCount}`)
  if (d.noticeHours != null) bits.push(`${d.noticeHours} h notice`)
  if (d.insurance === 'required') bits.push('pet insurance needed')
  for (const ch of d.chips || []) bits.push(CHIP[ch] || ch)
  if (d.items?.length) bits.push(...d.items)
  return bits.join(' · ')
}

export function HouseRules({ propertyId }: { propertyId: number }) {
  const s = useOwner()
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await sync<Data>('owner/conditions', { propertyId })
    if (r.ok) { setData({ conditions: r.conditions, proposals: r.proposals, hints: r.hints }); setFailed(null) } else setFailed(r.message)
  }, [propertyId])
  useEffect(() => { load() }, [load])

  const save = async (key: string, status: Status, details: Details = {}, note: string | null = null) => {
    if (!data) return false
    const cur = data.conditions.find(c => c.key === key)
    setBusy(true)
    const r = await sync<{ condition: Cond }>('owner/conditions/set', { propertyId, key, status, details, note, baseVersion: cur?.version || 0 })
    setBusy(false)
    if (!r.ok) {
      s.say(r.message, r.status === 409 ? 'warn' : 'err')
      if (r.status === 409) await load()
      return false
    }
    setData(d => d && { ...d, conditions: [...d.conditions.filter(c => c.key !== key), r.condition], proposals: d.proposals.filter(p => p.key !== key) })
    s.say(`Saved for this home: ${label(key)} – ${statusLabel(status)}.`)
    return true
  }
  const decide = async (p: Cond, decision: 'accept' | 'reject') => {
    setBusy(true)
    const r = await sync<{ condition?: Cond }>('owner/conditions/decide', { propertyId, proposalId: p.id, decision })
    setBusy(false)
    if (!r.ok) { s.say(r.message, 'err'); await load(); return }
    s.say(decision === 'accept' ? `Saved: ${label(p.key)} – ${statusLabel(p.status)}.` : 'Suggestion removed.')
    await load()
  }

  if (failed) return <section className="lv-section"><p>{failed}</p><button className="lv-btn" onClick={load}>Try again</button></section>
  if (!data) return <section className="lv-section"><p className="lv-faint">Loading house rules…</p></section>
  const hintFor = (key: string) => data.hints.filter(h => (isPet(key) && h.field === 'pets') || (key === 'smoking' && h.field === 'smoking') || (key === 'occupancy' && h.field === 'sharing'))

  return (
    <section className="lv-section hr">
      <h2>House rules for this home</h2>
      <p className="lv-faint">Only for this home. Saved in ARGUS straight away, so they are the same on every device. Agencies only see them if you share the home with them.</p>

      {data.proposals.map(p => (
        <div key={p.id} className="hr-proposal">
          <Sparkles size={18} aria-hidden="true" />
          <div>
            <b>ARGUS noticed: {label(p.key)} – {statusLabel(p.status)}{summary(p) ? ` (${summary(p)})` : ''}</b>
            {p.evidence?.quote && <small>From your message: “{p.evidence.quote}”</small>}
            <small>Only a suggestion until you confirm it.</small>
          </div>
          <span className="hr-proposal-actions">
            <button className="lv-btn ok" disabled={busy} onClick={() => decide(p, 'accept')}><Check size={18} />Yes, correct</button>
            <button className="lv-btn quiet" disabled={busy} onClick={() => decide(p, 'reject')}><X size={18} />No</button>
          </span>
        </div>
      ))}

      <div className="hr-list">
        {TOPICS.map(t => {
          const c = data.conditions.find(x => x.key === t.key)
          const isOpen = open === t.key
          const hints = c ? [] : hintFor(t.key)
          return (
            <div key={t.key} className="hr-item" data-open={isOpen || undefined}>
              <div className="hr-head">
                <button className="hr-title" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.key)}>
                  <span><b>{t.label}</b><small>{c ? (summary(c) || (c.note ? c.note : t.hint)) : t.hint}</small></span>
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
                <div className="hr-status" role="group" aria-label={`${t.label}: status`}>
                  {STATUS.map(st => (
                    <button key={st.v} data-v={st.v} aria-pressed={c?.status === st.v} disabled={busy}
                      onClick={async () => { if (c?.status === st.v) { setOpen(isOpen ? null : t.key); return } const ok = await save(t.key, st.v, st.v === 'conditional' ? (c?.details || {}) : st.v === c?.status ? c.details : {}, c?.note ?? null); if (ok && st.v === 'conditional') setOpen(t.key) }}>
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>
              {c && c.source === 'ai' && <small className="hr-source">Suggested by ARGUS, confirmed by you</small>}
              {hints.map(h => (
                <small key={h.field + h.scope} className="hr-hint">From your earlier chats with ARGUS{h.scope === 'owner' ? ' (all homes)' : ''}: “{h.value}”</small>
              ))}
              {isOpen && <Editor topic={t.key} cond={c} busy={busy} onSave={(d, note) => save(t.key, c?.status && c.status !== 'unknown' ? c.status : 'conditional', d, note)} />}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Editor({ topic, cond, busy, onSave }: { topic: string; cond?: Cond; busy: boolean; onSave: (d: Details, note: string | null) => Promise<boolean> }) {
  const [d, setD] = useState<Details>(cond?.details || {})
  const [note, setNote] = useState(cond?.note || '')
  const [item, setItem] = useState('')
  useEffect(() => { setD(cond?.details || {}); setNote(cond?.note || '') }, [cond?.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (ch: string) => setD(x => ({ ...x, chips: (x.chips || []).includes(ch) ? (x.chips || []).filter(y => y !== ch) : [...(x.chips || []), ch] }))
  const num = (k: keyof Details, v: string) => setD(x => ({ ...x, [k]: v === '' ? undefined : Number(v.replace(/\D/g, '')) }))
  const clean = (x: Details): Details => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as Details

  return (
    <div className="hr-editor">
      {CHIPS[topic].length > 0 && (
        <div className="lv-chips hr-chips">
          {CHIPS[topic].map(ch => <button key={ch} type="button" aria-pressed={(d.chips || []).includes(ch)} onClick={() => toggle(ch)}>{CHIP[ch]}</button>)}
        </div>
      )}
      {isPet(topic) && (
        <div className="hr-fields">
          <div className="hr-field"><span>Pet insurance</span>
            <div className="lv-chips hr-chips">
              {([['required', 'Required'], ['not_required', 'Not needed'], ['unknown', 'Not sure']] as const).map(([v, l]) => (
                <button key={v} type="button" aria-pressed={d.insurance === v} onClick={() => setD(x => ({ ...x, insurance: x.insurance === v ? undefined : v }))}>{l}</button>
              ))}
            </div>
          </div>
          <label className="hr-field"><span>How many at most</span><input className="lv-input hr-num" inputMode="numeric" value={d.maxCount ?? ''} onChange={e => num('maxCount', e.target.value)} /></label>
          {topic === 'pets_other' && <label className="hr-field wide"><span>Which animals</span><input className="lv-input" maxLength={120} value={d.kinds || ''} onChange={e => setD(x => ({ ...x, kinds: e.target.value }))} placeholder="e.g. birds, fish" /></label>}
        </div>
      )}
      {topic === 'tenancy_duration' && (
        <div className="hr-fields">
          <label className="hr-field"><span>Shortest (months)</span><input className="lv-input hr-num" inputMode="numeric" value={d.minMonths ?? ''} onChange={e => num('minMonths', e.target.value)} /></label>
          <label className="hr-field"><span>Longest (months)</span><input className="lv-input hr-num" inputMode="numeric" value={d.maxMonths ?? ''} onChange={e => num('maxMonths', e.target.value)} /></label>
        </div>
      )}
      {topic === 'occupancy' && <div className="hr-fields"><label className="hr-field"><span>People at most</span><input className="lv-input hr-num" inputMode="numeric" value={d.maxPeople ?? ''} onChange={e => num('maxPeople', e.target.value)} /></label></div>}
      {topic === 'viewing' && <div className="hr-fields"><label className="hr-field"><span>Notice (hours)</span><input className="lv-input hr-num" inputMode="numeric" value={d.noticeHours ?? ''} onChange={e => num('noticeHours', e.target.value)} /></label></div>}
      {topic === 'other' && (
        <div className="hr-items">
          {(d.items || []).map((x, i) => <span key={i} className="hr-own">{x}<button type="button" aria-label={`Remove ${x}`} onClick={() => setD(v => ({ ...v, items: (v.items || []).filter((_, j) => j !== i) }))}><X size={14} /></button></span>)}
          <div className="lv-row">
            <input className="lv-input" maxLength={200} value={item} onChange={e => setItem(e.target.value)} placeholder="e.g. No parties" onKeyDown={e => { if (e.key === 'Enter' && item.trim()) { setD(v => ({ ...v, items: [...(v.items || []), item.trim()].slice(0, 10) })); setItem('') } }} />
            <button type="button" className="lv-btn" disabled={!item.trim()} onClick={() => { setD(v => ({ ...v, items: [...(v.items || []), item.trim()].slice(0, 10) })); setItem('') }}>Add</button>
          </div>
        </div>
      )}
      <label className="hr-field wide"><span>Exceptions (optional)</span><input className="lv-input" maxLength={500} value={d.exceptions || ''} onChange={e => setD(x => ({ ...x, exceptions: e.target.value }))} placeholder="e.g. assistance dogs always welcome" /></label>
      <label className="hr-field wide"><span>Explanation (optional)</span><textarea className="lv-input" rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>
      <button className="lv-btn ok" disabled={busy} onClick={() => onSave(clean(d), note.trim() || null)}><Check size={18} />Save</button>
    </div>
  )
}

// ── what the owner did, from ARGUS (same on every device) ──────────────────
interface Act { id: number; at: string; label: string; ref: string | null; topic: string | null }
export function ActivityList() {
  const [rows, setRows] = useState<Act[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => { sync<{ activity: Act[] }>('owner/activity').then(r => (r.ok ? setRows(r.activity) : setFailed(r.message))) }, [])
  if (failed) return <p className="lv-faint">{failed}</p>
  if (!rows) return <p className="lv-faint">Loading…</p>
  if (!rows.length) return <p className="lv-faint">Nothing yet.</p>
  return (
    <ul className="hr-activity">
      {rows.map(r => (
        <li key={r.id}>
          <b>{r.label}{r.topic && TOPICS.some(t => t.key === r.topic) ? `: ${label(r.topic)}` : ''}</b>
          <small>{new Date(r.at).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{r.ref ? ` · Ref ${r.ref}` : ''}</small>
        </li>
      ))}
    </ul>
  )
}
