'use client'
// "Get Owner Info" for a booking request (Kev, 2026-11-21). Shown next to
// Create Group to staff who may create owner groups; the server decides who
// really gets the contact (admins and agents with can_view_owner_contact) and
// logs every opening. A request stays a request: seeing the number is not the
// owner's OK.
import { useState } from 'react'
import { Phone, X } from 'lucide-react'
import { crmFetch } from '@/lib/crm/api'

type Info = { ref: string; town: string | null; bookingState: string; owner: { name: string | null; phone: string | null; doNotContact: boolean }; note: string }

export function OwnerInfoButton({ viewingId, className, style, label = 'Get Owner Info' }: { viewingId: number; className?: string; style?: React.CSSProperties; label?: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function open() {
    setBusy(true); setErr(null)
    try { setInfo(await crmFetch(`viewing-followups/by-viewing/${viewingId}/owner-info`)) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Owner details could not be opened.') }
    finally { setBusy(false) }
  }
  const digits = info?.owner.phone?.replace(/\D/g, '') || ''
  return (
    <>
      <button type="button" onClick={open} disabled={busy} className={className} style={style} title="Show the owner's contact for this booking request (logged)">
        <Phone className="w-3 h-3" style={{ display: 'inline', marginRight: 4 }} />{busy ? 'Opening…' : label}
      </button>
      {(info || err) && (
        <div role="dialog" aria-modal="true" aria-label="Owner information" onClick={() => { setInfo(null); setErr(null) }}
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(5,8,16,.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px, 100%)', borderRadius: 18, background: '#121A29', color: '#F4F1E9', border: '1px solid rgba(255,255,255,.1)', padding: 20, boxShadow: '0 24px 70px rgba(0,0,0,.4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <b style={{ fontSize: 16 }}>Owner information</b>
              <button type="button" aria-label="Close" onClick={() => { setInfo(null); setErr(null) }} style={{ background: 'transparent', border: 0, color: '#9AA4B8', cursor: 'pointer' }}><X size={18} /></button>
            </div>
            {err && <p style={{ color: '#F87171', marginTop: 12 }}>{err}</p>}
            {info && (
              <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
                <div style={{ color: '#9AA4B8', fontSize: 13 }}>#{info.ref}{info.town ? ` · ${info.town}` : ''} · booking {info.bookingState === 'confirmed' ? 'confirmed by the owner' : 'requested, not yet confirmed'}</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{info.owner.name || 'Owner'}</div>
                {info.owner.phone && <div style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{info.owner.phone}</div>}
                {info.owner.doNotContact && <div style={{ padding: '8px 10px', borderRadius: 10, background: 'rgba(251,191,36,.12)', color: '#FBBF24', fontSize: 13 }}>Marked do-not-contact.</div>}
                {digits && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <a href={`tel:+${digits}`} style={{ padding: '8px 14px', borderRadius: 10, background: '#7770FF', color: '#fff', textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>Call</a>
                    <a href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer" style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,.15)', color: '#F4F1E9', textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>WhatsApp</a>
                  </div>
                )}
                <p style={{ color: '#9AA4B8', fontSize: 12, margin: 0 }}>{info.note}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
