'use client'
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from './ui'
import type { Detail, Me, Schedule } from './types'

const BASE = '/api/owner-portal'
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAY_NUM = [1, 2, 3, 4, 5, 6, 0]
const TIMES = Array.from({ length: 4 * 17 }, (_, i) => { const m = 6 * 60 + i * 15; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` })
const DURATIONS = [10, 15, 20, 30, 60, 120]
export const EMPTY: Schedule = { weekly: [], breaks: [], exceptions: [], blocked: [], durationMin: 20, bufferMin: 10, noticeHours: 12, horizonDays: 21, approval: 'manual' }

function TimeSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{TIMES.map(t => <option key={t}>{t}</option>)}</select>
}

export function AvailabilityEditor({ me, notify }: { me: Me; notify: (m: string) => void }) {
  const [pid, setPid] = useState<number>(me.properties[0]?.id)
  const [s, setS] = useState<Schedule>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [custom, setCustom] = useState(false)
  const [copyTo, setCopyTo] = useState<number[]>([])

  useEffect(() => {
    if (!pid) return
    setLoaded(false); setErr('')
    api<Detail>(BASE, `/properties/${pid}`).then(d => { const sch = d.rules?.schedule || EMPTY; setS(sch); setCustom(!DURATIONS.includes(sch.durationMin)); setLoaded(true) }).catch(e => setErr(e.message))
  }, [pid])

  const set = (patch: Partial<Schedule>) => setS(prev => ({ ...prev, ...patch }))
  const ranges = (day: number) => s.weekly.map((w, i) => ({ ...w, i })).filter(w => w.day === day)
  const others = me.properties.filter(p => p.id !== pid)
  const summary = useMemo(() => {
    const hours = s.weekly.reduce((n, w) => n + (Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3)) - Number(w.start.slice(0, 2)) * 60 - Number(w.start.slice(3))), 0) / 60
    return `${hours.toFixed(hours % 1 ? 1 : 0)} h per week · ${s.durationMin}-min viewings · ${s.bufferMin} min between · ${s.noticeHours} h notice`
  }, [s])

  async function save() {
    setSaving(true); setErr('')
    try {
      const r = await api<{ windows: number; version: number }>(BASE, `/properties/${pid}/rules`, { method: 'PUT', json: { schedule: s } })
      if (copyTo.length) await api(BASE, `/properties/${pid}/rules/copy`, { method: 'POST', json: { propertyIds: copyTo } })
      notify(`Availability saved: ${r.windows} viewing windows over the next ${s.horizonDays} days${copyTo.length ? `, copied to ${copyTo.length} more` : ''}.`)
      setCopyTo([])
    } catch (e) { setErr((e as ApiError).message) } finally { setSaving(false) }
  }

  if (!me.scopes.includes('schedule')) return <div className="op-empty">Availability is not part of your access.</div>
  return (
    <div>
      <div className="op-section-head">
        <div>
          <div className="op-eyebrow">Availability</div>
          <h1 className="op-h1">When can agents view?</h1>
          <p className="op-lede">Set it once. Agents only see free times, never who else is booked. Changes apply to new requests straight away.</p>
        </div>
        {me.properties.length > 1 && (
          <label className="op-field" style={{ minWidth: 220 }}><span>Property</span>
            <select className="op-input" value={pid} onChange={e => setPid(Number(e.target.value))}>{me.properties.map(p => <option key={p.id} value={p.id}>#{p.ref} · {p.town || 'Malta'}</option>)}</select>
          </label>
        )}
      </div>
      {err && <div className="op-error" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
      {!loaded ? <div className="op-empty">Loading…</div> : (
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="op-card op-card-pad">
            <div className="op-eyebrow">Weekly times</div>
            <p style={{ margin: '4px 0 6px', color: 'var(--op-muted)', fontSize: 13.5 }}>{summary}</p>
            {DAYS.map((name, idx) => {
              const day = DAY_NUM[idx]
              const list = ranges(day)
              return (
                <div key={name} className="op-rule-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button type="button" className="op-toggle" aria-pressed={list.length > 0} onClick={() => set({ weekly: list.length ? s.weekly.filter(w => w.day !== day) : [...s.weekly, { day, start: '10:00', end: '13:00' }] })}>{name.slice(0, 3)}</button>
                  </div>
                  <div>
                    {!list.length && <span style={{ color: 'var(--op-faint)', fontSize: 13.5 }}>Not available</span>}
                    {list.map(w => (
                      <span key={w.i} className="op-range">
                        <TimeSelect label={`${name} from`} value={w.start} onChange={v => set({ weekly: s.weekly.map((x, j) => j === w.i ? { ...x, start: v } : x) })} />–
                        <TimeSelect label={`${name} until`} value={w.end} onChange={v => set({ weekly: s.weekly.map((x, j) => j === w.i ? { ...x, end: v } : x) })} />
                        <button type="button" className="op-btn op-btn-ghost op-btn-sm" aria-label={`Remove ${name} ${w.start}`} onClick={() => set({ weekly: s.weekly.filter((_, j) => j !== w.i) })}><Trash2 size={14} /></button>
                      </span>
                    ))}
                    {list.length > 0 && <button type="button" className="op-btn op-btn-ghost op-btn-sm" onClick={() => set({ weekly: [...s.weekly, { day, start: '16:00', end: '18:00' }] })}><Plus size={14} /> Add time</button>}
                  </div>
                </div>
              )
            })}
          </section>

          <section className="op-card op-card-pad" style={{ display: 'grid', gap: 14 }}>
            <div className="op-eyebrow">Viewing length and spacing</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Viewing length">
              {DURATIONS.map(d => <button key={d} type="button" className="op-toggle" aria-pressed={!custom && s.durationMin === d} onClick={() => { setCustom(false); set({ durationMin: d }) }}>{d < 60 ? `${d} min` : `${d / 60} h`}</button>)}
              <button type="button" className="op-toggle" aria-pressed={custom} onClick={() => setCustom(true)}>Custom</button>
              {custom && <input className="op-input" style={{ width: 110, minHeight: 36 }} type="number" min={5} max={240} step={5} aria-label="Custom minutes" value={s.durationMin} onChange={e => set({ durationMin: Number(e.target.value) })} />}
            </div>
            <div className="op-grid-2">
              <label className="op-field"><span>Break between viewings</span>
                <select className="op-input" value={s.bufferMin} onChange={e => set({ bufferMin: Number(e.target.value) })}>{[0, 5, 10, 15, 20, 30, 45, 60].map(n => <option key={n} value={n}>{n ? `${n} minutes` : 'No break'}</option>)}</select></label>
              <label className="op-field"><span>Minimum notice</span>
                <select className="op-input" value={s.noticeHours} onChange={e => set({ noticeHours: Number(e.target.value) })}>{[0, 2, 4, 12, 24, 48, 72].map(n => <option key={n} value={n}>{n ? `${n} hours` : 'None'}</option>)}</select></label>
              <label className="op-field"><span>Show times for the next</span>
                <select className="op-input" value={s.horizonDays} onChange={e => set({ horizonDays: Number(e.target.value) })}>{[7, 14, 21, 30, 45, 60].map(n => <option key={n} value={n}>{n} days</option>)}</select></label>
              <label className="op-field"><span>Daily break (every day)</span>
                <span className="op-range" style={{ margin: 0 }}>
                  <TimeSelect label="Daily break from" value={s.breaks[0]?.start || '13:00'} onChange={v => set({ breaks: [{ day: null, start: v, end: s.breaks[0]?.end || '14:00' }] })} />–
                  <TimeSelect label="Daily break until" value={s.breaks[0]?.end || '14:00'} onChange={v => set({ breaks: [{ day: null, start: s.breaks[0]?.start || '13:00', end: v }] })} />
                  {s.breaks.length ? <button type="button" className="op-btn op-btn-ghost op-btn-sm" onClick={() => set({ breaks: [] })}>None</button> : <span style={{ fontSize: 12, color: 'var(--op-faint)' }}>off</span>}
                </span>
              </label>
            </div>
          </section>

          <section className="op-card op-card-pad" style={{ display: 'grid', gap: 12 }}>
            <div className="op-eyebrow">Requests</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Approval">
              <button type="button" className="op-toggle" aria-pressed={s.approval === 'manual'} onClick={() => set({ approval: 'manual' })}>I place each request</button>
              <button type="button" className="op-toggle" aria-pressed={s.approval === 'auto'} onClick={() => set({ approval: 'auto' })}>Propose free times automatically</button>
            </div>
            <p style={{ margin: 0, color: 'var(--op-muted)', fontSize: 13.5 }}>{s.approval === 'auto' ? 'A request for a free time inside your rules is proposed to the agent at once. It is still only confirmed after the agent reconfirms with the client.' : 'Every request waits in your desk until you place or decline it.'}</p>
          </section>

          <section className="op-card op-card-pad" style={{ display: 'grid', gap: 12 }}>
            <div className="op-eyebrow">Days off and holidays</div>
            {s.blocked.map((b, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label className="op-field"><span>From</span><input className="op-input" type="date" value={b.from} onChange={e => set({ blocked: s.blocked.map((x, j) => j === i ? { ...x, from: e.target.value } : x) })} /></label>
                <label className="op-field"><span>Until</span><input className="op-input" type="date" value={b.to} onChange={e => set({ blocked: s.blocked.map((x, j) => j === i ? { ...x, to: e.target.value } : x) })} /></label>
                <label className="op-field" style={{ flex: 1, minWidth: 140 }}><span>Label</span><input className="op-input" value={b.label || ''} maxLength={80} onChange={e => set({ blocked: s.blocked.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} /></label>
                <button type="button" className="op-btn op-btn-ghost" aria-label="Remove" onClick={() => set({ blocked: s.blocked.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
              </div>
            ))}
            {s.exceptions.map((x, i) => (
              <div key={`e${i}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label className="op-field"><span>Date</span><input className="op-input" type="date" value={x.date} onChange={e => set({ exceptions: s.exceptions.map((y, j) => j === i ? { ...y, date: e.target.value } : y) })} /></label>
                <label className="op-field"><span>On that day</span>
                  <select className="op-input" value={x.kind} onChange={e => set({ exceptions: s.exceptions.map((y, j) => j === i ? (e.target.value === 'available' ? { date: y.date, kind: 'available', start: '10:00', end: '12:00' } : { date: y.date, kind: 'unavailable' }) : y) })}>
                    <option value="unavailable">Not available</option><option value="available">Extra times</option></select></label>
                {x.kind === 'available' && <span className="op-range"><TimeSelect label="Extra from" value={x.start || '10:00'} onChange={v => set({ exceptions: s.exceptions.map((y, j) => j === i ? { ...y, start: v } : y) })} />–<TimeSelect label="Extra until" value={x.end || '12:00'} onChange={v => set({ exceptions: s.exceptions.map((y, j) => j === i ? { ...y, end: v } : y) })} /></span>}
                <button type="button" className="op-btn op-btn-ghost" aria-label="Remove" onClick={() => set({ exceptions: s.exceptions.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="op-btn op-btn-sm" onClick={() => { const d = new Date().toISOString().slice(0, 10); set({ blocked: [...s.blocked, { from: d, to: d, label: 'Holiday' }] }) }}><Plus size={14} /> Block dates</button>
              <button type="button" className="op-btn op-btn-sm" onClick={() => set({ exceptions: [...s.exceptions, { date: new Date().toISOString().slice(0, 10), kind: 'unavailable' }] })}><Plus size={14} /> One-off change</button>
            </div>
          </section>

          {others.length > 0 && (
            <section className="op-card op-card-pad" style={{ display: 'grid', gap: 10 }}>
              <div className="op-eyebrow">Use the same times for</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{others.map(p => <button key={p.id} type="button" className="op-toggle" aria-pressed={copyTo.includes(p.id)} onClick={() => setCopyTo(c => c.includes(p.id) ? c.filter(x => x !== p.id) : [...c, p.id])}>#{p.ref} · {p.town}</button>)}</div>
            </section>
          )}

          <div style={{ position: 'sticky', bottom: 'calc(84px + env(safe-area-inset-bottom))', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="op-btn op-btn-accent" disabled={saving} onClick={save} style={{ minWidth: 200 }}>{saving ? 'Saving…' : 'Save availability'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
