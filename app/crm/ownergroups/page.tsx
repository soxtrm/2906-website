'use client'
// ============================================================================
// /ownergroups — OWNERGROUPS 5/5: the CRM dashboard for every `!o`
// Owner-Assistant-managed conversation. Mirrors /clientgroups' own shape
// (list + detail sheet), data from /api/crm/ownergroups/* (routes/
// crmOwnergroups.js), which reuses services/ownerAssistant.js/
// ownerPreferenceProfile.js/scheduledOutreach.js verbatim.
// ============================================================================
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

const FIELD =
  'w-full px-3 py-2 bg-off-white border-0 rounded text-sm text-navy ' +
  'placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50'
const LABEL = 'block text-[10px] font-semibold uppercase tracking-[0.12em] text-navy/40 mb-1.5'
const PRIMARY =
  'px-3 py-2 rounded bg-navy text-white text-xs font-semibold hover:bg-navy-light ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const GHOST = 'px-3 py-2 rounded text-xs text-navy/50 hover:text-navy transition-colors border border-navy/10'

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

function DetailSheet({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msgText, setMsgText] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [scheduling, setScheduling] = useState(false)

  const load = useCallback(() => {
    crmFetch(`ownergroups/${id}`).then(setData).catch(e => setErr(e?.data?.error || e?.message || 'Failed to load'))
  }, [id])
  useEffect(() => { load() }, [load])

  async function scheduleOutreach() {
    if (!msgText.trim() || !scheduledFor) return
    setScheduling(true); setErr(null)
    try {
      await crmJson(`ownergroups/${id}/schedule-outreach`, 'POST', {
        messageText: msgText.trim(), scheduledFor: new Date(scheduledFor).toISOString(),
      })
      setMsgText(''); setScheduledFor('')
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not schedule outreach')
    } finally { setScheduling(false) }
  }

  async function cancelCampaign(campaignId: number) {
    try { await crmFetch(`ownergroups/${id}/outreach-campaigns/${campaignId}`, { method: 'DELETE' }); load(); onChanged() }
    catch (e: any) { setErr(e?.data?.error || e?.message || 'Could not cancel') }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-lg h-full bg-white overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-navy">{data?.ownerContact?.name || data?.state?.owner_phone || 'Owner'}</h2>
          <button onClick={onClose} className={GHOST}>Close</button>
        </div>
        {err && <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        {!data ? <p className="text-sm text-navy/40">Loading…</p> : (
          <>
            <div className="mb-4 flex items-center gap-2">
              {statusPill(data.state.status)}
              <span className="text-[11px] text-navy/40">{data.state.session} · {data.state.chat_id}</span>
            </div>

            <div className="rounded-lg border border-navy/10 p-3 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Properties ({data.properties?.length || 0})</h3>
              {(data.properties || []).map((p: any) => (
                <div key={p.id} className="text-xs flex justify-between py-1 border-b border-off-white last:border-0">
                  <span className="font-mono">{p.ref}</span>
                  <span className="text-navy/50">{p.available_status} · {p.town}</span>
                </div>
              ))}
              {!data.properties?.length && <p className="text-xs text-navy/30">None on file.</p>}
            </div>

            <div className="rounded-lg border border-navy/10 p-3 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Preference card (OG-4)</h3>
              {(data.profile || []).filter((p: any) => p.field !== 'general').map((p: any) => (
                <div key={p.id} className="text-xs flex justify-between py-1 border-b border-off-white last:border-0">
                  <span>{p.field}: <strong>{p.value}</strong></span>
                  <span className="text-navy/40">{p.is_explicit ? 'explicit' : `inferred (${Math.round((p.confidence || 0) * 100)}%)`}</span>
                </div>
              ))}
              {!(data.profile || []).some((p: any) => p.field !== 'general') && <p className="text-xs text-navy/30">No preferences captured yet.</p>}
            </div>

            <div className="rounded-lg border border-navy/10 p-3 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Schedule outreach</h3>
              <textarea className={FIELD + ' mb-2'} rows={3} placeholder="Message text…" value={msgText} onChange={e => setMsgText(e.target.value)} />
              <input type="datetime-local" className={FIELD + ' mb-2'} value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} />
              <button className={PRIMARY} disabled={scheduling || !msgText.trim() || !scheduledFor} onClick={scheduleOutreach}>
                {scheduling ? 'Scheduling…' : 'Schedule'}
              </button>
              {(data.campaigns || []).length > 0 && (
                <div className="mt-3 space-y-1">
                  {data.campaigns.map((c: any) => (
                    <div key={c.id} className="text-xs flex justify-between items-center py-1 border-t border-off-white">
                      <span>{new Date(c.scheduled_for).toLocaleString()} · {c.status}</span>
                      {c.status === 'pending' && <button className="text-red-500 text-[10px]" onClick={() => cancelCampaign(c.id)}>Cancel</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <details className="rounded-lg border border-navy/10 p-3">
              <summary className="text-xs font-bold uppercase tracking-wide text-navy/50 cursor-pointer">Recent activity</summary>
              <div className="mt-2 space-y-1">
                {(data.events || []).map((e: any, i: number) => (
                  <div key={i} className="text-[11px] text-navy/50 py-1 border-b border-off-white last:border-0">
                    {e.kind} {e.reason ? `— ${e.reason}` : ''} · {fmtTimeAgo(e.created_at)}
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

function OwnergroupsInner() {
  const { me } = useCrm()
  const [rows, setRows] = useState<Ownergroup[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)

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
          {rows.map(og => <OwnergroupCard key={og.id} og={og} onOpen={() => setOpenId(og.id)} />)}
        </div>
      )}
      <div className="mt-6 rounded-lg border border-dashed border-navy/15 p-4">
        <h3 className="text-xs font-bold uppercase tracking-wide text-navy/40 mb-1">Warm reachout waves</h3>
        <p className="text-xs text-navy/30">Not built yet — the underlying wave engine is still two ad-hoc scripts (wave_send.js/wave_send_jasmine.js), parked pending a dedicated build. This section will surface real wave data once that exists.</p>
      </div>
      {openId != null && <DetailSheet id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </CrmShell>
  )
}

export default function OwnergroupsPage() {
  return <CrmProvider><OwnergroupsInner /></CrmProvider>
}
