'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarCheck, Clock3, GripVertical, Users } from 'lucide-react'
import { api, ApiError, Chip, fmtDay, fmtLongDay, fmtTime, fmtWhen, LABEL, Sheet, TONE, dayKey } from './ui'
import type { Desk, Detail, Me, Request, Slot } from './types'

const BASE = '/api/owner-portal'
const NEEDS = ['REQUESTED', 'RESCHEDULE_REQUESTED']
const WAITING = ['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING']

function useNarrow() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => { const m = window.matchMedia('(max-width: 760px)'); const f = () => setNarrow(m.matches); f(); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  return narrow
}

function clientLine(c: Request['client']) {
  return [c.people ? `${c.people} ${c.people === 1 ? 'person' : 'people'}` : null, c.groupType, c.moveIn ? `move-in ${c.moveIn}` : null, c.pets ? `pets: ${c.pets}` : null].filter(Boolean).join(' · ')
}

export function ViewingDesk({ me, notify, onChanged }: { me: Me; notify: (m: string) => void; onChanged: () => void }) {
  const [desk, setDesk] = useState<Desk | null>(null)
  const [error, setError] = useState('')
  const [propertyId, setPropertyId] = useState<number | null>(null)
  const [armed, setArmed] = useState<number | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [assign, setAssign] = useState<{ req: Request; slot: Slot } | null>(null)
  const [act, setAct] = useState<{ req: Request; action: 'decline' | 'cancel' | 'reschedule' } | null>(null)
  const narrow = useNarrow()
  const dragging = useRef<number | null>(null)
  const canAct = me.scopes.includes('requests')

  const load = useCallback(() => api<Desk>(BASE, '/desk?days=7').then(d => { setDesk(d); setError(''); setPropertyId(p => p ?? d.calendars[0]?.propertyId ?? null) }).catch(e => setError(e.message)), [])
  useEffect(() => { load() }, [load])

  const reqs = desk?.requests || []
  const needs = reqs.filter(r => NEEDS.includes(r.state))
  const waiting = reqs.filter(r => WAITING.includes(r.state))
  const confirmed = reqs.filter(r => r.state === 'CONFIRMED').sort((a, b) => Date.parse(a.proposedStart!) - Date.parse(b.proposedStart!))
  const cal = desk?.calendars.find(c => c.propertyId === propertyId) || null
  const armedReq = reqs.find(r => r.id === armed) || null

  // Arming a request for another property switches the calendar to it.
  useEffect(() => { if (armedReq && armedReq.propertyId !== propertyId) setPropertyId(armedReq.propertyId) }, [armedReq, propertyId])

  const days = useMemo(() => {
    if (!desk) return []
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(`${desk.from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10) })
  }, [desk])
  const held = useMemo(() => {
    const out: { start: string; label: string; state: string }[] = []
    for (const r of reqs) if (r.propertyId === propertyId && r.proposedStart && ['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED'].includes(r.state)) out.push({ start: r.proposedStart, label: `${r.agent.agency || r.agent.name}`, state: r.state })
    for (const e of desk?.external || []) if (e.propertyId === propertyId) out.push({ start: e.startsAt, label: 'Board booking', state: 'board' })
    return out
  }, [reqs, desk, propertyId])
  const rows = useMemo(() => {
    const free = (cal?.slots || []).filter(s => s.state === 'free')
    const mins = [...free.map(s => s.start), ...held.map(h => h.start)].map(t => { const [h, m] = fmtTime(t).split(':').map(Number); return h * 60 + m })
    const lo = Math.max(6 * 60, Math.min(8 * 60, ...mins)), hi = Math.min(22 * 60, Math.max(19 * 60, ...mins))
    const out: number[] = []
    for (let m = Math.floor(lo / 30) * 30; m <= hi; m += 30) out.push(m)
    return out
  }, [cal, held])
  const inCell = (day: string, m: number) => (t: string) => { if (dayKey(t) !== day) return false; const [h, mm] = fmtTime(t).split(':').map(Number); const x = h * 60 + mm; return x >= m && x < m + 30 }

  function pickSlot(slot: Slot) {
    const req = armedReq
    if (!req) { notify('Choose a request first, then a time.'); return }
    if (req.propertyId !== propertyId) return
    setAssign({ req, slot })
  }

  if (error) return <div className="op-error" role="alert">{error}</div>
  if (!desk) return <div className="op-empty">Loading your viewing desk…</div>

  const slotButton = (s: Slot) => {
    const key = s.start
    return (
      <button key={key} type="button" className="op-slot" data-over={overKey === key} data-armed={!!armedReq && armedReq.propertyId === propertyId}
        aria-label={`Free ${fmtWhen(s.start)}${armedReq ? ` — assign ${armedReq.agent.name}` : ''}`}
        onClick={() => pickSlot(s)}
        onDragOver={e => { e.preventDefault(); setOverKey(key) }} onDragLeave={() => setOverKey(k => k === key ? null : k)}
        onDrop={e => { e.preventDefault(); setOverKey(null); const id = Number(e.dataTransfer.getData('text/plain')) || dragging.current; dragging.current = null; const req = reqs.find(r => r.id === id); if (req && req.propertyId === propertyId) setAssign({ req, slot: s }); else notify('That request is for another property.') }}>
        {fmtTime(s.start)}
      </button>
    )
  }

  return (
    <div>
      <div className="op-section-head">
        <div>
          <div className="op-eyebrow">Viewing desk</div>
          <h1 className="op-h1">{needs.length ? `${needs.length} request${needs.length === 1 ? '' : 's'} to place` : 'All requests answered'}</h1>
          <p className="op-lede">{canAct ? (narrow ? 'Tap a request, then tap a free time.' : 'Drag a request onto a free time, or select it and click a time.') : 'You can view the calendar. Placing requests is not part of your access.'} A proposed slot is only confirmed after the agent reconfirms with the client.</p>
        </div>
        {desk.calendars.length > 1 && (
          <label className="op-field" style={{ minWidth: 220 }}>
            <span>Calendar</span>
            <select className="op-input" value={propertyId ?? ''} onChange={e => { setPropertyId(Number(e.target.value)); setArmed(null) }}>
              {desk.calendars.map(c => <option key={c.propertyId} value={c.propertyId}>#{c.ref} · {c.town || 'Malta'}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="op-desk">
        <section className="op-card" aria-label="Calendar">
          {!cal?.rules ? (
            <div className="op-empty">No availability set for this property yet. Open <b>Availability</b> to set your weekly times.</div>
          ) : narrow ? (
            <MobilePicker cal={cal} days={days} slotButton={slotButton} armed={armedReq} held={held} />
          ) : (
            <div className="op-week">
              <div className="op-week-grid" role="grid" aria-label={`Week of ${fmtLongDay(`${days[0]}T12:00:00Z`)}`}>
                <div className="op-week-day" />
                {days.map(d => <div key={d} className="op-week-day" role="columnheader">{fmtDay(`${d}T12:00:00Z`).split(' ')[0]}<small>{fmtDay(`${d}T12:00:00Z`).split(' ').slice(1).join(' ')}</small></div>)}
                {rows.map(m => [
                  <div key={`t${m}`} className="op-week-time">{`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`}</div>,
                  ...days.map(d => (
                    <div key={`${d}${m}`} className="op-week-cell" role="gridcell">
                      {held.filter(h => inCell(d, m)(h.start)).map(h => <span key={h.start} className="op-booked" data-state={h.state}>{fmtTime(h.start)} {h.state === 'CONFIRMED' ? '✓' : ''} {h.label}</span>)}
                      {cal.slots.filter(s => s.state === 'free' && inCell(d, m)(s.start)).map(slotButton)}
                    </div>
                  )),
                ])}
              </div>
            </div>
          )}
        </section>

        <aside className="op-inbox" aria-label="Requests">
          <Group title="Needs your answer" empty="Nothing waiting for you.">
            {needs.map(r => (
              <RequestCard key={r.id} r={r} me={me} armed={armed === r.id} draggable={canAct && !narrow}
                onArm={() => canAct && setArmed(a => a === r.id ? null : r.id)} onDragBegin={() => { dragging.current = r.id; window.setTimeout(() => setArmed(r.id), 0) }}
                onDecline={() => setAct({ req: r, action: 'decline' })} />
            ))}
          </Group>
          <Group title="Waiting for the agent" empty="No proposals out.">
            {waiting.map(r => <RequestCard key={r.id} r={r} me={me} onCancel={() => setAct({ req: r, action: 'cancel' })} />)}
          </Group>
          <Group title="Confirmed" empty="No confirmed viewings yet.">
            {confirmed.map(r => <RequestCard key={r.id} r={r} me={me} onCancel={() => setAct({ req: r, action: 'cancel' })} onReschedule={() => setAct({ req: r, action: 'reschedule' })}
              onDone={async (a) => { try { await api(BASE, `/requests/${r.id}/${a}`, { method: 'POST', json: {} }); notify(a === 'complete' ? 'Marked as completed' : 'Marked as no-show'); load(); onChanged() } catch (e: any) { notify(e.message) } }} />)}
          </Group>
          {!!desk.external.length && (
            <Group title="Booked through the board" empty="">
              {desk.external.map(e => <div key={e.viewingId} className="op-card op-card-pad" style={{ padding: 12 }}><b>{fmtWhen(e.startsAt)}</b> · {e.durationMin} min <Chip>{e.status === 'confirmed' ? 'Confirmed' : 'Pending'} · handled by your agent</Chip></div>)}
            </Group>
          )}
        </aside>
      </div>

      <AssignSheet assign={assign} onClose={() => setAssign(null)} onDone={(msg) => { setAssign(null); setArmed(null); notify(msg); load(); onChanged() }} />
      <ActionSheet act={act} onClose={() => setAct(null)} onDone={(msg) => { setAct(null); notify(msg); load(); onChanged() }} />
    </div>
  )
}

function Group({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : []
  return (
    <section>
      <div className="op-eyebrow" style={{ margin: '6px 2px 8px' }}>{title}</div>
      <div style={{ display: 'grid', gap: 10 }}>{list.length ? list : empty ? <div className="op-card op-empty" style={{ padding: 16 }}>{empty}</div> : null}</div>
    </section>
  )
}

function RequestCard({ r, me, armed, draggable, onArm, onDragBegin, onDecline, onCancel, onReschedule, onDone }: {
  r: Request; me: Me; armed?: boolean; draggable?: boolean; onArm?: () => void; onDragBegin?: () => void; onDecline?: () => void; onCancel?: () => void; onReschedule?: () => void; onDone?: (a: 'complete' | 'no_show') => void
}) {
  const prop = me.properties.find(p => p.id === r.propertyId)
  const canAct = me.scopes.includes('requests')
  const past = r.proposedEnd && Date.parse(r.proposedEnd) < Date.now()
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
    <article className="op-request" aria-pressed={onArm ? !!armed : undefined}
      draggable={draggable} onDragStart={e => { e.dataTransfer.setData('text/plain', String(r.id)); e.dataTransfer.effectAllowed = 'move'; onDragBegin?.() }}
      data-testid={`request-${r.id}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start' }}>
        <div>
          <Chip tone={TONE[r.state]}>{LABEL[r.state]}</Chip>
          <h3 style={{ marginTop: 8 }}>{r.agent.name}{r.agent.agency ? <span style={{ color: 'var(--op-muted)', fontWeight: 500 }}> · {r.agent.agency}</span> : null}</h3>
          <p>#{prop?.ref} · {prop?.town || 'Malta'} · {r.durationMin} min</p>
        </div>
        {draggable && <GripVertical size={18} aria-hidden style={{ color: 'var(--op-faint)', flex: 'none' }} />}
      </div>
      {clientLine(r.client) && <p><Users size={13} aria-hidden style={{ verticalAlign: -2 }} /> {clientLine(r.client)}</p>}
      {(r.client.budgetNote || r.client.notes) && <p style={{ borderLeft: '2px solid var(--op-line-strong)', paddingLeft: 8 }}>{[r.client.budgetNote, r.client.notes].filter(Boolean).join(' · ')}</p>}
      {r.proposedStart && <p><CalendarCheck size={13} aria-hidden style={{ verticalAlign: -2 }} /> <b>{fmtWhen(r.proposedStart)}</b>{WAITING.includes(r.state) && r.expiresAt ? ` · agent reconfirms by ${fmtWhen(r.expiresAt)}` : ''}</p>}
      {!r.proposedStart && !!r.preferred.length && <p><Clock3 size={13} aria-hidden style={{ verticalAlign: -2 }} /> Prefers {r.preferred.map(p => fmtWhen(p.start)).join(', ')}</p>}
      {canAct && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {onArm && <button type="button" className={`op-btn op-btn-sm ${armed ? 'op-btn-accent' : 'op-btn-primary'}`} onClick={onArm}>{armed ? 'Now pick a time' : 'Assign a time'}</button>}
          {onDecline && <button type="button" className="op-btn op-btn-sm op-btn-ghost op-btn-danger" onClick={onDecline}>Decline</button>}
          {onDone && past && <><button type="button" className="op-btn op-btn-sm" onClick={() => onDone('complete')}>Completed</button><button type="button" className="op-btn op-btn-sm op-btn-ghost" onClick={() => onDone('no_show')}>No show</button></>}
          {onReschedule && !past && <button type="button" className="op-btn op-btn-sm op-btn-ghost" onClick={onReschedule}>Need another time</button>}
          {onCancel && !past && <button type="button" className="op-btn op-btn-sm op-btn-ghost op-btn-danger" onClick={onCancel}>Cancel</button>}
        </div>
      )}
    </article>
    </motion.div>
  )
}

function MobilePicker({ cal, days, slotButton, armed, held }: { cal: Desk['calendars'][number]; days: string[]; slotButton: (s: Slot) => React.ReactNode; armed: Request | null; held: { start: string; label: string; state: string }[] }) {
  const [day, setDay] = useState(days[0])
  const free = cal.slots.filter(s => s.state === 'free' && s.date === day)
  const busy = held.filter(h => dayKey(h.start) === day)
  return (
    <div className="op-card-pad" style={{ display: 'grid', gap: 14 }}>
      {armed ? <div className="op-note">Placing <b>{armed.agent.name}</b>. Tap a free time.</div> : <div className="op-note">Tap <b>Assign a time</b> on a request below, then a time here.</div>}
      <div className="op-day-strip" role="group" aria-label="Day">
        {days.map(d => <button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)}>{fmtDay(`${d}T12:00:00Z`)}<br /><small>{cal.slots.filter(s => s.state === 'free' && s.date === d).length} free</small></button>)}
      </div>
      {busy.length > 0 && <div style={{ display: 'grid', gap: 6 }}>{busy.map(h => <span key={h.start} className="op-booked" data-state={h.state}>{fmtTime(h.start)} · {h.label}</span>)}</div>}
      <div className="op-slot-list">{free.length ? free.map(slotButton) : <div className="op-empty" style={{ gridColumn: '1/-1' }}>No free times on this day.</div>}</div>
    </div>
  )
}

