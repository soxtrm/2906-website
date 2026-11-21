'use client'
// Safe Drafts review, Reminder Due results and inbox decisions (Kev, 2026-11-21, P0).
// Safe Drafts: one pool per persona (Kevin, Gabriela, Cedric) and intent. Kev's
// pack texts arrive as "pending review" and are never sent until approved here.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { crmGet, crmJson } from '@/lib/crm/api'

type Draft = {
  id: number; persona: string; number: number; body: string; active: boolean; source: string; used: number
  code: string | null; intent: string; required_context: string[]; review_status: 'approved' | 'pending_review' | 'rejected'
}
const PERSONAS: [string, string][] = [['kev', 'Kevin'], ['gabriela', 'Gabriela'], ['cedric', 'Cedric']]
const INTENTS: [string, string][] = [
  ['new_owner_general', 'New owner · general'], ['new_owner_rental', 'New owner · rental'], ['new_owner_sales', 'New owner · sales'],
  ['existing_relationship_checkin', 'Existing relationship'], ['owner_requested_callback', 'Owner asked for a callback'],
  ['upcoming_property_followup', 'Upcoming property'], ['specific_property_availability', 'Specific property availability'],
  ['multiple_property_confirmation', 'Several properties'], ['missing_property_details', 'Missing details'], ['verified_client_matching', 'Client match'],
]
const STATUS: Record<string, string> = { approved: 'Approved', pending_review: 'Waiting for review', rejected: 'Rejected' }
const USED_BY: Record<string, string> = {
  new_owner_general: 'Auto outreach (first contact)', owner_requested_callback: 'Reminder Due, 09:00', upcoming_property_followup: 'Reminder Due, 09:00',
}

function preview(body: string) {
  return body.replace(/\{\{greeting\}\}/g, 'Good afternoon').replace(/\{\{opening\}\}/g, 'Good afternoon, ')
}

