'use client'
// ============================================================================
// /ownergroups — OWNERGROUPS 5/5: the CRM dashboard for every `!o`
// Owner-Assistant-managed conversation. Mirrors /clientgroups' own shape
// (list + detail sheet), data from /api/crm/ownergroups/* (routes/
// crmOwnergroups.js), which reuses services/ownerAssistant.js/
// ownerPreferenceProfile.js/scheduledOutreach.js verbatim.
// ============================================================================
import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
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
function DashboardTabs() {
  const pathname = usePathname() || ''
  const router = useRouter()
  const tabs = [
    { href: '/clientgroups', label: 'Clientgroups' },
    { href: '/ownergroups', label: 'Ownergroups' },
  ]
  return (
    <div className="flex gap-1 mb-4 border-b border-navy/10">
      {tabs.map(t => {
        const active = pathname.startsWith(t.href)
        return (
          <button key={t.href} onClick={() => router.push(t.href)}
            className={`px-4 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px ${
              active ? 'border-gold text-navy' : 'border-transparent text-navy/40 hover:text-navy'
            }`}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function OwnergroupCard({ og, onOpen }: { og: Ownergroup; onOpen: () => void }) {
  return (
    <div onClick={onOpen} className="rounded-lg border border-navy/10 bg-white p-4 cursor-pointer hover:border-gold/40 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-semibold text-sm text-navy">{og.ownerName || og.ownerPhone || 'Unlinked owner'}</div>
          <div className="text-[11px] text-navy/40">{og.session} · {og.chatId.replace(/@.*/, '')}</div>
        </div>
        {statusPill(og.status)}
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {og.propertyRefs.slice(0, 4).map(ref => (
          <span key={ref} className="text-[10px] px-1.5 py-0.5 rounded bg-off-white text-navy/60 font-mono">{ref}</span>
        ))}
        {og.propertiesCount > 4 && <span className="text-[10px] text-navy/40">+{og.propertiesCount - 4} more</span>}
        {!og.propertiesCount && <span className="text-[10px] text-navy/30">No properties on file</span>}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-navy/50">
        <span>{og.listedCount}/{og.propertiesCount} listed</span>
        {og.hasCard && <span className="text-gold font-semibold">🗂 {og.preferenceCount} pref{og.preferenceCount === 1 ? '' : 's'}</span>}
        {og.pendingViewingReminder && <span className="text-blue-600 font-semibold">⏰ viewing pending</span>}
      </div>
      <div className="text-[10px] text-navy/30 mt-2">{og.lastAction ? `Last: ${og.lastAction} (${fmtTimeAgo(og.lastActionAt)})` : 'No action yet'}</div>
    </div>
  )
}

function OwnergroupsInner() {
  const { me } = useCrm()
  const router = useRouter()
  const [rows, setRows] = useState<Ownergroup[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    crmFetch('ownergroups').then(d => setRows(d.ownergroups || [])).catch(e => setErr(e?.data?.error || e?.message || 'Failed to load')).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  if (me && me.role !== 'admin') {
    return (
      <CrmShell title="Ownergroups" subtitle="Admins only">
        <DashboardTabs />
        <p className="text-sm text-navy/40">This dashboard is admin-only.</p>
      </CrmShell>
    )
  }

  return (
    <CrmShell title="Ownergroups" subtitle={`${rows.length} managed owner conversation${rows.length === 1 ? '' : 's'}`}>
      <DashboardTabs />
      {err && <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      {loading ? (
        <p className="text-sm text-navy/40">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-navy/40">No ownergroups yet — activate one with <code>!o</code> in an owner's chat.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map(og => <OwnergroupCard key={og.id} og={og} onOpen={() => router.push(`/crm/ownergroups/${og.id}`)} />)}
        </div>
      )}
      <div className="mt-6 rounded-lg border border-dashed border-navy/15 p-4">
        <h3 className="text-xs font-bold uppercase tracking-wide text-navy/40 mb-1">Warm reachout waves</h3>
        <p className="text-xs text-navy/30">Not built yet — the underlying wave engine is still two ad-hoc scripts (wave_send.js/wave_send_jasmine.js), parked pending a dedicated build. This section will surface real wave data once that exists.</p>
      </div>
    </CrmShell>
  )
}

export default function OwnergroupsPage() {
  return <CrmProvider><OwnergroupsInner /></CrmProvider>
}
