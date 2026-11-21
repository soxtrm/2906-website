'use client'
// Auto Outreach status + message library (Kev, 2026-11-21, P0).
// The status reads GET outreach/accounts/:id/auto-status: one state with its
// reason and next step, the batch range, last success, next run, and per day
// the real queue numbers (selected → eligible → queued → accepted → delivered,
// failed, skipped with reasons). Never a generic "Paused".
import { useCallback, useEffect, useState } from 'react'
import { crmGet, crmJson } from '@/lib/crm/api'

type DayRow = {
  planId: number; date: string; status: string; armed: boolean; scheduledAt: string | null
  display: { state: string; label: string }; holdReason: string | null
  batch: { min: number | null; max: number | null; target: number | null }
  counts: { selected: number; eligible: number; queued: number; accepted: number; delivered: number; failed: number; skipped: number }
  skipReasons: Record<string, number>; messageMode: string
}
export type AutoStatus = {
  generatedAt: string; session: string; healthy: boolean
  auto: { enabled: boolean; rolling: boolean; state: string; label: string; reason: string; next: string | null }
  batch: { base: number; variation: number; min: number; max: number; hardCap: number }
  lastSuccess: { day: string; at: string | null; accepted: number } | null
  nextRun: { at: string; target: number | null; queued: number } | null
  quotaToday: { used: number; cap: number; remaining: number } | null
  days: DayRow[]
}

