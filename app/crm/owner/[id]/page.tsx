'use client'
import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch } from '@/lib/crm/api'
import { CrmProvider, CrmShell, Masked, Pill, Thumbs, AVAIL, A, AD, AB, F, FM, fmtMoney, fmtDate } from '@/lib/crm/ui'

export default function OwnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CrmProvider><OwnerDetail id={parseInt(id)} /></CrmProvider>
}

function OwnerDetail({ id }: { id: number }) {
  const router = useRouter()
  const [d, setD] = useState<any>(null)
  useEffect(() => { crmFetch(`owners/${id}`).then(setD).catch(() => {}) }, [id])
  const o = d?.owner
  const props = d?.properties || []

  return (
    <CrmShell title={o?.name || 'Owner'} subtitle={o ? `ON-${String(o.id).padStart(3, '0')}` : undefined} onAdd={() => router.push('/property/new')}>
      <div style={{ padding: 26, fontFamily: F, maxWidth: 900 }}>
        <div style={{ marginBottom: 14 }}><button onClick={() => router.push('/owners')} style={back}>← Owners</button></div>
        {!o && <div style={{ color: '#BBB' }}>Loading…</div>}
        {o && (
          <>
            {/* Created-by — prominent */}
            <div style={{ background: '#131313', borderRadius: 14, padding: '18px 22px', color: '#FFF', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 9, color: '#777', letterSpacing: '0.14em', textTransform: 'uppercase' }}>🔑 Owner Creator</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: A, marginTop: 4, letterSpacing: '-0.02em' }}>{o.createdBy || 'Unattributed'}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>In system since {fmtDate(o.since)} · receives Owner-Bonus on all properties</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 30, fontWeight: 800 }}>{props.length}</div>
                <div style={{ fontSize: 10, color: '#888' }}>properties</div>
              </div>
            </div>

            {/* contact */}
            <div style={{ background: '#FFF', borderRadius: 14, padding: '18px 22px', marginTop: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>Contact</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: '#AAA', minWidth: 44 }}>Phone</span>
                <Masked entityType="owner_phone" entityId={o.id} masked={o.phoneMasked} hasValue={o.hasPhone} size={13} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, color: '#AAA', minWidth: 44 }}>Email</span>
                <Masked entityType="owner_email" entityId={o.id} masked={o.emailMasked} hasValue={o.hasEmail} size={13} />
              </div>
            </div>

            {/* properties */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>Properties ({props.length})</div>
              {props.map((l: any) => (
                <div key={l.id} onClick={() => router.push(`/property/${l.id}`)} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 16px', background: '#FFF', borderRadius: 12, marginBottom: 8, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', borderLeft: l.exclusive ? `4px solid ${A}` : '4px solid transparent' }}>
                  <Thumbs images={l.images} count={l.imageCount} exclusive={l.exclusive} w={68} h={46} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: A, fontFamily: FM }}>{l.ref}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1A1A1A', marginTop: 1 }}>{l.location.town} · {l.type}</div>
                    <div style={{ marginTop: 5 }}><Pill status={l.availableStatus} map={AVAIL} small /></div>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 16, color: '#0F0F0F', whiteSpace: 'nowrap' }}>{l.prices.longlet ? `${fmtMoney(l.prices.longlet)}/mo` : (l.prices.sale ? fmtMoney(l.prices.sale) : '—')}</div>
                </div>
              ))}
              {!props.length && <div style={{ color: '#BBB', fontSize: 13 }}>No visible properties for this owner.</div>}
            </div>
          </>
        )}
      </div>
    </CrmShell>
  )
}

const back: React.CSSProperties = { background: '#F4F2EC', border: '1px solid #E8E4DA', borderRadius: 8, padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: F, color: '#888', fontWeight: 600 }
