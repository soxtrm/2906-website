'use client'
// ============================================================================
// booking-dialog.tsx — the Book button's Calendly-style add-on (Kev, 2026-09-23).
//
// Owner Conversation → Fact Update → Viewing Window → Booking Slots →
// Agent/Client Booking → Schedule Board / Calendars.
//
//   * Owner-confirmed windows ("Tuesday 4pm", read from the owner chat by the
//     backend's fact engine) are shown as 10-minute boxes. 10 min = single
//     slot, 20 min = double slot for back-to-back viewings. Taken boxes show
//     who has them, so agents can send clients together.
//   * No window yet → the listing can only be REQUESTED (the existing
//     BookDialog, which asks the owner) — never a confirmed slot.
//   * Bookings reach every calendar via the backend (calendar_events trigger +
//     ICS feeds); cancel/move here updates them all.
//   * Owner-confirmed vs proposed: "Tuesday 4pm" confirms 16:00 only; the
//     rest of the planning block is PROPOSED and books as "pending owner".
//   * Dual-use listings (classified winter + short let): the Airbnb /
//     Booking.com iCal is SHORTSTAY_OCCUPANCY — shown as a warning on slots,
//     never a block on an owner-authorised viewing.
// Nobody is scored on no-shows — this is coordination only.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, CalendarDays, Copy, Link2, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { cn } from '@/lib/utils'
import {
  type Booking, type BookingView, type Slot, bookingLine, dayLabel, maltaToIso, time12, timeLabel,
} from '@/lib/crm/booking'

const FIELD =
  'w-full px-3 py-2 bg-off-white border-0 rounded text-sm text-navy ' +
  'placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50'
const LABEL = 'block text-[10px] font-semibold uppercase tracking-[0.12em] text-navy/40 mb-1.5'
const PRIMARY =
  'px-4 py-2.5 rounded bg-navy text-white text-sm font-semibold hover:bg-navy-light ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2'
const GHOST = 'px-3 py-2 rounded text-xs text-navy/50 hover:text-navy transition-colors'
const SECTION = 'text-[10px] font-semibold uppercase tracking-[0.12em] text-navy/40 mb-2'
const YELLOW = '#E8B931'

const TYPE_TONE: Record<string, string> = {
  video_viewing: 'bg-sky-50 text-sky-800 ring-sky-200',
  photos: 'bg-violet-50 text-violet-800 ring-violet-200',
  first_view: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  general: 'bg-slate-50 text-slate-700 ring-slate-200',
  high_chance: 'bg-amber-50 text-amber-800 ring-amber-300',
}