const TZ = 'Europe/Malta'
const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
const hm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—')
const dayName = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00Z`))
const REASON: Record<string, string> = {
  do_not_contact: 'opted out', same_account_cooldown: 'recently contacted', over_batch_limit: 'over batch limit',
  final_check_do_not_contact: 'opted out', reserved_elsewhere_at_arm: 'on another list', daily_cap_reached: 'daily cap',
}
const reasonText = (r: string) => REASON[r] || r.replace(/^final_check_|^ineligible_at_send: ?/, '').replace(/[:_]/g, ' ')

export function useAutoStatus(accountId: number, tick = 0) {
  const [data, setData] = useState<AutoStatus | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setData(await crmGet(`outreach/accounts/${accountId}/auto-status`)); setError('') }
    catch (e: any) { setError(e?.message || 'Auto status unavailable') }
  }, [accountId])
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t) }, [load, tick])
  return { data, error, reload: load }
}

export function AutoStatusPanel({ data, error }: { data: AutoStatus | null; error: string }) {
  if (error && !data) return <div className="auto-status is-unknown" role="status"><b>Auto status unavailable</b><span>{error}</span></div>
  if (!data) return null
  const a = data.auto
  return (
    <section className={`auto-status is-${a.state}`} aria-label="Auto outreach status">
      <header>
        <span className="auto-state">{a.label}</span>
        <p>{a.reason}{a.next ? <><br /><b>Next:</b> {a.next}</> : null}</p>
      </header>
      <dl className="auto-facts">
        <div><dt>Batch per day</dt><dd>{data.batch.min}–{data.batch.max}<small>{data.batch.base}{data.batch.variation ? ` ±${data.batch.variation}` : ''} · cap {data.batch.hardCap}</small></dd></div>
        <div><dt>Next run</dt><dd>{data.nextRun ? when(data.nextRun.at) : '—'}<small>{data.nextRun ? `${data.nextRun.queued} owners queued` : 'nothing scheduled'}</small></dd></div>
        <div><dt>Last success</dt><dd>{data.lastSuccess?.at ? when(data.lastSuccess.at) : '—'}<small>{data.lastSuccess ? `${data.lastSuccess.accepted} accepted` : ''}</small></dd></div>
        <div><dt>Today</dt><dd>{data.quotaToday ? `${data.quotaToday.used}/${data.quotaToday.cap}` : '—'}<small>owners contacted</small></dd></div>
      </dl>
      <div className="auto-days" role="table" aria-label="Next five days">
        <div role="row" className="auto-days-head">
          <span role="columnheader">Day</span><span role="columnheader">Status</span>
          <span role="columnheader" title="Owners on the day's list">Selected</span>
          <span role="columnheader" title="Reserved for this run, not sent yet">Queued</span>
          <span role="columnheader" title="Accepted by WhatsApp">Sent</span>
          <span role="columnheader" title="Delivery receipt recorded">Delivered</span>
          <span role="columnheader">Failed</span><span role="columnheader">Skipped</span>
        </div>
        {data.days.map(d => (
          <div role="row" key={d.planId} className={`auto-day is-${d.display.state}`}>
            <span role="cell"><b>{dayName(d.date)}</b><small>{hm(d.scheduledAt)}{d.batch.max ? ` · ${d.batch.min}–${d.batch.max}` : ''}</small></span>
            <span role="cell" className="auto-day-label">{d.display.label}</span>
            <span role="cell">{d.counts.eligible}{d.counts.selected !== d.counts.eligible ? <small> of {d.counts.selected}</small> : null}</span>
            <span role="cell">{d.counts.queued}</span>
            <span role="cell">{d.counts.accepted}</span>
            <span role="cell">{d.counts.delivered}</span>
            <span role="cell">{d.counts.failed}</span>
            <span role="cell" title={Object.entries(d.skipReasons).map(([r, n]) => `${n} × ${reasonText(r)}`).join('\n')}>
              {d.counts.skipped}{d.counts.skipped ? <small> {Object.entries(d.skipReasons).slice(0, 2).map(([r, n]) => `${n} ${reasonText(r)}`).join(', ')}</small> : null}
            </span>
          </div>
        ))}
        {!data.days.length && <p className="auto-empty">No day is prepared yet.</p>}
      </div>
    </section>
  )
}

// ── Message library ──────────────────────────────────────────────────────────
type LibText = { id: number; persona: string; number: number; body: string; active: boolean; source: string; used: number; last_used_at: string | null }
const PERSONAS: [string, string][] = [['kev', 'Kevin'], ['gabriela', 'Gabriela'], ['cedric', 'Cedric']]

export function MessageLibrary() {
  const [persona, setPersona] = useState('kev')
  const [rows, setRows] = useState<LibText[] | null>(null)
  const [edit, setEdit] = useState<{ id: number | null; body: string } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setRows((await crmGet(`outreach/library?persona=${persona}`)).templates); setError('') } catch (e: any) { setError(e?.message || 'Library unavailable') }
  }, [persona])
  useEffect(() => { load() }, [load])
  async function save() {
    if (!edit) return
    try { await crmJson('outreach/library', 'POST', { id: edit.id, persona, body: edit.body }); setEdit(null); await load() }
    catch (e: any) { setError(e?.message === 'greeting_not_allowed' ? 'Leave the greeting out: it is added when the message is sent (Good morning / afternoon / evening).' : e?.message || 'Not saved') }
  }
  async function toggle(t: LibText) {
    try { await crmJson(`outreach/library/${t.id}/active`, 'POST', { active: !t.active }); await load() } catch (e: any) { setError(e?.message || 'Not changed') }
  }
  const active = rows?.filter(r => r.active).length ?? 0
  return (
    <section className="msg-library" aria-label="Message library">
      <header>
        <div>
          <h3>Message library</h3>
          <p>Auto picks one of these texts at random for every owner and never sends the same text to the same owner twice. The greeting is added at the moment of sending, from the owner&apos;s local time. Nothing is rewritten by AI.</p>
        </div>
        <div className="msg-library-tabs" role="group" aria-label="Persona">
          {PERSONAS.map(([k, label]) => <button key={k} type="button" aria-pressed={persona === k} onClick={() => { setPersona(k); setEdit(null) }}>{label}</button>)}
        </div>
      </header>
      {error && <p className="msg-library-error" role="alert">{error}</p>}
      <div className="msg-library-bar"><span>{active} active of {rows?.length ?? '…'}</span><button type="button" onClick={() => setEdit({ id: null, body: '' })}>Add a text</button></div>
      {edit && (
        <div className="msg-library-edit">
          <textarea value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} rows={9} aria-label="Library text" placeholder={"I hope you're well.\n\n…\n\nSignature"} />
          <div><button type="button" onClick={save}>Save text</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      <ol className="msg-library-list">
        {(rows || []).map(t => (
          <li key={t.id} className={t.active ? '' : 'is-off'}>
            <div className="msg-library-meta">
              <b>#{t.number}</b><small>{t.source === 'kev_draft' ? 'from your Saved Drafts' : t.source === 'edited' ? 'edited' : t.source === 'added' ? 'added' : 'written for you'} · sent {t.used}×</small>
              <span>
                <button type="button" onClick={() => setEdit({ id: t.id, body: t.body })}>Edit</button>
                <button type="button" onClick={() => toggle(t)} aria-pressed={t.active}>{t.active ? 'On' : 'Off'}</button>
              </span>
            </div>
            <p><em>Good afternoon, </em>{t.body.replace(/^Hope/, 'hope')}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