export function SafeDrafts() {
  const [persona, setPersona] = useState('kev')
  const [intent, setIntent] = useState('owner_requested_callback')
  const [rows, setRows] = useState<Draft[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<{ id: number | null; body: string } | null>(null)
  const load = useCallback(async () => {
    try { setRows((await crmGet(`outreach/library?persona=${persona}`)).templates); setError('') } catch (e: any) { setError(e?.message || 'Safe Drafts unavailable') }
  }, [persona])
  useEffect(() => { load() }, [load])
  const counts = useMemo(() => {
    const c: Record<string, { approved: number; pending: number }> = {}
    for (const r of rows || []) { const k = r.intent; c[k] = c[k] || { approved: 0, pending: 0 }; if (r.review_status === 'approved' && r.active) c[k].approved++; if (r.review_status === 'pending_review') c[k].pending++ }
    return c
  }, [rows])
  const shown = (rows || []).filter(r => r.intent === intent)
  async function review(ids: number[], status: string) {
    if (!ids.length) return
    setBusy(true)
    try { await crmJson('outreach/library/review', 'POST', { ids, status }); await load() } catch (e: any) { setError(e?.message || 'Not saved') } finally { setBusy(false) }
  }
  async function save() {
    if (!edit) return
    try { await crmJson('outreach/library', 'POST', { id: edit.id, persona, body: edit.body }); setEdit(null); await load() }
    catch (e: any) { setError(e?.message === 'greeting_not_allowed' ? 'Leave the greeting out — use {{greeting}} or {{opening}}; it is filled in when the message is sent.' : e?.message || 'Not saved') }
  }
  const pendingHere = shown.filter(r => r.review_status === 'pending_review').map(r => r.id)
  return (
    <section className="msg-library" aria-label="Safe Drafts">
      <header>
        <div>
          <h3>Safe Drafts</h3>
          <p>Every automatic message is one of these texts, unchanged — picked at random per owner, never the same text twice to one owner. {'{{greeting}}'} and {'{{opening}}'} become “Good morning / afternoon / evening” at the moment of sending; the other {'{{…}}'} fields come from the owner’s recorded request. A text is only used once it is approved.</p>
        </div>
        <div className="msg-library-tabs" role="group" aria-label="Persona">
          {PERSONAS.map(([k, label]) => <button key={k} type="button" aria-pressed={persona === k} onClick={() => { setPersona(k); setEdit(null) }}>{label}</button>)}
        </div>
      </header>
      <div className="sd-intents" role="tablist" aria-label="Intent">
        {INTENTS.map(([k, label]) => {
          const c = counts[k] || { approved: 0, pending: 0 }
          return <button key={k} type="button" role="tab" aria-selected={intent === k} onClick={() => { setIntent(k); setEdit(null) }}>
            <b>{label}</b><small>{c.approved} approved{c.pending ? ` · ${c.pending} to review` : ''}{USED_BY[k] ? ` · ${USED_BY[k]}` : ''}</small>
          </button>
        })}
      </div>
      {error && <p className="msg-library-error" role="alert">{error}</p>}
      <div className="msg-library-bar">
        <span>{shown.length} texts · {shown.filter(r => r.review_status === 'approved' && r.active).length} in use</span>
        <span style={{ display: 'flex', gap: 6 }}>
          {pendingHere.length > 0 && <button type="button" disabled={busy} onClick={() => review(pendingHere, 'approved')}>Approve all {pendingHere.length} waiting</button>}
          <button type="button" onClick={() => setEdit({ id: null, body: '' })}>Add a text</button>
        </span>
      </div>
      {edit && (
        <div className="msg-library-edit">
          <textarea value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} rows={9} aria-label="Safe Draft text" placeholder={'{{opening}}I hope you are well.\n\n…\n\nSignature'} />
          <div><button type="button" onClick={save}>Save text</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      <ol className="msg-library-list">
        {shown.map(t => (
          <li key={t.id} className={`${t.active && t.review_status !== 'rejected' ? '' : 'is-off'} is-${t.review_status}`}>
            <div className="msg-library-meta">
              <b>{t.code ? t.code.replace(/^ARGUS-[A-Z]+-/, '') : `#${t.number}`}</b>
              <small>{STATUS[t.review_status]}{t.source === 'kev_pack_v1_1' ? ' · your pack' : t.source === 'kev_draft' ? ' · your Saved Draft' : ''} · sent {t.used}×</small>
              <span>
                {t.review_status !== 'approved' && <button type="button" disabled={busy} onClick={() => review([t.id], 'approved')}>Approve</button>}
                {t.review_status !== 'rejected' && <button type="button" disabled={busy} onClick={() => review([t.id], 'rejected')}>Reject</button>}
                <button type="button" onClick={() => setEdit({ id: t.id, body: t.body })}>Edit</button>
              </span>
            </div>
            {t.required_context?.length > 0 && <small className="sd-context">Needs: {t.required_context.join(', ').replace(/_/g, ' ')}</small>}
            <p>{preview(t.body)}</p>
          </li>
        ))}
      </ol>
      {!shown.length && rows && <p className="auto-empty">No texts for this intent yet.</p>}
    </section>
  )
}

// ── Reminder Due texts: checked automatically, no approval round ──────────
// Kev, 2026-11-21 ("must run autonomously"): the run checks every callback / upcoming
// text itself (persona, own signature, sender exists, placeholders, no invented facts,
// greeting made at send time, purpose) and uses the ones that pass. A failing text is
// held with the exact reason; the rest of its group keeps sending. Kev can still stop a text.
type VText = Draft & { validation: { ok: boolean; problems: string[]; at: string } | null; reviewed_by: string | null; sent: number }
type VGroup = { persona: string; intent: string; sendable: number; held: number; rejected: number }
const EXAMPLE: Record<string, string> = {
  agreed_followup_time_phrase: 'at the end of November', followup_subject: 'the 2-Bedroom Apartment in Sliema', upcoming_property_label: 'the 3-Bedroom Apartment in Gżira',
}
function asSent(body: string) {
  return body.replace(/\{\{greeting\}\}/g, 'Good morning').replace(/\{\{opening\}\}/g, 'Good morning, ').replace(/\{\{([a-z_]+)\}\}/g, (m, k) => EXAMPLE[k] || m)
    .replace(/^(Good morning, )([A-Z])([a-z])/, (m, a, c, n) => `${a}${c.toLowerCase()}${n}`)
}
const GROUP_INTENTS: [string, string][] = [['owner_requested_callback', 'Owner asked for a callback'], ['upcoming_property_followup', 'Upcoming property']]
const PROBLEM: Record<string, string> = {
  missing_own_signature: 'not signed with the persona’s own name', foreign_persona_signature: 'signs as another persona', contains_numbers: 'contains a number (only the owner’s details may)',
  mentions_price: 'mentions a price', mentions_property_type: 'names a property type outside the owner’s details', claims_a_client: 'claims a client', claims_a_viewing_or_deal: 'claims a viewing or deal',
  greeting_not_generated_at_send_time: 'greeting is not made at sending time', unresolved_placeholder_text: 'unfilled placeholder text', no_paragraphs: 'no paragraphs', too_short: 'too short', too_long: 'too long',
}
const problemText = (p: string) => PROBLEM[p] || (p.startsWith('no_verified_sender_for:') ? `no active ${p.split(':')[1]} WhatsApp account` : p.replace(/[:_]/g, ' '))

export function ActivateReminderDue({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<{ templates: VText[]; groups: VGroup[] } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = useCallback(async () => { setData(await crmGet('outreach/reminder-daily/templates')) }, [])
  useEffect(() => { load().catch(e => setMsg(e?.message || 'Could not load the texts')) }, [load])
  if (!data) return msg ? <p className="msg-library-error">{msg}</p> : null
  const total = data.templates.length
  const sendable = data.templates.filter(t => t.active && t.review_status === 'approved').length
  const held = data.templates.filter(t => t.review_status === 'pending_review')
  async function stop(id: number) {
    setBusy(true); setMsg('')
    try { await crmJson('outreach/library/review', 'POST', { ids: [id], status: 'rejected' }); setMsg('Text stopped — it will not be sent again. The other texts of its group carry on.'); await load(); onChanged?.() }
    catch (e: any) { setMsg(e?.message || 'Not changed') } finally { setBusy(false) }
  }
  return (
    <section className="rd-activate" aria-label="Reminder Due texts">
      <header>
        <div>
          <h3>Reminder Due texts · {sendable} of {total} in use · checked automatically</h3>
          <p>No approval round. Before every run ARGUS checks each text: right persona and its own signature, an active sending account for that persona, only the owner’s own details as placeholders (no invented price, property, client or viewing), greeting made at the moment of sending, and that it reads as a callback or an upcoming-property follow-up. Texts that pass are used; a text that fails is held with the reason and the others of its group carry on. You can still stop any text.</p>
        </div>
      </header>
      {msg && <p className="rd-msg" role="status">{msg}</p>}
      {held.length > 0 && <p className="rd-msg" style={{ color: '#ffb86b' }}>{held.length} held: {held.map(t => `${t.code?.replace(/^ARGUS-/, '') || `#${t.number}`} (${(t.validation?.problems || ['not checked yet']).map(problemText).join(', ')})`).join(' · ')}</p>}
      <div className="rd-groups">
        {PERSONAS.flatMap(([p, pl]) => GROUP_INTENTS.map(([i, il]) => {
          const key = `${p}:${i}`
          const g = data.groups.find(x => x.persona === p && x.intent === i) || { sendable: 0, held: 0, rejected: 0 }
          const list = data.templates.filter(t => t.persona === p && t.intent === i)
          return (
            <div key={key} className={`rd-group${g.sendable ? ' is-ready' : ' is-bad'}`}>
              <div className="rd-group-head">
                <b>{pl} · {il}</b>
                <small>{g.sendable} in use{g.held ? ` · ${g.held} held` : ''}{g.rejected ? ` · ${g.rejected} stopped` : ''} · {list.reduce((n, t) => n + (t.sent || 0), 0)} sent so far</small>
                <span><button type="button" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>{open === key ? 'Hide texts' : `Show ${list.length} texts`}</button></span>
              </div>
              {open === key && <ol className="rd-previews">{list.map(t => (
                <li key={t.id}>
                  <small>{t.code?.replace(/^ARGUS-[A-Z]+-/, '') || `#${t.number}`} · {t.review_status === 'rejected' || !t.active ? 'stopped' : t.review_status === 'approved' ? (t.validation?.ok ? 'passed the check · in use' : 'in use') : `held — ${(t.validation?.problems || ['not checked yet']).map(problemText).join(', ')}`}{t.sent ? ` · sent ${t.sent}×` : ''}</small>
                  <p>{asSent(t.body)}</p>
                  {t.review_status === 'approved' && t.active && <button type="button" className="rd-stop" disabled={busy} onClick={() => stop(t.id)}>Stop using this text</button>}
                </li>))}
              </ol>}
            </div>
          )
        }))}
      </div>
    </section>
  )
}

// ── Reminder Due operations: what ARGUS did by itself, and what needs a person ──
type Mon = {
  today: string; enabled: boolean; nextRun: string; nextRunDate: string; dueToday: number
  days: ({ date: string } & Record<string, number | string>)[]; suppressed: { reason: string; n: number }[]; rescheduled: number
  exceptions: { id: number; date: string; state: string; reason: string | null; session_name: string; owner_name: string | null; phone_last4: string }[]
  attention: { id: number; session: string; phone_last4: string; text: string; disposition: string; action: string; created_at: string }[]
}
const SUPPRESSED: Record<string, string> = {
  another_reminder_for_this_owner_today: 'owner already gets a message today', automatic_reply_not_an_owner_request: 'note was an automatic reply', not_a_follow_up_request: 'note is not a follow-up request',
  owner_gate: 'contact rule (opt-out, pause, person active)', blocked: 'blocked (not an owner / opted out)', paused_by_hand: 'paused by a person', held_back: 'held back by the reply guard',
  property_available_now_needs_agent: 'property available now — for an agent', listing_advert_not_an_owner_request: 'listing advert, not an owner request', no_verified_sender: 'no verified sending account',
  sender_account_inactive: 'sending account inactive', reminder_contacted: 'already contacted', no_owner_phone: 'no phone number',
}
export function ReminderOperations() {
  const [m, setM] = useState<Mon | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { const f = () => crmGet('outreach/reminder-daily/monitor').then(setM).catch((e: any) => setErr(e?.message || 'Operations unavailable')); f(); const t = setInterval(f, 60_000); return () => clearInterval(t) }, [])
  if (err) return <p className="msg-library-error">{err}</p>
  if (!m) return null
  const sum = (k: string) => m.days.reduce((n, d) => n + (Number(d[k]) || 0), 0)
  const next = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(m.nextRun))
  return (
    <section className="rd-panel rd-ops" aria-label="Reminder Due operations">
      <header><div>
        <h3>Reminder Due · runs by itself {m.enabled ? '' : '(switched off)'}</h3>
        <p>Every Monday–Saturday at 09:00 ARGUS sends the callbacks owners asked for and the upcoming-property follow-ups, from the account the owner spoke to, with a checked text and the greeting of that moment. Every contact rule is checked again at the moment of sending. Old reminders are released a few per day. Only the exceptions below need you.</p>
      </div></header>
      <div className="rd-summary">
        <span><b>{next}</b>Next run</span>
        <span><b>{m.dueToday}</b>Due today</span>
        <span className="is-sent"><b>{sum('sent')}</b>Sent · 7 days</span>
        <span className="is-failed"><b>{sum('failed') + sum('ambiguous')}</b>Failed / check</span>
        <span className="is-waiting"><b>{m.rescheduled}</b>Rescheduled</span>
        <span><b>{sum('skipped')}</b>Suppressed</span>
        <span className="is-waiting"><b>{m.attention.length}</b>Replies for you</span>
      </div>
      {m.suppressed.length > 0 && <p className="rd-upcoming">Suppressed, last 7 days: {m.suppressed.map(s => `${SUPPRESSED[s.reason] || s.reason.replace(/_/g, ' ')} ${s.n}`).join(' · ')}</p>}
      {m.exceptions.length > 0 && <ol className="rd-rows">{m.exceptions.map(x => <li key={x.id} className={`is-${x.state}`}><div className="rd-line"><span className="rd-state">{x.state === 'ambiguous' ? 'Check chat' : 'Failed'}</span><span className="rd-who"><b>{x.owner_name || 'Owner'} ·{x.phone_last4} · {x.session_name}</b><small>{x.date} · {String(x.reason || '').replace(/[:_]/g, ' ')}</small></span></div></li>)}</ol>}
      {m.attention.length > 0 && <>
        <p className="rd-upcoming">Owner replies that need a person (kept unread in WhatsApp):</p>
        <ol className="rd-rows">{m.attention.map(a => <li key={a.id} className="is-waiting"><div className="rd-line"><span className="rd-state">{a.disposition.replace(/_/g, ' ')}</span><span className="rd-who"><b>“{a.text}”</b><small>{a.session} ·{a.phone_last4} · {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(a.created_at))}</small></span></div></li>)}</ol>
      </>}
      {!m.exceptions.length && !m.attention.length && <p className="auto-empty">Nothing needs you right now.</p>}
    </section>
  )
}

// ── Reminder Due: what the 09:00 run did ───────────────────────────────────
type RRow = { id: number; reminder_id: number; state: string; reason: string | null; intent: string | null; session_name: string | null; planned_at: string | null; sent_at: string | null; rendered_text: string | null; owner_name: string | null; phone_last4: string; due: string; original_note: string; template_code: string | null }
const RSTATE: Record<string, string> = { planned: 'Planned', sending: 'Sending', sent: 'Sent', skipped: 'Not sent', waiting: 'Waiting', failed: 'Failed', ambiguous: 'Check by hand' }
const REASON: Record<string, string> = {
  automatic_reply_not_an_owner_request: 'the note is an automatic reply, not an owner request', not_a_follow_up_request: 'the note is not a request to follow up',
  another_reminder_for_this_owner_today: 'this owner already gets one message today', friend_not_owner: 'not an owner', permanent_owner_stop: 'owner asked to stop',
  worker_restarted_during_send: 'the server restarted while sending — check the chat before sending again',
}
const reasonText = (r: string | null) => {
  if (!r) return ''
  if (REASON[r]) return REASON[r]
  if (r.startsWith('no_approved_template:')) { const [, intent, persona] = r.split(':'); return `no usable ${intent.replace(/_/g, ' ')} text for ${persona === 'kev' ? 'Kevin' : persona} — see Reminder Due texts` }
  if (r.startsWith('held_back:')) return 'held back by the reply guard — not sent'
  if (r === 'property_available_now_needs_agent') return 'property is available now — for an agent, not a follow-up text'
  if (r === 'listing_advert_not_an_owner_request') return 'the note is a listing advert, not an owner request'
  if (r.startsWith('owner_contacted_within_')) return 'owner was contacted in the last 4 days'
  if (r.startsWith('owner_gate:')) return `blocked: ${r.slice(11).replace(/_/g, ' ')}`
  if (r.startsWith('sender_offline')) return `${r.split(':')[1] || 'sending account'} offline${r.endsWith('retrying') ? ' — retrying' : ''}`
  return r.replace(/[:_]/g, ' ')
}
const hm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '')

export function ReminderDuePanel() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date())
  const [date, setDate] = useState(today)
  const [data, setData] = useState<{ date: string; since: string | null; enabled: boolean; summary: Record<string, number>; rows: RRow[]; upcoming: { due: string; n: number }[] } | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const load = useCallback(async () => {
    try { setData(await crmGet(`outreach/reminder-daily?date=${date}`)); setError('') } catch (e: any) { setError(e?.message || 'Reminder run unavailable') }
  }, [date])
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t) }, [load])
  return (
    <section className="rd-panel" aria-label="Reminder Due">
      <header>
        <div>
          <h3>Reminder Due · automatic</h3>
          <p>Every morning at 09:00 (Mon–Sat) ARGUS follows up the owners whose agreed date has arrived — from the account they talked to, with an approved Safe Draft, one message per owner, opt-outs, pauses and a 4-day cooldown respected.{data?.since ? ` Reminders due before ${data.since} are not sent automatically.` : ''}</p>
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value || today)} aria-label="Run date" />
      </header>
      {error && <p className="msg-library-error" role="alert">{error}</p>}
      {data && <>
        <div className="rd-summary">
          {(['sent', 'planned', 'waiting', 'skipped', 'failed', 'ambiguous'] as const).map(k => <span key={k} className={`is-${k}`}><b>{data.summary[k] || 0}</b>{RSTATE[k]}</span>)}
          {!data.enabled && <span className="is-failed"><b>off</b>kill switch REMINDER_DAILY=0</span>}
        </div>
        <ol className="rd-rows">
          {data.rows.map(r => (
            <li key={r.id} className={`is-${r.state}`}>
              <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                <span className="rd-state">{RSTATE[r.state] || r.state}</span>
                <span className="rd-who"><b>{r.owner_name || 'Owner'} ·{r.phone_last4}</b><small>due {r.due}{r.session_name ? ` · via ${r.session_name}` : ''}{r.sent_at ? ` · sent ${hm(r.sent_at)}` : r.planned_at && r.state === 'planned' ? ` · at ${hm(r.planned_at)}` : ''}</small></span>
                <span className="rd-reason">{r.state === 'sent' ? (r.template_code || '').replace(/^ARGUS-/, '') : reasonText(r.reason)}</span>
              </button>
              {open === r.id && <div className="rd-detail">
                <p><small>Owner said</small>{r.original_note}</p>
                {r.rendered_text && <p><small>{r.state === 'sent' ? 'Sent' : 'Text'}</small>{r.rendered_text}</p>}
              </div>}
            </li>
          ))}
        </ol>
        {!data.rows.length && <p className="auto-empty">No reminder was due on {data.date}{data.date === today ? ' (the run is at 09:00, Mon–Sat)' : ''}.</p>}
        {data.upcoming.length > 0 && <p className="rd-upcoming">Due next: {data.upcoming.slice(0, 7).map(u => `${u.due.slice(5)} · ${u.n}`).join('   ')}</p>}
      </>}
    </section>
  )
}

