'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, datePart, startOfWeek, timePart, toHHMM, toMin, weekdayOf, windowsFor } from '@/lib/owner/engine'
import { SOURCE_LABEL, type Property, type ViewingRequest } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { RequestCard } from './request-card'
import { dayName, monthName, niceDate, occupants, propColor, shortDay } from './format'

// The owner trims the calendar to the hours they actually have (e.g. 16–20)
// and picks the grid: whole hours, half hours or quarter hours.
type Range = { from: number; to: number; step: 15 | 30 | 60 }
const RANGE_KEY = 'ow_cal_range_v1'
const HOUR_H: Record<Range['step'], number> = { 60: 40, 30: 50, 15: 76 }
function useRange(): [Range, (r: Range) => void] {
  const [r, setR] = useState<Range>({ from: 8, to: 21, step: 30 })
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null'); if (v && v.to > v.from) setR(v) } catch { /* default */ } }, [])
  return [r, (n: Range) => { setR(n); try { localStorage.setItem(RANGE_KEY, JSON.stringify(n)) } catch { /* private mode */ } }]
}
const LIVE = new Set(['awaiting_owner', 'question', 'new_time_proposed', 'confirmed', 'completed'])
const ALL = 0

type Draft = { date: string; a: number; b: number }
type Edit = { pid: number; date: string; start: string; end: string; ruleId?: string; extraId?: string }
const timesBetween = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => toHHMM(from + i * step))

