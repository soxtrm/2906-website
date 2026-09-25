'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch } from '@/lib/crm/api'
import {
  CrmProvider, CrmShell, OwnerPanel, Masked, A, AD, AB, F, FM, fmtDate, useIsMobile,
  DCARD, DCARD_BORDER, DTRAY, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER,
} from '@/lib/crm/ui'

export default function OwnersPage() {
  return <CrmProvider><Owners /></CrmProvider>
}

function Owners() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<any[]>([])
  const [search, setSearch] = useState('')
  const [panel, setPanel] = useState<number | null>(null)

  const load = useCallback(() => {
    const q = search ? `?search=${encodeURIComponent(search)}` : ''
    crmFetch(`owners${q}`).then(d => setRows(d.owners || [])).catch(() => {})
  }, [search])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  const thS: React.CSSProperties = { padding: '9px 16px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: DTEXT_FAINT, letterSpacing: '0.12em', textTransform: 'uppercase', borderBottom: `1px solid ${DBORDER}`, background: DTRAY, position: 'sticky', top: 0, zIndex: 5, whiteSpace: 'nowrap', fontFamily: F }
  const tdS: React.CSSProperties = { padding: '13px 16px', verticalAlign: 'middle', borderBottom: `1px solid ${DBORDER}` }

  const filterBar = (
    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search owners by name or phone..."
      style={{ flex: 1, background: '#0E1420', border: `1px solid ${DBORDER}`, borderRadius: 7, padding: '6px 12px', fontSize: 12, color: DTEXT, fontFamily: F, width: isMobile ? '100%' : 320, outline: 'none' }} />
  )

  return (
    <CrmShell title="Owner Database" subtitle={`${rows.length} shown · 4,200+ in database`} onAdd={() => router.push('/property/new')} filterBar={filterBar} dark>
      {panel != null && <OwnerPanel ownerId={panel} onClose={() => setPanel(null)} />}
      {isMobile ? (
        <div style={{ padding: '12px 14px' }}>
          {rows.map(o => (
            <div key={o.id} style={{ background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 12, marginBottom: 8, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 11, background: `linear-gradient(135deg,${AD},rgba(212,137,26,0.05))`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: `1px solid ${AB}` }}>
                <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--crm-accent)', fontFamily: F }}>{(o.name || '?')[0]}</span>
              </div>
              <div style={{ flex: 1 }} onClick={() => setPanel(o.id)}>
                <div style={{ fontSize: 14, fontWeight: 700, color: DTEXT, fontFamily: F, borderBottom: `1px dashed ${AB}`, display: 'inline', cursor: 'pointer' }}>{o.name || 'Unnamed'}</div>
                <div style={{ fontSize: 10, color: DTEXT_FAINT, marginTop: 3, fontFamily: FM }}>ON-{String(o.id).padStart(3, '0')}</div>
                <div style={{ marginTop: 5 }}><Masked entityType="owner_phone" entityId={o.id} masked={o.phoneMasked} hasValue={o.hasPhone} size={11} /></div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: DTEXT, fontFamily: F }}>{o.props}</div>
                <div style={{ fontSize: 9, color: DTEXT_FAINT, fontFamily: F }}>listings</div>
                <div style={{ marginTop: 5 }}><span style={{ background: AD, border: `1px solid ${AB}`, color: 'var(--crm-accent)', borderRadius: 4, padding: '2px 7px', fontSize: 9, fontWeight: 700, fontFamily: F }}>{o.by || '—'}</span></div>
              </div>
            </div>
          ))}
          {!rows.length && <div style={{ padding: 40, textAlign: 'center', color: DTEXT_FAINT, fontFamily: F }}>No owners found.</div>}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Name', 'Contact', 'Email', 'Owner ID', 'Properties', 'Created by', ''].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map(o => (
              <tr key={o.id} style={{ background: DCARD, borderBottom: `1px solid ${DBORDER}` }}>
                <td style={{ ...tdS, fontSize: 14 }}>
                  <div style={{ fontWeight: 700, color: DTEXT, cursor: 'pointer', borderBottom: `1px dashed ${AB}`, display: 'inline-block' }} onClick={() => setPanel(o.id)}>{o.name || 'Unnamed'}</div>
                  <div style={{ fontSize: 10, color: DTEXT_FAINT, marginTop: 2, fontFamily: FM }}>ON-{String(o.id).padStart(3, '0')}</div>
                </td>
                <td style={tdS}><Masked entityType="owner_phone" entityId={o.id} masked={o.phoneMasked} hasValue={o.hasPhone} /></td>
                <td style={tdS}><Masked entityType="owner_email" entityId={o.id} masked={o.emailMasked} hasValue={o.hasEmail} /></td>
                <td style={{ ...tdS, fontFamily: FM, fontSize: 11, color: DTEXT_FAINT }}>ON-{String(o.id).padStart(3, '0')}</td>
                <td style={{ ...tdS, textAlign: 'center', fontWeight: 800, fontSize: 16, color: DTEXT }}>{o.props}</td>
                <td style={tdS}><span style={{ background: AD, border: `1px solid ${AB}`, color: 'var(--crm-accent)', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>{o.by || '—'}</span></td>
                <td style={tdS}><button onClick={() => router.push(`/owner/${o.id}`)} style={{ background: A, color: '#151C2C', border: 'none', borderRadius: 7, padding: '6px 13px', fontSize: 11, cursor: 'pointer', fontFamily: F, fontWeight: 700 }}>View →</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: DTEXT_FAINT, fontFamily: F }}>No owners found.</td></tr>}
          </tbody>
        </table>
      )}
    </CrmShell>
  )
}