// ── Inbox: which owner replies were marked read, and why ───────────────────
type IRow = { id: number; session: string; phone_last4: string; text: string; disposition: string; action: string; detail: any; created_at: string }
const ACTION: Record<string, string> = { marked_read: 'Marked read', kept_visible: 'Left unread', kept_no_preceding_question: 'Left unread · we had not asked', kept_newer_message: 'Left unread · newer message', kept_callback_not_recorded: 'Left unread · callback not saved', kept_opt_out_not_recorded: 'Left unread · stop not saved' }
export function InboxDecisions() {
  const [rows, setRows] = useState<IRow[] | null>(null)
  useEffect(() => { crmGet('outreach/inbox-dispositions?limit=40').then(r => setRows(r.rows)).catch(() => setRows([])) }, [])
  if (!rows) return null
  return (
    <section className="rd-panel" aria-label="Inbox decisions">
      <header><div><h3>Inbox · owner replies</h3><p>A plain “no” to our question is processed and marked read; a callback date is saved first; “stop” is recorded first; anything with a new property, a question or details stays unread. Nothing is deleted.</p></div></header>
      <ol className="rd-rows">
        {rows.map(r => (
          <li key={r.id} className={r.action === 'marked_read' ? 'is-sent' : 'is-waiting'}>
            <div className="rd-line">
              <span className="rd-state">{ACTION[r.action] || r.action}</span>
              <span className="rd-who"><b>“{r.text}”</b><small>{r.session} ·{r.phone_last4} · {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(r.created_at))}{r.detail?.reminderId ? ` · callback saved (due ${r.detail.due})` : ''}{r.detail?.cancelledReminders?.length ? ` · ${r.detail.cancelledReminders.length} reminder(s) cancelled` : ''}{r.action === 'marked_read' ? (r.detail?.seen?.api === 'accepted' ? ' · read receipt accepted by WhatsApp API (phone state not observable)' : r.detail?.seen?.api === 'error' ? ' · read receipt FAILED' : ' · read receipt sent') : ''}</small></span>
            </div>
          </li>
        ))}
      </ol>
      {!rows.length && <p className="auto-empty">No owner reply has been handled yet.</p>}
    </section>
  )
}