function AssignSheet({ assign, onClose, onDone }: { assign: { req: Request; slot: Slot } | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)
  const [override, setOverride] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const req = assign?.req
  useEffect(() => {
    setErr(null); setOverride(false); setDetail(null)
    if (req) api<Detail>(BASE, `/properties/${req.propertyId}`).then(setDetail).catch(() => setDetail(null))
  }, [req])
  if (!assign || !req) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const conditions = detail?.proposals.find(p => p.fields.conditions)?.fields.conditions as Record<string, string> | undefined
  async function submit() {
    setBusy(true); setErr(null)
    try {
      const out = await api<{ agentMessage: string }>(BASE, `/requests/${req!.id}/propose`, { method: 'POST', json: { start: assign!.slot.start, allowBufferOverlap: override && err?.code === 'BUFFER_CONFLICT', allowOutsideRules: override && err?.code === 'OUTSIDE_AVAILABILITY' } })
      onDone(`Proposed ${fmtWhen(assign!.slot.start)}. ${req!.agent.name} now confirms with the client.`)
      void out
    } catch (e: any) { setErr(e) } finally { setBusy(false) }
  }
  return (
    <Sheet open title="Propose this time?" onClose={onClose} footer={<>
      <button className="op-btn op-btn-ghost" onClick={onClose}>Not now</button>
      <button className="op-btn op-btn-accent" disabled={busy || (!!err && !(err.data?.overridable && override))} onClick={submit}>{busy ? 'Proposing…' : 'Propose slot'}</button>
    </>}>
      <div style={{ fontSize: 22, fontWeight: 700 }} className="op-display">{fmtLongDay(assign.slot.start)} · {fmtTime(assign.slot.start)}–{fmtTime(new Date(Date.parse(assign.slot.start) + req.durationMin * 60000).toISOString())}</div>
      <dl className="op-kv">
        <dt>Property</dt><dd>#{detail?.property.ref || '…'} · {detail?.property.town || ''}</dd>
        <dt>Agent</dt><dd>{req.agent.name}{req.agent.agency ? ` · ${req.agent.agency}` : ''}</dd>
        <dt>Requested</dt><dd>{req.preferred.length ? req.preferred.map(p => fmtWhen(p.start)).join(', ') : 'Any time that suits you'}</dd>
        <dt>Client</dt><dd>{clientLine(req.client) || '—'}{req.client.notes ? ` · ${req.client.notes}` : ''}</dd>
        <dt>Duration</dt><dd>{req.durationMin} min{detail?.rules ? ` · ${detail.rules.schedule.bufferMin} min buffer` : ''}</dd>
        <dt>Conditions</dt><dd>{conditions ? Object.entries(conditions).map(([k, v]) => `${k.replace('_', ' ')}: ${v}`).join(' · ') : 'None recorded'}</dd>
      </dl>
      <div className="op-note">The agent gets: “Viewing slot proposed for #{detail?.property.ref || '…'} at {new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Malta', hour: 'numeric', minute: '2-digit' }).format(new Date(assign.slot.start))}. Please confirm availability with your client and reconfirm in ARGUS.” It is confirmed only after that.</div>
      {err && <div className="op-error" role="alert">{err.message}{err.data?.overridable ? <label style={{ display: 'flex', gap: 8, marginTop: 8, fontWeight: 500, color: 'var(--op-ink)' }}><input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} /> Propose it anyway</label> : null}</div>}
    </Sheet>
  )
}

