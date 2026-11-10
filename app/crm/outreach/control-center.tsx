'use client'
// Outreach Planner V2 control center (Claude, 2026-11-09). Every number here
// comes from GET /outreach/control/overview, /outreach/automation/:id and
// /outreach/activity/:id — persisted run records, never prepared lists.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, MinusCircle, PauseCircle, PlayCircle, XCircle } from 'lucide-react'
import { crmGet, crmJson } from '@/lib/crm/api'
import './control-center.css'
import { DraftEditor } from './outreach-p0'

export type DayCell = {
  date: string; relative: string | null; weekday: number; state: string; label: string; mode?: string; planId?: number
  scheduledAt?: string | null; target?: number | string | null; accepted?: number; failed?: number; skipped?: number; reason?: string | null; wrapped?: boolean
}
export type OverviewAccount = {
  id: number; label: string; sessionName: string; persona: string | null; sessionStatus: string; connected: boolean; restricted: boolean
  restrictionUntil: string | null; restrictionReason: string | null; sentToday: number; targetToday: number | null; lastAcceptedAt: string | null
  nextRun: { at: string; mode: string; status: string } | null; automation: { enabled: boolean; suspendedReason: string | null; suspendedRecoverable: boolean | null } | null
  legacyAuto: boolean; days: DayCell[]; attention: string[]
}
export type Overview = {
  generatedAt: string; today: string
  kpi: { sentToday: number; scheduled: number; remaining: number; nextRun: { at: string; label: string } | null; activeAccounts: number; accounts: number; attention: { accountId: number; label: string; reason: string }[] }
  accounts: OverviewAccount[]
}

const TZ = 'Europe/Malta'
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hm = (iso?: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—')
const dayLabel = (d: DayCell) => d.relative || `${WEEKDAYS[d.weekday - 1]} ${d.date.slice(8)}`
const whenLabel = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit' }).format(d)
  return `${day} · ${hm(iso)}`
}

export function useOverview(pollMs = 60_000) {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try { setData(await crmGet('outreach/control/overview')); setError('') }
    catch (e: any) { setError(e?.message || 'Overview unavailable') }
  }, [])
  useEffect(() => { reload(); const t = setInterval(reload, pollMs); return () => clearInterval(t) }, [reload, pollMs])
  return { data, error, reload }
}

// ── KPI bar ───────────────────────────────────────────────────────────────────
export function KpiBar({ data, error }: { data: Overview | null; error: string }) {
  const k = data?.kpi
  const items: { label: string; value: string; hint: string; tone?: string }[] = [
    { label: 'Sent today', value: k ? String(k.sentToday) : '—', hint: 'Messages the WhatsApp provider accepted today (Malta day).' },
    { label: 'Scheduled', value: k ? String(k.scheduled) : '—', hint: 'Messages in today\'s runs that have not started yet.' },
    { label: 'Remaining', value: k ? String(k.remaining) : '—', hint: 'Messages still pending in today\'s runs that are already running.' },
    { label: 'Next run', value: k?.nextRun ? `${hm(k.nextRun.at)} · ${k.nextRun.label}` : '—', hint: 'The next real scheduled execution.' },
    { label: 'Active accounts', value: k ? `${k.activeAccounts}/${k.accounts}` : '—', hint: 'Connected and not restricted.' },
    { label: 'Attention', value: k ? String(k.attention.length) : '—', hint: k?.attention.map(a => `${a.label}: ${a.reason}`).join('\n') || 'Nothing needs attention.', tone: k?.attention.length ? 'warn' : 'ok' },
  ]
  return (
    <section className="cc-kpis" aria-label="Today in numbers">
      {items.map(item => (
        <div key={item.label} className={`cc-kpi ${item.tone ? `is-${item.tone}` : ''}`} title={item.hint}>
          <small>{item.label}</small><b>{item.value}</b>
        </div>
      ))}
      {error && <p className="cc-error" role="alert">{error}</p>}
    </section>
  )
}

