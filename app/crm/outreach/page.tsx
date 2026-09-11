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

type Account = { id: number; sessionName: string; phone: string; label: string; connected: boolean }
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

  useEffect(() => { load() }, [load])

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
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.12em' }}>ARGUS</span>
              <span style={{ fontSize: 10, color: FAINT, letterSpacing: '0.1em' }}>2906</span>
              <span style={{ width: 1, height: 14, background: HAIRLINE }} />
              <span style={{ fontSize: 16, fontStyle: 'italic', fontWeight: 600, color: '#d9a6ff' }}>NEON</span>
            </div>
            <div style={{ fontSize: 9, color: FAINT, letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 2 }}>Automatic Outreach Engine</div>
          </div>
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
            <ProfileConsole key={acc.id} account={acc} accent={accentFor(i)} onChanged={load} />
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
function ProfileConsole({ account, accent, onChanged }: { account: Account; accent: typeof ACCENTS[0]; onChanged: () => void }) {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [activeLabel, setActiveLabel] = useState<'TODAY' | 'TOMORROW' | 'IN_2_DAYS'>('TOMORROW')
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

  useEffect(() => {
    if (!activePlan) return
    setMsgDraft(activePlan.message_template || '')
    if (activePlan.scheduled_at) setArmTime(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(activePlan.scheduled_at)))
    crmGet(`outreach/plans/${activePlan.id}`).then(r => {
      setQueueText((r.plan.entries || []).map((e: Entry) => `+${e.normalized_phone}${e.display_name ? ' ' + e.display_name : ''}`).join('\n'))
    }).catch(() => {})
  }, [activePlan?.id])

  async function refresh() { await loadPlans(); onChanged() }

  async function savePastedList() {
    if (!activePlan) return
    setBusy(true); setNote('')
    try {
      await crmJson(`outreach/plans/${activePlan.id}/paste`, 'POST', { text: queueText })
      await refresh()
      setNote('Saved.')
    } catch (e: any) { setNote(e?.message || 'Failed to save') } finally { setBusy(false) }
  }

  async function generate(topUp = false) {
    if (!activePlan) return
    setBusy(true); setNote('')
    try {
      const r = await crmJson(`outreach/plans/${activePlan.id}/generate`, 'POST', { count, topUp })
      await refresh()
      setNote(`${r.added} added${r.need && r.added < r.need ? ` (only ${r.added}/${r.need} eligible found)` : ''}.`)
    } catch (e: any) { setNote(e?.message || 'Failed to generate') } finally { setBusy(false) }
  }

  async function clearList() {
    if (!activePlan) return
    setBusy(true)
    try { await crmJson(`outreach/plans/${activePlan.id}/clear`, 'POST', {}); setQueueText(''); await refresh() }
    finally { setBusy(false) }
  }

  async function saveMessage() {
    if (!activePlan) return
    await crmJson(`outreach/plans/${activePlan.id}/message`, 'POST', { text: msgDraft })
    setMsgOpen(false)
    await refresh()
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: account.connected ? '#3ecf8e' : '#f2597a' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: account.connected ? '#3ecf8e' : '#f2597a' }} />
          {account.connected ? 'CONNECTED' : 'DISCONNECTED'}
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
          {activePlan?.scheduled_at && <div style={{ fontSize: 11, color: FAINT, marginTop: 2 }}>Finished around {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(activePlan.scheduled_at))}</div>}
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
          <button disabled={busy} onClick={() => generate(false)} style={{ ...btnPrimary(accent), flex: '1 1 auto' }}>+ Create List</button>
          <input type="number" value={count} onChange={e => setCount(Math.max(1, Math.min(200, parseInt(e.target.value) || 40)))} style={inputSmall} />
          <button disabled={busy} onClick={() => generate(true)} style={btnGhost}>Top Up</button>
          <button disabled={busy} onClick={clearList} style={btnGhost}>Clear</button>
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
        <div style={{ background: EDITOR, border: `1px solid ${accent.glow}`, borderRadius: 12, padding: 10 }}>
          <textarea value={msgDraft} onChange={e => setMsgDraft(e.target.value)} placeholder="Hi [name], quick check on your property…" style={{ width: '100%', background: 'transparent', border: 'none', color: TEXT, fontFamily: F, fontSize: 12.5, resize: 'vertical', height: 80, outline: 'none' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button onClick={saveMessage} style={btnPrimary(accent)}>Save Message</button>
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
              Next: {activePlan.scheduled_date} · {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(activePlan.scheduled_at))}
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