function ActionSheet({ act, onClose, onDone }: { act: { req: Request; action: 'decline' | 'cancel' | 'reschedule' } | null; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { setNote(''); setErr('') }, [act])
  if (!act) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const words = { decline: ['Decline this request?', 'Decline', 'Declined'], cancel: ['Cancel this viewing?', 'Cancel viewing', 'Cancelled'], reschedule: ['Ask for another time?', 'Ask for another time', 'The agent was asked for another time'] }[act.action]
  return (
    <Sheet open title={words[0]} onClose={onClose} footer={<>
      <button className="op-btn op-btn-ghost" onClick={onClose}>Back</button>
      <button className="op-btn op-btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await api(BASE, `/requests/${act.req.id}/${act.action}`, { method: 'POST', json: { note: note || undefined } }); onDone(words[2]) } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>{words[1]}</button>
    </>}>
      <p style={{ margin: 0 }}>{act.req.agent.name}{act.req.agent.agency ? ` · ${act.req.agent.agency}` : ''}{act.req.proposedStart ? ` · ${fmtWhen(act.req.proposedStart)}` : ''}</p>
      <label className="op-field"><span>Note for the agent (optional)</span><textarea className="op-input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></label>
      {err && <div className="op-error" role="alert">{err}</div>}
    </Sheet>
  )
}