export function BookingDialog({ refId, town, onClose, onDone, onRequest }: {
  refId: string; town?: string | null
  onClose: () => void
  onDone: (msg: string) => void
  // no owner-confirmed window → fall back to the owner viewing REQUEST (BookDialog)
  onRequest: () => void
}) {
  const [v, setV] = useState<BookingView | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'book' | 'calendars'>('book')
  const [agents, setAgents] = useState<{ id: number; name: string }[]>([])
  const [pick, setPick] = useState<{ windowId: number; start: string } | null>(null)
  const [dur, setDur] = useState<10 | 20>(10)
  const [type, setType] = useState('first_view')
  const [f, setF] = useState({ clientName: '', groupSize: '', notes: '', agentId: '' })
  const [moving, setMoving] = useState<Booking | null>(null)
  const [showWindowForm, setShowWindowForm] = useState(false)
  const [wf, setWf] = useState({ date: '', from: '16:00', to: '17:30', fromDate: '', confirmation: 'start_only' as 'start_only' | 'full_window' })
  const [feedUrl, setFeedUrl] = useState('')
  const [copied, setCopied] = useState(false)

  const base = `schedule-board/listings/${encodeURIComponent(refId)}`
  const load = useCallback(() => crmFetch(`${base}/booking`)
    .then((d: BookingView) => { setV(d); setLoadErr(null) })
    .catch((e: any) => setLoadErr(e?.message || 'Could not load the booking calendar.')), [base])

  useEffect(() => { load() }, [load])
  useEffect(() => { crmFetch('schedule-board/agents').then(d => setAgents(d.agents || [])).catch(() => {}) }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  const bookingById = useMemo(() => new Map((v?.bookings || []).map(b => [b.id, b])), [v])
  const activeBookings = (v?.bookings || []).filter(b => b.status !== 'cancelled')

  // A 20-min pick needs the NEXT box in the same window to be free too.
  function canStartAt(slots: Slot[], i: number, d: number) {
    const need = d / 10
    for (let k = 0; k < need; k++) {
      const s = slots[i + k]
      if (!s) return false
      const ownMove = moving && s.bookingId === moving.id
      if (s.state !== 'free' && !ownMove) return false
    }
    return true
  }
  // Is the current pick inside owner-confirmed time? A 20-min pick needs both boxes confirmed.
  const pickInfo = useMemo(() => {
    if (!pick || !v) return { proposed: false, occupied: false }
    const w = v.windows.find(x => x.id === pick.windowId)
    const t0 = new Date(pick.start).getTime()
    const boxes = (w?.slots || []).filter(s => { const t = new Date(s.start).getTime(); return t >= t0 && t < t0 + dur * 60000 })
    return { proposed: boxes.some(s => !s.confirmed) && !(boxes[0]?.confirmed && boxes[0]?.start === w?.start), occupied: boxes.some(s => s.occupied) }
  }, [pick, v, dur])
  const picked = (w: number, s: Slot) => {
    if (!pick || pick.windowId !== w) return false
    const t = new Date(s.start).getTime(), p = new Date(pick.start).getTime()
    return t >= p && t < p + dur * 60000
  }

  async function book() {
    setErr(null)
    if (!pick) return setErr('Pick a time slot.')
    if (!moving && !f.clientName.trim()) return setErr('Who is coming? Add the client name.')
    setBusy(true)
    try {
      if (moving) {
        await crmJson(`schedule-board/bookings/${moving.id}`, 'PATCH', { startsAt: pick.start, durationMin: dur, appointmentType: type })
        onDone(`Moved to ${dayLabel(pick.start)} ${time12(pick.start)} — calendars updated.`)
        setMoving(null)
      } else {
        const d = await crmJson(`${base}/booking`, 'POST', {
          startsAt: pick.start, durationMin: dur, appointmentType: type,
          clientName: f.clientName.trim(), groupSize: f.groupSize ? Number(f.groupSize) : undefined,
          notes: f.notes || undefined, agentId: f.agentId ? Number(f.agentId) : undefined,
        })
        onDone(d.message || 'Booked.')
        setF({ clientName: '', groupSize: '', notes: '', agentId: '' })
      }
      setPick(null)
      await load()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not book.')
      await load()
    } finally { setBusy(false) }
  }

  async function cancel(b: Booking) {
    setBusy(true); setErr(null)
    try {
      await crmJson(`schedule-board/bookings/${b.id}/cancel`, 'POST', {})
      onDone(`Cancelled: ${bookingLine(b)}`)
      await load()
    } catch (e: any) { setErr(e?.data?.error || e?.message || 'Could not cancel.') }
    finally { setBusy(false) }
  }

  async function saveWindow() {
    setErr(null); setBusy(true)
    try {
      if (!wf.fromDate && !wf.date) throw new Error('Pick the day of the viewing window.')
      const body = wf.fromDate
        ? { fromDate: wf.fromDate }
        : { start: maltaToIso(wf.date, wf.from), end: maltaToIso(wf.date, wf.to), confirmation: wf.confirmation }
      const d = await crmJson(`${base}/viewing-window`, 'POST', { ...body, note: 'set on the board' })
      setV(prev => prev ? { ...prev, ...d.view } : d.view)
      setShowWindowForm(false)
      onDone('Viewing availability saved — the listing now shows BOOKINGS POSSIBLE.')
    } catch (e: any) { setErr(e?.data?.error || e?.message || 'Could not save the window.') }
    finally { setBusy(false) }
  }
  async function removeWindow(id: number) {
    setBusy(true)
    try {
      const d = await crmFetch(`${base}/viewing-window/${id}`, { method: 'DELETE' })
      setV(prev => prev ? { ...prev, ...d.view } : d.view)
    } catch (e: any) { setErr(e?.data?.error || e?.message) } finally { setBusy(false) }
  }

  async function addFeed() {
    setErr(null); setBusy(true)
    try {
      const d = await crmJson(`${base}/calendar-feeds`, 'POST', { url: feedUrl.trim() })
      if (d.ok === false) setErr(`Connected, but the first sync failed: ${d.error}`)
      setFeedUrl('')
      await load()
    } catch (e: any) { setErr(e?.data?.error || e?.message || 'Could not connect this calendar.') }
    finally { setBusy(false) }
  }
  async function syncFeed(id: number) {
    setBusy(true)
    try { await crmJson(`${base}/calendar-feeds/${id}/sync`, 'POST', {}); await load() }
    catch (e: any) { setErr(e?.data?.error || e?.message) } finally { setBusy(false) }
  }
  async function removeFeed(id: number) {
    setBusy(true)
    try { await crmFetch(`${base}/calendar-feeds/${id}`, { method: 'DELETE' }); await load() }
    catch (e: any) { setErr(e?.data?.error || e?.message) } finally { setBusy(false) }
  }

  const header = (
    <div className="flex items-start justify-between px-5 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-gray-100 shrink-0">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-bold text-navy tracking-tight">Book</h2>
          {v?.bookingsPossible && (
            <span className="text-[9px] font-bold uppercase tracking-[0.1em] px-2 py-0.5 rounded"
              style={{ background: YELLOW, color: '#1B2A4A' }}>Bookings possible</span>
          )}
          {v?.dualUse && (
            <span className="text-[9px] font-bold uppercase tracking-[0.1em] px-2 py-0.5 rounded bg-[#1B3A4B] text-[#7EC8E3]">
              ❄️ Winter + Short
            </span>
          )}
        </div>
        <p className="text-xs text-navy/40 mt-0.5">#{refId}{town ? ` · ${town}` : ''} · times in Malta time</p>
      </div>
      <button onClick={onClose} aria-label="Close"
        className="w-8 h-8 rounded flex items-center justify-center bg-off-white text-navy/40 hover:text-navy shrink-0">
        <X className="w-4 h-4" />
      </button>
    </div>
  )

  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
        className="fixed inset-0 z-[199] bg-navy/20 backdrop-blur-[3px]" />
      <motion.div
        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        data-booking-dialog={refId}
        className="fixed z-[200] bg-white shadow-2xl flex flex-col inset-x-0 bottom-0 rounded-t-2xl max-h-[92vh]
                   sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2
                   sm:w-[640px] sm:rounded-xl sm:max-h-[90vh]">
        {header}
        {(v?.canManageCalendars || v?.dualUse) && (
          <div className="flex gap-1 px-5 sm:px-6 pt-3 shrink-0">
            {(['book', 'calendars'] as const).map(k => (
              <button key={k} onClick={() => setTab(k)}
                className={cn('px-3 py-1.5 rounded text-xs font-semibold',
                  tab === k ? 'bg-navy text-white' : 'bg-off-white text-navy/60 hover:text-navy')}>
                {k === 'book' ? 'Slots & bookings' : 'Connected calendars'}
              </button>
            ))}
          </div>
        )}

        <div className="px-5 sm:px-6 py-4 overflow-y-auto grow">
          {err && (
            <div className="flex items-start gap-2 rounded bg-red-50 text-red-700 text-xs px-3 py-2 mb-4">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /><span>{err}</span>
            </div>
          )}
          {loadErr && <div className="text-sm text-red-700">{loadErr}</div>}
          {!v && !loadErr && <div className="flex items-center gap-2 text-sm text-navy/50"><Loader2 className="w-4 h-4 animate-spin" /> Loading calendar…</div>}

          {v && tab === 'book' && (
            <div className="space-y-5">
              {/* ── owner-confirmed availability ─────────────────────────── */}
              {!v.canBookSlots && (
                <div className="rounded-lg border border-dashed border-navy/15 p-4">
                  {v.viewingsFrom ? (
                    <>
                      <div className="text-sm font-semibold text-navy">Owner: viewings from {dayLabel(v.viewingsFrom.date + 'T12:00:00Z')}</div>
                      {v.viewingsFrom.evidence && <div className="text-xs text-navy/50 mt-1 italic">“{v.viewingsFrom.evidence}”</div>}
                      <div className="text-xs text-navy/50 mt-2">No exact time yet — request one; the owner confirms, then slots open here.</div>
                    </>
                  ) : (
                    <>
                      <div className="text-sm font-semibold text-navy">No owner-confirmed viewing time yet</div>
                      <div className="text-xs text-navy/50 mt-1">Request a viewing — the owner is asked, and once they name a time (e.g. “Tuesday 4pm”) the slots appear here for every agent.</div>
                    </>
                  )}
                  <div className="flex gap-2 mt-3 flex-wrap">
                    <button className={PRIMARY} onClick={onRequest} data-booking-request>Request viewing</button>
                    <button className={GHOST} onClick={() => setShowWindowForm(s => !s)}>Owner already told me a time</button>
                  </div>
                </div>
              )}

              {v.windows.map(w => (
                <div key={w.id} data-booking-window={w.id}>
                  <div className="flex items-baseline justify-between gap-2 mb-2">
                    <div>
                      <div className="text-sm font-bold text-navy">{dayLabel(w.start)} · {timeLabel(w.start)}–{timeLabel(w.end)}</div>
                      {w.evidence && <div className="text-[11px] text-navy/45 italic">Owner: “{w.evidence}”</div>}
                      <div className="text-[11px] text-navy/55" data-window-confirmation-label={w.confirmation}>
                        {w.confirmation === 'full_window'
                          ? (v.standingPermission ? 'Standing permission — every slot owner-confirmed' : 'Owner confirmed the whole window')
                          : w.confirmation === 'start_only'
                            ? `Owner confirmed ${timeLabel(w.start)} only — later slots are our planning block (proposed, need the owner's OK)`
                            : 'Approximate time — every slot is proposed until the owner confirms'}
                      </div>
                    </div>
                    <button className="text-[10px] text-navy/35 hover:text-red-600" onClick={() => removeWindow(w.id)} title="Owner withdrew this window">remove window</button>
                  </div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                    {w.slots.map((s, i) => {
                      const b = s.bookingId ? bookingById.get(s.bookingId) : null
                      const ownMove = !!(moving && b && b.id === moving.id)
                      const selectable = (s.state === 'free' || ownMove) && canStartAt(w.slots, i, dur)
                      const proposed = !s.confirmed
                      const sel = picked(w.id, s)
                      return (
                        <button key={s.start} data-slot={s.start} data-slot-state={s.state} data-slot-confirmed={s.confirmed ? '1' : '0'} data-slot-occupied={s.occupied ? '1' : '0'}
                          disabled={!selectable && !sel}
                          onClick={() => setPick({ windowId: w.id, start: s.start })}
                          title={b ? `${b.agent.name} · ${b.appointmentLabel}${b.party.label ? ' · ' + b.party.label : ''}`
                            : s.state === 'past' ? 'Past'
                            : `${proposed ? 'Proposed — needs the owner\'s OK' : 'Owner-confirmed'}${s.occupied ? ' · short-stay guests in (warning only)' : ''}`}
                          className={cn('rounded-md px-1 py-2 text-[11px] font-semibold leading-tight text-center transition-colors ring-1',
                            sel ? 'bg-navy text-white ring-navy'
                              : s.state === 'free' && proposed ? 'bg-white text-navy/60 ring-dashed ring-navy/25 border border-dashed border-navy/25 hover:ring-gold'
                              : s.state === 'free' ? 'bg-emerald-50 text-navy ring-emerald-300 hover:ring-gold'
                              : s.state === 'booked' ? 'text-white ring-transparent'
                              : 'bg-off-white text-navy/25 ring-transparent',
                            s.occupied && s.state !== 'booked' && 'bg-[repeating-linear-gradient(45deg,#fff7e6,#fff7e6_4px,#fdebc8_4px,#fdebc8_8px)]',
                            !selectable && !sel && s.state === 'free' && 'opacity-50')}
                          style={s.state === 'booked' && !sel ? { background: b?.agent.colorHex || '#64748b', opacity: ownMove ? 0.55 : 1 } : undefined}>
                          {timeLabel(s.start)}
                          {/* the booking's label sits on its FIRST box only; a 20-min
                              booking's second box just reads as its continuation */}
                          {b && (b.startsAt && new Date(b.startsAt).getTime() === new Date(s.start).getTime()
                            ? <div className="text-[9px] font-medium truncate opacity-90" data-slot-booking-head={b.id}>{b.agent.name}</div>
                            : <div className="text-[9px] font-medium opacity-60" data-slot-booking-cont={b.id}>↳ cont.</div>)}
                          {!b && s.state === 'free' && <div className="text-[9px] font-medium opacity-70">{proposed ? 'proposed' : 'confirmed'}{s.occupied ? ' · guests' : ''}</div>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              {showWindowForm && (
                <div className="rounded-lg bg-off-white p-3 space-y-2" data-window-form>
                  <div className={SECTION}>Owner-confirmed viewing time</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><label className={LABEL}>Day</label><input type="date" className={FIELD} value={wf.date} onChange={e => setWf(s => ({ ...s, date: e.target.value, fromDate: '' }))} /></div>
                    <div><label className={LABEL}>From</label><input type="time" step={600} className={FIELD} value={wf.from} onChange={e => setWf(s => ({ ...s, from: e.target.value }))} /></div>
                    <div><label className={LABEL}>To</label><input type="time" step={600} className={FIELD} value={wf.to} onChange={e => setWf(s => ({ ...s, to: e.target.value }))} /></div>
                  </div>
                  <div className="flex flex-wrap gap-3 text-[11px] text-navy/70" data-window-confirmation>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={wf.confirmation === 'start_only'} onChange={() => setWf(s => ({ ...s, confirmation: 'start_only' }))} />
                      Owner confirmed only the start time (rest = proposed)
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={wf.confirmation === 'full_window'} onChange={() => setWf(s => ({ ...s, confirmation: 'full_window' }))} />
                      Owner approved the whole range
                    </label>
                  </div>
                  <div className="text-[11px] text-navy/40">…or only a date (“viewings from 15 October”) — no time is invented:</div>
                  <input type="date" className={FIELD} value={wf.fromDate} onChange={e => setWf(s => ({ ...s, fromDate: e.target.value }))} />
                  <div className="flex justify-end gap-2">
                    <button className={GHOST} onClick={() => setShowWindowForm(false)}>Cancel</button>
                    <button className={PRIMARY} disabled={busy} onClick={saveWindow}>Save</button>
                  </div>
                </div>
              )}
              {v.canBookSlots && !showWindowForm && (
                <button className="text-[11px] text-navy/40 hover:text-navy" onClick={() => setShowWindowForm(true)}>+ add another owner-confirmed time</button>
              )}

              {/* ── the booking form ─────────────────────────────────────── */}
              {v.canBookSlots && (
                <div className="space-y-3 border-t border-gray-100 pt-4">
                  {moving && (
                    <div className="text-xs rounded bg-amber-50 text-amber-800 px-3 py-2 flex items-center justify-between">
                      <span>Moving: {bookingLine(moving)} — pick the new slot</span>
                      <button className="underline" onClick={() => { setMoving(null); setPick(null) }}>stop</button>
                    </div>
                  )}
                  <div>
                    <div className={SECTION}>Length</div>
                    <div className="flex gap-2">
                      {([10, 20] as const).map(d => (
                        <button key={d} data-duration={d} onClick={() => { setDur(d); setPick(null) }}
                          className={cn('px-3 py-2 rounded text-xs font-semibold ring-1',
                            dur === d ? 'bg-navy text-white ring-navy' : 'bg-white text-navy ring-navy/15')}>
                          {d} min {d === 10 ? '· single' : '· double (back-to-back)'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className={SECTION}>Appointment</div>
                    <div className="flex flex-wrap gap-1.5">
                      {v.appointmentTypes.map(t => (
                        <button key={t.key} data-type={t.key} onClick={() => setType(t.key)}
                          className={cn('px-2.5 py-1.5 rounded-full text-[11px] font-semibold ring-1',
                            type === t.key ? 'bg-navy text-white ring-navy' : TYPE_TONE[t.key])}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {!moving && (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2">
                          <label className={LABEL}>Client *</label>
                          <input className={FIELD} data-client-name value={f.clientName} onChange={e => setF(s => ({ ...s, clientName: e.target.value }))} placeholder="e.g. Maria & Tom" />
                        </div>
                        <div>
                          <label className={LABEL}>People</label>
                          <input type="number" min={1} className={FIELD} value={f.groupSize} onChange={e => setF(s => ({ ...s, groupSize: e.target.value }))} placeholder="2" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={LABEL}>Viewing agent</label>
                          <select className={cn(FIELD, 'appearance-none')} value={f.agentId} onChange={e => setF(s => ({ ...s, agentId: e.target.value }))}>
                            <option value="">Me</option>
                            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={LABEL}>Notes</label>
                          <input className={FIELD} value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} placeholder="budget, move-in, pets…" />
                        </div>
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-navy/50">
                      {pick ? `${dayLabel(pick.start)} · ${time12(pick.start)} · ${dur} min${pickInfo.proposed ? ' · proposed (pending owner)' : ' · owner-confirmed'}${pickInfo.occupied ? ' · ⚠ guests in' : ''}` : 'Pick a slot above'}
                    </div>
                    <button className={PRIMARY} disabled={busy || !pick} onClick={book} data-booking-submit>
                      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {moving ? 'Move booking' : pickInfo.proposed ? 'Reserve (proposed)' : 'Book slot'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── who is coming ────────────────────────────────────────── */}
              <div className="border-t border-gray-100 pt-4">
                <div className={SECTION}>Bookings on this property</div>
                {!activeBookings.length && <div className="text-xs text-navy/40">None yet.</div>}
                <div className="space-y-1.5">
                  {activeBookings.map(b => (
                    <div key={b.id} data-booking-row={b.id} className="flex items-center gap-2 text-xs rounded bg-off-white px-3 py-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: b.agent.colorHex || '#64748b' }} />
                      <div className="grow min-w-0">
                        <div className="font-semibold text-navy truncate">{bookingLine(b)}</div>
                        {b.attention && <div className="text-amber-700 whitespace-normal" data-booking-attention={b.id}>⚠ {b.attention.reason}</div>}
                        <div className="text-navy/45 truncate">
                          {b.appointmentLabel}{b.durationMin ? ` · ${b.durationMin} min` : ''}
                          {b.party.label ? ` · ${b.party.label}` : b.party.ref ? ` · ${b.party.ref}` : ''}
                          {b.party.size ? ` (${b.party.size})` : ''}
                        </div>
                      </div>
                      {b.canEdit && b.startsAt && (
                        <button className="text-navy/50 hover:text-navy" onClick={() => { setMoving(b); setDur((b.durationMin as 10 | 20) || 10); setType(b.appointmentType || 'general'); setPick(null) }}>move</button>
                      )}
                      {b.canEdit && (
                        <button className="text-red-600/70 hover:text-red-700" disabled={busy} onClick={() => cancel(b)} data-booking-cancel={b.id}>cancel</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {v && tab === 'calendars' && (
            <div className="space-y-5">
              <div className="text-xs text-navy/55 leading-relaxed">
                {v.dualUse
                  ? <>Classified <b>winter let + short let</b> (Malta default: short let April–November). That is a classification only — short-stay availability, rates and booking permission are <b>not</b> confirmed by it. Connect its Airbnb / Booking.com / VRBO calendar to see guest stays.</>
                  : <>Connect a short-stay channel calendar (Airbnb, Booking.com, VRBO, another agency) to see guest stays.</>}
                <div className="mt-1 text-navy/45">Short-stay occupancy is shown on viewing slots as a warning — it never blocks a viewing the owner authorised. Viewing appointments are never exported as accommodation blocks.</div>
              </div>
              {v.canManageCalendars ? (
                <>
                  <div>
                    <div className={SECTION}>Import — paste the channel’s iCal export link</div>
                    <div className="flex gap-2">
                      <input className={FIELD} value={feedUrl} onChange={e => setFeedUrl(e.target.value)} placeholder="https://www.airbnb.com/calendar/ical/….ics" data-feed-url />
                      <button className={PRIMARY} disabled={busy || !feedUrl.trim()} onClick={addFeed}><Link2 className="w-3.5 h-3.5" />Connect</button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {v.calendarFeeds.map(fd => (
                      <div key={fd.id} className="flex items-center gap-2 text-xs rounded bg-off-white px-3 py-2">
                        <CalendarDays className="w-3.5 h-3.5 text-navy/40" />
                        <div className="grow min-w-0">
                          <div className="font-semibold text-navy capitalize">{fd.source} <span className="font-normal text-navy/40">· {fd.host}</span></div>
                          <div className={cn('text-[11px]', fd.status === 'error' ? 'text-red-600' : 'text-navy/45')}>
                            {fd.status === 'error' ? `Sync failed: ${fd.error}` : `${fd.events} stays · synced ${fd.lastSyncedAt ? new Date(fd.lastSyncedAt).toLocaleString('en-GB', { timeZone: 'Europe/Malta' }) : 'never'}`}
                          </div>
                        </div>
                        <button title="Sync now" onClick={() => syncFeed(fd.id)} className="text-navy/40 hover:text-navy"><RefreshCw className="w-3.5 h-3.5" /></button>
                        <button title="Disconnect" onClick={() => removeFeed(fd.id)} className="text-red-500/60 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  {v.calendarExportUrl && (
                    <div>
                      <div className={SECTION}>Export — short-stay occupancy only, for Airbnb / Booking.com (“import calendar”)</div>
                      <div className="flex gap-2">
                        <input readOnly className={cn(FIELD, 'text-[11px]')} value={v.calendarExportUrl} onFocus={e => e.target.select()} />
                        <button className={GHOST} onClick={() => { navigator.clipboard?.writeText(v.calendarExportUrl || ''); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
                          <Copy className="w-3.5 h-3.5 inline" /> {copied ? 'copied' : 'copy'}
                        </button>
                      </div>
                      <div className="text-[11px] text-navy/40 mt-1">Guest stays from every connected channel, so the channels see each other — never viewings or photo appointments. Add <code>?exclude=airbnb</code> for the Airbnb import.</div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-navy/50">Only the listing agent or an admin can connect calendars.</div>
              )}
              <div>
                <div className={SECTION}>Short-stay occupancy (next 120 days)</div>
                {!v.occupied.length && <div className="text-xs text-navy/40">No stays from connected calendars.</div>}
                <div className="flex flex-wrap gap-1.5">
                  {v.occupied.map(o => (
                    <span key={o.id} className="text-[11px] rounded bg-off-white px-2 py-1 text-navy/70">
                      {dayLabel(o.start)} → {dayLabel(o.end)} <span className="text-navy/35 capitalize">· {o.source}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </>
  )
}
