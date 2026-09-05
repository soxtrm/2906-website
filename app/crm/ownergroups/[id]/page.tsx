'use client'
// ============================================================================
// /ownergroups/[id] — OGX-1: the deep owner profile page, replacing OG-5's
// thin slide-over sheet as the real detail view. Tab structure per Kev's
// exact spec: Properties / Kontakte / Property Maps / Owner Flows / Owner
// Credentials / Sale Inventory / Rent Inventory. Owner Flows (OGX-2) and
// Owner Credentials (OGX-3) are visible placeholders here — not yet built.
//
// Data from GET /api/crm/ownergroups/:id (routes/crmOwnergroups.js), which
// now also returns preferenceComparison (OG-4's Karteikarte, general vs
// per-property) and contacts (owner_account_labels — which WA session(s)
// actually talk to this owner). No parallel data model.
//
// Map: reuses the SAME town-centre + deterministic-fan-out approach the
// Schedule Board's own map already uses (lib/crm/towns.ts) — there is
// deliberately no per-property lat/lng in the database (privacy: town-level
// precision only), so this is the correct reuse, not a shortcut. Maps key
// comes from the same GET /api/crm/schedule-board/config the board uses.
// ============================================================================
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { TOWNS, townKey, spread } from '@/lib/crm/towns'

const FIELD =
  'w-full px-3 py-2 bg-off-white border-0 rounded text-sm text-navy ' +
  'placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50'
const PRIMARY =
  'px-3 py-2 rounded bg-navy text-white text-xs font-semibold hover:bg-navy-light ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const GHOST = 'px-3 py-2 rounded text-xs text-navy/50 hover:text-navy transition-colors border border-navy/10'

type Tab = 'properties' | 'contacts' | 'map' | 'flows' | 'credentials' | 'sale' | 'rent'
const TABS: { key: Tab; label: string; placeholder?: string }[] = [
  { key: 'properties', label: 'Properties' },
  { key: 'contacts', label: 'Kontakte' },
  { key: 'map', label: 'Property Maps' },
  { key: 'flows', label: 'Owner Flows', placeholder: 'Coming in OGX-2 — configurable check-in rhythms, price-flexibility follow-up, and an activity log will live here.' },
  { key: 'credentials', label: 'Owner Credentials', placeholder: 'Coming in OGX-3 — document upload/download and the owner self-upload link will live here.' },
  { key: 'sale', label: 'Sale Inventory' },
  { key: 'rent', label: 'Rent Inventory' },
]

function fmtMoney(n: number | null | undefined) { return n == null ? null : `€${Number(n).toLocaleString()}` }

function PropertyRow({ p }: { p: any }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-off-white last:border-0 text-sm">
      <div>
        <span className="font-mono font-semibold text-navy">{p.ref}</span>
        <span className="text-navy/40 text-xs ml-2">{p.town}{p.sub_location ? `, ${p.sub_location}` : ''}</span>
        {(p.bedrooms != null || p.bathrooms != null) && (
          <span className="text-navy/40 text-xs ml-2">{p.bedrooms ?? '—'}bd/{p.bathrooms ?? '—'}ba</span>
        )}
      </div>
      <div className="text-right">
        <div className="text-xs">
          {p.available_status === 'available' || p.available_status === 'available_confirmed'
            ? <span className="text-green-700 font-semibold">on market</span>
            : p.available_status === 'rented'
            ? <span className="text-red-600 font-semibold">rented</span>
            : <span className="text-navy/40">{p.available_status || 'unknown'}</span>}
        </div>
        <div className="text-[11px] text-navy/40">
          {p.longlet_price ? `${fmtMoney(p.longlet_price)}/mo` : ''}{p.sale_price ? ` · ${fmtMoney(p.sale_price)} sale` : ''}
        </div>
      </div>
    </div>
  )
}

function PreferenceRow({ r }: { r: any }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-off-white last:border-0 text-xs">
      <span><strong className="text-navy">{r.field}</strong>: {r.value}</span>
      <span className={r.is_explicit ? 'text-gold font-semibold' : 'text-navy/40'}>
        {r.is_explicit ? 'explicit' : `inferred (${Math.round((r.confidence || 0) * 100)}%, ×${r.sample_count})`}
      </span>
    </div>
  )
}

