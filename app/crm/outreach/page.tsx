'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { crmGet, crmJson } from '@/lib/crm/api'
import { CrmProvider, useCrm } from '@/lib/crm/ui'

// ── ARGUS / NEON design tokens ───────────────────────────────────────────────
const BG = '#07070a'
const PANEL = '#0d0d12'
const PANEL2 = '#111116'
const EDITOR = '#0a0a0d'
const HAIRLINE = 'rgba(255,255,255,0.08)'
const TEXT = '#EDEDF2'
const MUTED = '#8A8A99'
const FAINT = '#55555f'
const F = "'Bricolage Grotesque', 'Inter', system-ui, sans-serif"
const FM = "'JetBrains Mono', 'SF Mono', monospace"

// Deterministic per-account accent palette (spec point 32 — never random,
// never changes after refresh; assigned by stable DB order).
const ACCENTS = [
  { name: 'magenta', a: '#e0389f', b: '#7a1054', glow: 'rgba(224,56,159,0.28)', soft: 'rgba(224,56,159,0.12)' },
  { name: 'amber', a: '#f2a53d', b: '#8a4a06', glow: 'rgba(242,165,61,0.26)', soft: 'rgba(242,165,61,0.12)' },
  { name: 'cyan', a: '#35d6c4', b: '#0d6b62', glow: 'rgba(53,214,196,0.26)', soft: 'rgba(53,214,196,0.12)' },
  { name: 'cobalt', a: '#4f7bf2', b: '#1c2f8a', glow: 'rgba(79,123,242,0.28)', soft: 'rgba(79,123,242,0.12)' },
  { name: 'violet', a: '#9d6ef2', b: '#4a1d8a', glow: 'rgba(157,110,242,0.26)', soft: 'rgba(157,110,242,0.12)' },
  { name: 'emerald', a: '#3ecf8e', b: '#0f6b45', glow: 'rgba(62,207,142,0.24)', soft: 'rgba(62,207,142,0.12)' },
  { name: 'rose', a: '#f2597a', b: '#8a1030', glow: 'rgba(242,89,122,0.26)', soft: 'rgba(242,89,122,0.12)' },
  { name: 'lime', a: '#b9d94a', b: '#5a6b10', glow: 'rgba(185,217,74,0.22)', soft: 'rgba(185,217,74,0.12)' },
]
function accentFor(index: number) { return ACCENTS[index % ACCENTS.length] }

type Account = { id: number; sessionName: string; phone: string; label: string; connected: boolean; lastOutreachAt: string | null }
type Template = { id: number; label: string; text: string; created_at: string }
type Entry = {
  id: number; normalized_phone: string; display_name: string | null
  classification: string | null; eligibility_status: string; skip_reason: string | null
  send_status: string; sent_at: string | null
}
type Plan = {
  id: number; account_id: number; session_name: string; scheduled_date: string
  scheduled_at: string | null; status: string; armed: boolean; message_template: string | null
  label: 'TODAY' | 'TOMORROW' | 'IN_2_DAYS' | string
  stats: { total: number; eligible: number; hot: number; cold: number; skip: number; sent: number }
  entries?: Entry[]
}

function useMaltaClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: '2-digit', month: 'short' }).format(now)
  return { time, date }
}