// ── Day status icon (never colour only: icon + accessible label) ─────────────
const STATE_ICON: Record<string, typeof CheckCircle2> = {
  completed: CheckCircle2, partial: AlertTriangle, no_sends: MinusCircle, skipped: PauseCircle, cancelled: XCircle, failed: XCircle,
  scheduled: Clock3, planned: CircleDashed, running: PlayCircle, attention: AlertTriangle, suspended: PauseCircle, off: MinusCircle, empty: CircleDashed, auto_prepared: CircleDashed, paused: PauseCircle,
}
export function DayIcon({ day, size = 14 }: { day: DayCell; size?: number }) {
  const Icon = STATE_ICON[day.state] || CircleDashed
  const title = `${dayLabel(day)}: ${day.label}${day.scheduledAt ? ` · ${hm(day.scheduledAt)}` : ''}${day.accepted ? ` · ${day.accepted} accepted` : ''}`
  return <span className={`cc-day-icon is-${day.state}`} title={title} aria-label={title} role="img"><Icon size={size} aria-hidden /></span>
}

// ── Compact account rail ─────────────────────────────────────────────────────
export function AccountRail({ accounts, selectedId, onSelect, footer }: { accounts: OverviewAccount[]; selectedId: number | null; onSelect: (id: number) => void; footer?: React.ReactNode }) {
  return (
    <nav className="cc-rail" aria-label="Outreach accounts">
      {accounts.map(a => {
        const state = a.restricted ? 'restricted' : a.connected ? 'online' : 'offline'
        return (
          <button key={a.id} type="button" className={`cc-rail-row${selectedId === a.id ? ' is-selected' : ''}`} aria-pressed={selectedId === a.id} onClick={() => onSelect(a.id)}>
            <span className={`cc-dot is-${state}`} title={state === 'online' ? 'Connected' : state === 'restricted' ? 'Restricted' : `Disconnected (${a.sessionStatus})`} />
            <span className="cc-rail-main">
              <b>{a.label}</b>
              <small>{a.automation?.enabled ? (a.automation.suspendedReason ? 'Auto · suspended' : 'Auto') : 'Manual'}{a.nextRun ? ` · next ${whenLabel(a.nextRun.at)}` : ''}</small>
            </span>
            <span className="cc-rail-count" title="Accepted today / today's target">{a.sentToday}<small>/{a.targetToday ?? '—'}</small></span>
            <span className="cc-rail-days" aria-label="Next five days">{a.days.slice(0, 5).map(d => <DayIcon key={d.date} day={d} size={12} />)}</span>
            {(a.restricted || !a.connected || a.automation?.suspendedReason) && <span className="cc-rail-warn" title={a.attention.join('\n')}><AlertTriangle size={12} aria-hidden /> {a.attention[0]}</span>}
          </button>
        )
      })}
      {footer}
    </nav>
  )
}