// ── Property Maps tab ────────────────────────────────────────────────────
function PropertyMapTab({ properties }: { properties: any[] }) {
  const mapRef = useRef<HTMLDivElement>(null)
  const [mapsKey, setMapsKey] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'no-key' | 'no-locations'>('loading')

  useEffect(() => {
    crmFetch('schedule-board/config').then(d => setMapsKey((d && d.mapsKey) || '')).catch(() => setMapsKey(''))
  }, [])

  useEffect(() => {
    if (mapsKey === null) return
    if (!mapsKey) { setStatus('no-key'); return }
    if (!mapRef.current) return

    // Deterministic town-centre + fan-out, same primitives the Schedule
    // Board's own map uses (lib/crm/towns.ts) — no per-property lat/lng
    // exists in the database by design (village-level precision only).
    const byTown: Record<string, any[]> = {}
    for (const p of properties) {
      const k = townKey(p.town) || '_unknown'
      ;(byTown[k] ||= []).push(p)
    }
    const points: { ref: string; lat: number; lng: number; label: string }[] = []
    for (const [k, list] of Object.entries(byTown)) {
      const base = k === '_unknown' ? null : TOWNS[k]
      if (!base) continue
      list.forEach((p, i) => {
        const pos = spread(base, i, list.length)
        points.push({ ref: p.ref, lat: pos.lat, lng: pos.lng, label: `${p.ref} — ${p.town}` })
      })
    }
    if (!points.length) { setStatus('no-locations'); return }

    function initMap() {
      const g = (window as any).google
      if (!g || !mapRef.current) return
      const map = new g.maps.Map(mapRef.current, {
        center: { lat: points[0].lat, lng: points[0].lng },
        zoom: points.length > 1 ? 12 : 14,
      })
      const bounds = new g.maps.LatLngBounds()
      for (const pt of points) {
        const marker = new g.maps.Marker({ position: { lat: pt.lat, lng: pt.lng }, map, title: pt.label })
        const info = new g.maps.InfoWindow({ content: pt.label })
        marker.addListener('click', () => info.open(map, marker))
        bounds.extend({ lat: pt.lat, lng: pt.lng })
      }
      if (points.length > 1) map.fitBounds(bounds)
      setStatus('ready')
    }

    if ((window as any).google?.maps) { initMap(); return }
    const existing = document.getElementById('owner-map-script')
    if (existing) { existing.addEventListener('load', initMap); return }
    const s = document.createElement('script')
    s.id = 'owner-map-script'
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}`
    s.async = true
    s.onload = initMap
    document.head.appendChild(s)
  }, [mapsKey, properties])

  if (status === 'no-key') return <p className="text-sm text-navy/40">Maps key not configured.</p>
  if (status === 'no-locations') return <p className="text-sm text-navy/40">None of this owner's properties have a recognised town, so no pins to show.</p>
  return <div ref={mapRef} style={{ width: '100%', height: 360, borderRadius: 10, background: '#EEE' }} />
}

function DetailContent({ id }: { id: number }) {
  const router = useRouter()
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('properties')
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
      load()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not schedule outreach')
    } finally { setScheduling(false) }
  }

  if (err) return <div className="text-sm text-red-600">{err}</div>
  if (!data) return <p className="text-sm text-navy/40">Loading…</p>

  const properties: any[] = data.properties || []
  const saleProperties = properties.filter(p => p.sale_price != null)
  const rentProperties = properties.filter(p => p.longlet_price != null || p.shortlet)
  const comparison = data.preferenceComparison || { general: [], byProperty: [] }

  return (
    <div>
      <button className={GHOST + ' mb-3'} onClick={() => router.push('/ownergroups')}>← Back to Ownergroups</button>
      <h2 className="font-bold text-lg text-navy mb-1">{data.ownerContact?.name || data.state?.owner_phone || 'Owner'}</h2>
      <p className="text-xs text-navy/40 mb-4">{data.state?.session} · {data.state?.chat_id}</p>

      <div className="flex flex-wrap gap-1 mb-4 border-b border-navy/10">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === t.key ? 'border-gold text-navy' : 'border-transparent text-navy/40 hover:text-navy'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'properties' && (
        <div className="rounded-lg border border-navy/10 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">All properties ({properties.length})</h3>
          {properties.map(p => <PropertyRow key={p.id} p={p} />)}
          {!properties.length && <p className="text-sm text-navy/30">No properties on file for this owner.</p>}

          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mt-6 mb-3">Preference comparison (OG-4)</h3>
          <div className="mb-3">
            <div className="text-[11px] font-semibold text-navy/50 mb-1">General (applies to every property)</div>
            {comparison.general.map((r: any) => <PreferenceRow key={r.id} r={r} />)}
            {!comparison.general.length && <p className="text-xs text-navy/30">Nothing general captured yet.</p>}
          </div>
          {comparison.byProperty.map((grp: any) => (
            <div key={grp.propertyId} className="mb-3">
              <div className="text-[11px] font-semibold text-gold mb-1">Specific to {grp.propertyRef}</div>
              {grp.preferences.map((r: any) => <PreferenceRow key={r.id} r={r} />)}
            </div>
          ))}
          {!comparison.byProperty.length && !comparison.general.length && (
            <p className="text-xs text-navy/30">No preference card yet — opens automatically on repeated positive feedback, !upload, or a reminder/positive reply after outreach (OG-4).</p>
          )}

          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mt-6 mb-3">Schedule outreach</h3>
          <textarea className={FIELD + ' mb-2'} rows={3} placeholder="Message text…" value={msgText} onChange={e => setMsgText(e.target.value)} />
          <input type="datetime-local" className={FIELD + ' mb-2'} value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} />
          <button className={PRIMARY} disabled={scheduling || !msgText.trim() || !scheduledFor} onClick={scheduleOutreach}>
            {scheduling ? 'Scheduling…' : 'Schedule'}
          </button>
          {(data.campaigns || []).length > 0 && (
            <div className="mt-3 space-y-1">
              {data.campaigns.map((c: any) => (
                <div key={c.id} className="text-xs py-1 border-t border-off-white">{new Date(c.scheduled_for).toLocaleString()} · {c.status}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'contacts' && (
        <div className="rounded-lg border border-navy/10 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">Owner contact</h3>
          <div className="text-sm mb-4">
            <div>Name: <strong>{data.ownerContact?.name || '—'}</strong></div>
            <div>Phone: <strong>{data.ownerContact?.phone_normalized || '—'}</strong></div>
            <div>Email: <strong>{data.ownerContact?.email || '—'}</strong></div>
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">WA accounts talking to this owner</h3>
          {(data.contacts || []).map((c: any, i: number) => (
            <div key={i} className="flex justify-between text-xs py-1.5 border-b border-off-white last:border-0">
              <span className="font-semibold">{c.account_session}</span>
              <span className="text-navy/50">{c.label} · in {c.total_msgs_in} / out {c.total_msgs_out}</span>
            </div>
          ))}
          {!(data.contacts || []).length && <p className="text-xs text-navy/30">No account/label history yet.</p>}
        </div>
      )}

      {tab === 'map' && (
        <div className="rounded-lg border border-navy/10 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">Where this owner's properties are</h3>
          <PropertyMapTab properties={properties} />
        </div>
      )}

      {(tab === 'flows' || tab === 'credentials') && (
        <div className="rounded-lg border border-dashed border-navy/15 p-6 text-center">
          <p className="text-sm text-navy/40">{TABS.find(t => t.key === tab)?.placeholder}</p>
        </div>
      )}

      {tab === 'sale' && (
        <div className="rounded-lg border border-navy/10 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">Sale inventory ({saleProperties.length})</h3>
          {saleProperties.map(p => <PropertyRow key={p.id} p={p} />)}
          {!saleProperties.length && <p className="text-sm text-navy/30">Nothing listed for sale.</p>}
        </div>
      )}

      {tab === 'rent' && (
        <div className="rounded-lg border border-navy/10 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">Rent inventory ({rentProperties.length})</h3>
          {rentProperties.map(p => <PropertyRow key={p.id} p={p} />)}
          {!rentProperties.length && <p className="text-sm text-navy/30">Nothing listed for rent.</p>}
        </div>
      )}
    </div>
  )
}

function OwnerProfileInner() {
  const { me } = useCrm()
  const params = useParams()
  const id = Number(params?.id)

  if (me && me.role !== 'admin') {
    return <CrmShell title="Owner profile" subtitle="Admins only"><p className="text-sm text-navy/40">This page is admin-only.</p></CrmShell>
  }
  if (!id || Number.isNaN(id)) {
    return <CrmShell title="Owner profile"><p className="text-sm text-red-600">Invalid owner id.</p></CrmShell>
  }
  return (
    <CrmShell title="Owner profile">
      <DetailContent id={id} />
    </CrmShell>
  )
}

export default function OwnerProfilePage() {
  return <CrmProvider><OwnerProfileInner /></CrmProvider>
}