function maltaHM(d: Date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

// Kev, 2026-09-11: "checkt wann der letzte !outreach gemacht wurde und
// versucht immer auto +30min zu setzen" — the PRIMARY suggestion is always
// +30min from the real last send for this account (from outreach_log —
// covers a manual !outreach typed straight into WhatsApp too, not just
// ARGUS's own plans). Only falls back to chaining off a previous ARGUS day
// (+20min, spec point 19) when there's no real send history at all yet.
function suggestTime(plans: Plan[] | null, label: string, lastOutreachAt: string | null): string {
  if (lastOutreachAt) {
    return maltaHM(new Date(new Date(lastOutreachAt).getTime() + 30 * 60_000))
  }
  const order = ['TODAY', 'TOMORROW', 'IN_2_DAYS']
  const idx = order.indexOf(label)
  if (idx > 0 && plans) {
    const prev = plans.find(p => p.label === order[idx - 1])
    if (prev?.scheduled_at) return maltaHM(new Date(new Date(prev.scheduled_at).getTime() + 20 * 60_000))
  }
  return '14:15'
}

// ── AUTO button: per-account "what I used last time" memory ─────────────────
// Kev, 2026-09-12: "die Presettings übernimmt (textwise und anzahl)... die
// letzte Nachricht die im Vortag gesettet wurde... dann ist es beim nächsten
// mal das was beim letzten mal war, das ist ja auch JE account unterschiedlich."
// No backend field for this (CLAUDE.md: never touch backend from here) —
// localStorage, keyed per account, is the whole store. Written every time a
// list is actually generated (AUTO or the manual Create List button), so
// "last time" means exactly that regardless of which path set it.
function lastUsedKey(accountId: number) { return `outreach_last_used_${accountId}` }
function loadLastUsed(accountId: number): { text: string; count: number } | null {
  try {
    const raw = localStorage.getItem(lastUsedKey(accountId))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveLastUsed(accountId: number, v: { text: string; count: number }) {
  try { localStorage.setItem(lastUsedKey(accountId), JSON.stringify(v)) } catch { /* ignore */ }
}
// First-ever AUTO click for an account (no memory yet) — Kev, 2026-09-12:
// "Cedric & Default können 40+ und die anderen beiden besser unter 40 weils
// keine business accs sind."
function defaultSeedCount(account: Account) {
  // "Default" is a display label ("Kev Primary") over the technical
  // session_name ("default") — match both so the real default account
  // qualifies, not just whichever one is literally labelled "Default".
  const l = (account.label + ' ' + account.sessionName).toLowerCase()
  return l.includes('cedric') || l.includes('default') ? 40 : 35
}

function dayLabelText(l: string) {
  if (l === 'TODAY') return 'TODAY'
  if (l === 'TOMORROW') return 'TOMORROW'
  if (l === 'IN_2_DAYS') return 'IN 2 DAYS'
  return l
}

export default function OutreachPlannerPage() {
  return <CrmProvider><ArgusConsole /></CrmProvider>
}

function ArgusConsole() {
  const { me } = useCrm()
  const clock = useMaltaClock()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState('')
  const [duplicates, setDuplicates] = useState<any[]>([])
  const [summary, setSummary] = useState<any>(null)
  // Templates are a global library (spec follow-up: "Saved Drafts" button) —
  // lifted here, not per-console, so saving one in DEFAULT's card makes it
  // immediately available in every other account's card too.
  const [templates, setTemplates] = useState<Template[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const [accRes, sumRes] = await Promise.all([
        crmGet('outreach/accounts'),
        crmGet('outreach/today-summary').catch(() => null),
      ])
      setAccounts(accRes.accounts)
      setSummary(sumRes)
      setError('')
    } catch (e: any) {
      setError(e?.message || 'Failed to load accounts')
    }
  }, [])

  const loadTemplates = useCallback(async () => {
    try { const r = await crmGet('outreach/templates'); setTemplates(r.templates || []) } catch { /* ignore */ }
  }, [])

  useEffect(() => { load(); loadTemplates() }, [load, loadTemplates])

  async function checkDuplicates() {
    try {
      const r = await crmGet('outreach/duplicates')
      setDuplicates(r.conflicts || [])
    } catch { /* ignore */ }
  }

  const connectedCount = accounts?.filter(a => a.connected).length ?? 0

  if (me && me.role !== 'admin') {
    return (
      <div style={{ minHeight: '100vh', background: BG, color: TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
        Admins only.
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse 1200px 600px at 20% -10%, rgba(224,56,159,0.06), transparent), radial-gradient(ellipse 1000px 500px at 90% 0%, rgba(79,123,242,0.06), transparent), ${BG}`, color: TEXT, fontFamily: F, paddingBottom: 60 }}>
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{ padding: '22px 24px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, borderBottom: `1px solid ${HAIRLINE}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a href="/" style={{ color: FAINT, fontSize: 11, textDecoration: 'none', marginRight: 4 }}>← CRM</a>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/argus-logo.png" alt="ARGUS / NEON" style={{ height: 40, width: 'auto', display: 'block' }} />
          <div style={{ marginLeft: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Outreach Planner</div>
            <div style={{ fontSize: 11, color: MUTED }}>Plan · Schedule · Execute · Audit</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ background: PANEL, border: `1px solid ${HAIRLINE}`, borderRadius: 12, padding: '8px 14px' }}>
            <div style={{ fontSize: 9, color: FAINT, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Connected Accounts</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              {(accounts || []).map((a, i) => (
                <span key={a.id} title={a.sessionName} style={{ width: 8, height: 8, borderRadius: '50%', background: a.connected ? accentFor(i).a : 'transparent', border: `1px solid ${a.connected ? accentFor(i).a : FAINT}`, boxShadow: a.connected ? `0 0 6px ${accentFor(i).glow}` : 'none' }} />
              ))}
              <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 6 }}>{connectedCount} / {accounts?.length ?? 0} connected</span>
            </div>
          </div>
          <div style={{ background: PANEL, border: `1px solid ${HAIRLINE}`, borderRadius: 12, padding: '8px 14px', textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: FAINT, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Europe/Malta</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: FM }}>{clock.time} <span style={{ fontSize: 10, color: MUTED, fontFamily: F }}>{clock.date}</span></div>
          </div>
        </div>
      </div>

      {error && <div style={{ padding: '10px 24px', color: '#f2597a', fontSize: 12 }}>{error}</div>}
      {!accounts && !error && <div style={{ padding: 24, color: MUTED, fontSize: 12 }}>Loading…</div>}

      {/* ── PROFILE CONSOLES — horizontal scroll ──────────────────────── */}
      {accounts && (
        <div ref={scrollerRef} style={{ display: 'flex', gap: 18, overflowX: 'auto', padding: '20px 24px', scrollSnapType: 'x proximity', WebkitOverflowScrolling: 'touch' }}>
          {accounts.map((acc, i) => (
            <ProfileConsole key={acc.id} account={acc} accent={accentFor(i)} onChanged={load} templates={templates} onTemplatesChanged={loadTemplates} />
          ))}
        </div>
      )}

      {/* ── GLOBAL PANELS ──────────────────────────────────────────────── */}
      <div style={{ padding: '4px 24px', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', background: PANEL, border: `1px solid ${HAIRLINE}`, borderRadius: 16, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Today Contacted</div>
            <span style={{ fontSize: 11, color: MUTED }}>Unique owners: {summary?.unique_owners ?? '—'} · Duplicate sends: {summary ? Math.max(0, (summary.total_sends || 0) - (summary.unique_owners || 0)) : '—'}</span>
          </div>
          {(summary?.perAccount || []).length === 0 && <div style={{ fontSize: 12, color: FAINT }}>Nothing sent today yet.</div>}
          {(summary?.perAccount || []).map((row: any, i: number) => (
            <div key={row.session_name} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${HAIRLINE}`, fontSize: 12.5 }}>
              <span style={{ color: accountsColor(accounts || [], row.session_name) }}>{row.session_name.toUpperCase()}</span>
              <span style={{ fontWeight: 700 }}>{row.n}</span>
            </div>
          ))}
        </div>

        <div style={{ flex: '1 1 280px', background: PANEL, border: `1px solid ${HAIRLINE}`, borderRadius: 16, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Duplicate Audit</div>
            <button onClick={checkDuplicates} style={btnGhost}>Check Duplicates</button>
          </div>
          {duplicates.length === 0
            ? <div style={{ fontSize: 12, color: '#3ecf8e' }}>✓ No active cross-account conflicts</div>
            : duplicates.map((d: any) => (
              <div key={d.normalized_phone} style={{ fontSize: 12, padding: '6px 0', borderBottom: `1px solid ${HAIRLINE}` }}>
                <div style={{ color: '#f2a53d', fontWeight: 700 }}>+{d.normalized_phone}</div>
                <div style={{ color: MUTED, fontSize: 11 }}>{d.plans.map((p: any) => `${p.session_name} · ${p.scheduled_date}`).join('  vs  ')}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function accountsColor(accounts: Account[], sessionName: string) {
  const idx = accounts.findIndex(a => a.sessionName === sessionName)
  return idx >= 0 ? accentFor(idx).a : MUTED
}

const btnGhost: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${HAIRLINE}`, color: TEXT, borderRadius: 8,
  padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: F, fontWeight: 600,
}

// ── ONE profile console ──────────────────────────────────────────────────────
function ProfileConsole({ account, accent, onChanged, templates, onTemplatesChanged }: {
  account: Account; accent: typeof ACCENTS[0]; onChanged: () => void
  templates: Template[]; onTemplatesChanged: () => void
}) {
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [plans, setPlans] = useState<Plan[] | null>(null)
  // Kev, 2026-09-11: defaults to TODAY, not TOMORROW — "ich hab kb für
  // morgen alles auszufüllen und dann zu merken dass es für den falschen
  // tag ist" (filling in the wrong day by accident because it opened on
  // tomorrow by default).
  const [activeLabel, setActiveLabel] = useState<'TODAY' | 'TOMORROW' | 'IN_2_DAYS'>('TODAY')
  const [queueText, setQueueText] = useState('')
  const [msgOpen, setMsgOpen] = useState(false)
  const [msgDraft, setMsgDraft] = useState('')
  const [count, setCount] = useState(40)
  const [armTime, setArmTime] = useState('14:15')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const loadPlans = useCallback(async () => {
    const r = await crmGet(`outreach/plans?accountId=${account.id}`)
    setPlans(r.plans)
  }, [account.id])

  useEffect(() => { loadPlans() }, [loadPlans])

  const activePlan = plans?.find(p => p.label === activeLabel) || null

  // Kev, 2026-09-11 (real bug: "sieht man die Liste aber nicht" — Create
  // List updated the STATS but never the textarea, because this effect only
  // re-fetches entries when activePlan.id CHANGES, and generating/topping-up
  // never changes the id (same plan, more rows) — so nothing re-triggered
  // it, and only a full page reload ever showed the new numbers. Split out
  // as its own function so every action that can change entries (generate,
  // top up, clear) can force a reload immediately, not just tab-switching.
  const loadEntries = useCallback(async (planId: number) => {
    const r = await crmGet(`outreach/plans/${planId}`)
    setQueueText((r.plan.entries || []).map((e: Entry) => `+${e.normalized_phone}${e.display_name ? ' ' + e.display_name : ''}`).join('\n'))
  }, [])

  useEffect(() => {
    if (!activePlan) return
    setMsgDraft(activePlan.message_template || '')
    // Kev, 2026-09-11 (real bug: "die Zeit hängt am ersten" — editing
    // TOMORROW's time then switching tabs kept showing that same value on
    // TODAY/IN 2 DAYS) — armTime is ONE shared field for the whole console,
    // so it must be explicitly RESET on every tab switch, unconditionally,
    // never left over from whichever tab was open before. A plan with no
    // scheduled_at yet gets a suggested time instead of a stale leftover —
    // +20min from the previous day's own time when that's armed (spec
    // point 19's auto-suggest), otherwise a plain default.
    setArmTime(activePlan.scheduled_at ? maltaHM(new Date(activePlan.scheduled_at)) : suggestTime(plans, activeLabel, account.lastOutreachAt))
    loadEntries(activePlan.id)
  }, [activePlan?.id])

  async function refresh(alsoReloadEntriesForPlanId?: number) {
    await loadPlans()
    if (alsoReloadEntriesForPlanId) await loadEntries(alsoReloadEntriesForPlanId)
    onChanged()
  }

  async function savePastedList() {
    if (!activePlan) return
    setBusy(true); setNote('')
    try {
      await crmJson(`outreach/plans/${activePlan.id}/paste`, 'POST', { text: queueText })
      await refresh(activePlan.id)
      setNote('Saved.')
    } catch (e: any) { setNote(e?.message || 'Failed to save') } finally { setBusy(false) }
  }

  // topUp=false ("Create List"): generates a fresh batch of `count` eligible
  // owners via the SAME engine the real !createlist WhatsApp command uses
  // (services/listBuilder.js:buildPoolBatch — not a separate/fake frontend
  // generator). topUp=true ("Top Up"): keeps everyone already in the queue
  // and only fetches as many ADDITIONAL eligible owners as needed to reach
  // `count` total, never duplicating what's already there.
  async function generate(topUp = false, overrideCount?: number) {
    if (!activePlan) return
    const n = overrideCount ?? count
    setBusy(true); setNote('')
    try {
      const r = await crmJson(`outreach/plans/${activePlan.id}/generate`, 'POST', { count: n, topUp })
      await refresh(activePlan.id)
      saveLastUsed(account.id, { text: msgDraft, count: n })
      setNote(`${r.added} added${r.need && r.added < r.need ? ` (only ${r.added}/${r.need} eligible found)` : ''}.`)
    } catch (e: any) { setNote(e?.message || 'Failed to generate') } finally { setBusy(false) }
  }

  async function clearList() {
    if (!activePlan) return
    setBusy(true)
    try { await crmJson(`outreach/plans/${activePlan.id}/clear`, 'POST', {}); setQueueText(''); await refresh(activePlan.id) }
    finally { setBusy(false) }
  }

  async function saveMessage(overrideText?: string) {
    if (!activePlan) return
    const text = overrideText ?? msgDraft
    await crmJson(`outreach/plans/${activePlan.id}/message`, 'POST', { text })
    setMsgOpen(false)
    await refresh()
  }

  // Kev, 2026-09-12: one click for the non-custom day. Reuses this account's
  // last-used text+count (or a sane first-time default), regenerates the
  // list and saves the message — then, when there's an earlier day-tab in
  // this 3-day window, nudges the arm time to +15min after it ("zeit +15min
  // zum vortag automatisch"). Everything it touches stays a normal editable
  // field afterward (message box left open) — AUTO never arms anything.
  async function autoRun() {
    if (!activePlan) return
    const last = loadLastUsed(account.id)
    const seedCount = last?.count ?? defaultSeedCount(account)
    const seedText = last?.text ?? msgDraft

    setCount(seedCount)
    if (seedText) setMsgDraft(seedText)
    setMsgOpen(true)

    const order = ['TODAY', 'TOMORROW', 'IN_2_DAYS'] as const
    const idx = order.indexOf(activeLabel)
    if (idx > 0 && plans) {
      const prev = plans.find(p => p.label === order[idx - 1])
      if (prev?.scheduled_at) setArmTime(maltaHM(new Date(new Date(prev.scheduled_at).getTime() + 15 * 60_000)))
    }

    setBusy(true); setNote('')
    try {
      const r = await crmJson(`outreach/plans/${activePlan.id}/generate`, 'POST', { count: seedCount, topUp: false })
      if (seedText) await crmJson(`outreach/plans/${activePlan.id}/message`, 'POST', { text: seedText })
      await refresh(activePlan.id)
      saveLastUsed(account.id, { text: seedText, count: seedCount })
      setNote(`Auto: ${r.added} added${seedText ? ' · message set' : ' · no message yet — write one below'}.`)
    } catch (e: any) {
      setNote(e?.message || 'Auto failed')
    } finally { setBusy(false) }
  }

  // Saved Drafts (spec follow-up, Kev 2026-09-11) — a small global template
  // library so a good message doesn't need retyping on every plan.
  async function saveAsTemplate() {
    if (!msgDraft.trim()) return
    const label = window.prompt('Save this message as a template — give it a short name:', '')
    if (!label) return
    await crmJson('outreach/templates', 'POST', { label, text: msgDraft })
    await onTemplatesChanged()
  }
  function loadTemplate(t: Template) {
    setMsgDraft(t.text)
    setTemplatesOpen(false)
  }
  async function deleteTemplate(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    await crmJson(`outreach/templates/${id}`, 'DELETE', {}).catch(() => {})
    await onTemplatesChanged()
  }

  async function saveDraft() {
    if (!activePlan) return
    setBusy(true)
    try { await crmJson(`outreach/plans/${activePlan.id}/save`, 'POST', {}); await refresh() } finally { setBusy(false) }
  }

  async function arm() {
    if (!activePlan) return
    setBusy(true); setNote('')
    try {
      const r = await crmJson(`outreach/plans/${activePlan.id}/arm`, 'POST', { time: armTime })
      if (r.ok === false) {
        const reasons: Record<string, string> = { no_message: 'Set a message first.', no_eligible_entries: 'No eligible entries in this queue.', time_in_past: 'That time has already passed.' }
        setNote(reasons[r.reason] || r.reason)
      } else { setNote(`Armed for ${armTime}.`) }
      await refresh()
    } finally { setBusy(false) }
  }

  async function pause() { if (!activePlan) return; setBusy(true); try { await crmJson(`outreach/plans/${activePlan.id}/pause`, 'POST', {}); await refresh() } finally { setBusy(false) } }
  async function cancel() { if (!activePlan) return; setBusy(true); try { await crmJson(`outreach/plans/${activePlan.id}/cancel`, 'POST', {}); await refresh() } finally { setBusy(false) } }

  const s = activePlan?.stats
  const isCompleted = activePlan?.status === 'completed'
  const initials = account.label.slice(0, 1).toUpperCase()

  return (
    <div style={{
      flex: '0 0 min(92vw, 380px)', scrollSnapAlign: 'start',
      background: `linear-gradient(165deg, ${accent.soft}, ${PANEL} 40%)`,
      border: `1px solid ${accent.glow}`, borderRadius: 22, padding: 18,
      boxShadow: `0 0 0 1px rgba(255,255,255,0.02), 0 20px 60px -20px ${accent.glow}`,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 42, height: 42, borderRadius: '50%', background: `linear-gradient(135deg, ${accent.a}, ${accent.b})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16, flexShrink: 0 }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '0.04em' }}>{account.label.toUpperCase()}</div>
          <div style={{ fontSize: 11, color: MUTED, fontFamily: FM }}>+{account.phone}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: account.connected ? '#3ecf8e' : '#f2597a' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: account.connected ? '#3ecf8e' : '#f2597a' }} />
            {account.connected ? 'CONNECTED' : 'DISCONNECTED'}
          </div>
          {/* Kev, 2026-09-11: real last-send time from outreach_log — same
              source suggestTime() bases its +30min suggestion on. */}
          <div style={{ fontSize: 9.5, color: FAINT, textAlign: 'right' }}>
            Last outreach: {account.lastOutreachAt
              ? `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short' }).format(new Date(account.lastOutreachAt))} · ${maltaHM(new Date(account.lastOutreachAt))}`
              : '—'}
          </div>
        </div>
      </div>

      {/* day tabs */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['TODAY', 'TOMORROW', 'IN_2_DAYS'] as const).map(label => {
          const p = plans?.find(pl => pl.label === label)
          const on = activeLabel === label
          return (
            <button key={label} onClick={() => setActiveLabel(label)} style={{
              flex: 1, padding: '9px 4px', borderRadius: 10, border: `1px solid ${on ? accent.a : HAIRLINE}`,
              background: on ? `linear-gradient(135deg, ${accent.a}, ${accent.b})` : 'rgba(255,255,255,0.03)',
              color: on ? '#0a0a0d' : MUTED, fontWeight: 700, fontSize: 10.5, cursor: 'pointer', fontFamily: F,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            }}>
              <span>{dayLabelText(label)}</span>
              <span style={{ fontSize: 8, opacity: 0.8 }}>{p?.status === 'completed' ? '✓ DONE' : p?.status === 'ready' ? '● READY' : p?.status === 'running' ? '▶ RUNNING' : '○ DRAFT'}</span>
            </button>
          )
        })}
      </div>

      {/* editable queue */}
      {isCompleted ? (
        <div style={{ background: EDITOR, borderRadius: 12, padding: 16, opacity: 0.75 }}>
          <div style={{ color: '#3ecf8e', fontWeight: 700, fontSize: 12.5 }}>✓ OUTREACH COMPLETED</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{s?.sent} sent · {s?.skip} skipped</div>
          {activePlan?.scheduled_at && <div style={{ fontSize: 11, color: FAINT, marginTop: 2 }}>Finished around {maltaHM(new Date(activePlan.scheduled_at))}</div>}
        </div>
      ) : (
        <textarea
          value={queueText}
          onChange={e => setQueueText(e.target.value)}
          onBlur={savePastedList}
          disabled={activePlan?.status === 'running'}
          placeholder={'Paste numbers, one per line:\n+35679932938 Mark\n+35679409341 Sarah'}
          spellCheck={false}
          style={{
            background: EDITOR, border: `1px solid ${HAIRLINE}`, borderRadius: 12, color: '#d8d8e0',
            fontFamily: FM, fontSize: 12, padding: 12, height: 200, resize: 'vertical', outline: 'none',
            lineHeight: 1.6,
          }}
        />
      )}

      {/* stats */}
      {s && (
        <div style={{ fontSize: 11, color: MUTED, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ color: TEXT }}>{s.eligible}/{s.total}</b> eligible
          <span>{s.hot} hot</span><span>{s.cold} cold</span><span>{s.skip} skip</span>
        </div>
      )}
      {note && <div style={{ fontSize: 11, color: accent.a }}>{note}</div>}

      {/* generate row */}
      {!isCompleted && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            disabled={busy} onClick={autoRun}
            title="One click for a non-custom day: reuses this account's last text + count, regenerates the list, saves the message, and nudges the arm time — everything stays editable after."
            style={{ ...btnPrimary(accent), flex: '0 0 auto', paddingLeft: 16, paddingRight: 16 }}>
            ⚡ AUTO
          </button>
          <button disabled={busy} onClick={() => generate(false)} title="Generates a fresh list of eligible owners — the exact same engine as the real !createlist WhatsApp command." style={{ ...btnGhost, flex: '1 1 auto' }}>+ Create List</button>
          <input type="number" value={count} onChange={e => setCount(Math.max(1, Math.min(200, parseInt(e.target.value) || 40)))} style={inputSmall} />
          <button disabled={busy} onClick={() => generate(true)} title="Keeps everyone already in the queue and only adds as many NEW eligible owners as needed to reach the count above." style={btnGhost}>Top Up</button>
          <button disabled={busy} onClick={clearList} title="Removes everyone from this queue and releases their reservation." style={btnGhost}>Clear</button>
        </div>
      )}

      {/* message + save */}
      {!isCompleted && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setMsgOpen(o => !o)} style={{ ...btnGhost, flex: 1, borderColor: activePlan?.message_template ? accent.a : HAIRLINE }}>
            ✏️ Message {activePlan?.message_template ? '· set' : '· empty'}
          </button>
          <button disabled={busy} onClick={saveDraft} style={{ ...btnGhost, flex: 1 }}>Save Draft</button>
        </div>
      )}
      {msgOpen && !isCompleted && (
        <div style={{ background: EDITOR, border: `1px solid ${accent.glow}`, borderRadius: 12, padding: 10, position: 'relative' }}>
          <textarea value={msgDraft} onChange={e => setMsgDraft(e.target.value)} placeholder="Hi [name], quick check on your property…" style={{ width: '100%', background: 'transparent', border: 'none', color: TEXT, fontFamily: F, fontSize: 12.5, resize: 'vertical', height: 80, outline: 'none' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setTemplatesOpen(o => !o)} title="Load a previously saved message" style={btnGhost}>💾 Saved Drafts ({templates.length})</button>
              {templatesOpen && (
                <div style={{ position: 'absolute', bottom: '110%', left: 0, background: PANEL2, border: `1px solid ${HAIRLINE}`, borderRadius: 10, padding: 6, minWidth: 220, maxHeight: 220, overflowY: 'auto', zIndex: 20, boxShadow: '0 12px 32px rgba(0,0,0,0.5)' }}>
                  {templates.length === 0 && <div style={{ fontSize: 11, color: FAINT, padding: '6px 8px' }}>No saved drafts yet.</div>}
                  {templates.map(t => (
                    <div key={t.id} onClick={() => loadTemplate(t)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                      <span onClick={e => deleteTemplate(t.id, e)} style={{ color: FAINT, fontSize: 13, flexShrink: 0 }}>✕</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={saveAsTemplate} title="Save this text as a new reusable draft" style={btnGhost}>Save as Draft</button>
              <button onClick={() => saveMessage()} style={btnPrimary(accent)}>Save Message</button>
            </div>
          </div>
        </div>
      )}

      {/* schedule / arm */}
      {!isCompleted && (
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, color: MUTED, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Outreach Plan</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: activePlan?.armed ? accent.a : FAINT }}>{activePlan?.armed ? '● ARMED' : '○ NOT ARMED'}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="time" value={armTime} onChange={e => setArmTime(e.target.value)} style={{ ...inputSmall, flex: 1 }} />
            <button disabled={busy || activePlan?.armed} onClick={arm} style={btnPrimary(accent)}>ARM</button>
            <button disabled={busy || !activePlan?.armed} onClick={pause} style={btnGhost}>PAUSE</button>
            <button disabled={busy} onClick={cancel} style={{ ...btnGhost, color: '#f2597a' }}>CANCEL</button>
          </div>
          {activePlan?.scheduled_at && (
            <div style={{ fontSize: 11, color: MUTED }}>
              Next: {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short' }).format(new Date(activePlan.scheduled_at))} · {maltaHM(new Date(activePlan.scheduled_at))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function btnPrimary(accent: typeof ACCENTS[0]): React.CSSProperties {
  return {
    background: `linear-gradient(135deg, ${accent.a}, ${accent.b})`, border: 'none', color: '#0a0a0d',
    borderRadius: 8, padding: '8px 14px', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: F,
  }
}
const inputSmall: React.CSSProperties = {
  background: EDITOR, border: `1px solid ${HAIRLINE}`, color: TEXT, borderRadius: 8,
  padding: '7px 8px', fontSize: 12, width: 64, fontFamily: FM, outline: 'none',
}