// ── Next 09:00 run (dry run, nothing is written or sent) ────────────────────
type PRow = { id: number; owner_name: string | null; phone_last4: string; due: string; parsed_timing: string | null; note: string; source_session: string; state: string; reason: string | null; intent: string | null; session: string | null; approx: boolean }
export function NextRunPreview() {
  const [data, setData] = useState<{ date: string | null; skippedRun: string | null; planned: PRow[]; waiting: PRow[]; skipped: PRow[]; backlog?: { limit: number; released: { reminderId: number; category: string; wasDue: string }[]; redated?: { reminderId: number; from: string; to: string; phrase: string }[]; remaining: number } | null } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { crmGet('outreach/reminder-daily/preview').then(setData).catch((e: any) => setError(e?.message || 'Preview unavailable')) }, [])
  if (error) return <p className="msg-library-error">{error}</p>
  if (!data) return null
  const all = [...data.planned, ...data.waiting, ...data.skipped]
  return (
    <section className="rd-panel" aria-label="Next reminder run">
      <header><div>
        <h3>Next run · {data.date ? new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(`${data.date}T12:00:00Z`)) : '—'} 09:00</h3>
        <p>A dry run of exactly what the 09:00 job will do with today’s data: who gets a message, who waits and why, who is left out and why. Nothing is written or sent by this preview. A month the owner named stays a month (“approx.”) — no day is invented.</p>
      </div></header>
      <div className="rd-summary">
        <span className="is-sent"><b>{data.planned.length}</b>Will be sent</span>
        <span className="is-waiting"><b>{data.waiting.length}</b>Waiting</span>
        <span><b>{data.skipped.length}</b>Left out</span>
      </div>
      {data.backlog && <p className="rd-upcoming">From the old reminders: {data.backlog.released.length} released into this run (callbacks first, at most {data.backlog.limit} a day and 3 per account; originally due {data.backlog.released.map(x => x.wasDue).join(', ') || '—'}) · {data.backlog.remaining} still queued{data.backlog.redated?.length ? ` · ${data.backlog.redated.length} saved date${data.backlog.redated.length === 1 ? '' : 's'} corrected to the owner’s own (${data.backlog.redated.map(x => x.phrase).join(', ')})` : ''}.</p>}
      <ol className="rd-rows">
        {all.map(r => (
          <li key={r.id} className={`is-${r.state}`}><div className="rd-line">
            <span className="rd-state">{RSTATE[r.state] || r.state}</span>
            <span className="rd-who"><b>{r.owner_name || 'Owner'} ·{r.phone_last4} — {r.state === 'planned' ? `via ${r.session}` : reasonText(r.reason)}</b>
              <small>due {r.parsed_timing && r.approx ? `${r.parsed_timing} (approx.)` : r.due} · {r.note}</small></span>
          </div></li>
        ))}
      </ol>
      {!all.length && <p className="auto-empty">No reminder falls due for the next run.</p>}
    </section>
  )
}