// ── 10-day timeline ──────────────────────────────────────────────────────────
export function DayTimeline({ days, selected, onPick }: { days: DayCell[]; selected?: string | null; onPick?: (day: DayCell) => void }) {
  return (
    <ol className="cc-timeline" aria-label="Next ten days">
      {days.map(d => (
        <li key={d.date}>
          <button type="button" className={`cc-day is-${d.state}${selected === d.date ? ' is-selected' : ''}`} onClick={() => onPick?.(d)} aria-pressed={selected === d.date}>
            <span className="cc-day-head"><b>{dayLabel(d)}</b><DayIcon day={d} /></span>
            <span className="cc-day-time">{d.scheduledAt ? hm(d.scheduledAt) : '—'}</span>
            <span className="cc-day-label">{d.label}</span>
            <span className="cc-day-meta">{d.mode === 'automation' ? 'Auto' : d.mode === 'manual' ? 'Manual' : ''}{d.target != null && d.target !== '' ? ` · ${d.accepted || 0}/${d.target}` : ''}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

export function DayDetail({ day }: { day: DayCell | null }) {
  if (!day) return null
  return (
    <div className="cc-day-detail" role="region" aria-label={`Details ${dayLabel(day)}`}>
      <b>{dayLabel(day)} · {day.date}</b>
      <dl>
        <div><dt>State</dt><dd>{day.label}</dd></div>
        <div><dt>Time</dt><dd>{day.scheduledAt ? `${hm(day.scheduledAt)} Malta` : '—'}</dd></div>
        <div><dt>Target</dt><dd>{day.target ?? '—'}</dd></div>
        <div><dt>Accepted</dt><dd>{day.accepted ?? 0}</dd></div>
        <div><dt>Failed / skipped</dt><dd>{day.failed ?? 0} / {day.skipped ?? 0}</dd></div>
        <div><dt>Mode</dt><dd>{day.mode === 'automation' ? 'Automation' : day.mode === 'manual' ? 'Manual' : '—'}</dd></div>
        {day.reason && <div><dt>Reason</dt><dd>{day.reason.replace(/_/g, ' ')}</dd></div>}
      </dl>
    </div>
  )
}

// ── Controlled numeric field: raw text while typing, validated on blur ───────
export function NumberField({ id, label, value, min, max, onCommit, suffix, slider = true, help }: {
  id: string; label: string; value: number; min: number; max: number; onCommit: (v: number) => void; suffix?: string; slider?: boolean; help?: string
}) {
  const [raw, setRaw] = useState(String(value))
  const [error, setError] = useState('')
  const focused = useRef(false)
  // Sync only when the committed value changes from outside (reload, save).
  // Leaving the field with an invalid entry keeps what was typed plus the
  // message — it is never silently replaced by the old value.
  useEffect(() => { if (!focused.current) { setRaw(String(value)); setError('') } }, [value])
  const commit = (text: string) => {
    const n = Number(text)
    if (text === '' || !Number.isInteger(n)) { setError(`Enter a whole number from ${min} to ${max}.`); return }
    if (n < min || n > max) { setError(`Allowed: ${min}–${max}.`); return }
    setError(''); onCommit(n)
  }
  return (
    <div className="cc-field">
      <label htmlFor={id}>{label}</label>
      <div className="cc-field-row">
        <input id={id} type="text" inputMode="numeric" pattern="[0-9]*" value={raw} aria-invalid={!!error} aria-describedby={`${id}-msg`}
          onFocus={() => { focused.current = true }} onChange={e => setRaw(e.target.value.replace(/\D/g, '').slice(0, 3))}
          onBlur={e => { focused.current = false; commit(e.target.value) }} onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }} />
        {suffix && <span className="cc-suffix">{suffix}</span>}
        {slider && <input type="range" aria-label={`${label} slider`} min={min} max={max} step={1} value={Math.min(max, Math.max(min, Number(raw) || value))}
          onChange={e => { setRaw(e.target.value); setError(''); onCommit(Number(e.target.value)) }} />}
      </div>
      <small id={`${id}-msg`} className={error ? 'is-error' : ''}>{error || help || ''}</small>
    </div>
  )
}

// ── Automation setup (single flow, one Save & enable) ────────────────────────
type Config = {
  enabled: boolean; startDate: string; startTime: string; weekdays: number[]; targetBase: number; targetVariation: number
  paceBase: number; paceVariation: number; shiftMinutes: number; windowStart: string; windowEnd: string; templateMode: 'persona_rotation' | 'fixed'; templateId: number | null
  suspendedReason?: string | null; version?: number; updatedAt?: string; updatedBy?: string
}
const defaultConfig = (today: string): Config => ({
  enabled: false, startDate: today, startTime: '08:30', weekdays: [1, 2, 3, 4, 5], targetBase: 30, targetVariation: 5,
  paceBase: 30, paceVariation: 5, shiftMinutes: 20, windowStart: '08:30', windowEnd: '19:30', templateMode: 'persona_rotation', templateId: null,
})

export function AutomationSetup({ account, today, onSaved }: { account: OverviewAccount; today: string; onSaved: () => void }) {
  const [saved, setSaved] = useState<Config | null>(null)
  const [draft, setDraft] = useState<Config>(defaultConfig(today))
  const [timeline, setTimeline] = useState<DayCell[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [state, setState] = useState<{ busy: boolean; error: string; note: string }>({ busy: false, error: '', note: '' })
  const load = useCallback(async () => {
    const r = await crmGet(`outreach/automation/${account.id}`)
    const cfg = r.config ? { ...defaultConfig(today), ...r.config } : defaultConfig(today)
    setSaved(r.config ? cfg : null); setDraft(cfg); setTimeline(r.timeline || [])
  }, [account.id, today])
  useEffect(() => { load().catch(e => setState(s => ({ ...s, error: e.message }))) }, [load])
  useEffect(() => { crmGet(`outreach/persona-templates?persona=${account.persona || ''}`).then(r => setTemplates(r.templates || [])).catch(() => {}) }, [account.persona])
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setDraft(d => ({ ...d, [k]: v }))
  const dirty = JSON.stringify({ ...draft, suspendedReason: undefined, version: undefined, updatedAt: undefined, updatedBy: undefined }) !== JSON.stringify({ ...(saved || {}), suspendedReason: undefined, version: undefined, updatedAt: undefined, updatedBy: undefined })
  const approved = templates.filter(t => t.status === 'approved' && t.active)
  const firstMessage = (draft.templateMode === 'fixed' ? approved.find(t => t.id === draft.templateId) : approved.find(t => t.period === 'morning' && t.slot === 5) || approved.find(t => t.period === 'morning'))?.body || ''
  const save = async (enabled: boolean) => {
    setState({ busy: true, error: '', note: '' })
    try {
      const r = await crmJson(`outreach/automation/${account.id}`, 'PUT', { ...draft, enabled })
      const cfg = { ...defaultConfig(today), ...r.config }
      setSaved(cfg); setDraft(cfg); setTimeline(r.timeline || [])
      setState({ busy: false, error: '', note: enabled ? 'Saved and enabled. The next run is preflighted two minutes before it starts.' : 'Saved. Automation is off.' })
      onSaved()
    } catch (e: any) { setState({ busy: false, error: e?.message || 'Save failed', note: '' }) }
  }
  const lo = (b: number, v: number, min: number) => Math.max(min, b - v)
  const summary = `${account.label} will ${draft.enabled || !saved?.enabled ? 'begin' : 'continue'} on ${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${draft.startDate}T12:00:00Z`))} at ${draft.startTime} (Malta), on ${draft.weekdays.map(d => WEEKDAYS[d - 1]).join(', ')}, with about ${draft.targetBase} eligible contacts per run (${draft.targetBase ? `${lo(draft.targetBase, draft.targetVariation, 1)}–${Math.min(40, draft.targetBase + draft.targetVariation)}` : 'none'}), pace ${lo(draft.paceBase, draft.paceVariation, 10)}–${Math.min(100, draft.paceBase + draft.paceVariation)}%, using ${draft.templateMode === 'fixed' ? 'the selected approved template' : 'the approved templates for this persona'}. Preflight runs two minutes before each start. The start time moves +${draft.shiftMinutes} min after each run that actually sent messages and returns to ${draft.startTime} before ${draft.windowEnd}.`
  return (
    <div className="cc-auto">
      <header className="cc-auto-head">
        <div><small>AUTOMATION</small><h3>{account.label}</h3></div>
        <span className={`cc-badge ${saved?.enabled ? (saved.suspendedReason ? 'is-warn' : 'is-on') : ''}`}>{saved?.enabled ? (saved.suspendedReason ? `Enabled · suspended — ${saved.suspendedReason.replace(/_/g, ' ')}` : 'Automation enabled') : 'Automation off'}</span>
        {account.legacyAuto && <span className="cc-badge is-warn" title="The legacy five-day Auto is on for this account. Enabling V2 turns it off.">Legacy Auto on</span>}
      </header>
      <ol className="cc-steps">
        <li><b>Schedule</b>
          <div className="cc-grid">
            <div className="cc-field"><label htmlFor="cc-start-date">Start date</label><input id="cc-start-date" type="date" min={today} value={draft.startDate} onChange={e => set('startDate', e.target.value)} /></div>
            <div className="cc-field"><label htmlFor="cc-start-time">Start time</label><input id="cc-start-time" type="time" min={draft.windowStart} max={draft.windowEnd} value={draft.startTime} onChange={e => set('startTime', e.target.value)} /></div>
            <NumberField id="cc-shift" label="Shift per completed run" value={draft.shiftMinutes} min={0} max={60} suffix="min" slider={false} onCommit={v => set('shiftMinutes', v)} help="Only runs that sent messages move the time." />
            <div className="cc-field"><span className="cc-label">Window</span><div className="cc-field-row"><input aria-label="Window start" type="time" min="08:30" max="19:30" value={draft.windowStart} onChange={e => set('windowStart', e.target.value)} /><span className="cc-suffix">–</span><input aria-label="Window end" type="time" min="08:30" max="19:30" value={draft.windowEnd} onChange={e => set('windowEnd', e.target.value)} /></div><small>Inside 08:30–19:30 Malta.</small></div>
          </div>
          <div className="cc-weekdays" role="group" aria-label="Active weekdays">
            {WEEKDAYS.map((w, i) => <button key={w} type="button" aria-pressed={draft.weekdays.includes(i + 1)} onClick={() => set('weekdays', draft.weekdays.includes(i + 1) ? draft.weekdays.filter(d => d !== i + 1) : [...draft.weekdays, i + 1].sort())}>{w}</button>)}
          </div>
        </li>
        <li><b>Volume</b>
          <div className="cc-grid">
            <NumberField id="cc-target" label="Contacts per run" value={draft.targetBase} min={0} max={40} onCommit={v => set('targetBase', v)} help="0 = no outreach. Hard cap 40/day." />
            <NumberField id="cc-target-var" label="± variation" value={draft.targetVariation} min={0} max={10} slider={false} onCommit={v => set('targetVariation', v)} help={draft.targetBase ? `Range ${lo(draft.targetBase, draft.targetVariation, 1)}–${Math.min(40, draft.targetBase + draft.targetVariation)}` : ''} />
          </div>
        </li>
        <li><b>Pace</b>
          <div className="cc-grid">
            <NumberField id="cc-pace" label="Base pace" value={draft.paceBase} min={10} max={100} suffix="%" onCommit={v => set('paceBase', v)} help="Spacing between messages: delay × 100 / pace." />
            <NumberField id="cc-pace-var" label="± points" value={draft.paceVariation} min={0} max={20} slider={false} onCommit={v => set('paceVariation', v)} help={`Effective ${lo(draft.paceBase, draft.paceVariation, 10)}–${Math.min(100, draft.paceBase + draft.paceVariation)}%`} />
          </div>
        </li>
        <li><b>Template</b>
          <div className="cc-grid">
            <div className="cc-field"><label htmlFor="cc-template">Message</label>
              <select id="cc-template" value={draft.templateMode === 'fixed' ? String(draft.templateId || '') : 'rotation'} onChange={e => e.target.value === 'rotation' ? setDraft(d => ({ ...d, templateMode: 'persona_rotation', templateId: null })) : setDraft(d => ({ ...d, templateMode: 'fixed', templateId: Number(e.target.value) }))}>
                <option value="rotation">Approved templates for this persona (greeting by send time)</option>
                {approved.map(t => <option key={t.id} value={t.id}>{t.title || `Slot ${t.slot}`} · {t.period}</option>)}
              </select>
              <small>{approved.length ? `${approved.length} approved` : 'No approved template — approve one in Templates first.'}</small>
            </div>
          </div>
          {firstMessage && <div className="cc-wa-preview" aria-label="First message preview"><pre>{firstMessage}</pre></div>}
        </li>
        <li><b>Review</b><p className="cc-summary">{summary}</p>
          <p className="cc-fineprint">Disconnected or restricted accounts suspend safely and are never replaced by another account. A paused or skipped day is shown as such and does not count as a run.</p>
        </li>
      </ol>
      <footer className="cc-actions">
        {state.error && <p className="cc-error" role="alert">{state.error}</p>}
        {state.note && <p className="cc-note" role="status">{state.note}</p>}
        <button type="button" disabled={state.busy || !dirty} onClick={() => save(saved?.enabled === true)}>Save</button>
        {!saved?.enabled && <button type="button" className="is-primary" disabled={state.busy} onClick={() => save(true)}>Save &amp; enable</button>}
        {saved?.enabled && <button type="button" disabled={state.busy} onClick={() => save(false)}>Disable automation</button>}
        {saved?.updatedAt && <small>Saved {new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(saved.updatedAt))} · v{saved.version}</small>}
      </footer>
      <DayTimeline days={timeline} />
    </div>
  )
}

// ── Activity ────────────────────────────────────────────────────────────────
export function ActivityView({ account }: { account: OverviewAccount }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  useEffect(() => { setData(null); crmGet(`outreach/activity/${account.id}?days=14`).then(setData).catch(e => setError(e.message)) }, [account.id])
  return (
    <div className="cc-activity">
      <header className="cc-activity-head">
        <div><small>ACTIVITY</small><h3>{account.label}</h3></div>
        <dl>
          <div><dt>Last accepted</dt><dd>{account.lastAcceptedAt ? whenLabel(account.lastAcceptedAt) : 'None logged'}</dd></div>
          <div><dt>Next run</dt><dd>{account.nextRun ? whenLabel(account.nextRun.at) : '—'}</dd></div>
          <div><dt>Status</dt><dd>{account.attention[0] || (account.connected ? 'Connected' : account.sessionStatus)}</dd></div>
        </dl>
      </header>
      {error && <p className="cc-error">{error}</p>}
      {!data && !error && <p className="cc-muted">Loading…</p>}
      {data?.runs?.length === 0 && <p className="cc-muted">No runs in the last 14 days.</p>}
      {data?.runs?.map((r: any) => (
        <details key={r.id} className={`cc-run is-${r.status}`}>
          <summary>
            <b>{r.day}</b><span>{hm(r.scheduled_at)}</span><span>{r.run_mode === 'automation' ? 'Auto' : 'Manual'}</span>
            <span className="cc-run-state">{r.status === 'completed' ? (r.outcome === 'partial' ? 'Partial' : r.outcome === 'no_sends' ? '0 accepted' : 'Completed') : r.status}</span>
            <span title="accepted / target">{r.accepted_count}/{r.target_snapshot ?? r.target_count ?? '—'}</span>
            <span title="failed · skipped · reserved · pending">{r.failed_count}✕ · {r.skipped_count} skip · {r.reserved} res · {r.pending} pend</span>
            {r.outcome_reason && <em>{String(r.outcome_reason).replace(/_/g, ' ')}</em>}
          </summary>
          <ol className="cc-events">
            {r.events.map((e: any, i: number) => (
              <li key={i} className={e.ok === false ? 'is-bad' : e.ok ? 'is-ok' : ''}><time>{hm(e.at)}</time><span>{String(e.kind).replace(/^preflight:/, 'check · ').replace(/^transition:/, '→ ').replace(/_/g, ' ')}</span><small>{eventDetail(e.detail)}</small></li>
            ))}
            {!r.events.length && <li className="cc-muted">No events recorded for this run.</li>}
          </ol>
        </details>
      ))}
      {data?.accountEvents?.length > 0 && <details className="cc-run"><summary><b>Account events</b><span>{data.accountEvents.length}</span></summary>
        <ol className="cc-events">{data.accountEvents.map((e: any, i: number) => <li key={i} className={e.ok === false ? 'is-bad' : e.ok ? 'is-ok' : ''}><time>{whenLabel(e.at)}</time><span>{String(e.kind).replace(/_/g, ' ')}</span><small>{eventDetail(e.detail)}</small></li>)}</ol>
      </details>}
    </div>
  )
}
function eventDetail(d: any) {
  if (!d || typeof d !== 'object') return ''
  return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 160)
}

// ── Template review (draft → approved; only approved templates are sent) ────
export function TemplateReview() {
  const [rows, setRows] = useState<any[]>([])
  const [error, setError] = useState('')
  const load = useCallback(() => crmGet('outreach/persona-templates').then(r => setRows(r.templates || [])).catch(e => setError(e.message)), [])
  useEffect(() => { load() }, [load])
  const groups = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const t of rows) { const k = `${t.persona}·${t.slot}`; m.set(k, [...(m.get(k) || []), t]) }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [rows])
  const setStatus = async (ids: number[], status: string) => {
    try { for (const id of ids) await crmJson(`outreach/persona-templates/${id}/status`, 'POST', { status }); await load() }
    catch (e: any) { setError(e.message) }
  }
  return (
    <div className="cc-templates">
      <p className="cc-fineprint">Only <b>approved</b> templates are ever sent. Drafts can be edited and previewed safely; approving one adds it to the live rotation for that persona. New or AI-drafted text starts as a draft. Morning, afternoon and evening versions are chosen at send time (Malta).</p>
      {error && <p className="cc-error">{error}</p>}
      {groups.map(([key, items]) => {
        const status = items.every(t => t.status === 'approved') ? 'approved' : items.some(t => t.status === 'draft') ? 'draft' : items.every(t => t.status === 'inactive') ? 'inactive' : 'mixed'
        const morning = items.find(t => t.period === 'morning') || items[0]
        return (
          <article key={key} className={`cc-template is-${status}`}>
            <header><b>{morning.title || `${morning.persona} · slot ${morning.slot}`}</b><span className={`cc-badge is-${status}`}>{status}</span></header>
            <div className="cc-wa-preview"><pre>{morning.body}</pre></div>
            {status !== 'approved' && <details className="cc-template-edit"><summary>Edit text (stays {status}; never sent until approved)</summary>
              {items.map(t => <DraftEditor key={t.id} template={t} onSaved={load} />)}
            </details>}
            <footer>
              {status !== 'approved' && <button type="button" className="is-primary" onClick={() => setStatus(items.map(t => t.id), 'approved')}>Approve</button>}
              {status === 'approved' && <button type="button" onClick={() => setStatus(items.map(t => t.id), 'draft')}>Back to draft</button>}
              {status !== 'inactive' && <button type="button" onClick={() => setStatus(items.map(t => t.id), 'inactive')}>Deactivate</button>}
              <small>{items.length} period{items.length === 1 ? '' : 's'}{morning.approved_by ? ` · approved by ${morning.approved_by}` : ''}</small>
            </footer>
          </article>
        )
      })}
    </div>
  )
}

// Collapsible section whose content mounts only when opened: a failing or
// slow secondary lane (reminders, engagement, audit) can never take the
// control center down with it.
export function LazyDetails({ summary, defaultOpen = false, children }: { summary: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details className="cc-panel" open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      {open && children}
    </details>
  )
}
