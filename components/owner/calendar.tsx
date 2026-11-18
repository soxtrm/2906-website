'use client'
import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, datePart, startOfWeek, timePart, toHHMM, toMin, weekdayOf, windowsFor } from '@/lib/owner/engine'
import type { ViewingRequest } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { RequestCard } from './request-card'
import { dayName, monthName, niceDate, shortDay } from './format'

const START = 8 * 60, END = 21 * 60, HOUR_H = 46
const y = (min: number) => ((min - START) / 60) * HOUR_H
const snap = (min: number) => Math.max(START, Math.min(END, Math.round(min / 30) * 30))
const LIVE = new Set(['awaiting_owner', 'question', 'new_time_proposed', 'confirmed', 'completed'])

type Draft = { date: string; a: number; b: number }

export function WeekCalendar({ compact = false }: { compact?: boolean }) {
  const s = useOwner()
  const [view, setView] = useState<'week' | 'month' | 'day'>('week')
  const [anchor, setAnchor] = useState(s.today)
  const [propId, setPropId] = useState<number>(s.properties[0].id)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [open, setOpen] = useState<ViewingRequest | null>(null)
  const drag = useRef<{ date: string; top: number; a: number } | null>(null)
  const prop = s.properties.find(p => p.id === propId)!

  const reqs = s.requests.filter(r => r.propertyId === propId && LIVE.has(r.status))
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))
  const blocked = (d: string) => s.exceptions.some(e => e.propertyId === propId && e.date === d && e.kind === 'blocked' && !e.start)

  const minuteAt = (e: React.PointerEvent, top: number) => START + ((e.clientY - top) / HOUR_H) * 60
  const down = (e: React.PointerEvent<HTMLDivElement>, date: string) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (compact || blocked(date)) return
    const top = e.currentTarget.getBoundingClientRect().top
    const a = snap(minuteAt(e, top))
    drag.current = { date, top, a }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft({ date, a, b: a + 60 })
  }
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return
    const m = snap(minuteAt(e, drag.current.top))
    const { a } = drag.current
    setDraft({ date: drag.current.date, a: Math.min(a, m), b: Math.max(a + 30, m) })
  }
  const up = () => { drag.current = null }

  const shift = (n: number) => setAnchor(a => view === 'month'
    ? (() => { const [yy, mm] = a.split('-').map(Number); const d = new Date(Date.UTC(yy, mm - 1 + n, 1)); return d.toISOString().slice(0, 10) })()
    : addDays(a, view === 'week' ? 7 * n : n))

  const title = view === 'month'
    ? `${monthName(Number(anchor.slice(5, 7)) - 1)} ${anchor.slice(0, 4)}`
    : view === 'week' ? `${niceDate(days[0], false)} – ${niceDate(days[6], false)}` : niceDate(anchor)

  return (
    <div>
      <div className="ow-cal-tools">
        <div className="ow-inline-form">
          <label className="ow-label" htmlFor="ow-prop-sel">Property</label>
          <select id="ow-prop-sel" value={propId} onChange={e => { setPropId(Number(e.target.value)); setDraft(null) }}>
            {s.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="ow-inline-form">
          <button className="ow-btn small quiet" onClick={() => shift(-1)} aria-label="Previous"><ChevronLeft size={18} /></button>
          <b style={{ minWidth: 190, textAlign: 'center' }}>{title}</b>
          <button className="ow-btn small quiet" onClick={() => shift(1)} aria-label="Next"><ChevronRight size={18} /></button>
          <button className="ow-btn small" onClick={() => setAnchor(s.today)}>Today</button>
        </div>
        {!compact && (
          <div className="ow-seg" role="group" aria-label="View">
            {(['month', 'week', 'day'] as const).map(v => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
          </div>
        )}
      </div>

      {view === 'week' && (
        <div style={{ overflowX: 'auto' }}>
          <div className="ow-week" style={{ minWidth: 720, ['--ow-hour-h' as string]: `${HOUR_H}px` }}>
            <div className="ow-week-head" />
            {days.map(d => (
              <div key={d} className="ow-week-head" data-today={d === s.today} data-blocked={blocked(d)}>
                {shortDay(d)}<b>{Number(d.slice(8))}</b>
              </div>
            ))}
            <div className="ow-hours" style={{ height: y(END) }}>
              {Array.from({ length: (END - START) / 60 + 1 }, (_, i) => <span key={i} className="ow-hour" style={{ top: i * HOUR_H }}>{toHHMM(START + i * 60)}</span>)}
            </div>
            {days.map(d => {
              const wins = windowsFor(s.rules, s.exceptions, propId, d)
              const ruleFor = (start: string, end: string) => s.rules.find(r => r.propertyId === propId && r.weekday === weekdayOf(d) && r.start === start && r.end === end)
              const extraFor = (start: string) => s.exceptions.find(e => e.propertyId === propId && e.date === d && e.kind === 'extra' && e.start === start)
              const dayReqs = reqs.filter(r => datePart(r.start) === d)
              return (
                <div key={d} className="ow-day" style={{ height: y(END) }} onPointerDown={e => down(e, d)} onPointerMove={move} onPointerUp={up}
                  aria-label={`${dayName(d)}: ${wins.length ? wins.map(w => `${w.start} to ${w.end}`).join(', ') : 'no viewing hours'}`}>
                  {wins.map(w => {
                    const rule = ruleFor(w.start, w.end); const extra = extraFor(w.start)
                    return (
                      <div key={w.start} className="ow-shutter" data-extra={w.source === 'extra'} style={{ top: y(toMin(w.start)), height: y(toMin(w.end)) - y(toMin(w.start)) }}>
                        {w.start}–{w.end}{w.source === 'extra' ? ' · this day only' : ''}
                        {!compact && (rule || extra) && <button aria-label={`Remove ${w.start} to ${w.end}`} onClick={() => (rule ? s.removeRule(rule.id) : s.removeExtra(extra!.id))}>×</button>}
                      </div>
                    )
                  })}
                  {draft && draft.date === d && <div className="ow-shutter" data-draft="true" style={{ top: y(draft.a), height: y(draft.b) - y(draft.a) }}>{toHHMM(draft.a)}–{toHHMM(draft.b)}</div>}
                  {dayReqs.map(r => {
                    const room = r.roomId ? prop.rooms.find(x => x.id === r.roomId) : null
                    return (
                      <button key={r.id} className="ow-tab" data-status={r.status} style={{ top: y(toMin(timePart(r.start))) + 2 }} onClick={() => setOpen(r)}>
                        {timePart(r.start)} {r.status === 'confirmed' ? 'Viewing' : r.status === 'completed' ? 'Viewed' : 'Request'}{room ? ` · ${room.label}` : ''}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {view === 'month' && <Month anchor={anchor} propId={propId} onPick={d => { setAnchor(d); setView('day') }} />}
      {view === 'day' && <Day date={anchor} propId={propId} />}

      <div className="ow-legend" aria-hidden="true">
        <span><i style={{ background: 'repeating-linear-gradient(180deg,#1f4d3f 0 4px,#2f6b58 4px 6px)' }} />Viewing hours</span>
        <span><i style={{ background: '#b88a3c' }} />Waiting for you</span>
        <span><i style={{ background: '#fff', outline: '2px solid #1f4d3f' }} />Confirmed</span>
        <span><i style={{ background: 'repeating-linear-gradient(135deg,#f3e3e5 0 4px,#fff 4px 8px)' }} />Blocked day</span>
      </div>

      {!compact && view === 'week' && !draft && <p className="ow-hint" style={{ marginTop: 14 }}>Drag down a day to add viewing hours. Visitors can only ask for times inside them.</p>}
      {draft && (
        <div className="ow-panel" style={{ marginTop: 16 }} role="dialog" aria-label="Save viewing hours">
          <h3>{dayName(draft.date)}, {toHHMM(draft.a)} to {toHHMM(draft.b)} at {prop.name}</h3>
          <div className="ow-req-actions" style={{ marginTop: 12 }}>
            <button className="ow-btn primary" onClick={() => { s.addRule({ propertyId: propId, weekday: weekdayOf(draft.date), start: toHHMM(draft.a), end: toHHMM(draft.b), slotMinutes: 30 }); setDraft(null) }}>Every {dayName(draft.date)}</button>
            <button className="ow-btn" onClick={() => { s.addExtra(propId, draft.date, toHHMM(draft.a), toHHMM(draft.b)); setDraft(null) }}>Only on {niceDate(draft.date, false)}</button>
            <button className="ow-btn quiet" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
      {open && (
        <div style={{ marginTop: 16 }}>
          <RequestCard r={s.requests.find(r => r.id === open.id)!} />
          <button className="ow-btn quiet" style={{ marginTop: 8 }} onClick={() => setOpen(null)}>Close</button>
        </div>
      )}
    </div>
  )
}

function Month({ anchor, propId, onPick }: { anchor: string; propId: number; onPick: (d: string) => void }) {
  const s = useOwner()
  const first = `${anchor.slice(0, 7)}-01`
  const grid = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(startOfWeek(first), i)), [first])
  return (
    <div className="ow-month">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="ow-month-dow">{d}</div>)}
      {grid.map(d => {
        const wins = windowsFor(s.rules, s.exceptions, propId, d)
        const waiting = s.requests.filter(r => r.propertyId === propId && datePart(r.start) === d && r.status === 'awaiting_owner').length
        const conf = s.requests.filter(r => r.propertyId === propId && datePart(r.start) === d && r.status === 'confirmed').length
        const blocked = s.exceptions.some(e => e.propertyId === propId && e.date === d && e.kind === 'blocked' && !e.start)
        return (
          <button key={d} className="ow-mday" data-out={d.slice(0, 7) !== anchor.slice(0, 7)} data-today={d === s.today} data-blocked={blocked} onClick={() => onPick(d)}
            aria-label={`${niceDate(d)}${wins.length ? ', viewing hours' : ''}${waiting ? `, ${waiting} waiting` : ''}${conf ? `, ${conf} confirmed` : ''}${blocked ? ', blocked' : ''}`}>
            <b>{Number(d.slice(8))}</b>
            {wins.length > 0 && <span className="ow-mbar" />}
            {waiting > 0 && <span className="ow-mdot">{waiting} waiting</span>}
            {conf > 0 && <span className="ow-mdot" style={{ color: 'var(--ow-green)' }}>{conf} confirmed</span>}
          </button>
        )
      })}
    </div>
  )
}

function Day({ date, propId }: { date: string; propId: number }) {
  const s = useOwner()
  const wins = windowsFor(s.rules, s.exceptions, propId, date)
  const blocked = s.exceptions.some(e => e.propertyId === propId && e.date === date && e.kind === 'blocked' && !e.start)
  const reqs = s.requests.filter(r => r.propertyId === propId && datePart(r.start) === date).sort((a, b) => a.start.localeCompare(b.start))
  return (
    <div className="ow-attn">
      <div className="ow-panel">
        <h3>{blocked ? 'This day is blocked' : wins.length ? `Viewing hours: ${wins.map(w => `${w.start}–${w.end}`).join(', ')}` : 'No viewing hours on this day'}</h3>
        <div className="ow-req-actions" style={{ marginTop: 12 }}>
          {blocked
            ? <button className="ow-btn" onClick={() => s.unblockDay(propId, date)}>Open this day again</button>
            : <button className="ow-btn" onClick={() => s.blockDay(propId, date)}>Block this whole day</button>}
        </div>
      </div>
      {reqs.length ? reqs.map(r => <RequestCard key={r.id} r={r} />) : <div className="ow-panel ow-empty">No requests on this day.</div>}
    </div>
  )
}
