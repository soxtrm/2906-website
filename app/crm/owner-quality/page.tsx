'use client'
// ============================================================================
// /crm/owner-quality — ARGUS › Intelligence › Owner Conversation Quality
// (Claude, 2026-11-10, Owner AI recalibration).
// Weekly report generated Monday 08:30 Europe/Malta (or on demand), measured
// from real owner conversations; anonymised cases; founder review with
// Approve / Correct / Block. Admin only (server-side and in the nav). Nothing
// on this page sends a message, changes a template or edits live behaviour:
// approved corrections become regression fixtures for the next release.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CrmProvider, CrmShell, useCrm, useIsMobile, DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, A, F } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

type Sev = 'P0' | 'P1' | 'P2'
type Case = {
  case_id: string; severity: Sev; kind: string; reason: string; at: string; session?: string | null
  inbound_excerpt: string; outbound_excerpt: string; stored_facts: Record<string, unknown>
  actual_action: string; expected_action: string; produced_by: string; secure_chat_ref: string | null
}
type Report = {
  id: string; created_at: string; trigger: string; period_from: string; period_to: string; digest: string
  report: {
    period: { from: string; to: string; timezone: string }
    runtime: { backend_release: string; model_id: string; prompt_hash: string; policy_version: string }
    denominators: Record<string, number>; indicators: Record<string, number>
    previous_period: { indicators: Record<string, number>; denominators: Record<string, number> }
    severity_counts: Record<Sev, number>; cases: Case[]; golden_examples: (Case & { kind: string })[]
    review: Record<string, number>; regression: null | { release: string; policy_version: string; code_hash: string; results: any; created_at: string }
    release_decision: string
  }
  reviews: { case_id: string; decision: string; corrected_action: string | null; corrected_reply: string | null; note: string | null; reviewer: string; created_at: string }[]
}
type ListResp = {
  reports: { id: string; created_at: string; trigger: string; period_from: string; period_to: string; digest: string; severity_counts: Record<Sev, number>; release_decision: string }[]
  schedule: { next_run_at: string; last_run_at: string | null; cron: string; timezone: string } | null
  open_incidents: { id: number; created_at: string; severity: string; kind: string; session: string | null; detail: string | null }[]
}
type Evidence = { id: number; session: string; status: string; reason: string | null; stored_facts: Record<string, unknown>; log: { from: string; text: string; at: string }[]; decisions: any[] }

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'review', label: 'Needs Review' },
  { key: 'golden', label: 'Golden Examples' },
  { key: 'releases', label: 'Releases & Regression' },
] as const
type Tab = typeof TABS[number]['key']

const INDICATORS: { key: string; label: string }[] = [
  { key: 'direct_questions_ignored', label: 'Direct questions ignored' },
  { key: 'false_unavailable', label: 'Wrong availability' },
  { key: 'unnecessary_questions', label: 'Repeated / needless questions' },
  { key: 'residential_permit_questions', label: 'Permit questions to homes' },
  { key: 'room_studio_misinterpretations', label: 'Room / studio mix-ups' },
  { key: 'missed_viewing_offers', label: 'Missed viewing / call offers' },
  { key: 'owner_price_correction_missed', label: 'Price corrections missed' },
  { key: 'media_state_errors', label: 'Media issues' },
  { key: 'forbidden_copy', label: 'Forbidden wording' },
  { key: 'quiet_hours_violations', label: 'Sent outside hours' },
  { key: 'quiet_hours_blocked', label: 'Held for quiet hours' },
  { key: 'dnc_events', label: 'Opt-outs' },
  { key: 'dnc_violations', label: 'Messages after opt-out' },
  { key: 'wrong_agency', label: 'Wrong agency named' },
  { key: 'duplicate_replies', label: 'Duplicate replies' },
  { key: 'human_handoffs', label: 'Human takeovers' },
  { key: 'messages_suppressed', label: 'Messages suppressed' },
]
const SEV_TONE: Record<Sev, { fg: string; bg: string }> = {
  P0: { fg: '#F2597A', bg: 'rgba(242,89,122,0.14)' }, P1: { fg: '#F2A53D', bg: 'rgba(242,165,61,0.14)' }, P2: { fg: '#7EA0FF', bg: 'rgba(79,123,242,0.14)' },
}
const ACTIONS = ['NO_SEND', 'ANSWER_DIRECT', 'ACKNOWLEDGE_UPDATE', 'ASK_SINGLE_MISSING', 'HUMAN_HANDOFF', 'WAIT_FOR_MEDIA', 'DEFER', 'DNC']
const fmt = (d: string | null | undefined) => d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—'
const day = (d: string) => String(d).slice(0, 10)

