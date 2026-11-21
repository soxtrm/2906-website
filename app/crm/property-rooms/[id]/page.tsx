'use client'
// CRM: NEXUS Rooms of one property (2026-11-21). The same rooms screen owners have in NEXUS Sync, for agents who
// manage homes whose owners do not use Sync. Admins and the listing agent edit; other staff read.
import { use } from 'react'
import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { RoomsManager, type RoomsApi } from '@/components/owner/rooms-manager'
import '@/components/rooms/rooms.css'
import '@/app/owner/live.css'

function crmApi(id: number): RoomsApi {
  return async (op, body) => {
    try {
      const base = `property-rooms/${id}`
      const out = op === 'owner/rooms' ? await crmFetch(base)
        : op === 'owner/rooms/stays' ? await crmFetch(`${base}/stays`)
        : op === 'owner/rooms/decide' ? await crmJson(`${base}/stays/${encodeURIComponent(String(body.stayId))}/decide`, 'POST', body)
        : await crmJson(`${base}/${op.split('/').pop()}`, 'POST', body)
      return { ok: true, ...out }
    } catch (e: any) {
      return { ok: false, error: e?.data?.error || 'FAILED', message: e?.data?.message || e?.message || 'Request failed', status: e?.status || 0 }
    }
  }
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const pid = Number(id)
  return (
    <CrmProvider>
      <CrmShell title="Rooms" subtitle="Rooms of one home: prices, statuses, photos, layout and requests from NEXUS Booking">
        <div className="lv" style={{ maxWidth: 980 }}><RoomsManager propertyId={pid} readOnly={false} api={crmApi(pid)} /></div>
      </CrmShell>
    </CrmProvider>
  )
}
