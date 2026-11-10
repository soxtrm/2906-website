'use client'
// ARGUS Outreach P0 (Claude, 2026-11-10): traffic lights, daily pace card,
// Auto / Pause controls, 7-day plan, persona preview. Real API state only —
// GET/PUT /outreach/pace/:id, /outreach/control/overview, /outreach/persona-*.
import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, CircleDashed, Clock3, PauseCircle, XCircle } from 'lucide-react'
import { crmGet, crmJson } from '@/lib/crm/api'
import type { DayCell, OverviewAccount } from './control-center'
import './outreach-p0.css'

const TZ = 'Europe/Malta'
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hm = (iso?: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—')
const whenLabel = (iso?: string | null) => iso ? `${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit' }).format(new Date(iso))} · ${hm(iso)}` : '—'
const dayLabel = (d: DayCell) => d.relative || `${WEEKDAYS[d.weekday - 1]} ${d.date.slice(8)}`

export type Health = { color: 'green' | 'yellow' | 'red' | 'gray' | 'unknown'; code: string; label: string; reason: string; action: string | null; telemetryAt: string | null; nextAt: string | null }
export type P0Account = OverviewAccount & { health?: Health; manualPaused?: { at: string; by: string | null; reason: string | null } | null; pace?: { target: number | null; variation: number; min: number; max: number; version: number; savedAt: string | null } }

const LIGHT_ICON: Record<Health['color'], typeof CheckCircle2> = { green: CheckCircle2, yellow: Clock3, red: XCircle, gray: PauseCircle, unknown: CircleDashed }

// Colour is never the only signal: icon + label (+ reason when not compact).
export function HealthLight({ health, compact = false }: { health?: Health | null; compact?: boolean }) {
  const h: Health = health || { color: 'unknown', code: 'unknown', label: 'Unknown', reason: 'Status not loaded', action: null, telemetryAt: null, nextAt: null }
  const Icon = LIGHT_ICON[h.color] || CircleDashed
  const title = `${h.label} — ${h.reason}${h.action ? `. ${h.action}` : ''}${h.telemetryAt ? ` (checked ${hm(h.telemetryAt)})` : ''}`
  return (
    <span className={`p0-light is-${h.color}${compact ? ' is-compact' : ''}`} title={title} data-light={h.color} data-code={h.code}>
      <Icon size={compact ? 12 : 14} aria-hidden /><b>{h.label}</b>{!compact && <small>{h.reason}</small>}
    </span>
  )
}

export const HEALTH_FILTERS: [string, string][] = [['all', 'All'], ['ready', 'Ready'], ['scheduled', 'Scheduled'], ['blocked', 'Blocked'], ['paused', 'Paused']]
export function healthMatches(h: Health | undefined, filter: string) {
  if (filter === 'all') return true
  const c = h?.color || 'unknown'
  if (filter === 'ready') return c === 'green'
  if (filter === 'scheduled') return c === 'yellow'
  if (filter === 'blocked') return c === 'red' || c === 'unknown'
  return c === 'gray'
}

export function HealthFilter({ accounts, value, onChange }: { accounts: P0Account[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="p0-filter" role="radiogroup" aria-label="Filter accounts by status" data-testid="health-filter">
      {HEALTH_FILTERS.map(([key, label]) => {
        const n = accounts.filter(a => healthMatches(a.health, key)).length
        return <button key={key} type="button" role="radio" aria-checked={value === key} onClick={() => onChange(key)}>{label} <span>{n}</span></button>
      })}
    </div>
  )
}

// Account cards with real traffic lights (all accounts, compact on mobile).
export function AccountCards({ accounts, selectedId, onSelect }: { accounts: P0Account[]; selectedId: number | null; onSelect: (id: number) => void }) {
  return (
    <div className="p0-cards" data-testid="account-cards">
      {accounts.map(a => (
        <button key={a.id} type="button" className={`p0-card is-${a.health?.color || 'unknown'}${selectedId === a.id ? ' is-selected' : ''}`} aria-pressed={selectedId === a.id} onClick={() => onSelect(a.id)} data-testid={`account-card-${a.id}`}>
          <span className="p0-card-top"><b>{a.label}</b><HealthLight health={a.health} compact /></span>
          <small className="p0-card-reason">{a.health?.reason || '—'}{a.health?.action ? ` · ${a.health.action}` : ''}</small>
          <span className="p0-card-meta">
            <span title="Provider-accepted today / today's target">{a.sentToday}/{a.targetToday ?? '—'} today</span>
            <span>{a.pace?.target != null ? `${a.pace.target}${a.pace.variation ? '±5' : ''}/day` : '—'}</span>
            <span>{a.nextRun ? `next ${whenLabel(a.nextRun.at)}` : 'no run planned'}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

type Pace = { accountId: number; target: number | null; variation: number; min: number; max: number; cap: number; version: number; savedAt: string | null; savedBy: string | null; worker: { min: number; max: number; source: string }; note?: string | null }
// Unsaved drafts survive switching accounts (and polling never touches them).
const paceDrafts = new Map<number, { target: string; variation: number }>()

export function PaceCard({ account, onSaved }: { account: P0Account; onSaved?: () => void }) {
  const [pace, setPace] = useState<Pace | null>(null)
  const [draft, setDraftState] = useState<{ target: string; variation: number }>(() => paceDrafts.get(account.id) || { target: '', variation: 5 })
  const [state, setState] = useState({ busy: false, error: '', conflict: false, note: '' })
  const setDraft = useCallback((d: { target: string; variation: number }) => { paceDrafts.set(account.id, d); setDraftState(d) }, [account.id])
  const load = useCallback(async (replaceDraft: boolean) => {
    const p: Pace = await crmGet(`outreach/pace/${account.id}`)
    setPace(p)
    if (replaceDraft || !paceDrafts.has(account.id)) setDraft({ target: String(p.target ?? 0), variation: p.variation ? 5 : 0 })
  }, [account.id, setDraft])
  useEffect(() => { load(false).catch(e => setState(s => ({ ...s, error: e?.message || 'Could not load the daily pace' }))) }, [load])
  const cap = pace?.cap ?? 40
  const n = Number(draft.target)
  const valid = draft.target !== '' && Number.isInteger(n) && n >= 0 && n <= cap
  const dirty = !!pace && (String(pace.target ?? 0) !== draft.target || (pace.variation ? 5 : 0) !== draft.variation)
  const v = valid && n > 0 ? Math.min(draft.variation, n - 1) : 0
  const lo = valid ? (n === 0 ? 0 : Math.max(1, n - v)) : 0
  const hi = valid ? (n === 0 ? 0 : Math.min(cap, n + v)) : 0
  const save = async () => {
    if (!valid || !pace || !dirty) return
    setState({ busy: true, error: '', conflict: false, note: '' })
    try {
      const r = await crmJson(`outreach/pace/${account.id}`, 'PUT', { target: n, variation: draft.variation, version: pace.version })
      setPace(r); setDraft({ target: String(r.target), variation: r.variation ? 5 : 0 }); paceDrafts.delete(account.id)
      setState({ busy: false, error: '', conflict: false, note: r.note || '' }); onSaved?.()
    } catch (e: any) {
      setState({ busy: false, error: e?.message || 'Save failed', conflict: e?.status === 409, note: '' })
    }
  }
  const savedLabel = pace?.savedAt ? `Saved ${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(pace.savedAt))} · v${pace.version}` : 'Not saved yet'
  return (
    <section className="p0-pace" aria-label={`Daily pace for ${account.label}`} data-testid="pace-card">
      <header>
        <div><small>DAILY PACE · {account.label}</small><h3><span data-testid="pace-value">{valid ? n : '—'}</span> <em>owner contacts / day</em></h3></div>
        <span className={`p0-pace-state${dirty ? ' is-dirty' : ''}`} data-testid="pace-state">{state.busy ? 'Saving…' : dirty ? 'Unsaved changes' : savedLabel}</span>
      </header>
      <div className="p0-pace-controls">
        <input type="range" className="p0-slider" data-testid="pace-slider" min={0} max={cap} step={1} value={valid ? n : (pace?.target ?? 0)}
          aria-label="Daily pace, owner contacts per day" aria-valuetext={valid ? `${n} contacts per day` : 'invalid'}
          onChange={e => { setDraft({ ...draft, target: e.target.value }); setState(s => ({ ...s, error: '', conflict: false, note: '' })) }} />
        <input type="text" inputMode="numeric" className="p0-number" data-testid="pace-number" aria-label="Daily pace number" value={draft.target}
          onChange={e => setDraft({ ...draft, target: e.target.value.replace(/\D/g, '').slice(0, 2) })} onKeyDown={e => { if (e.key === 'Enter') save() }} />
      </div>
      <div className="p0-pace-row">
        <div className="p0-seg" role="radiogroup" aria-label="Planned variation">
          {[0, 5].map(x => <button key={x} type="button" role="radio" aria-checked={draft.variation === x} onClick={() => setDraft({ ...draft, variation: x })}>{x ? '±5' : 'Exact'}</button>)}
        </div>
        <span className="p0-env" data-testid="pace-envelope">
          {!valid ? `Enter a whole number 0–${cap}` : n === 0 ? 'No scheduled outreach' : `Planned ${lo}–${hi} eligible contacts / day`}{valid && n > 0 && n + draft.variation > cap ? ` · max permitted ${cap}` : ''}
        </span>
        <button type="button" className="p0-primary" data-testid="pace-save" disabled={!valid || !dirty || state.busy} onClick={save}>{state.busy ? 'Saving…' : 'Save'}</button>
      </div>
      {pace && <small className="p0-worker" data-testid="pace-worker">Sender reads {pace.worker.min}–{pace.worker.max}/day · hard cap {cap}/day · saving never sends or starts anything</small>}
      {state.note && <p className="p0-note" role="status">{state.note}</p>}
      {state.error && <p className="p0-error" role="alert" data-testid="pace-error">{state.error}{state.conflict && <> <button type="button" onClick={() => { paceDrafts.delete(account.id); setState({ busy: false, error: '', conflict: false, note: '' }); load(true) }}>Load latest</button></>}</p>}
    </section>
  )
}

// Auto ON/OFF and Manual Pause are separate controls.
export function AutoPauseRow({ account, onChanged }: { account: P0Account; onChanged: () => void }) {
  const [busy, setBusy] = useState(''); const [error, setError] = useState('')
  const v2 = !!account.automation?.enabled
  const autoOn = v2 || account.legacyAuto
  const act = async (key: string, fn: () => Promise<any>) => { setBusy(key); setError(''); try { await fn(); onChanged() } catch (e: any) { setError(e?.message || 'Failed') } finally { setBusy('') } }
  const toggleAuto = () => {
    if (!window.confirm(`${autoOn ? 'Turn Auto OFF' : 'Turn Auto ON'} for ${account.label}?`)) return
    act('auto', () => v2 ? crmJson(`outreach/automation/${account.id}/enabled`, 'POST', { enabled: !autoOn }) : crmJson(`outreach/accounts/${account.id}/auto`, 'POST', { enabled: !autoOn }))
  }
  return (
    <div className="p0-autorow" data-testid="auto-row">
      <div className="p0-switch">
        <span>Auto</span>
        <button type="button" role="switch" aria-checked={autoOn} data-testid="auto-switch" disabled={!!busy} onClick={toggleAuto}>{autoOn ? 'ON' : 'OFF'}</button>
        <small>{v2 ? 'automation' : account.legacyAuto ? 'daily planner' : 'manual only'}</small>
      </div>
      <button type="button" data-testid="pause-button" disabled={!!busy} className={account.manualPaused ? 'p0-primary' : ''}
        onClick={() => act('pause', () => crmJson(`outreach/automation/${account.id}/pause`, 'POST', { paused: !account.manualPaused, reason: account.manualPaused ? null : 'Paused from Outreach overview' }))}>
        {account.manualPaused ? 'Resume' : 'Pause'}
      </button>
      <dl>
        <div><dt>Next action</dt><dd>{account.manualPaused ? 'Held — manually paused' : account.nextRun ? `${whenLabel(account.nextRun.at)} Malta` : 'None planned'}</dd></div>
        <div><dt>Last accepted</dt><dd>{account.lastAcceptedAt ? whenLabel(account.lastAcceptedAt) : 'None logged'}</dd></div>
        <div><dt>Sent today</dt><dd>{account.sentToday}</dd></div>
        {account.attention?.length > 0 && <div><dt>Blocked / failed</dt><dd>{account.attention.join(' · ')}</dd></div>}
      </dl>
      {error && <p className="p0-error" role="alert">{error}</p>}
    </div>
  )
}

const DAY_LIGHT: Record<string, Health['color']> = { completed: 'green', partial: 'green', running: 'green', scheduled: 'yellow', planned: 'yellow', preflight: 'yellow', ready: 'yellow', auto_prepared: 'yellow', no_sends: 'red', failed: 'red', attention: 'red', skipped: 'red', suspended: 'red', cancelled: 'gray', off: 'gray', empty: 'gray', paused: 'gray' }
export function dayLight(d: DayCell): Health['color'] {
  if (d.state === 'skipped' && /manual_pause|paused/.test(d.reason || '')) return 'gray'
  return DAY_LIGHT[d.state] || 'gray'
}
export function SevenDays({ days }: { days: DayCell[] }) {
  return (
    <ol className="p0-seven" aria-label="Next seven days" data-testid="seven-days">
      {days.slice(0, 7).map(d => (
        <li key={d.date} className={`is-${dayLight(d)}`} title={`${dayLabel(d)}: ${d.label}${d.reason ? ` — ${d.reason.replace(/_/g, ' ')}` : ''}`}>
          <b>{dayLabel(d)}</b><span className={`p0-dot is-${dayLight(d)}`} aria-hidden />
          <span>{d.label}</span>
          <small>{d.scheduledAt ? hm(d.scheduledAt) : '—'}{d.target != null && d.target !== '' ? ` · ${d.accepted || 0}/${d.target}` : ''}</small>
        </li>
      ))}
    </ol>
  )
}

// Live (approved) introduction for this persona at this Malta moment + drafts awaiting review.
export function PersonaPreview({ persona }: { persona: string | null }) {
  const [live, setLive] = useState<any>(null); const [all, setAll] = useState<any[]>([]); const [i, setI] = useState(0)
  useEffect(() => {
    setI(0)
    if (!persona) return
    crmGet(`outreach/persona-preview/${persona}`).then(setLive).catch(() => setLive(null))
    crmGet(`outreach/persona-templates?persona=${persona}`).then(r => setAll(r.templates || [])).catch(() => setAll([]))
  }, [persona])
  const variants: any[] = live?.variants || []
  const period = live?.period || 'morning'
  const drafts = all.filter(t => t.status === 'draft' && t.period === period)
  const cur = variants.length ? variants[i % variants.length] : null
  return (
    <section className="p0-persona" data-testid="persona-preview">
      <header>
        <div><small>MESSAGE PREVIEW · {live?.period ? `${live.period}, chosen at send time (Malta)` : 'outside sending hours'}</small><h3>{persona || '—'}</h3></div>
        {variants.length > 1 && <button type="button" onClick={() => setI(i + 1)}>Variant {(i % variants.length) + 1} of {variants.length} ›</button>}
      </header>
      {cur ? <div className="p0-wa"><pre data-testid="persona-live">{cur.body}</pre><small>Live · approved{cur.approved_by ? ` by ${cur.approved_by}` : ''} · slot {cur.slot}</small></div>
        : <p className="p0-muted">No approved template for this persona at this time of day.</p>}
      {drafts.length > 0 && <p className="p0-muted" data-testid="persona-drafts">{drafts.length} draft introduction{drafts.length === 1 ? '' : 's'} awaiting review in Templates — drafts are never sent.</p>}
    </section>
  )
}

// Draft editor used inside Templates: edits body only; status is unchanged.
export function DraftEditor({ template, onSaved }: { template: any; onSaved: () => void }) {
  const [body, setBody] = useState<string>(template.body)
  const [state, setState] = useState({ busy: false, error: '', saved: false })
  useEffect(() => { setBody(template.body) }, [template.id, template.body])
  const save = async () => {
    setState({ busy: true, error: '', saved: false })
    try { await crmJson('outreach/persona-templates', 'PUT', { persona: template.persona, period: template.period, slot: template.slot, body, active: template.active !== false }); setState({ busy: false, error: '', saved: true }); onSaved() }
    catch (e: any) { setState({ busy: false, error: e?.message || 'Save failed', saved: false }) }
  }
  return (
    <div className="p0-draft" data-testid={`draft-editor-${template.id}`}>
      <label>{template.period} · slot {template.slot} <small>({template.status})</small></label>
      <textarea rows={9} value={body} onChange={e => setBody(e.target.value)} aria-label={`Edit ${template.persona} ${template.period} slot ${template.slot}`} />
      <div className="p0-draft-row">
        <button type="button" disabled={state.busy || body === template.body} onClick={save}>{state.busy ? 'Saving…' : 'Save draft'}</button>
        {state.saved && <small role="status">Saved — still {template.status}; not sent until approved.</small>}
        {state.error && <small className="p0-error" role="alert">{state.error}</small>}
      </div>
    </div>
  )
}