const ui = {
  card: { background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 16, padding: 16 } as React.CSSProperties,
  label: { fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: DTEXT_DIM, fontWeight: 700 } as React.CSSProperties,
  btn: (tone: 'primary' | 'ghost' | 'danger' | 'ok' = 'ghost', disabled = false): React.CSSProperties => ({
    background: tone === 'primary' ? A : 'transparent', color: tone === 'primary' ? '#fff' : tone === 'danger' ? '#F2597A' : tone === 'ok' ? '#3ECF8E' : DTEXT,
    border: tone === 'primary' ? 'none' : `1px solid ${tone === 'danger' ? 'rgba(242,89,122,0.45)' : tone === 'ok' ? 'rgba(62,207,142,0.45)' : DBORDER}`,
    borderRadius: 9, padding: '7px 12px', fontSize: 12, fontWeight: 700, fontFamily: F, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, minHeight: 40, whiteSpace: 'nowrap' }),
  input: { background: 'var(--crm-raised)', color: DTEXT, border: `1px solid ${DBORDER}`, borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: F, minHeight: 40, boxSizing: 'border-box', width: '100%' } as React.CSSProperties,
  bubble: (bot: boolean): React.CSSProperties => ({ background: bot ? 'rgba(64,86,232,0.14)' : 'var(--crm-raised)', border: `1px solid ${DBORDER}`, borderRadius: 12, padding: '8px 10px', fontSize: 12.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }),
}

function SevBadge({ s }: { s: Sev }) {
  return <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 7px', borderRadius: 999, color: SEV_TONE[s].fg, background: SEV_TONE[s].bg }}>{s}</span>
}