// ── Inactive reminders: why, and which could be reviewed (read-only) ────────
type Cat = { key: string; label: string; count: number; safeToReview: number; sample: { id: number; owner: string | null; phoneLast4: string; due: string; timing: string | null; note: string; status: string; safe: boolean }[] }
export function ReminderBacklog() {
  const [data, setData] = useState<{ total: number; overdue: number; paused: number; safeToReview: number; since: string; categories: Cat[] } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { crmGet('outreach/reminder-backlog').then(setData).catch(() => setData(null)) }, [])
  if (!data) return null
  return (
    <section className="rd-panel" aria-label="Inactive reminders">
      <header><div>
        <h3>Inactive reminders · {data.total}</h3>
        <p>{data.overdue} were due before the automatic start ({data.since}) and {data.paused} are paused since 1 Nov. None of them is sent automatically. Each is sorted into one reason; <b>{data.safeToReview}</b> look safe to review for reactivation (an owner request the run understands, owner reachable, not contacted since, due in the last 90 days). Reviewing changes nothing by itself.</p>
      </div></header>
      <ol className="rd-rows">
        {data.categories.map(c => (
          <li key={c.key} className={c.safeToReview ? 'is-sent' : 'is-skipped'}>
            <button type="button" onClick={() => setOpen(open === c.key ? null : c.key)} aria-expanded={open === c.key}>
              <span className="rd-state">{c.count}</span>
              <span className="rd-who"><b>{c.label}</b><small>{c.safeToReview ? `${c.safeToReview} safe to review` : 'not for reactivation'}</small></span>
              <span className="rd-reason">{open === c.key ? 'Hide examples' : 'Show examples'}</span>
            </button>
            {open === c.key && <div className="rd-detail">{c.sample.map(s => <p key={s.id}><small>#{s.id} · {s.owner || 'Owner'} ·{s.phoneLast4} · due {s.timing && !/\d/.test(s.timing) ? `${s.timing} (approx.)` : s.due}</small>{s.note}</p>)}</div>}
          </li>
        ))}
      </ol>
    </section>
  )
}

// ── Reply guard: automated messages that were held back ─────────────────────
type GRow = { id: number; session: string; chat_last4: string; module: string; reason: string; text: string; created_at: string }
const GREASON: Record<string, string> = { owner_turn_final: 'owner’s answer needed no reply', already_replied_this_turn: 'this owner message was already answered' }
export function ReplyGuardLog() {
  const [rows, setRows] = useState<GRow[] | null>(null)
  useEffect(() => { crmGet('outreach/reply-guard').then(r => setRows(r.rows)).catch(() => setRows([])) }, [])
  if (!rows) return null
  return (
    <section className="rd-panel" aria-label="Held back replies">
      <header><div><h3>Held back · second bot replies</h3><p>One owner message gets at most one automated reply, and none when the owner’s answer needs nothing (“nothing available”, “I’ll let you know”, a date, “stop”, “thanks”). Messages you write yourself are never held back.</p></div></header>
      <ol className="rd-rows">
        {rows.map(r => <li key={r.id} className="is-skipped"><div className="rd-line">
          <span className="rd-state">{r.module}</span>
          <span className="rd-who"><b>“{r.text}”</b><small>{r.session} ·{r.chat_last4} · {GREASON[r.reason] || r.reason} · {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(r.created_at))}</small></span>
        </div></li>)}
      </ol>
      {!rows.length && <p className="auto-empty">Nothing held back yet.</p>}
    </section>
  )
}
