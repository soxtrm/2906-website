'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Zap, Users, MessageSquare, Clock3, ShieldCheck, Radio, Layers } from 'lucide-react'
import './outreach-console.css'
import { crmGet, crmJson } from '@/lib/crm/api'
import { normalizeOutreachCountDraft } from '@/lib/crm/outreach-count'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'

// ── ARGUS / NEON design tokens ───────────────────────────────────────────────
const BG = 'var(--crm-bg)'
const PANEL = 'var(--crm-surface)'
const PANEL2 = 'var(--crm-surface)'
const EDITOR = 'var(--crm-raised)'
const HAIRLINE = 'var(--crm-border)'
const TEXT = 'var(--crm-text)'
const MUTED = 'var(--crm-muted)'
const FAINT = 'var(--crm-faint)'
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

type Account = {
  id: number; sessionName: string; phone: string; label: string; connected: boolean; lastOutreachAt: string | null
  pool: 'top' | 'bottom'; outreachVolumePercent: number; outreachVolumeUntil: string | null
  active?: boolean; outreachEnabled?: boolean; outreachEligible?: boolean
  sessionStatus?: string; operationalStatus?: 'ready' | 'offline' | 'restricted'
  restrictionDetectedAt?: string | null; restrictionUntil?: string | null; restrictionReason?: string | null
  restrictionsThisWeek?: number
  outreachAutoBaseCount?: number | null; outreachAutoMessage?: string
  recentRuns?: { id: number; status: string; total_contacts: number; sent_count: number; skip_count: number; started_at: string | null; completed_at: string | null; updated_at: string | null; volume_percent_snapshot: number | null }[]
  planningDays?: {day: string; label: string; status: string; armed: boolean; scheduledAt: string | null; count: number; display?: DayDisplay}[]
  outreachPaceMin?: number | null; outreachPaceMax?: number | null
  outreachAutoEnabled?: boolean; outreachAutoRolling?: boolean
  dailyTargetMin?: number; dailyTargetMax?: number; persona?: string | null
  quotaToday?: { day: string; target: number; cap: number; used: number; sent: number; remaining: number; remainingToTarget: number } | null
}
type DayDisplay = { state: 'empty' | 'auto_prepared' | 'scheduled' | 'running' | 'completed' | 'paused' | 'attention' | 'failed' | 'cancelled'; label: string }
type Template = { id: number; label: string; text: string; created_at: string }
type Entry = {
  id: number; normalized_phone: string; display_name: string | null
  classification: string | null; eligibility_status: string; skip_reason: string | null
  send_status: string; sent_at: string | null
}
type Plan = {
  id: number; account_id: number; session_name: string; scheduled_date: string
  scheduled_at: string | null; status: string; source?: string | null; armed: boolean; message_template: string | null
  label: 'TODAY' | 'TOMORROW' | 'IN_2_DAYS' | 'IN_3_DAYS' | 'IN_4_DAYS' | string
  stats: { total: number; eligible: number; hot: number; cold: number; skip: number; sent: number }
  entries?: Entry[]
  message_mode?: 'free_text' | 'persona_rotation' | null; template_slot?: number | null
  target_count?: number | null; display?: DayDisplay
}
type DueReminder = {
  id: number; owner_name: string | null; phone_last4: string | null; note: string
  contact_due_date: string; contact_classification: 'owner' | 'friend' | 'unknown'
  auto_send_status: string; auto_send_block_reason: string | null
  assigned_session: string | null; auto_send_for: string | null
}
type RecheckProperty = { id: number; ref: string; town: string | null; property_type: string | null; bedrooms: number | null; available_status: string | null }
type OwnerRecheckTask = {
  id: number; owner_name: string | null; state: 'DECISION_REQUIRED' | 'WAITING_FOR_DATE' | 'AUTO_RESOLVED' | 'AUTOMATION_BLOCKED' | 'APPROVED'
  decision: string; reason: string; proposed_action: string | null; proposed_message: string | null
  property_id: number | null; updated_at: string; context_snapshot: {
    owner?: { name?: string; lastKnownAccountId?: number | null }
    lastRelevantMessage?: { at?: string; text?: string } | null
    properties?: RecheckProperty[]
    reminder?: { id?: number; note?: string; due?: string; timing?: string }
  }
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

function outreachDaypart(time: string) {
  const hour = Number.parseInt(time.split(':')[0] || '0', 10)
  if (hour < 12) return 'Morning'
  if (hour < 18) return 'Afternoon'
  return 'Evening'
}

function outreachTimeLabel(value: string | null) {
  if (!value) return null
  const time = maltaHM(new Date(value))
  return `${outreachDaypart(time)} · ${time}`
}

const OUTREACH_DAY_LABELS = ['TODAY', 'TOMORROW', 'IN_2_DAYS', 'IN_3_DAYS', 'IN_4_DAYS'] as const
type OutreachDayLabel = typeof OUTREACH_DAY_LABELS[number]
const OUTREACH_LIST_MAX = 45
// Kev, 2026-10-29: the 24h 15m chain is gone. Rule: max 40 unique owners per
// account per Malta day, sends only 08:30–19:30 (backend enforces both).
const SEND_WINDOW = { start: 8 * 60 + 30, end: 19 * 60 + 30 }
function maltaMinutes(d: Date) {
  const [h, m] = maltaHM(d).split(':').map(Number)
  return h * 60 + m
}

// One glyph + one word per day state: never colour alone (spec 7).
const DAY_BADGE: Record<DayDisplay['state'], { glyph: string; word: string }> = {
  empty: { glyph: '—', word: 'Empty' },
  auto_prepared: { glyph: 'A', word: 'Auto' },
  scheduled: { glyph: '✓', word: 'Saved' },
  running: { glyph: '▶', word: 'Running' },
  completed: { glyph: '✔', word: 'Done' },
  paused: { glyph: 'Ⅱ', word: 'Paused' },
  attention: { glyph: '!', word: 'Check' },
  failed: { glyph: '✕', word: 'Error' },
  cancelled: { glyph: '✕', word: 'Cancelled' },
}
function DayBadge({ display, compact = false }: { display?: DayDisplay; compact?: boolean }) {
  const d = display || { state: 'empty' as const, label: 'Not prepared' }
  const badge = DAY_BADGE[d.state] || DAY_BADGE.empty
  return <span className={`day-badge is-${d.state}`} title={d.label} aria-label={d.label}><b aria-hidden>{badge.glyph}</b>{!compact && <span>{badge.word}</span>}</span>
}
function isArgusManager(account: Account) {
  return /argus\s*1|argus[_-]?1/i.test(`${account.label} ${account.sessionName}`)
}
function accountDisplayName(account: Account) {
  return /^(default|primary)$/i.test(account.sessionName) || /primary/i.test(account.label) ? 'Kev Default' : account.label
}
function accountPriority(account: Account) {
  const argus = `${account.sessionName}`.match(/^argus[ _-]?([1-4])$/i)
  if (argus) return -30 + Number(argus[1])
  const session = account.sessionName.toLowerCase()
  if (session === 'default') return -15
  if (session === 'kevsecond') return -14
  if (session === 'kevthirdd') return -13
  if (session === 'argus2') return -5
  if (session.includes('cedric')) return -4
  if (session.includes('gabri')) return -3
  return 10
}
function cooldownState(account: Account) {
  const q = account.quotaToday
  if (q && q.remaining <= 0) return { ready: false, label: `Daily cap ${q.used}/${q.cap} · resumes 08:30` }
  const minutes = maltaMinutes(new Date())
  const open = minutes >= SEND_WINDOW.start && minutes < SEND_WINDOW.end
  const used = q ? `${q.used}/${q.cap} today` : 'quota —'
  return { ready: open, label: open ? `Window open · ${used}` : `Window 08:30–19:30 · ${used}` }
}

// Kev, 2026-10-29: no more "last send + 24h15" chain. Instead each day follows
// the day before it +16 min ("sobald ich ne zeit bei today setze, morgen +16
// min"); the backend applies the same rule when ARM sets a time and when Auto
// prepares. Without an earlier day the suggestion is a morning start.
const DAILY_SHIFT_MIN = 16
function suggestTime(plans: Plan[] | null, label: string, _lastOutreachAt: string | null): string {
  const order = ['TODAY', 'TOMORROW', 'IN_2_DAYS', 'IN_3_DAYS', 'IN_4_DAYS']
  const idx = order.indexOf(label)
  for (let back = 1; idx - back >= 0 && plans; back++) {
    const prev = plans.find(p => p.label === order[idx - back])
    if (!prev?.scheduled_at) continue
    const minutes = maltaMinutes(new Date(prev.scheduled_at)) + DAILY_SHIFT_MIN * back
    if (minutes + 30 > SEND_WINDOW.end) break
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  }
  return '08:45'
}

// ── AUTO button: per-account "what I used last time" memory ─────────────────
// Kev, 2026-09-12: "die Presettings übernimmt (textwise und anzahl)... die
// letzte Nachricht die im Vortag gesettet wurde... dann ist es beim nächsten
// mal das was beim letzten mal war, das ist ja auch JE account unterschiedlich."
// The backend is now the durable source for AUTO defaults. localStorage stays
// as a compatibility fallback for accounts prepared before those fields were
// deployed and for a browser that briefly reloads before the account refresh.
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
  if (l === 'IN_2_DAYS') return 'THIRD DAY'
  if (l === 'IN_3_DAYS') return 'FOURTH DAY'
  if (l === 'IN_4_DAYS') return 'FIFTH DAY'
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
  const [adding,setAdding]=useState(false)
  const [newAccount,setNewAccount]=useState({label:'',sessionName:'',phone:''})
  const [registering,setRegistering]=useState(false)
  const [duplicates, setDuplicates] = useState<any[] | null>(null)
  const [summary, setSummary] = useState<any>(null)
  const [dueReminders, setDueReminders] = useState<{ rows: DueReminder[]; perAccount: any[] }>({ rows: [], perAccount: [] })
  const [rechecks, setRechecks] = useState<{ mode: string; tasks: OwnerRecheckTask[] }>({ mode: 'REVIEW_ONLY', tasks: [] })
  // Templates are a global library (spec follow-up: "Saved Drafts" button) —
  // lifted here, not per-console, so saving one in DEFAULT's card makes it
  // immediately available in every other account's card too.
  const [templates, setTemplates] = useState<Template[]>([])
  const [activeTab, setActiveTab] = useState<'tools' | 'reminders' | 'engagement' | 'templates'>('tools')
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [accRes, sumRes, dueRes, recheckRes] = await Promise.all([
        crmGet('outreach/accounts'),
        crmGet('outreach/today-summary').catch(() => null),
        crmGet('outreach/due-reminders').catch(() => ({ rows: [], perAccount: [] })),
        crmGet('outreach/owner-recheck').catch(() => ({ mode: 'UNKNOWN', tasks: [] })),
      ])
      setAccounts(accRes.accounts)
      setSummary(sumRes)
      setDueReminders(dueRes)
      setRechecks(recheckRes)
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
    } catch (e: any) { setError(e.message || 'Duplicate check failed'); setDuplicates(null) }
  }

  const connectedCount = accounts?.filter(a => a.connected && !/^(jasmine|olga)$/i.test(a.sessionName)).length ?? 0
  const orderedAccounts = useMemo(() => [...(accounts || [])].filter(a => !/^(jasmine|olga)$/i.test(a.sessionName.trim())).sort((a, b) => accountPriority(a) - accountPriority(b) || a.id - b.id), [accounts])
  const outreachAccounts = useMemo(() => orderedAccounts.filter(account => account.active !== false && account.outreachEnabled !== false && !isArgusManager(account)), [orderedAccounts])
  const selectedAccount = outreachAccounts.find(account => account.id === selectedAccountId) || outreachAccounts.find(account => account.sessionName.toLowerCase() === 'default') || outreachAccounts[0] || null

  useEffect(() => {
    if (outreachAccounts.length && !outreachAccounts.some(account => account.id === selectedAccountId)) setSelectedAccountId((outreachAccounts.find(account => account.sessionName.toLowerCase() === 'default') || outreachAccounts[0]).id)
  }, [outreachAccounts, selectedAccountId])

  if (me && me.role !== 'admin') {
    return (
      <div className="argus-workspace" style={{ minHeight: '100vh', background: BG, color: TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
        Admins only.
      </div>
    )
  }

  return (
    <CrmShell title="Outreach" subtitle="Accounts, queues and reviewed owner contact." dark><div className="argus-workspace" style={{ minHeight: '100vh', color: TEXT, fontFamily: F, paddingBottom: 60 }}>
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <section className="outreach-hero">
        <div className="outreach-hero-copy">
          <span><Radio size={12} aria-hidden /> ARGUS / OUTREACH SYSTEM</span>
          <h2>Every account.<br /><strong>In sync.</strong></h2>
          <p>One control layer for outreach identities, protected timing and reviewed owner contact.</p>
          <div className="outreach-hero-signals" aria-label="System principles">
            <span><ShieldCheck size={13} /> Reviewed sends</span>
            <span><Clock3 size={13} /> 08:30–19:30 Malta · max 40/day</span>
            <span><Layers size={13} /> Separate identities</span>
          </div>
        </div>
        <div className="outreach-orbit" aria-hidden="true">
          <i /><i /><i />
          <span><Zap size={25} /><b>ARGUS</b><small>OUTREACH</small></span>
        </div>
        <div className="outreach-hero-status">
          <div className="outreach-status-card">
            <div style={{ fontSize: 9, color: FAINT, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Connected Accounts</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              {orderedAccounts.map((a, i) => (
                <span key={a.id} title={a.sessionName} style={{ width: 8, height: 8, borderRadius: '50%', background: a.connected ? accentFor(i).a : 'transparent', border: `1px solid ${a.connected ? accentFor(i).a : FAINT}`, boxShadow: a.connected ? `0 0 6px ${accentFor(i).glow}` : 'none' }} />
              ))}
              <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 6 }}>{connectedCount} / {orderedAccounts.length} connected</span>
            </div>
          </div>
          <div className="outreach-status-card time">
            <div style={{ fontSize: 9, color: FAINT, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Europe/Malta</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: FM }}>{clock.time} <span style={{ fontSize: 10, color: MUTED, fontFamily: F }}>{clock.date}</span></div>
          </div>
          <div className="outreach-status-card wide">
            <RecentOutreachBars runs={summary?.recentRuns || []} />
          </div>
        </div>
      </section>

      <nav className="outreach-main-tabs" aria-label="Outreach workspace">
        <button aria-pressed={activeTab === 'tools'} onClick={() => setActiveTab('tools')}>Outreach tools <span>{outreachAccounts.length}</span></button>
        <button aria-pressed={activeTab === 'reminders'} onClick={() => setActiveTab('reminders')}>Outreach reminders <span>{dueReminders.rows.length + rechecks.tasks.length}</span></button>
        <button aria-pressed={activeTab === 'engagement'} onClick={() => setActiveTab('engagement')}>Engagement</button>
        <button aria-pressed={activeTab === 'templates'} onClick={() => setActiveTab('templates')}>Templates</button>
      </nav>

      {error && <div style={{ padding: '10px 24px', color: 'var(--crm-danger)', fontSize: 12 }}>{error}</div>}
      {!accounts && !error && <div style={{ padding: 24, color: MUTED, fontSize: 12 }}>Loading…</div>}

      {accounts && activeTab === 'reminders' && <>
        <OwnerRecheckLane data={rechecks} onChanged={load} />
        <DueReminderLane data={dueReminders} />
      </>}
      {accounts && activeTab === 'engagement' && <EngagementLane accounts={outreachAccounts} />}
      {accounts && activeTab === 'templates' && <TemplateLibrary />}

      {accounts && activeTab === 'tools' && <>
        <div className="outreach-control-layout">
        <section className="outreach-account-overview">
          <header><div><span>ACCOUNT CONTROL</span><h2>Accounts</h2></div><p>Select one identity. Restricted accounts stay visible and cannot be armed.</p></header>
          <div className="outreach-account-grid"><div className="account-row-label">SYSTEM & OUTREACH / ARGUS</div>
            {orderedAccounts.map((account, index) => {
              const manager = isArgusManager(account), selectable = account.active !== false && account.outreachEnabled !== false && !manager, selected = selectedAccount?.id === account.id, cooldown = cooldownState(account), restricted = account.operationalStatus === 'restricted'
              return <div key={account.id} className={/^argus[ _-]?[1-4]$/i.test(account.sessionName) ? 'account-slot argus-slot' : 'account-slot'}>{index > 0 && /^argus[ _-]?[1-4]$/i.test(orderedAccounts[index-1].sessionName) && !/^argus[ _-]?[1-4]$/i.test(account.sessionName) && <span className="account-team-label">YOUR TEAM</span>}<button key={account.id} type="button" disabled={!selectable} aria-pressed={selected} onClick={() => setSelectedAccountId(account.id)} className={`outreach-account-tile${/^argus[ _-]?[1-4]$/i.test(account.sessionName) ? ' is-argus' : ''}${manager ? ' is-manager' : ''}${!selectable ? ' is-support' : ''}${restricted ? ' is-restricted' : ''}${selected ? ' is-selected' : ''}`} style={{ '--account-accent': accentFor(index).a } as React.CSSProperties}>
                <i aria-hidden>{manager ? '⌘' : selectable ? '↗' : '◇'}</i><span><b>{accountDisplayName(account)}</b><small>{manager ? 'SYSTEM MANAGER · NOT IN ROTATION' : selectable ? `${account.pool === 'bottom' ? 'Z→A' : 'A→Z'} OUTREACH` : 'SUPPORT · NOT IN ROTATION'}</small></span>
                <em className={restricted ? 'is-restricted' : account.connected ? 'is-online' : ''}>{restricted ? 'RESTRICTED' : account.connected ? 'ONLINE' : 'OFFLINE'}</em>
                <footer><span>{account.lastOutreachAt ? `Last · ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short' }).format(new Date(account.lastOutreachAt))} ${maltaHM(new Date(account.lastOutreachAt))}` : 'No outreach logged'}</span>{selectable && <strong className={cooldown.ready ? 'is-ready' : ''}>{restricted ? `Held${account.restrictionUntil ? ` until ${maltaHM(new Date(account.restrictionUntil))}` : ''}` : cooldown.label}</strong>}</footer>
                {selectable && <span className="account-plan-strip" aria-label="Next five days">{account.planningDays?.map((day,index)=><span key={day.day} title={`${day.day}: ${day.display?.label || day.status}${day.scheduledAt ? ' · '+maltaHM(new Date(day.scheduledAt)) : ''} · ${day.count} contacts`}><span>{index===0?'T':index===1?'T+1':`T+${index}`}</span><DayBadge display={day.display} compact /></span>)}</span>}
                {selectable && <span className="account-auto-line"><b className={account.outreachAutoEnabled ? 'is-on' : ''}>{account.outreachAutoEnabled ? (account.outreachAutoRolling ? 'AUTO · ROLLING' : 'AUTO · NOT SAVED') : 'MANUAL'}</b><small>Pace {account.outreachPaceMin ?? account.outreachVolumePercent ?? '—'}{account.outreachPaceMax && account.outreachPaceMax !== account.outreachPaceMin ? `–${account.outreachPaceMax}` : ''}%</small></span>}
              </button></div>
            })}
            <button className="account-add" onClick={()=>setAdding(true)}><b>+</b><span>Add account<small>Expand your network</small></span></button>
          </div>
          {adding && <form className="account-register" onSubmit={async event=>{event.preventDefault();setRegistering(true);setError('');try{await crmJson('outreach/accounts','POST',newAccount);setAdding(false);setNewAccount({label:'',sessionName:'',phone:''});await load()}catch(e:any){setError(e.message||'Registration failed')}finally{setRegistering(false)}}}>
            <h3>Connect another outreach account</h3><p>Register the identity here, then connect its WhatsApp session. An offline account cannot send.</p>
            <label>Display name<input required value={newAccount.label} onChange={e=>setNewAccount({...newAccount,label:e.target.value})} placeholder="Argus 5" /></label>
            <label>Session name<input required pattern="[A-Za-z0-9_-]{2,40}" value={newAccount.sessionName} onChange={e=>setNewAccount({...newAccount,sessionName:e.target.value})} placeholder="Argus5" /></label>
            <label>Phone number<input required type="tel" value={newAccount.phone} onChange={e=>setNewAccount({...newAccount,phone:e.target.value})} placeholder="+356 …" /></label>
            <button disabled={registering} type="submit">{registering?'Registering…':'Register account'}</button><button type="button" onClick={()=>setAdding(false)}>Cancel</button>
          </form>}
        </section>

        {selectedAccount && <div className="outreach-active-console">
          <div className="outreach-active-caption"><span>ACTIVE OUTREACH TOOL</span><b>{accountDisplayName(selectedAccount)}</b><small>Auto keeps five morning days prepared. SAVE ALL schedules them; every send re-checks the owner, the 08:30–19:30 window and the 40/day cap.</small></div>
          <ProfileConsole key={selectedAccount.id} account={selectedAccount} accent={accentFor(Math.max(0, orderedAccounts.findIndex(account => account.id === selectedAccount.id)))} onChanged={load} templates={templates} onTemplatesChanged={loadTemplates} />
        </div>
        }
        </div>

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
          {duplicates === null ? <div style={{fontSize:12,color:MUTED}}>Run a check to review cross-account conflicts.</div> : duplicates.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--crm-success)' }}>✓ No active cross-account conflicts</div>
            : duplicates.map((d: any) => (
              <div key={d.normalized_phone} style={{ fontSize: 12, padding: '6px 0', borderBottom: `1px solid ${HAIRLINE}` }}>
                <div style={{ color: '#f2a53d', fontWeight: 700 }}>+{d.normalized_phone}</div>
                <div style={{ color: MUTED, fontSize: 11 }}>{d.plans.map((p: any) => `${p.session_name} · ${p.scheduled_date}`).join('  vs  ')}</div>
              </div>
            ))}
        </div>
      </div>
      </>}
    </div></CrmShell>
  )
}