function useNarrow() {
  const [n, setN] = useState(false)
  useEffect(() => {
    const m = window.matchMedia('(max-width: 700px)')
    const on = () => setN(m.matches); on(); m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return n
}

export function WeekCalendar({ compact = false }: { compact?: boolean }) {
  const s = useOwner()
  const narrow = useNarrow()
  const [view, setView] = useState<'week' | 'month' | 'day'>('week')
  const [anchor, setAnchor] = useState(s.today)
  const [propId, setPropId] = useState<number>(ALL)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [open, setOpen] = useState<ViewingRequest | null>(null)
  const [range, setRange] = useRange()
  const [edit, setEdit] = useState<Edit | null>(null)
  const START = range.from * 60, END = range.to * 60, H = HOUR_H[range.step]
  const y = (min: number) => ((Math.max(START, Math.min(END, min)) - START) / 60) * H
  const snap = (min: number) => Math.max(START, Math.min(END, Math.round(min / range.step) * range.step))
  const drag = useRef<{ date: string; top: number; a: number } | null>(null)
  const ids = s.properties.map(p => p.id)
  const shown: Property[] = propId === ALL ? s.properties.filter(p => p.listing !== 'draft') : s.properties.filter(p => p.id === propId)
  const lanes = shown.length

  const span = narrow ? 3 : 7
  const first = narrow ? anchor : startOfWeek(anchor)
  const days = Array.from({ length: span }, (_, i) => addDays(first, i))
  const blockedFor = (pid: number, d: string) => s.exceptions.some(e => e.propertyId === pid && e.date === d && e.kind === 'blocked' && !e.start)
  const blocked = (d: string) => shown.length > 0 && shown.every(p => blockedFor(p.id, d))

  const minuteAt = (e: React.PointerEvent, top: number) => START + ((e.clientY - top) / H) * 60
  const down = (e: React.PointerEvent<HTMLDivElement>, date: string) => {
    if ((e.target as HTMLElement).closest('button, .ow-band')) return
    if (compact || blocked(date)) return
    const top = e.currentTarget.getBoundingClientRect().top
    const a = snap(minuteAt(e, top))
    drag.current = { date, top, a }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft({ date, a, b: Math.min(END, a + 60) })
  }
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return
    const m = snap(minuteAt(e, drag.current.top))
    const { a } = drag.current
    setDraft({ date: drag.current.date, a: Math.min(a, m), b: Math.max(a + range.step, m) })
  }
  const up = () => { drag.current = null }

  const shift = (n: number) => setAnchor(a => view === 'month'
    ? (() => { const [yy, mm] = a.split('-').map(Number); const d = new Date(Date.UTC(yy, mm - 1 + n, 1)); return d.toISOString().slice(0, 10) })()
    : addDays(a, view === 'week' ? span * n : n))

  const title = view === 'month'
    ? `${monthName(Number(anchor.slice(5, 7)) - 1)} ${anchor.slice(0, 4)}`
    : view === 'week' ? `${niceDate(days[0], false)} – ${niceDate(days[span - 1], false)}` : niceDate(anchor)
  const lane = (i: number, n: number) => ({ left: `calc(${(i / n) * 100}% + 3px)`, width: `calc(${100 / n}% - 6px)` })
  // a day is only split into lanes for the homes that actually have hours or requests that day
  const activeOn = (d: string) => shown.filter(p => (!blockedFor(p.id, d) && windowsFor(s.rules, s.exceptions, p.id, d).length)
    || s.requests.some(r => r.propertyId === p.id && LIVE.has(r.status) && datePart(r.start) === d))

  return (
    <div className="ow-cal">
      <div className="ow-cal-tools">
        <div className="ow-pills" role="group" aria-label="Property">
          <button type="button" aria-pressed={propId === ALL} onClick={() => { setPropId(ALL); setDraft(null) }}>All homes</button>
          {s.properties.filter(p => p.listing !== 'draft').map(p => (
            <button type="button" key={p.id} aria-pressed={propId === p.id} onClick={() => { setPropId(p.id); setDraft(null) }}>
              <i style={{ background: propColor(ids, p.id) }} />{p.name.split(' ').slice(0, 2).join(' ')}
            </button>
          ))}
        </div>
        <div className="ow-cal-nav">
          <button className="ow-icon-btn" onClick={() => shift(-1)} aria-label="Previous"><ChevronLeft size={18} /></button>
          <b>{title}</b>
          <button className="ow-icon-btn" onClick={() => shift(1)} aria-label="Next"><ChevronRight size={18} /></button>
          <button className="ow-btn small" onClick={() => setAnchor(s.today)}>Today</button>
          <div className="ow-range" role="group" aria-label="Hours shown">
            <select aria-label="From" value={range.from} onChange={e => setRange({ ...range, from: Math.min(Number(e.target.value), range.to - 1) })}>
              {Array.from({ length: 18 }, (_, i) => i + 6).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
            <span>–</span>
            <select aria-label="To" value={range.to} onChange={e => setRange({ ...range, to: Math.max(Number(e.target.value), range.from + 1) })}>
              {Array.from({ length: 18 }, (_, i) => i + 7).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
            <select aria-label="Grid" value={range.step} onChange={e => setRange({ ...range, step: Number(e.target.value) as Range['step'] })}>
              <option value={60}>60 min</option><option value={30}>30 min</option><option value={15}>15 min</option>
            </select>
          </div>
          {!compact && (
            <div className="ow-seg" role="group" aria-label="View">
              {(['month', 'week', 'day'] as const).map(v => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'week' && narrow ? '3 days' : v[0].toUpperCase() + v.slice(1)}</button>)}
            </div>
          )}
        </div>
      </div>

      {view === 'week' && (
        <div className="ow-week" style={{ gridTemplateColumns: `44px repeat(${span}, minmax(0, 1fr))`, ['--ow-hour-h' as string]: `${(H * range.step) / 60}px` }}>
          <div className="ow-week-head" />
          {days.map(d => (
            <button type="button" key={d} className="ow-week-head" data-today={d === s.today} data-blocked={blocked(d)}
              onClick={() => { setAnchor(d); setView('day'); setDraft(null) }} aria-label={`Open ${niceDate(d)}`}>
              {shortDay(d)}<b>{Number(d.slice(8))}</b>
            </button>
          ))}
          <div className="ow-hours" style={{ height: y(END) }}>
            {Array.from({ length: (END - START) / 60 + 1 }, (_, i) => <span key={i} className="ow-hour" style={{ top: i * H }}>{toHHMM(START + i * 60)}</span>)}
            {range.step <= 30 && Array.from({ length: (END - START) / 60 }, (_, i) => <span key={`h${i}`} className="ow-hour minor" style={{ top: i * H + H / 2 }}>{toHHMM(START + i * 60 + 30)}</span>)}
          </div>
          {days.map(d => { const act = activeOn(d); const n = Math.max(1, act.length); return (
            <div key={d} className="ow-day" data-blocked={blocked(d)} style={{ height: y(END) }} onPointerDown={e => down(e, d)} onPointerMove={move} onPointerUp={up}>
              {act.map((p, li) => {
                const color = propColor(ids, p.id)
                const wins = blockedFor(p.id, d) ? [] : windowsFor(s.rules, s.exceptions, p.id, d)
                const ruleFor = (start: string, end: string) => s.rules.find(r => r.propertyId === p.id && r.weekday === weekdayOf(d) && r.start === start && r.end === end)
                const extraFor = (start: string) => s.exceptions.find(e => e.propertyId === p.id && e.date === d && e.kind === 'extra' && e.start === start)
                return wins.filter(w => toMin(w.end) > START && toMin(w.start) < END).map(w => {
                  const rule = ruleFor(w.start, w.end); const extra = extraFor(w.start)
                  return (
                    <div key={p.id + w.start} className="ow-band" data-extra={w.source === 'extra'} role={compact ? undefined : 'button'} tabIndex={compact ? undefined : 0}
                      title={`${p.name}: viewing hours ${w.start}–${w.end}${w.source === 'extra' ? ' (this day only)' : ''}`}
                      onClick={() => !compact && (rule || extra) && setEdit({ pid: p.id, date: d, start: w.start, end: w.end, ruleId: rule?.id, extraId: extra?.id })}
                      onKeyDown={e => { if (!compact && e.key === 'Enter' && (rule || extra)) setEdit({ pid: p.id, date: d, start: w.start, end: w.end, ruleId: rule?.id, extraId: extra?.id }) }}
                      style={{ ...lane(li, n), top: y(toMin(w.start)), height: y(toMin(w.end)) - y(toMin(w.start)), ['--pc' as string]: color }}>
                      {n === 1 && <span>{w.start}–{w.end}</span>}
                      {n === 1 && propId === ALL && <em>{p.name.split(' ').slice(0, 2).join(' ')}</em>}
                      {w.source === 'extra' && n === 1 && <small>once</small>}
                    </div>
                  )
                })
              })}
              {draft && draft.date === d && <div className="ow-band" data-draft="true" style={{ left: 3, right: 3, top: y(draft.a), height: y(draft.b) - y(draft.a) }}><span>{toHHMM(draft.a)}–{toHHMM(draft.b)}</span></div>}
              {act.map((p, li) => s.requests.filter(r => r.propertyId === p.id && LIVE.has(r.status) && datePart(r.start) === d && toMin(timePart(r.start)) >= START && toMin(timePart(r.start)) < END).map(r => {
                const room = r.roomId ? p.rooms.find(x => x.id === r.roomId) : null
                const label = `${timePart(r.start)} ${r.status === 'confirmed' ? 'Viewing' : r.status === 'completed' ? 'Viewed' : 'Request'}${room ? `, ${room.label}` : ''}, ${p.name}`
                return (
                  <button key={r.id} className="ow-ev" data-status={r.status} title={label} aria-label={label}
                    style={{ ...(n > 1 ? lane(li, n) : { left: 6, right: 6 }), top: y(toMin(timePart(r.start))) + 2, ['--pc' as string]: propColor(ids, p.id) }} onClick={() => setOpen(r)}>
                    {timePart(r.start)}{n === 1 && !narrow ? (r.status === 'confirmed' ? ' Viewing' : r.status === 'completed' ? ' Viewed' : ' Request') : ''}
                  </button>
                )
              }))}
            </div>
          ) })}
        </div>
      )}

      {view === 'month' && <Month anchor={anchor} shown={shown} onPick={d => { setAnchor(d); setView('day') }} />}
      {view === 'day' && <Day date={anchor} shown={shown} onOpen={setOpen} />}

      <div className="ow-legend" aria-hidden="true">
        {shown.length > 1 && shown.map(p => <span key={p.id}><i style={{ background: propColor(ids, p.id) }} />{p.name}</span>)}
        <span><i className="sw-wait" />Waiting for you</span>
        <span><i className="sw-ok" />Confirmed</span>
        <span><i className="sw-block" />Blocked</span>
      </div>

      {!compact && view === 'week' && !draft && <p className="ow-faint" style={{ marginTop: 10 }}>Drag down a day to add viewing hours.</p>}
      {draft && (
        <>
          <button className="ow-scrim" aria-label="Cancel" onClick={() => setDraft(null)} />
          <div className="ow-sheet" role="dialog" aria-label="Save viewing hours">
            <h3>{dayName(draft.date)}, {toHHMM(draft.a)} to {toHHMM(draft.b)}</h3>
            <p className="ow-faint">Visitors can ask for any time inside these hours.</p>
            <DraftActions draft={draft} props={shown} onDone={() => setDraft(null)} />
          </div>
        </>
      )}
      {edit && (
        <>
          <button className="ow-scrim" aria-label="Close" onClick={() => setEdit(null)} />
          <EditSheet e={edit} step={range.step} onDone={() => setEdit(null)} />
        </>
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

function DraftActions({ draft, props, onDone }: { draft: Draft; props: Property[]; onDone: () => void }) {
  const s = useOwner()
  const ids = s.properties.map(p => p.id)
  const [pid, setPid] = useState(props.length === 1 ? props[0].id : 0)
  return (
    <>
      {props.length > 1 && (
        <div className="ow-pills" role="group" aria-label="For which home" style={{ marginTop: 10 }}>
          {props.map(p => <button type="button" key={p.id} aria-pressed={pid === p.id} onClick={() => setPid(p.id)}><i style={{ background: propColor(ids, p.id) }} />{p.name}</button>)}
        </div>
      )}
      <div className="ow-req-actions" style={{ marginTop: 12 }}>
        <button className="ow-btn primary" disabled={!pid} onClick={() => { s.addRule({ propertyId: pid, weekday: weekdayOf(draft.date), start: toHHMM(draft.a), end: toHHMM(draft.b), slotMinutes: 30 }); onDone() }}>Every {dayName(draft.date)}</button>
        <button className="ow-btn" disabled={!pid} onClick={() => { s.addExtra(pid, draft.date, toHHMM(draft.a), toHHMM(draft.b)); onDone() }}>Only {niceDate(draft.date, false)}</button>
        <button className="ow-btn quiet" onClick={onDone}>Cancel</button>
      </div>
    </>
  )
}

function Month({ anchor, shown, onPick }: { anchor: string; shown: Property[]; onPick: (d: string) => void }) {
  const s = useOwner()
  const ids = s.properties.map(p => p.id)
  const first = `${anchor.slice(0, 7)}-01`
  const grid = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(startOfWeek(first), i)), [first])
  return (
    <div className="ow-month">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="ow-month-dow">{d}</div>)}
      {grid.map(d => {
        const open = shown.filter(p => windowsFor(s.rules, s.exceptions, p.id, d).length && !s.exceptions.some(e => e.propertyId === p.id && e.date === d && e.kind === 'blocked' && !e.start))
        const dayReqs = s.requests.filter(r => shown.some(p => p.id === r.propertyId) && datePart(r.start) === d)
        const waiting = dayReqs.filter(r => r.status === 'awaiting_owner').length
        const conf = dayReqs.filter(r => r.status === 'confirmed').length
        const blocked = shown.length > 0 && shown.every(p => s.exceptions.some(e => e.propertyId === p.id && e.date === d && e.kind === 'blocked' && !e.start))
        return (
          <button key={d} className="ow-mday" data-out={d.slice(0, 7) !== anchor.slice(0, 7)} data-today={d === s.today} data-blocked={blocked} onClick={() => onPick(d)}
            aria-label={`${niceDate(d)}${open.length ? `, viewing hours at ${open.length} home${open.length > 1 ? 's' : ''}` : ''}${waiting ? `, ${waiting} waiting` : ''}${conf ? `, ${conf} confirmed` : ''}${blocked ? ', blocked' : ''}`}>
            <b>{Number(d.slice(8))}</b>
            <span className="ow-mbars">{open.map(p => <i key={p.id} style={{ background: propColor(ids, p.id) }} />)}</span>
            <span className="ow-mcount">
              {waiting > 0 && <em className="wait">{waiting}</em>}
              {conf > 0 && <em className="ok">{conf}</em>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Day({ date, shown, onOpen }: { date: string; shown: Property[]; onOpen: (r: ViewingRequest) => void }) {
  const s = useOwner()
  const ids = s.properties.map(p => p.id)
  const reqs = s.requests.filter(r => shown.some(p => p.id === r.propertyId) && datePart(r.start) === date && r.status !== 'declined' && r.status !== 'cancelled').sort((a, b) => a.start.localeCompare(b.start))
  const STATUS: Record<string, string> = { awaiting_owner: 'Waiting for you', question: 'Question open', new_time_proposed: 'New time suggested', confirmed: 'Confirmed', completed: 'Viewed' }
  return (
    <div className="ow-attn">
      <h3 className="ow-day-title">{niceDate(date)}</h3>
      {reqs.length ? (
        <ol className="ow-agenda">
          {reqs.map(r => {
            const p = s.properties.find(x => x.id === r.propertyId)!
            const room = r.roomId ? p.rooms.find(x => x.id === r.roomId) : null
            const agency = r.requester.agencyId ? s.agencies.find(a => a.id === r.requester.agencyId) : null
            const who = agency ? `${r.requester.agentName ? `${r.requester.agentName} · ` : ''}${agency.name}` : `Private person (${SOURCE_LABEL[r.source]})`
            return (
              <li key={r.id} data-status={r.status}>
                <button type="button" onClick={() => onOpen(r)}>
                  <time>{timePart(r.start)}</time>
                  <span className="ow-agenda-main">
                    <b>{who}</b>
                    <span className="ow-agenda-home"><i style={{ background: propColor(ids, p.id) }} />{room ? `${room.label}, ` : ''}{p.name}</span>
                    <span className="ow-faint">{occupants(r.applicant)} · {r.applicant.months} months{r.applicant.pets ? ` · ${r.applicant.pets}` : ''}</span>
                  </span>
                  <span className="ow-agenda-state">{STATUS[r.status] || r.status}</span>
                </button>
              </li>
            )
          })}
        </ol>
      ) : <div className="ow-panel ow-empty">Nobody is coming on this day.</div>}
      <div className="ow-panel">
        <ul className="ow-dayrows">
          {shown.map(p => {
            const wins = windowsFor(s.rules, s.exceptions, p.id, date)
            const blocked = s.exceptions.some(e => e.propertyId === p.id && e.date === date && e.kind === 'blocked' && !e.start)
            return (
              <li key={p.id}>
                <span className="ow-dayrow-name"><i style={{ background: propColor(ids, p.id) }} />{p.name}</span>
                <span className="ow-muted">{blocked ? 'Blocked' : wins.length ? wins.map(w => `${w.start}–${w.end}`).join(', ') : 'No viewing hours'}</span>
                {blocked
                  ? <button className="ow-btn small" onClick={() => s.unblockDay(p.id, date)}>Open again</button>
                  : <button className="ow-btn small quiet" onClick={() => s.blockDay(p.id, date)}>Block day</button>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

function EditSheet({ e, step, onDone }: { e: Edit; step: number; onDone: () => void }) {
  const s = useOwner()
  const p = s.properties.find(x => x.id === e.pid)!
  const [start, setStart] = useState(e.start)
  const [end, setEnd] = useState(e.end)
  const opts = timesBetween(6 * 60, 23 * 60, Math.min(step, 30))
  const save = () => {
    if (toMin(end) <= toMin(start)) { s.say('The end has to be after the start.', 'err'); return }
    if (e.ruleId) s.updateRule(e.ruleId, start, end); else if (e.extraId) s.updateExtra(e.extraId, start, end)
    onDone()
  }
  const del = () => { if (e.ruleId) s.removeRule(e.ruleId); else if (e.extraId) s.removeExtra(e.extraId); onDone() }
  return (
    <div className="ow-sheet" role="dialog" aria-label="Change viewing hours">
      <p className="ow-sheet-home"><i style={{ background: propColor(s.properties.map(x => x.id), p.id) }} />{p.name}</p>
      <h3>{e.ruleId ? `Every ${dayName(e.date)}` : `Only ${niceDate(e.date)}`}</h3>
      <div className="ow-sheet-times">
        <label><span>From</span><select value={start} onChange={x => setStart(x.target.value)}>{opts.map(t => <option key={t}>{t}</option>)}</select></label>
        <label><span>To</span><select value={end} onChange={x => setEnd(x.target.value)}>{opts.map(t => <option key={t}>{t}</option>)}</select></label>
      </div>
      <div className="ow-req-actions" style={{ marginTop: 14 }}>
        <button className="ow-btn primary" onClick={save}>Save</button>
        <button className="ow-btn quiet danger" onClick={del}>Delete these hours</button>
        <button className="ow-btn quiet" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}