function OwnerQuality() {
  const { me } = useCrm()
  const mobile = useIsMobile()
  const [tab, setTab] = useState<Tab>('overview')
  const [list, setList] = useState<ListResp | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [filter, setFilter] = useState<string>('')
  const [open, setOpen] = useState<Case | null>(null)

  const loadReport = useCallback(async (id: string) => {
    setReport(await crmFetch(`owner-quality/reports/${encodeURIComponent(id)}`))
  }, [])
  const load = useCallback(async () => {
    try {
      const l: ListResp = await crmFetch('owner-quality/reports')
      setList(l)
      if (l.reports[0]) await loadReport(l.reports[0].id)
      setError('')
    } catch (e: any) { setError(e.status === 403 ? 'Admin only.' : e.message) }
  }, [loadReport])
  useEffect(() => { load() }, [load])

  const generate = async () => {
    setBusy('generate')
    try { const r = await crmJson('owner-quality/reports', 'POST', {}); setToast(r.digest); await load() }
    catch (e: any) { setToast(`Could not generate: ${e.message}`) } finally { setBusy('') }
  }

  const reviewed = useMemo(() => Object.fromEntries((report?.reviews || []).map(r => [r.case_id, r])), [report])
  const cases = useMemo(() => (report?.report.cases || []).filter(c => !filter || c.kind === filter), [report, filter])

  if (error) return <CrmShell title="Owner AI Quality" dark><div role="alert" style={{ ...ui.card, margin: 24 }}>{error}</div></CrmShell>
  if (!list) return <CrmShell title="Owner AI Quality" dark><p style={{ color: DTEXT_DIM, padding: 24 }}>Loading quality reports…</p></CrmShell>

  const r = report?.report
  const pending = (r?.cases || []).filter(c => !reviewed[c.case_id]).length
  return (
    <CrmShell title="Owner AI Quality" subtitle="Intelligence · weekly owner-conversation review, measured from real chats" dark>
      <div data-testid="owner-quality" style={{ padding: mobile ? '12px 12px 120px' : '20px 24px 48px', display: 'grid', gap: 14, fontFamily: F, color: DTEXT, maxWidth: 1320 }}>
        {toast && <div role="status" data-testid="toast" style={{ ...ui.card, borderColor: 'rgba(64,86,232,0.5)', display: 'flex', gap: 10, alignItems: 'center' }}><span style={{ flex: 1 }}>{toast}</span><button style={ui.btn()} onClick={() => setToast('')}>Close</button></div>}
        {list.open_incidents.length > 0 && (
          <div role="alert" data-testid="incidents" style={{ ...ui.card, borderColor: 'rgba(242,89,122,0.5)', display: 'grid', gap: 6 }}>
            <b style={{ color: '#F2597A' }}>{list.open_incidents.length} open P0 incident{list.open_incidents.length === 1 ? '' : 's'} — not waiting for Monday</b>
            {list.open_incidents.slice(0, 5).map(i => (
              <div key={i.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
                <span style={{ flex: 1, minWidth: 200 }}>{fmt(i.created_at)} · {i.kind.replace(/_/g, ' ')}{i.session ? ` · ${i.session}` : ''} — {i.detail}</span>
                <button style={ui.btn('ok', !!busy)} disabled={!!busy} onClick={async () => { setBusy(`inc${i.id}`); try { await crmJson(`owner-quality/incidents/${i.id}/resolve`, 'POST', {}); await load() } finally { setBusy('') } }}>Mark resolved</button>
              </div>
            ))}
          </div>
        )}

        <section style={{ ...ui.card, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 240, display: 'grid', gap: 4 }}>
            <span style={ui.label}>Weekly report</span>
            {report ? <b data-testid="digest" style={{ fontSize: 14 }}>{report.digest}</b> : <b>No report yet — generate the first one.</b>}
            <span style={{ fontSize: 12, color: DTEXT_DIM }} data-testid="schedule">
              Automatic: every Monday 08:30 Malta · next {fmt(list.schedule?.next_run_at)}{list.schedule?.last_run_at ? ` · last ${fmt(list.schedule.last_run_at)}` : ''}
            </span>
          </div>
          {list.reports.length > 1 && (
            <select aria-label="Report" style={{ ...ui.input, width: 'auto' }} value={report?.id || ''} onChange={e => loadReport(e.target.value)}>
              {list.reports.map(x => <option key={x.id} value={x.id}>{day(x.period_from)} – {day(x.period_to)} · {x.trigger} · {fmt(x.created_at)}</option>)}
            </select>
          )}
          <button data-testid="generate" style={ui.btn('primary', !!busy)} disabled={!!busy} onClick={generate}>{busy === 'generate' ? 'Generating…' : 'Generate now'}</button>
          {report && <a data-testid="export" href={`/api/crm/owner-quality/reports/${report.id}/export`} style={{ ...ui.btn(), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Export anonymised report</a>}
        </section>

        <div role="tablist" style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
          {TABS.map(t => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} data-testid={`tab-${t.key}`} onClick={() => setTab(t.key)}
              style={{ ...ui.btn(tab === t.key ? 'primary' : 'ghost'), borderRadius: 999 }}>
              {t.label}{t.key === 'review' && r ? ` · ${pending}` : ''}
            </button>
          ))}
        </div>

        {r && tab === 'overview' && (
          <div style={{ display: 'grid', gap: 14 }}>
            <section style={{ ...ui.card, display: 'grid', gap: 10 }}>
              <span style={ui.label}>{day(r.period.from)} – {day(r.period.to)} · {r.period.timezone} · compared with the previous 7 days</span>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }} data-testid="denominators">
                <span><b>{r.denominators.conversations}</b> conversations</span>
                <span><b>{r.denominators.eligible_owner_inbound_bursts}</b> owner messages</span>
                <span><b>{r.denominators.auto_replies}</b> automated replies</span>
                <span><b>{r.denominators.decision_layer_turns}</b> decision-layer turns</span>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><SevBadge s="P0" /> {r.severity_counts.P0} <SevBadge s="P1" /> {r.severity_counts.P1} <SevBadge s="P2" /> {r.severity_counts.P2}</span>
                <span>Release decision: <b data-testid="release-decision">{r.release_decision.replace(/_/g, ' ')}</b></span>
              </div>
            </section>
            <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, minmax(0,1fr))' : 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }} data-testid="kpis">
              {INDICATORS.map(k => {
                const v = r.indicators[k.key] ?? 0
                const prev = r.previous_period?.indicators?.[k.key] ?? 0
                const canFilter = (r.cases || []).some(c => c.kind === k.key)
                return (
                  <button key={k.key} data-testid={`kpi-${k.key}`} disabled={!canFilter} onClick={() => { setFilter(k.key); setTab('review') }}
                    style={{ ...ui.card, padding: 12, textAlign: 'left', cursor: canFilter ? 'pointer' : 'default', color: DTEXT, display: 'grid', gap: 2, fontFamily: F }}>
                    <span style={{ fontSize: 11, color: DTEXT_DIM }}>{k.label}</span>
                    <b style={{ fontSize: 22 }}>{v}</b>
                    <span style={{ fontSize: 10.5, color: v > prev ? '#F2A53D' : v < prev ? '#3ECF8E' : DTEXT_FAINT }}>prev. 7 days: {prev}</span>
                  </button>
                )
              })}
            </div>
            <p style={{ fontSize: 12, color: DTEXT_DIM, margin: 0 }}>Counts come from stored conversations and the decision audit only. A KPI opens the matching cases.</p>
          </div>
        )}

        {r && tab === 'review' && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select aria-label="Filter cases" data-testid="case-filter" style={{ ...ui.input, width: 'auto' }} value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="">All cases ({r.cases.length})</option>
                {INDICATORS.filter(k => r.cases.some(c => c.kind === k.key)).map(k => <option key={k.key} value={k.key}>{k.label} ({r.cases.filter(c => c.kind === k.key).length})</option>)}
              </select>
              <span style={{ fontSize: 12, color: DTEXT_DIM }}>{pending} awaiting review · approved corrections become regression fixtures for the next release</span>
            </div>
            {!cases.length && <div style={ui.card}>No cases in this view.</div>}
            {cases.map(c => <CaseCard key={c.case_id} c={c} rv={reviewed[c.case_id]} onOpen={() => setOpen(c)} />)}
          </div>
        )}

        {r && tab === 'golden' && (
          <div style={{ display: 'grid', gap: 10 }} data-testid="golden">
            <p style={{ fontSize: 12, color: DTEXT_DIM, margin: 0 }}>The 20 most useful anonymised examples this week: the worst mistakes (BAD) and replies that did the right thing (GOOD). No phone numbers or addresses.</p>
            {r.golden_examples.map(g => (
              <section key={g.case_id} style={{ ...ui.card, display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ color: g.kind.startsWith('BAD') ? '#F2597A' : '#3ECF8E' }}>{g.kind.startsWith('BAD') ? 'BAD' : 'GOOD'}</b>
                  <span style={{ fontSize: 12, color: DTEXT_DIM }}>{g.kind.replace(/^BAD:/, '').replace(/_/g, ' ')} · {g.case_id} · {fmt(g.at)}</span>
                </div>
                {g.inbound_excerpt && <div style={ui.bubble(false)}>{g.inbound_excerpt}</div>}
                {g.outbound_excerpt && <div style={ui.bubble(true)}>{g.outbound_excerpt}</div>}
                {g.expected_action && <span style={{ fontSize: 12 }}>Correct action: <b>{g.expected_action}</b>{reviewed[g.case_id] ? ` · reviewed: ${reviewed[g.case_id].decision}` : ''}</span>}
              </section>
            ))}
          </div>
        )}

        {r && tab === 'releases' && (
          <div style={{ display: 'grid', gap: 10 }} data-testid="releases">
            <section style={{ ...ui.card, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 12.5 }}>
              <span style={{ color: DTEXT_DIM }}>Deployed release</span><b>{r.runtime.backend_release}</b>
              <span style={{ color: DTEXT_DIM }}>Policy version</span><span>{r.runtime.policy_version}</span>
              <span style={{ color: DTEXT_DIM }}>Decision code hash</span><code>{r.runtime.prompt_hash}</code>
              <span style={{ color: DTEXT_DIM }}>Model</span><span>{r.runtime.model_id}</span>
              <span style={{ color: DTEXT_DIM }}>Release decision</span><b>{r.release_decision.replace(/_/g, ' ')}</b>
            </section>
            <section style={{ ...ui.card, display: 'grid', gap: 8 }}>
              <span style={ui.label}>Latest regression run</span>
              {!r.regression && <span>No regression run recorded.</span>}
              {r.regression && (
                <>
                  <span style={{ fontSize: 12, color: DTEXT_DIM }}>{r.regression.release} · {fmt(r.regression.created_at)} · code {r.regression.code_hash}</span>
                  <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(2, minmax(0,1fr))', gap: 8 }}>
                    {Object.entries(r.regression.results || {}).map(([k, v]: [string, any]) => (
                      <div key={k} style={{ border: `1px solid ${DBORDER}`, borderRadius: 12, padding: 10, display: 'grid', gap: 2 }}>
                        <span style={{ fontSize: 12, color: DTEXT_DIM }}>{v.label || k}</span>
                        <b style={{ fontSize: 18, color: v.failed ? '#F2597A' : '#3ECF8E' }}>{v.passed}/{v.total}</b>
                        {v.note && <span style={{ fontSize: 11, color: DTEXT_FAINT }}>{v.note}</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            <p style={{ fontSize: 12, color: DTEXT_DIM, margin: 0 }}>A new policy reaches running accounts only through a verified release that replays every suite above. Reviews here never edit live behaviour.</p>
          </div>
        )}
      </div>
      {open && report && <CaseDrawer c={open} report={report} rv={reviewed[open.case_id]} mobile={mobile} onClose={() => setOpen(null)}
        onSaved={async (msg) => { setToast(msg); await loadReport(report.id) }} />}
    </CrmShell>
  )
}

function CaseCard({ c, rv, onOpen }: { c: Case; rv?: Report['reviews'][number]; onOpen: () => void }) {
  return (
    <button data-testid={`case-${c.case_id}`} onClick={onOpen} style={{ ...ui.card, textAlign: 'left', display: 'grid', gap: 6, color: DTEXT, cursor: 'pointer', fontFamily: F }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <SevBadge s={c.severity} />
        <b style={{ fontSize: 13 }}>{c.reason}</b>
        <span style={{ fontSize: 11.5, color: DTEXT_DIM }}>{fmt(c.at)}{c.session ? ` · ${c.session}` : ''}</span>
        {rv && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, color: rv.decision === 'block' ? '#F2597A' : '#3ECF8E' }}>{rv.decision.toUpperCase()}</span>}
      </div>
      {c.inbound_excerpt && <div style={{ fontSize: 12.5, color: DTEXT_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Owner: {c.inbound_excerpt}</div>}
      <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Bot: {c.outbound_excerpt}</div>
    </button>
  )
}

function CaseDrawer({ c, report, rv, mobile, onClose, onSaved }: { c: Case; report: Report; rv?: Report['reviews'][number]; mobile: boolean; onClose: () => void; onSaved: (m: string) => void }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [evErr, setEvErr] = useState('')
  const [action, setAction] = useState(c.expected_action.split('/')[0] && ACTIONS.includes(c.expected_action.split('/')[0]) ? c.expected_action.split('/')[0] : 'HUMAN_HANDOFF')
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const convId = c.secure_chat_ref ? c.secure_chat_ref.split(':')[1] : null

  const save = async (decision: 'approve' | 'correct' | 'block') => {
    setBusy(true)
    try {
      await crmJson(`owner-quality/reports/${report.id}/cases/${encodeURIComponent(c.case_id)}/review`, 'POST', {
        decision, correctedAction: decision === 'correct' ? `${action}` : null, correctedReply: decision === 'correct' && reply.trim() ? reply.trim() : null, note: note.trim() || null,
      })
      onSaved(decision === 'block' ? 'Blocked: this case will not become a fixture.' : 'Saved — added as a regression fixture candidate for the next release.')
      onClose()
    } catch (e: any) { onSaved(`Could not save: ${e.message}`) } finally { setBusy(false) }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Case evidence" data-testid="case-drawer"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: mobile ? '100%' : 560, maxWidth: '100%', height: '100%', overflowY: 'auto', background: 'var(--crm-bg)', borderLeft: `1px solid ${DBORDER}`, padding: mobile ? '14px 12px 120px' : 20, display: 'grid', gap: 12, alignContent: 'start', fontFamily: F, color: DTEXT, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SevBadge s={c.severity} /><b style={{ flex: 1 }}>{c.case_id}</b>
          <button style={ui.btn()} onClick={onClose} aria-label="Close">Close</button>
        </div>
        <section style={{ ...ui.card, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 12.5 }} data-testid="drawer-facts">
          <span style={{ color: DTEXT_DIM }}>What the owner said</span><span>{c.inbound_excerpt || '—'}</span>
          <span style={{ color: DTEXT_DIM }}>What was sent</span><span>{c.outbound_excerpt}</span>
          <span style={{ color: DTEXT_DIM }}>What data was stored</span><span>{Object.keys(c.stored_facts || {}).length ? Object.entries(c.stored_facts).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') : '—'}</span>
          <span style={{ color: DTEXT_DIM }}>Which rule failed</span><span>{c.reason}</span>
          <span style={{ color: DTEXT_DIM }}>Correct action</span><b>{c.expected_action}</b>
          <span style={{ color: DTEXT_DIM }}>Produced by</span><span>{c.produced_by}</span>
          <span style={{ color: DTEXT_DIM }}>When / account</span><span>{fmt(c.at)}{c.session ? ` · ${c.session}` : ''}</span>
        </section>
        {convId && !evidence && (
          <button style={ui.btn()} onClick={async () => { try { setEvidence(await crmFetch(`owner-quality/conversations/${convId}`)) } catch (e: any) { setEvErr(e.message) } }}>Open full evidence (admin only)</button>
        )}
        {evErr && <div role="alert" style={{ color: '#F2597A', fontSize: 12 }}>{evErr}</div>}
        {evidence && (
          <section style={{ ...ui.card, display: 'grid', gap: 6 }} data-testid="evidence">
            <span style={ui.label}>Conversation #{evidence.id} · {evidence.session} · {evidence.status}{evidence.reason ? ` · ${evidence.reason}` : ''}</span>
            {evidence.log.map((e, i) => <div key={i} style={{ ...ui.bubble(e.from === 'bot'), justifySelf: e.from === 'bot' ? 'end' : 'start', maxWidth: '88%' }}><span style={{ fontSize: 10.5, color: DTEXT_FAINT }}>{e.from} · {fmt(e.at)}</span><br />{e.text}</div>)}
            {evidence.decisions.length > 0 && <span style={{ fontSize: 12, color: DTEXT_DIM }}>Decision audit: {evidence.decisions.map(d => `${d.next_action}/${d.reason_code}${d.sent ? ' (sent)' : ''}`).join(' · ')}</span>}
          </section>
        )}
        <section style={{ ...ui.card, display: 'grid', gap: 8 }}>
          <span style={ui.label}>Founder review</span>
          {rv && <span style={{ fontSize: 12 }}>Last review: <b>{rv.decision}</b> by {rv.reviewer} · {fmt(rv.created_at)}{rv.corrected_action ? ` · ${rv.corrected_action}` : ''}</span>}
          <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: DTEXT_DIM }}>Correct action</span>
            <select aria-label="Correct action" style={ui.input} value={action} onChange={e => setAction(e.target.value)}>{ACTIONS.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: DTEXT_DIM }}>Correct reply (optional — leave empty if no message should be sent)</span>
            <textarea aria-label="Correct reply" rows={3} style={{ ...ui.input, resize: 'vertical' }} value={reply} onChange={e => setReply(e.target.value)} /></label>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: DTEXT_DIM }}>Note</span>
            <input aria-label="Note" style={ui.input} value={note} onChange={e => setNote(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button data-testid="approve" style={ui.btn('ok', busy)} disabled={busy} onClick={() => save('approve')}>Approve expected action</button>
            <button data-testid="correct" style={ui.btn('primary', busy)} disabled={busy} onClick={() => save('correct')}>Save correction</button>
            <button data-testid="block" style={ui.btn('danger', busy)} disabled={busy} onClick={() => save('block')}>Block (not a mistake)</button>
          </div>
          <span style={{ fontSize: 11.5, color: DTEXT_FAINT }}>Saving never sends anything and never changes live replies.</span>
        </section>
      </div>
    </div>
  )
}

export default function Page() {
  return <CrmProvider><OwnerQuality /></CrmProvider>
}
