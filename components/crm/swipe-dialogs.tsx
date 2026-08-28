'use client'
// components/crm/swipe-dialogs.tsx — Swipe Boards, agent-authenticated half.
// Two pieces: the "here's your link" confirmation after creating one, and
// the results panel (every link this agent made, who liked what, and the
// availability-check outcome each like triggered). The public swipe/like
// page itself is app/[locale]/swipe/[id]/page.tsx; a like there calls the
// same requestOwnerAvailability/listingAgentNotify path the board's own
// "Request Availability" button uses — nothing new to explain here, the
// av_status column already says what happened.
import { useState, useEffect } from 'react'
import { X, Copy, Check, Link2, Heart } from 'lucide-react'
import { crmJson } from '@/lib/crm/api'
import { A, AD, NAVY, F, FM } from '@/lib/crm/ui'

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(27,42,74,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16,
}
const sheet: React.CSSProperties = {
  background: '#FFF', borderRadius: 16, width: '100%', maxWidth: 480,
  maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
  fontFamily: F, boxShadow: '0 24px 60px rgba(27,42,74,0.25)',
}
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 18px', borderBottom: '1px solid #EDEBE5',
}

// ── "your link is ready" ─────────────────────────────────────────────────
export function SwipeLinkCreatedModal({ url, count, onClose }: { url: string; count: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { /* clipboard blocked — the field itself is still selectable */ }
  }
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...sheet, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#1A1A1A', fontSize: 14 }}>
            <Link2 size={16} color={A} /> Swipe link ready
          </div>
          <button onClick={onClose} style={{ border: 0, background: 'none', cursor: 'pointer', color: '#999' }}><X size={18} /></button>
        </div>
        <div style={{ padding: 20 }}>
          <p style={{ fontSize: 12.5, color: '#666', margin: '0 0 14px' }}>
            {count} listing{count === 1 ? '' : 's'} in the deck. Share this with a customer —
            they swipe through, and anything they like gets checked for availability automatically.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={url} onFocus={e => e.currentTarget.select()}
              style={{
                flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 10, border: '1px solid #E9E5DC',
                fontFamily: FM, fontSize: 12, color: '#333', background: '#FAFAF7',
              }} />
            <button onClick={copy} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderRadius: 10,
              border: 'none', background: copied ? '#DCFCE7' : NAVY, color: copied ? '#15803D' : '#FFF',
              fontWeight: 700, fontSize: 12, cursor: 'pointer', flexShrink: 0,
            }}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── results: every link + who liked what ─────────────────────────────────
type LinkRow = { id: string; title: string | null; created_at: string; active: boolean; property_count: number; like_count: number; visitor_count: number }
type LinkDetail = {
  id: string; title: string | null; url: string
  properties: { id: number; ref: string; town: string | null; bedrooms: number | null }[]
  likes: { property_id: number; visitor_id: string; liked_at: string; av_status: string | null; av_message: string | null; contact_name: string | null; contact_phone: string | null }[]
}

const AV_LABEL: Record<string, string> = {
  sent: 'Owner asked', dry_run: 'Owner would be asked (test mode)', sent_shortcut: 'Answered instantly (already confirmed)',
  already_checked_today: 'Owner already asked today', no_owner: 'No owner on file', no_owner_phone: 'No owner phone on file',
  no_account: 'No account free to send from', relayed: 'Sent to listing agent', no_creator_agent: 'Link owner inactive',
  listing_agent_unavailable: 'Listing agent unavailable', error: 'Something went wrong', not_found: 'Listing not found',
}
function avLabel(status: string | null) {
  if (!status) return '—'
  return AV_LABEL[status] || status.replace(/_/g, ' ')
}

export function SwipeLinksPanel({ onClose }: { onClose: () => void }) {
  const [links, setLinks] = useState<LinkRow[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LinkDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    crmJson('schedule-board/swipe-links', 'GET').then(d => setLinks(d.links || [])).catch(e => setErr(e?.message || 'Could not load'))
  }, [])

  useEffect(() => {
    if (!openId) { setDetail(null); return }
    crmJson(`schedule-board/swipe-links/${encodeURIComponent(openId)}`, 'GET').then(setDetail).catch(() => setDetail(null))
  }, [openId])

  const refOf = (id: number) => detail?.properties.find(p => p.id === id)

  return (
    <div style={overlay} onClick={onClose}>
      <div style={sheet} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#1A1A1A', fontSize: 14 }}>
            {openId && (
              <button onClick={() => setOpenId(null)} style={{ border: 0, background: 'none', cursor: 'pointer', color: A, fontWeight: 700, fontSize: 12, padding: 0 }}>← Back</button>
            )}
            <Link2 size={16} color={A} /> {openId ? (detail?.title || 'Swipe link') : 'Your swipe links'}
          </div>
          <button onClick={onClose} style={{ border: 0, background: 'none', cursor: 'pointer', color: '#999' }}><X size={18} /></button>
        </div>

        <div style={{ overflowY: 'auto', padding: 4 }}>
          {err && <div style={{ padding: 20, color: '#B91C1C', fontSize: 12.5 }}>{err}</div>}

          {!openId && links && links.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>
              No swipe links yet. Pick some listings on the board and hit "Swipe Link".
            </div>
          )}

          {!openId && links && links.map(l => (
            <button key={l.id} onClick={() => setOpenId(l.id)} style={{
              width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '13px 18px', border: 0, borderBottom: '1px solid #F2F0EA', background: '#FFF', cursor: 'pointer',
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#1A1A1A' }}>
                  {l.title || `${l.property_count} listing${l.property_count === 1 ? '' : 's'}`}
                  {!l.active && <span style={{ marginLeft: 8, fontSize: 10, color: '#B91C1C', fontWeight: 700 }}>PAUSED</span>}
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  {new Date(l.created_at).toLocaleDateString([], { day: '2-digit', month: 'short' })} · {l.property_count} listings
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: l.like_count ? A : '#CCC', fontWeight: 700, fontSize: 13 }}>
                <Heart size={14} fill={l.like_count ? A : 'none'} /> {l.like_count}
                <span style={{ fontSize: 10, color: '#BBB', fontWeight: 400, marginLeft: 2 }}>({l.visitor_count} visitor{l.visitor_count === 1 ? '' : 's'})</span>
              </div>
            </button>
          ))}

          {openId && !detail && <div style={{ padding: 40, textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>Loading…</div>}

          {openId && detail && (
            <div style={{ padding: '4px 18px 18px' }}>
              <div style={{ fontSize: 11, color: '#999', margin: '10px 0 14px', fontFamily: FM, wordBreak: 'break-all' }}>{detail.url}</div>
              {detail.likes.length === 0 ? (
                <div style={{ padding: '30px 0', textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>No likes yet.</div>
              ) : detail.likes.map((lk, i) => (
                <div key={i} style={{ padding: '11px 0', borderBottom: i < detail.likes.length - 1 ? '1px solid #F2F0EA' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: '#1A1A1A' }}>
                      #{refOf(lk.property_id)?.ref || lk.property_id} {refOf(lk.property_id)?.town ? `— ${refOf(lk.property_id)?.town}` : ''}
                    </span>
                    <span style={{ fontSize: 10.5, color: '#999' }}>{new Date(lk.liked_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: A, marginTop: 3, fontWeight: 600 }}>{avLabel(lk.av_status)}</div>
                  {(lk.contact_name || lk.contact_phone) && (
                    <div style={{ fontSize: 11.5, color: '#666', marginTop: 3 }}>
                      Left contact: {[lk.contact_name, lk.contact_phone].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