function RecentOutreachBars({ runs }: { runs: any[] }) {
  const max = Math.max(1, ...runs.map(run => Number(run.n) || 0))
  return <div style={{ width: '100%', minWidth: 190 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 9, color: FAINT, letterSpacing: '.08em' }}>LAST 3 OUTREACH</span><span style={{ fontSize: 9, color: MUTED }}>SENT</span></div>
    {!runs.length ? <div style={{ fontSize: 11, color: FAINT, marginTop: 8 }}>No completed runs yet</div> : <div style={{ height: 48, display: 'grid', gridTemplateColumns: `repeat(${runs.length}, minmax(42px, 1fr))`, alignItems: 'end', gap: 8, marginTop: 4 }}>
      {[...runs].reverse().map((run, index) => { const value=Number(run.n)||0; const sentAt=run.sent_at?new Date(run.sent_at):null; const label=sentAt?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Malta',day:'2-digit',month:'short'}).format(sentAt):run.scheduled_date; return <div key={run.id||index} title={`${run.session_name} · ${label} · ${value} sent`} style={{height:'100%',display:'grid',gridTemplateRows:'1fr auto',gap:2,minWidth:0}}><div style={{alignSelf:'end',height:`${Math.max(8,Math.round(value/max*30))}px`,borderRadius:'4px 4px 2px 2px',background:`linear-gradient(180deg, ${accentFor(index).a}, ${accentFor(index).a}88)`,display:'flex',alignItems:'flex-start',justifyContent:'center',color:'#fff',fontSize:10,fontWeight:800,paddingTop:1}}>{value}</div><div style={{fontSize:8,color:FAINT,textAlign:'center',whiteSpace:'nowrap'}}>{label}</div></div> })}
    </div>}
  </div>
}

function DueReminderLane({ data }: { data: { rows: DueReminder[]; perAccount: any[] } }) {
  const queued = data.rows.filter(r => r.auto_send_status === 'queued').length
  const blocked = data.rows.filter(r => r.auto_send_status === 'blocked' || r.contact_classification === 'friend').length
  const suppressed = data.rows.filter(r => r.auto_send_status === 'suppressed_recent').length
  const review = data.rows.filter(r => r.auto_send_status === 'review').length
  return (
    <section style={{ margin: '18px 24px 2px', border: `1px solid ${HAIRLINE}`, borderRadius: 18, background: PANEL, overflow: 'hidden' }}>
      <div style={{ padding: '16px 18px', display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', flexWrap: 'wrap', borderBottom: `1px solid ${HAIRLINE}` }}>
        <div>
          <div style={{ fontSize: 10, color: '#35d6c4', letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 800 }}>Legacy reminder queue</div>
          <div style={{ fontSize: 18, fontWeight: 760, marginTop: 3 }}>Held for owner recheck</div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>These rows cannot send automatically while REVIEW_ONLY is active.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={metricPill('#35d6c4')}>{queued} queued</span>
          <span style={metricPill('#8fa0b8')}>{suppressed} contacted ≤10d</span>
          <span style={metricPill('#f2a53d')}>{review} review</span>
          <span style={metricPill('#e26b78')}>{blocked} friend · no send</span>
        </div>
      </div>
      <div style={{ padding: '12px 18px', display: 'flex', gap: 8, overflowX: 'auto', borderBottom: `1px solid ${HAIRLINE}` }}>
        {data.perAccount.map((row: any) => (
          <span key={`${row.session_name}-${row.auto_send_status}`} style={{ whiteSpace: 'nowrap', border: `1px solid ${HAIRLINE}`, borderRadius: 999, padding: '6px 10px', color: MUTED, fontSize: 10.5 }}>
            {row.session_name} · {row.auto_send_status} {row.count}
          </span>
        ))}
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {data.rows.map(row => {
          const isFriend = row.contact_classification === 'friend'
          const isQueued = row.auto_send_status === 'queued'
          const stateLabel = isFriend ? 'FRIEND · NO SEND' : isQueued ? (row.assigned_session || 'UNASSIGNED') : row.auto_send_status.replaceAll('_', ' ').toUpperCase()
          const stateColor = isQueued ? '#35d6c4' : row.auto_send_status === 'suppressed_recent' ? '#8fa0b8' : isFriend ? '#e26b78' : '#f2a53d'
          const when = row.auto_send_for ? new Date(row.auto_send_for).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Review'
          return <div key={row.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(130px,1fr) minmax(180px,2fr) minmax(120px,1fr)', gap: 12, padding: '11px 18px', borderBottom: `1px solid ${HAIRLINE}`, alignItems: 'center' }}>
            <div><div style={{ fontSize: 12, fontWeight: 700 }}>{row.owner_name || `Contact ···${row.phone_last4 || ''}`}</div><div style={{ fontSize: 10, color: FAINT }}>R#{row.id} · due {String(row.contact_due_date).slice(0, 10)}</div></div>
            <div style={{ fontSize: 11, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.note || 'No reminder context stored'}</div>
            <div style={{ textAlign: 'right' }}><div style={{ fontSize: 11, color: stateColor, fontWeight: 750 }}>{stateLabel}</div><div style={{ fontSize: 10, color: FAINT }}>{isQueued ? when : row.auto_send_block_reason || 'manual review'}</div></div>
          </div>
        })}
        {!data.rows.length && <div style={{ padding: 18, color: FAINT, fontSize: 12 }}>No due reminders.</div>}
      </div>
    </section>
  )
}

const RECHECK_VIEWS = [
  ['DECISION_REQUIRED', 'Decision needed'],
  ['WAITING_FOR_DATE', 'Waiting for date'],
  ['AUTO_RESOLVED', 'Automatically resolved'],
  ['AUTOMATION_BLOCKED', 'Automation blocked'],
] as const

function OwnerRecheckLane({ data, onChanged }: { data: { mode: string; tasks: OwnerRecheckTask[] }; onChanged: () => Promise<void> }) {
  const [view, setView] = useState<OwnerRecheckTask['state']>('DECISION_REQUIRED')
  const [busy, setBusy] = useState<number | null>(null)
  const [pauseDates, setPauseDates] = useState<Record<number, string>>({})
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const visible = data.tasks.filter(task => task.state === view)

  async function act(task: OwnerRecheckTask, action: string, extra: Record<string, unknown> = {}) {
    setBusy(task.id)
    try {
      await crmJson(`outreach/owner-recheck/${task.id}/action`, 'POST', { action, ...extra })
      await onChanged()
    } finally { setBusy(null) }
  }

  return <section style={{ margin: '18px 24px 2px', border: `1px solid ${HAIRLINE}`, borderRadius: 18, background: PANEL, overflow: 'hidden' }}>
    <div style={{ padding: '16px 18px', display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', flexWrap: 'wrap', borderBottom: `1px solid ${HAIRLINE}` }}>
      <div>
        <div style={{ fontSize: 10, color: '#f2a53d', letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 800 }}>Owner Recheck</div>
        <div style={{ fontSize: 18, fontWeight: 760, marginTop: 3 }}>Context first. Contact only after review.</div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>One card per owner and topic. New replies invalidate old approvals.</div>
      </div>
      <span style={metricPill(data.mode === 'REVIEW_ONLY' ? '#f2a53d' : '#e26b78')}>{data.mode}</span>
    </div>
    <div style={{ padding: '10px 14px', display: 'flex', gap: 7, overflowX: 'auto', borderBottom: `1px solid ${HAIRLINE}` }}>
      {RECHECK_VIEWS.map(([state, label]) => {
        const count = data.tasks.filter(task => task.state === state).length
        const selected = view === state
        return <button key={state} onClick={() => setView(state)} style={{ ...btnGhost, whiteSpace: 'nowrap', color: selected ? TEXT : MUTED, borderColor: selected ? '#f2a53d88' : HAIRLINE, background: selected ? 'rgba(242,165,61,.08)' : 'transparent' }}>{label} · {count}</button>
      })}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,330px),1fr))', gap: 12, padding: 14 }}>
      {visible.map(task => {
        const snapshot = task.context_snapshot || {}
        const properties = snapshot.properties || []
        const last = snapshot.lastRelevantMessage
        const due = snapshot.reminder?.due ? String(snapshot.reminder.due).slice(0, 10) : 'unknown'
        return <article key={task.id} style={{ border: `1px solid ${HAIRLINE}`, borderRadius: 14, padding: 14, background: EDITOR, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <div><div style={{ fontSize: 14, fontWeight: 760 }}>{task.owner_name || snapshot.owner?.name || 'Owner'}</div><div style={{ fontSize: 9.5, color: FAINT, marginTop: 2 }}>RECHECK #{task.id} · reminder due {due}</div></div>
            <span style={{ ...metricPill(task.state === 'AUTOMATION_BLOCKED' ? '#e26b78' : task.state === 'AUTO_RESOLVED' ? '#3ecf8e' : '#f2a53d'), height: 'fit-content' }}>{task.decision.replaceAll('_', ' ')}</span>
          </div>
          <div style={{ marginTop: 11, fontSize: 11.5, lineHeight: 1.45, color: MUTED }}>{task.reason}</div>
          {last?.text && <div style={{ marginTop: 10, borderLeft: '2px solid #f2a53d88', padding: '8px 10px', background: 'rgba(242,165,61,.05)', borderRadius: '0 8px 8px 0' }}><div style={{ fontSize: 9, color: FAINT, textTransform: 'uppercase', letterSpacing: '.08em' }}>Latest relevant owner message · {last.at ? new Date(last.at).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'time unknown'}</div><div style={{ marginTop: 4, fontSize: 11.5, color: TEXT }}>“{last.text}”</div></div>}
          {snapshot.reminder?.note && <div style={{ marginTop: 9, fontSize: 10.5, color: FAINT }}><b style={{ color: MUTED }}>Old reminder:</b> {snapshot.reminder.note}</div>}
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {properties.map(property => <button key={property.id} disabled={busy === task.id} onClick={() => act(task, 'assign_property', { propertyId: property.id })} style={{ ...btnGhost, padding: '5px 8px', fontSize: 9.5 }}>#{property.ref} · {property.town || 'area unknown'} · {property.available_status || 'status unknown'}</button>)}
            {!properties.length && <span style={{ fontSize: 10, color: FAINT }}>No verified linked property.</span>}
          </div>
          {task.proposed_action && <div style={{ marginTop: 10, fontSize: 10.5, color: '#f2a53d' }}>{task.proposed_action}</div>}
          {task.state === 'DECISION_REQUIRED' && <div style={{ marginTop: 9 }}><textarea aria-label={`Message proposal for ${task.owner_name || 'owner'}`} value={drafts[task.id] ?? task.proposed_message ?? ''} onChange={event => setDrafts(old => ({ ...old, [task.id]: event.target.value }))} placeholder="Only write a proposal when one concrete question is still open." rows={3} style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', background: PANEL, border: `1px solid ${HAIRLINE}`, color: TEXT, borderRadius: 8, padding: 9, font: `11px/1.45 ${F}` }} /><button disabled={busy === task.id || !(drafts[task.id] ?? task.proposed_message ?? '').trim()} onClick={() => act(task, 'save_proposal', { message: drafts[task.id] ?? task.proposed_message })} style={{ ...btnGhost, marginTop: 6 }}>Save proposal</button></div>}
          {task.proposed_message && task.state !== 'DECISION_REQUIRED' && <div style={{ marginTop: 9, padding: 9, border: `1px solid ${HAIRLINE}`, borderRadius: 8, fontSize: 11 }}>{task.proposed_message}</div>}
          {(task.state === 'DECISION_REQUIRED' || task.state === 'WAITING_FOR_DATE') && <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <button disabled={busy === task.id} onClick={() => act(task, 'resolve')} style={btnGhost}>Already captured / done</button>
            <button disabled={busy === task.id} onClick={() => act(task, 'take_over')} style={btnGhost}>Take over personally</button>
            <button disabled={busy === task.id} onClick={() => act(task, 'block')} style={{ ...btnGhost, color: '#e26b78' }}>Block automation</button>
            {task.proposed_message && <button disabled={busy === task.id} onClick={() => act(task, 'approve')} style={{ ...btnGhost, color: '#3ecf8e' }}>Approve this proposal</button>}
          </div>}
          {(task.state === 'DECISION_REQUIRED' || task.state === 'WAITING_FOR_DATE') && <div style={{ marginTop: 8, display: 'flex', gap: 6 }}><input aria-label={`Pause ${task.owner_name || 'owner'} until`} type="date" value={pauseDates[task.id] || ''} onChange={event => setPauseDates(old => ({ ...old, [task.id]: event.target.value }))} style={{ background: PANEL, border: `1px solid ${HAIRLINE}`, color: TEXT, borderRadius: 8, padding: '6px 8px', fontSize: 10 }} /><button disabled={busy === task.id || !pauseDates[task.id]} onClick={() => act(task, 'pause', { until: pauseDates[task.id] })} style={btnGhost}>Pause until date</button></div>}
        </article>
      })}
      {!visible.length && <div style={{ color: FAINT, fontSize: 12, padding: 6 }}>No owners in this view.</div>}
    </div>
  </section>
}

function metricPill(color: string) {
  return { border: `1px solid ${color}55`, background: `${color}14`, color, borderRadius: 999, padding: '7px 11px', fontSize: 10.5, fontWeight: 800 } as const
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
  const accountListMax = OUTREACH_LIST_MAX
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [plans, setPlans] = useState<Plan[] | null>(null)
  // Kev, 2026-09-11: defaults to TODAY, not TOMORROW — "ich hab kb für
  // morgen alles auszufüllen und dann zu merken dass es für den falschen
  // tag ist" (filling in the wrong day by accident because it opened on
  // tomorrow by default).
  const [activeLabel, setActiveLabel] = useState<OutreachDayLabel>('TODAY')
  const [prepareDaysOpen, setPrepareDaysOpen] = useState(false)
  const [selectedPrepareDays, setSelectedPrepareDays] = useState<OutreachDayLabel[]>([])
  const [queueText, setQueueText] = useState('')
  const [msgOpen, setMsgOpen] = useState(true)
  const [msgDraft, setMsgDraft] = useState('')
  const initialCount = account.outreachAutoBaseCount || defaultSeedCount(account)
  const [count, setCount] = useState(initialCount)
  const [countDraft, setCountDraft] = useState(String(initialCount))
  const [armTime, setArmTime] = useState('14:15')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  // Kev, 2026-10-29: never fall back to 100 — an unset pace shows empty and
  // the backend refuses to send without one (the old reset-to-100 bug).
  const savedMin = account.outreachPaceMin ?? account.outreachVolumePercent ?? null
  const savedMax = account.outreachPaceMax ?? savedMin
  const [paceMin, setPaceMin] = useState<number | ''>(savedMin ?? '')
  const [paceMax, setPaceMax] = useState<number | ''>(savedMax ?? '')
  const [volumeBusy, setVolumeBusy] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [saveAll, setSaveAll] = useState<{ busy: boolean; result: any | null; error: string }>({ busy: false, result: null, error: '' })
  const [autoSummary, setAutoSummary] = useState('')
  const pickedInitialPlan = useRef(false)

  useEffect(() => { setPaceMin(savedMin ?? ''); setPaceMax(savedMax ?? '') }, [savedMin, savedMax])

  const loadPlans = useCallback(async () => {
    const r = await crmGet(`outreach/plans?accountId=${account.id}`)
    setPlans(r.plans)
  }, [account.id])

  useEffect(() => { loadPlans() }, [loadPlans])

  // Opening an account on an empty TODAY tab made prepared outreach look as
  // if it had disappeared. On the first load only, reveal the nearest plan
  // that is armed or already contains work. Manual tab changes remain sticky.
  useEffect(() => {
    if (!plans?.length || pickedInitialPlan.current) return
    pickedInitialPlan.current = true
    const current = plans.find(p => p.label === activeLabel)
    if (current && (current.armed || current.stats.total > 0 || current.message_template)) return
    const prepared = plans.find(p => p.armed || p.status === 'ready')
      || plans.find(p => p.stats.total > 0 || Boolean(p.message_template))
    if (prepared && OUTREACH_DAY_LABELS.includes(prepared.label as OutreachDayLabel)) {
      setActiveLabel(prepared.label as OutreachDayLabel)
    }
  }, [plans, activeLabel])

  const activePlan = plans?.find(p => p.label === activeLabel) || null

  function commitCountDraft() {
    const validated = normalizeOutreachCountDraft(countDraft, count, accountListMax)
    setCount(validated)
    setCountDraft(String(validated))
    return validated
  }

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
    setMsgDraft(activePlan.message_template || account.outreachAutoMessage || '')
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
    const n = overrideCount == null ? commitCountDraft() : Math.min(accountListMax, overrideCount)
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

  // One account-level action fills every untouched day. Random count/time
  // values are generated and persisted by the backend once, while contacts
  // remain previews until ARM performs the final recheck and lock.
  async function autoRun(selectedLabels: OutreachDayLabel[] = [...OUTREACH_DAY_LABELS]) {
    if (!plans?.length || busy || !selectedLabels.length) return
    const last = loadLastUsed(account.id)
    const seedCount = commitCountDraft()
    const seedText = msgDraft.trim() || account.outreachAutoMessage || activePlan?.message_template || last?.text || ''

    setCount(seedCount)
    setCountDraft(String(seedCount))
    if (seedText) setMsgDraft(seedText)
    setMsgOpen(true)

    setBusy(true); setNote('')
    try {
      const r = await crmJson(`outreach/accounts/${account.id}/auto-prepare`, 'POST', { baseCount: seedCount, message: seedText, labels: selectedLabels })
      setPlans(r.rollingPlans)
      await onChanged()
      saveLastUsed(account.id, { text: seedText, count: seedCount })
      const prepared = (r.plans || []).filter((plan: any) => plan.status === 'prepared')
      const preserved = (r.plans || []).filter((plan: any) => plan.status === 'preserved')
      const blocked = (r.plans || []).filter((plan: any) => plan.status === 'blocked')
      const contacts = prepared.reduce((sum: number, plan: any) => sum + Number(plan.preparedCount || 0), 0)
      const preparedTimes = prepared.map((plan: any) => outreachTimeLabel(plan.scheduledAt)).filter(Boolean)
      const timeSummary = preparedTimes.length ? ` · ${preparedTimes.join(' → ')}` : ''
      setAutoSummary(`✓ AUTO PREPARED · ${prepared.length} day${prepared.length === 1 ? '' : 's'} · +16 min daily${timeSummary} · press SAVE ALL to schedule`)
      setNote(`Auto prepared ${prepared.length} day${prepared.length === 1 ? '' : 's'} · ${contacts} previews · ${preserved.length} preserved${blocked.length ? ` · ${blocked.length} blocked by time/safety` : ''}.`)
      setSelectedPrepareDays([])
      setPrepareDaysOpen(false)
    } catch (e: any) {
      setAutoSummary('')
      setNote(e?.message || 'Auto failed')
    } finally { setBusy(false) }
  }

  function togglePrepareDay(label: OutreachDayLabel) {
    setSelectedPrepareDays(current => current.includes(label)
      ? current.filter(day => day !== label)
      : [...current, label])
  }

  function autoSelectPrepareDays() {
    setSelectedPrepareDays([...OUTREACH_DAY_LABELS])
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
        const reasons: Record<string, string> = { no_message: 'Set a message first.', no_eligible_entries: 'No eligible entries in this queue.', time_in_past: 'That time has already passed.', outside_send_window: 'Outreach only runs 08:30–19:30 Malta time.', daily_cap_reached: 'This account already reached 40 owners that day.', account_restricted: 'This account is restricted and held from outreach.', queue_lock_conflict: 'Some contacts were taken by another armed queue. Regenerate before arming.', insufficient_eligible_contacts: 'The pool no longer has enough eligible contacts. The plan remains unarmed.', starter_batch_limit: `A plan allows up to ${OUTREACH_LIST_MAX} eligible contacts.` }
        setNote(reasons[r.reason] || r.reason)
      } else {
        const moved = (r.following || []).filter((f: any) => f.status === 'rescheduled' || f.status === 'retimed')
        const failed = (r.following || []).filter((f: any) => f.status === 'failed')
        setNote(`Armed for ${armTime}.${moved.length ? ` Following days moved: ${moved.map((f: any) => f.time).join(' → ')} (+${DAILY_SHIFT_MIN} min each).` : ''}${failed.length ? ` ${failed.length} following day(s) could not be re-armed — check them.` : ''}`)
      }
      await refresh()
    } finally { setBusy(false) }
  }

  async function pause() { if (!activePlan) return; setBusy(true); try { await crmJson(`outreach/plans/${activePlan.id}/pause`, 'POST', {}); await refresh() } finally { setBusy(false) } }
  async function cancel() { if (!activePlan) return; setBusy(true); try { await crmJson(`outreach/plans/${activePlan.id}/cancel`, 'POST', {}); await refresh() } finally { setBusy(false) } }

  async function saveVolume() {
    if (paceMin === '') { setNote('Enter a pace between 10 and 100.'); return }
    const min = paceMin, max = paceMax === '' ? paceMin : paceMax
    setVolumeBusy(true); setNote('')
    try {
      await crmJson(`outreach/accounts/${account.id}/volume`, 'POST', { min, max })
      setNote(min === max ? `Pace ${min}% saved — stays until you change it.` : `Pace ${Math.min(min, max)}–${Math.max(min, max)}% saved — each run draws inside it.`)
      onChanged()
    } catch (e: any) { setNote(e?.message || 'Failed to save pace') } finally { setVolumeBusy(false) }
  }

  async function toggleAuto(enabled: boolean) {
    setAutoBusy(true); setNote('')
    try {
      const r = await crmJson(`outreach/accounts/${account.id}/auto`, 'POST', { enabled })
      if (r.rollingPlans) setPlans(r.rollingPlans)
      else await loadPlans()
      setNote(enabled ? 'Auto on — five days prepared (A). Press SAVE ALL to schedule them.' : `Auto off — ${(r.paused || []).length} future auto day(s) paused. Nothing new is sent.`)
      await onChanged()
    } catch (e: any) { setNote(e?.message || 'Could not change Auto') } finally { setAutoBusy(false) }
  }

  async function saveAllDays() {
    setSaveAll({ busy: true, result: null, error: '' })
    try {
      const r = await crmJson(`outreach/accounts/${account.id}/save-all`, 'POST', {})
      if (r.rollingPlans) setPlans(r.rollingPlans)
      setSaveAll({ busy: false, result: r, error: '' })
      await onChanged()
    } catch (e: any) { setSaveAll({ busy: false, result: null, error: e?.message || 'Save All failed' }) }
  }

  async function setRestriction(restricted: boolean) {
    setBusy(true); setNote('')
    try {
      await crmJson(`outreach/accounts/${account.id}/restriction`, 'POST', {
        restricted,
        hours: 40,
        reason: restricted ? 'manual_restriction' : 'manual_review_clear',
      })
      setNote(restricted ? 'Account held for at least 40 hours.' : 'Restriction cleared after review.')
      await onChanged()
    } catch (e: any) { setNote(e?.message || 'Failed to update restriction') } finally { setBusy(false) }
  }

  const s = activePlan?.stats
  const isCompleted = activePlan?.status === 'completed'
  const displayName = accountDisplayName(account)
  const initials = displayName.slice(0, 1).toUpperCase()

  return (
    <div className="queue-console" style={{
      flex: '0 0 min(92vw, 380px)', scrollSnapAlign: 'start',
      background: `linear-gradient(165deg, ${accent.soft}, ${PANEL} 40%)`,
      border: `1px solid ${accent.glow}`, borderRadius: 22, padding: 18,
      boxShadow: `0 0 0 1px rgba(255,255,255,0.02), 0 20px 60px -20px ${accent.glow}`,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div className="queue-mission">
        <span className="queue-eyebrow"><Radio size={13} /> OUTREACH / WORKSPACE</span>
        <h2>Prepare. Review. Connect.</h2>
        <p>One account. One queue. Every step in view.</p>
        <div className="queue-automation" aria-label="Automation">
          <button type="button" role="switch" aria-checked={Boolean(account.outreachAutoEnabled)} className={`auto-switch${account.outreachAutoEnabled ? ' is-on' : ''}`} disabled={autoBusy || account.operationalStatus === 'restricted'} onClick={() => toggleAuto(!account.outreachAutoEnabled)}>
            <i aria-hidden /><span><b>{autoBusy ? 'Working…' : account.outreachAutoEnabled ? 'Auto ON' : 'Auto OFF'}</b><small>{account.outreachAutoEnabled ? (account.outreachAutoRolling ? 'Rolling 5 days · keeps itself scheduled' : 'Prepared · press SAVE ALL') : '30–40 owners · 08:30–09:15 start'}</small></span>
          </button>
          <button type="button" className="queue-autosetup" disabled={saveAll.busy || account.operationalStatus === 'restricted' || !plans?.length} onClick={saveAllDays}><ShieldCheck size={17} />{saveAll.busy ? 'Saving…' : 'SAVE ALL'}<span>Schedule every prepared day</span></button>
          <button className="queue-autosetup is-secondary" disabled={busy || account.operationalStatus === 'restricted' || !plans?.length} onClick={() => setPrepareDaysOpen(open => !open)} aria-expanded={prepareDaysOpen}><Zap size={17} />{busy ? 'Preparing…' : 'Prepare free days'}<span>Choose days by hand</span></button>
          {account.quotaToday && <div className="quota-meter" aria-label={`Today ${account.quotaToday.used} of ${account.quotaToday.cap} owners used`}>
            <span>TODAY</span><b>{account.quotaToday.used}<small>/{account.quotaToday.cap}</small></b>
            <i><em style={{ width: `${Math.min(100, (account.quotaToday.used / Math.max(1, account.quotaToday.cap)) * 100)}%` }} /></i>
            <small>target {account.quotaToday.target} · {account.quotaToday.remaining} left</small>
          </div>}
        </div>
        {(saveAll.result || saveAll.error) && <div className={`save-all-result${saveAll.error || !saveAll.result?.ok ? ' is-warning' : ''}`} role="status">
          {saveAll.error ? <b>✕ {saveAll.error}</b> : <>
            <b>{saveAll.result.ok ? '✓ All days scheduled' : '! Some days were not scheduled'}</b>
            <span>{saveAll.result.scheduled} newly scheduled · {saveAll.result.alreadyScheduled} already scheduled{saveAll.result.failed ? ` · ${saveAll.result.failed} failed` : ''}{saveAll.result.notPrepared ? ` · ${saveAll.result.notPrepared} not prepared` : ''}</span>
            {(saveAll.result.results || []).filter((r: any) => r.status === 'failed' || r.status === 'not_prepared').map((r: any) => <small key={r.planId}>{dayLabelText(r.label)}: {r.status === 'failed' ? (r.reason || 'failed').replace(/_/g, ' ') : 'no list prepared'}</small>)}
          </>}
        </div>}
      </div>
      <div className="queue-progress" aria-label="Queue preparation progress">
        {[{icon: Users, label: 'Contacts', value: `${s?.eligible || 0} eligible`, done: Boolean(s?.eligible)}, {icon: MessageSquare, label: 'Message', value: activePlan?.message_template ? 'Saved' : 'Needs text', done: Boolean(activePlan?.message_template)}, {icon: Clock3, label: 'Window', value: armTime + ' · Malta', done: Boolean(activePlan?.scheduled_at)}, {icon: ShieldCheck, label: 'Release', value: activePlan?.armed ? 'Armed' : 'Review first', done: Boolean(activePlan?.armed)}].map((step, i) => <div key={step.label} className={step.done ? 'is-done' : ''}><step.icon size={17} /><span><small>0{i + 1} / {step.label}</small><b>{step.value}</b></span></div>)}
      </div>
      <div className="queue-identity">
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 42, height: 42, borderRadius: '50%', background: `linear-gradient(135deg, ${accent.a}, ${accent.b})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16, flexShrink: 0 }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '0.04em' }}>{displayName.toUpperCase()}</div>
          <div style={{ fontSize: 11, color: MUTED, fontFamily: FM }}>+{account.phone}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: account.operationalStatus === 'restricted' ? '#ff9e64' : account.connected ? '#3ecf8e' : '#f2597a' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: account.operationalStatus === 'restricted' ? '#ff9e64' : account.connected ? '#3ecf8e' : '#f2597a' }} />
            {account.operationalStatus === 'restricted' ? 'RESTRICTED' : account.connected ? 'CONNECTED' : 'DISCONNECTED'}
          </div>
          {/* Real last-send time from outreach_log; the next window observes
              the 08:30–19:30 window and the 40/day cap. */}
          <div style={{ fontSize: 9.5, color: FAINT, textAlign: 'right' }}>
            Last outreach: {account.lastOutreachAt
              ? `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short' }).format(new Date(account.lastOutreachAt))} · ${maltaHM(new Date(account.lastOutreachAt))}`
              : '—'}
          </div>
        </div>
      </div>

      <div className="account-safety-panel">
        <div className="account-volume-compact">
          <span>PACE · {account.pool === 'bottom' ? 'Z→A' : 'A→Z'}</span>
          <input aria-label={`${account.label} pace from percent`} type="number" min={10} max={100} value={paceMin} placeholder="—" onChange={e => setPaceMin(e.target.value === '' ? '' : Math.max(10, Math.min(100, Number(e.target.value) || 10)))} />
          <b>–</b>
          <input aria-label={`${account.label} pace to percent`} type="number" min={10} max={100} value={paceMax} placeholder="—" onChange={e => setPaceMax(e.target.value === '' ? '' : Math.max(10, Math.min(100, Number(e.target.value) || 10)))} />
          <b>%</b>
          <button disabled={volumeBusy || paceMin === ''} onClick={() => saveVolume()} style={btnGhost}>{volumeBusy ? 'Saving…' : 'Save'}</button>
          {savedMin == null && <small className="pace-missing">No pace saved — runs are refused until one is set.</small>}
          <span className={`account-pace-status ${paceMin === '' ? 'is-error' : (paceMin !== (savedMin ?? '') || paceMax !== (savedMax ?? '')) ? 'is-dirty' : 'is-saved'}`} role="status" aria-live="polite">
            {volumeBusy ? '… Saving' : savedMin == null ? '× No pace saved' : (paceMin !== savedMin || paceMax !== savedMax) ? `● Unsaved · ${paceMin}${paceMax !== '' && paceMax !== paceMin ? `–${paceMax}` : ''}%` : `✓ Saved · ${savedMin}${savedMax !== savedMin ? `–${savedMax}` : ''}%`}
          </span>
        </div>
        <div className="account-restriction-line">
          <span><b>{account.restrictionsThisWeek || 0}</b> restrictions this week</span>
          {account.operationalStatus === 'restricted'
            ? <><small>{account.restrictionUntil ? `Held until ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(account.restrictionUntil))}` : 'Held pending review'}</small><button disabled={busy} onClick={() => setRestriction(false)} style={btnGhost}>Clear after review</button></>
            : <button disabled={busy} onClick={() => setRestriction(true)} style={btnGhost}>Mark restricted · 40h</button>}
        </div>
        <div className="account-recent-runs"><span>RECENT RUNS</span>{(account.recentRuns || []).slice(0,5).map(run => { const at=run.completed_at||run.updated_at||run.started_at; return <div key={run.id}><b>{run.sent_count}/{run.total_contacts}</b><small>{run.volume_percent_snapshot == null ? 'pace —' : `${run.volume_percent_snapshot}% pace`}</small><time>{at ? `${new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Malta',day:'2-digit',month:'short'}).format(new Date(at))} · ${maltaHM(new Date(at))}` : '—'}</time></div> })}{!(account.recentRuns || []).length && <small>No runs logged.</small>}</div>
      </div>

      </div>
      <div className="queue-day-tabs">
      {/* day tabs */}
      <div style={{ display: 'flex', gap: 6 }}>
        {OUTREACH_DAY_LABELS.map(label => {
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
              <DayBadge display={p?.display} />
            </button>
          )
        })}
      </div>

      {prepareDaysOpen && (
        <div className="queue-day-picker" aria-label="Choose outreach days to prepare">
          <div className="queue-day-picker-head">
            <div><b>Which days?</b><span>Tick them yourself, or let Auto tick all five. Preparation stays editable and does not send.</span></div>
            <div>
              <button type="button" onClick={autoSelectPrepareDays} disabled={busy}>Auto · check all</button>
              <button type="button" onClick={() => setSelectedPrepareDays([])} disabled={busy || !selectedPrepareDays.length}>Clear</button>
            </div>
          </div>
          <div className="queue-day-checks">
            {OUTREACH_DAY_LABELS.map(label => {
              const plan = plans?.find(candidate => candidate.label === label)
              const checked = selectedPrepareDays.includes(label)
              return (
                <label key={label} className={checked ? 'is-checked' : ''}>
                  <input type="checkbox" checked={checked} disabled={busy} onChange={() => togglePrepareDay(label)} />
                  <span>{dayLabelText(label)}</span>
                  <small>{outreachTimeLabel(plan?.scheduled_at || null) || (plan?.armed ? 'Armed · kept' : plan?.status === 'completed' ? 'Done · kept' : plan?.stats?.total ? `${plan.stats.eligible} queued · kept` : 'Empty draft')}</small>
                </label>
              )
            })}
          </div>
          <button type="button" className="queue-prepare-selected" disabled={busy || !selectedPrepareDays.length} onClick={() => autoRun(selectedPrepareDays)}>
            {busy ? 'Preparing…' : `Prepare selected (${selectedPrepareDays.length})`}
          </button>
        </div>
      )}

      {autoSummary && <div className="queue-auto-confirm" role="status" aria-live="polite"><ShieldCheck size={15} />{autoSummary}</div>}

      </div>
      <section className="queue-contacts"><h3><Users size={17} /> Contact queue <span>01</span></h3>
      {/* editable queue */}
      {isCompleted ? (
        <div style={{ background: EDITOR, borderRadius: 12, padding: 16, opacity: 0.75 }}>
          <div style={{ color: 'var(--crm-success)', fontWeight: 700, fontSize: 12.5 }}>✓ OUTREACH COMPLETED</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{s?.sent} sent · {s?.skip} skipped</div>
          {activePlan?.scheduled_at && <div style={{ fontSize: 11, color: FAINT, marginTop: 2 }}>Finished around {maltaHM(new Date(activePlan.scheduled_at))}</div>}
        </div>
      ) : (
        <textarea
          value={queueText}
          onChange={e => setQueueText(e.target.value)}
          aria-label="Contact queue"
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
            disabled={busy || account.operationalStatus === 'restricted' || !activePlan} onClick={() => autoRun([activeLabel])}
            title="Prepare the exact target count as an editable draft. Contacts stay in the shared pool until ARM."
            style={{ ...btnPrimary(accent), flex: '0 0 auto', paddingLeft: 16, paddingRight: 16 }}>
            Auto-setup
          </button>
          <button disabled={busy} onClick={savePastedList} style={btnGhost}>Save edits</button>
          <button disabled={busy} onClick={() => generate(false)} title="Creates a fresh list of exactly the target size. Existing unsent entries are released back to the pool." style={{ ...btnGhost, flex: '1 1 auto' }}>{(s?.total || 0) > 0 ? `Replace with ${Math.min(count, accountListMax)}` : `+ Create ${Math.min(count, accountListMax)}`}</button>
          <input aria-label="Target contacts in list" type="text" inputMode="numeric" pattern="[0-9]*" value={countDraft} onChange={e => setCountDraft(e.target.value)} onBlur={commitCountDraft} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCountDraft(); e.currentTarget.blur() } }} style={inputSmall} />
          <span style={{ fontSize: 9, color: FAINT }}>Target · max {accountListMax}</span>
          <button disabled={busy || (s?.eligible || 0) >= Math.min(count, accountListMax)} onClick={() => generate(true)} title="Keeps the current queue and adds only enough new owners to reach the target." style={btnGhost}>Top up to {Math.min(count, accountListMax)}</button>
          <button disabled={busy} onClick={clearList} title="Removes everyone from this queue and releases their reservation." style={btnGhost}>Clear</button>
        </div>
      )}

      </section>
      <section className="queue-message"><h3><MessageSquare size={17} /> Your message <span>02</span></h3>
      <p className="queue-help">{activePlan?.message_mode === 'persona_rotation'
        ? `Persona rotation · variant ${activePlan.template_slot ?? '—'}. The greeting and closing are chosen at the moment of sending (Malta time). Editing the text below switches this day to your own wording.`
        : 'Your own wording. A leading greeting and the closing are corrected to the Malta time of sending.'}</p>
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

      </section>
      <section className="queue-release"><h3><Clock3 size={17} /> Release window <span>03</span></h3><p className="queue-help">Malta time · sends only 08:30–19:30, max 40 owners per account per day. Each following day starts 16 minutes later than the day before. A run reaching 19:30 pauses and resumes 08:30 next morning. Owner checks run again before every message.</p>
      {/* schedule / arm */}
      {!isCompleted && (
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, color: MUTED, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Outreach Plan</span>
            <DayBadge display={activePlan?.display} />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="time" min="08:30" max="19:29" value={armTime} onChange={e => setArmTime(e.target.value)} style={{ ...inputSmall, flex: 1 }} />
            <button disabled={busy || activePlan?.armed || account.operationalStatus === 'restricted' || !account.connected} onClick={arm} style={btnPrimary(accent)}>ARM</button>
            <button disabled={busy || !activePlan?.armed} onClick={pause} style={btnGhost}>PAUSE</button>
            <button disabled={busy} onClick={cancel} style={{ ...btnGhost, color: 'var(--crm-danger)' }}>CANCEL</button>
          </div>
          <div className="queue-time-readout"><span>{outreachDaypart(armTime)}</span><b>{armTime}</b><small>Auto next day: +16 min · accept with ARM</small></div>
          {activePlan?.scheduled_at && (
            <div style={{ fontSize: 11, color: MUTED }}>
              Next: {new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short' }).format(new Date(activePlan.scheduled_at))} · {maltaHM(new Date(activePlan.scheduled_at))}
            </div>
          )}
        </div>
      )}
      </section>
    </div>
  )
}


// ── Engagement & Call Candidates (Kev, 2026-10-29) ─────────────────────────
// Derived from the send log; the call list is manual follow-up only and never
// contains anyone who opted out on WhatsApp.
const ENGAGEMENT_LEVELS = [1, 3, 5, 6, 7]
function EngagementLane({ accounts }: { accounts: Account[] }) {
  const [session, setSession] = useState('')
  const [minAttempts, setMinAttempts] = useState(3)
  const [overview, setOverview] = useState<any>(null)
  const [calls, setCalls] = useState<any>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const q = session ? `session=${encodeURIComponent(session)}&` : ''
    setError('')
    Promise.all([crmGet(`outreach/engagement?${q}`), crmGet(`outreach/call-candidates?${q}minAttempts=${minAttempts}`)])
      .then(([o, c]) => { if (live) { setOverview(o); setCalls(c) } })
      .catch(e => { if (live) setError(e?.message || 'Failed to load engagement') })
    return () => { live = false }
  }, [session, minAttempts])
  return (
    <section className="engagement-lane">
      <header><div><span>ENGAGEMENT</span><h2>Replies & call candidates</h2></div>
        <label>Account<select value={session} onChange={e => setSession(e.target.value)}><option value="">All accounts</option>{accounts.map(a => <option key={a.id} value={a.sessionName}>{accountDisplayName(a)}</option>)}</select></label>
      </header>
      {error && <p className="lane-error" role="alert">{error}</p>}
      {overview && <div className="engagement-stats">
        <div><small>Owners contacted</small><b>{overview.ownersContacted}</b></div>
        <div><small>Replied</small><b>{overview.ownersReplied}</b><span>{overview.replyRate}%</span></div>
        <div><small>Opted out</small><b>{overview.optedOut}</b></div>
        <div><small>Auto stops after</small><b>{overview.autoRetryStopsAt}</b><span>unanswered</span></div>
      </div>}
      {overview && <div className="engagement-levels" role="group" aria-label="No reply after N attempts">
        {overview.noReplyByAttempts.map((l: any) => <button key={l.attempts} aria-pressed={minAttempts === l.attempts} onClick={() => setMinAttempts(l.attempts)}><small>≥ {l.attempts} attempt{l.attempts === 1 ? '' : 's'}</small><b>{l.owners}</b></button>)}
      </div>}
      <h3>Call Candidates — No WhatsApp Response <span>{calls?.candidates?.length ?? '—'}</span></h3>
      <p className="queue-help">Manual follow-up list. Owners who opted out, are blocked or were marked angry are never listed — a WhatsApp opt-out is not permission to call.</p>
      <div className="call-list">
        {(calls?.candidates || []).map((c: any) => <div key={c.phone}>
          <span><b>{c.name || 'Unknown owner'}</b><small>{[c.location, c.propertyType].filter(Boolean).join(' · ') || '—'}</small></span>
          <a href={`tel:+${c.phone}`}>+{c.phone}</a>
          <small>{c.attempts} attempts · last {c.lastSentAt ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short' }).format(new Date(c.lastSentAt)) : '—'} · {c.lastAccount}</small>
        </div>)}
        {calls && !calls.candidates.length && <small>No owners at this threshold.</small>}
      </div>
    </section>
  )
}

// ── Persona template library: 3 personas × 3 periods × 4 variants ─────────
const PERSONAS = [{ key: 'kev', label: 'Kevin' }, { key: 'cedric', label: 'Cedric' }, { key: 'gabriela', label: 'Gabriela' }]
const PERIODS = ['morning', 'afternoon', 'evening'] as const
function TemplateLibrary() {
  const [persona, setPersona] = useState('kev')
  const [rows, setRows] = useState<any[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    const r = await crmGet(`outreach/persona-templates?persona=${persona}`)
    setRows(r.templates || []); setDrafts({}); setStatus({})
  }, [persona])
  useEffect(() => { load().catch(() => setRows([])) }, [load])
  const key = (t: any) => `${t.persona}:${t.period}:${t.slot}`
  async function save(t: any, active = t.active) {
    const k = key(t)
    setStatus(s => ({ ...s, [k]: 'Saving…' }))
    try {
      await crmJson('outreach/persona-templates', 'PUT', { persona: t.persona, period: t.period, slot: t.slot, body: drafts[k] ?? t.body, active })
      setStatus(s => ({ ...s, [k]: '✓ Saved' }))
      await load()
    } catch (e: any) { setStatus(s => ({ ...s, [k]: `✕ ${e?.message || 'Failed'}` })) }
  }
  return (
    <section className="template-library">
      <header><div><span>TEMPLATES</span><h2>Persona rotation library</h2></div>
        <div className="persona-tabs" role="group" aria-label="Persona">{PERSONAS.map(p => <button key={p.key} aria-pressed={persona === p.key} onClick={() => setPersona(p.key)}>{p.label}</button>)}</div>
      </header>
      <p className="queue-help">Four variants per time of day. Rotation never repeats the previous variant and prefers the least recently used. The greeting must match its period; other personas' names are refused.</p>
      {PERIODS.map(period => <div key={period} className="template-period"><h3>{period === 'morning' ? 'Morning · 08:00–11:59' : period === 'afternoon' ? 'Afternoon · 12:00–17:59' : 'Evening · 18:00–23:59'}</h3>
        {rows.filter(t => t.period === period).map(t => { const k = key(t); return <div key={k} className={`template-card${t.active ? '' : ' is-off'}`}>
          <header><b>Variant {t.slot}</b><label><input type="checkbox" checked={t.active} onChange={e => save(t, e.target.checked)} /> Active</label></header>
          <textarea value={drafts[k] ?? t.body} onChange={e => setDrafts(d => ({ ...d, [k]: e.target.value }))} rows={5} />
          <footer><small>{status[k] || (t.updated_by ? `Edited by ${t.updated_by}` : 'Seed text')}</small><button disabled={(drafts[k] ?? t.body) === t.body} onClick={() => save(t)} style={btnGhost}>Save</button></footer>
        </div> })}
      </div>)}
    </section>
  )
}

function btnPrimary(accent: typeof ACCENTS[0]): React.CSSProperties {
  return {
    background: 'var(--crm-action)', border: '1px solid var(--crm-action)', color: 'var(--crm-inverse)',
    borderRadius: 8, padding: '8px 14px', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: F,
  }
}
const inputSmall: React.CSSProperties = {
  background: EDITOR, border: `1px solid ${HAIRLINE}`, color: TEXT, borderRadius: 8,
  padding: '7px 8px', fontSize: 12, width: 64, fontFamily: FM, outline: 'none',
}
