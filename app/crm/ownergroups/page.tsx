'use client'
// ============================================================================
// /ownergroups — OWNERGROUPS 5/5: the CRM dashboard for every `!o`
// Owner-Assistant-managed conversation. Mirrors /clientgroups' own shape
// (list + detail sheet), data from /api/crm/ownergroups/* (routes/
// crmOwnergroups.js), which reuses services/ownerAssistant.js/
// ownerPreferenceProfile.js/scheduledOutreach.js verbatim.
// ============================================================================
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { GroupNavigation, GroupStats, crmPath } from '@/components/crm/group-navigation'
import { crmFetch } from '@/lib/crm/api'

type Ownergroup = {
  id: number; chatId: string; session: string; status: string; enabled: boolean
  ownerName: string | null; ownerPhone: string | null
  propertiesCount: number; listedCount: number; propertyRefs: string[]
  preferenceCount: number; hasCard: boolean
  lastAction: string | null; lastActionAt: string | null
  pendingViewingReminder: boolean; updatedAt: string
}

const STATUS_MAP: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  ARMED:         { bg: '#DCFCE7', text: '#15803D', dot: '#22C55E', label: 'Armed' },
  ENABLED:       { bg: '#FEF9C3', text: '#A16207', dot: '#EAB308', label: 'Enabled' },
  HUMAN_ACTIVE:  { bg: '#DBEAFE', text: '#1D4ED8', dot: '#3B82F6', label: 'Human active' },
  PAUSED:        { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: 'Paused' },
  DISABLED:      { bg: '#FEE2E2', text: '#B91C1C', dot: '#EF4444', label: 'Disabled' },
  DORMANT:       { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: 'Dormant' },
}
function statusPill(status: string) {
  const s = STATUS_MAP[status] || { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: status }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, background: s.bg, color: s.text, fontSize: 10, fontWeight: 700 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot }} />{s.label}
    </span>
  )
}
function fmtTimeAgo(iso: string | null) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// Shared little tab row so an agent can jump between the two "managed
// conversation" dashboards without hunting through the sidebar — Kev's
// explicit OG-5 ask ("Owner-Dashboard und Client-Dashboard über Tabs oben
// umschaltbar").
const DashboardTabs = GroupNavigation

function OwnergroupCard({ og, onOpen }: { og: Ownergroup; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="crm-group-card">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-semibold text-sm text-white">{og.ownerName || og.ownerPhone || 'Unlinked owner'}</div>
          <div className="text-[11px] text-white/40">{og.session} · {og.chatId.replace(/@.*/, '')}</div>
        </div>
        {statusPill(og.status)}
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {og.propertyRefs.slice(0, 4).map(ref => (
          <span key={ref} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60 font-mono">{ref}</span>
        ))}
        {og.propertiesCount > 4 && <span className="text-[10px] text-white/40">+{og.propertiesCount - 4} more</span>}
        {!og.propertiesCount && <span className="text-[10px] text-white/30">No properties on file</span>}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-white/50">
        <span>{og.listedCount}/{og.propertiesCount} listed</span>
        {og.hasCard && <span className="text-gold font-semibold">🗂 {og.preferenceCount} pref{og.preferenceCount === 1 ? '' : 's'}</span>}
        {og.pendingViewingReminder && <span className="text-blue-400 font-semibold">⏰ viewing pending</span>}
      </div>
      <div className="text-[10px] text-white/30 mt-2">{og.lastAction ? `Last: ${og.lastAction} (${fmtTimeAgo(og.lastActionAt)})` : 'No action yet'}</div>
    </button>
  )
}

function OwnergroupsInner() {
  const { me } = useCrm()
  const router = useRouter()
  const pathname = usePathname() || '/'
  const [rows, setRows] = useState<Ownergroup[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [session, setSession] = useState('all')
  const [sort, setSort] = useState('activity')
  const load = useCallback(() => {
    setLoading(true); setErr(null)
    crmFetch('ownergroups').then(d => setRows(d.ownergroups || [])).catch(e => setErr(e?.message || 'Unable to load ownergroups')).finally(() => setLoading(false))
  }, [])
  useEffect(() => { if (me?.role === 'admin') load(); else setLoading(false) }, [load, me?.role])
  const filtered = rows.filter(row => {
    const haystack = [row.ownerName, row.ownerPhone, row.session, ...row.propertyRefs].join(' ').toLocaleLowerCase()
    return (!q.trim() || haystack.includes(q.trim().toLocaleLowerCase())) && (status === 'all' || (status === 'viewing' ? row.pendingViewingReminder : row.status === status)) && (session === 'all' || row.session === session)
  }).sort((a,b) => sort === 'name' ? (a.ownerName || '').localeCompare(b.ownerName || '') : sort === 'properties' ? b.propertiesCount - a.propertiesCount : Date.parse(b.lastActionAt || b.updatedAt) - Date.parse(a.lastActionAt || a.updatedAt))
  return <CrmShell title="Ownergroups" subtitle="Your owners, properties and conversations in one place." dark>
    <div className="crm-group-workspace"><DashboardTabs />
      {me?.role !== 'admin' ? <div className="crm-empty">This dashboard is available to admins.</div> : <>
        <GroupStats items={[{label:'Owner conversations',value:rows.length},{label:'Managed properties',value:rows.reduce((n,r)=>n+r.propertiesCount,0)},{label:'Viewing reminders',value:rows.filter(r=>r.pendingViewingReminder).length}]} />
        <div className="crm-group-toolbar">
          <label className="crm-search">Find an owner or property<input type="search" placeholder="Name, reference, phone or account" value={q} onChange={e=>setQ(e.target.value)} /></label>
          <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option><option value="viewing">Viewing pending</option>{Array.from(new Set(rows.map(r=>r.status))).sort().map(v=><option key={v} value={v}>{v.replaceAll('_',' ')}</option>)}</select></label>
          <label>Account<select value={session} onChange={e=>setSession(e.target.value)}><option value="all">All accounts</option>{Array.from(new Set(rows.map(r=>r.session))).sort().map(v=><option key={v}>{v}</option>)}</select></label>
          <label>Sort by<select value={sort} onChange={e=>setSort(e.target.value)}><option value="activity">Recent activity</option><option value="name">Owner name</option><option value="properties">Most properties</option></select></label>
          <button className="crm-button" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          {(q || status !== 'all' || session !== 'all') && <button className="crm-button" onClick={()=>{setQ('');setStatus('all');setSession('all')}}>Clear filters</button>}
        </div>
        {err && <div role="alert" className="crm-error">{err} <button className="crm-button" onClick={load}>Try again</button></div>}
        <p style={{color:'var(--crm-muted)',fontSize:12,marginBottom:14}} role="status">{loading ? 'Loading conversations…' : `${filtered.length} of ${rows.length} conversations`}</p>
        {!loading && !err && !filtered.length && <div className="crm-empty">{rows.length ? 'No conversations match these filters.' : "No ownergroups yet. Activate one with !o in an owner’s chat."}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">{filtered.map(og => <OwnergroupCard key={og.id} og={og} onOpen={() => router.push(crmPath(`/ownergroups/${og.id}`,pathname))} />)}</div>
      </>}
    </div>
  </CrmShell>
}

export default function OwnergroupsPage() {
  return <CrmProvider><OwnergroupsInner /></CrmProvider>
}
