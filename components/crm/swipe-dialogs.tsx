'use client'
// components/crm/swipe-dialogs.tsx — Swipe Boards, agent-authenticated half.
// Two pieces: the "here's your link" confirmation after creating one, and
// the results panel (every link this agent made, who liked/favourited
// what). The public swipe page (app/[locale]/swipe/[id]/page.tsx) never
// contacts the owner by itself — a like or favourite there just records the
// pick (routes/swipe.js). This panel is the agent's overview of those
// picks; Chat/Book below act on them deliberately, same as the board.
import { useState, useEffect } from 'react'
import { X, Copy, Check, Link2, Heart, Star, MessageCircle, CalendarPlus } from 'lucide-react'
import { crmJson } from '@/lib/crm/api'
import { A, AD, NAVY, F, FM } from '@/lib/crm/ui'

// Green = "available to act on" everywhere else in the CRM (lib/crm/ui.tsx
// AVAIL.available) — reused verbatim so this reads as the same system, not a
// new one.
const GREEN = '#15803D', GREEN_BG = '#DCFCE7'
const GOLD = '#B8953F'

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

// ── results: every link + who liked/favourited what ───────────────────────
type LinkRow = { id: string; title: string | null; created_at: string; active: boolean; property_count: number; like_count: number; favourite_count: number; visitor_count: number }
type LinkDetail = {
  id: string; title: string | null; url: string
  properties: { id: number; ref: string; town: string | null; bedrooms: number | null }[]
  // kind: 'favourite' (star) ranks above 'like' (heart) — the backend already
  // sorts favourites first; this panel just renders that order.
  likes: { property_id: number; visitor_id: string; liked_at: string; kind: 'like' | 'favourite'; contact_name: string | null; contact_phone: string | null }[]
}

export function SwipeLinksPanel({
  onClose, onBook, onChat, isOnBoard,
}: {
  onClose: () => void
  // Kev, 2026-08-29: these must produce EXACTLY what the board's own
  // Chat/Book buttons produce — so this panel never opens a dialog itself,
  // it just hands the ref to the page's real setBooking/setChatting (the
  // same functions the board's cards and the ?ref=&action= deep link use).
  onBook: (ref: string) => void
  onChat: (ref: string) => void
  isOnBoard: (ref: string) => boolean
}) {
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: l.favourite_count ? GOLD : '#CCC' }}>
                  <Star size={13} fill={l.favourite_count ? GOLD : 'none'} /> {l.favourite_count}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: l.like_count ? '#EF4444' : '#CCC' }}>
                  <Heart size={13} fill={l.like_count ? '#EF4444' : 'none'} /> {l.like_count}
                </span>
                <span style={{ fontSize: 10, color: '#BBB', fontWeight: 400 }}>({l.visitor_count} visitor{l.visitor_count === 1 ? '' : 's'})</span>
              </div>
            </button>
          ))}

          {openId && !detail && <div style={{ padding: 40, textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>Loading…</div>}

          {openId && detail && (
            <div style={{ padding: '4px 18px 18px' }}>
              <div style={{ fontSize: 11, color: '#999', margin: '10px 0 14px', fontFamily: FM, wordBreak: 'break-all' }}>{detail.url}</div>
              {detail.likes.length === 0 ? (
                <div style={{ padding: '30px 0', textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>No likes yet.</div>
              ) : detail.likes.map((lk, i) => {
                const ref = refOf(lk.property_id)?.ref
                const onBoard = ref ? isOnBoard(ref) : false
                return (
                <div key={i} style={{ padding: '11px 0', borderBottom: i < detail.likes.length - 1 ? '1px solid #F2F0EA' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, color: '#1A1A1A' }}>
                      {lk.kind === 'favourite'
                        ? <Star size={13} fill={GOLD} color={GOLD} />
                        : <Heart size={13} fill="#EF4444" color="#EF4444" />}
                      #{ref || lk.property_id} {refOf(lk.property_id)?.town ? `— ${refOf(lk.property_id)?.town}` : ''}
                    </span>
                    <span style={{ fontSize: 10.5, color: '#999' }}>{new Date(lk.liked_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  {(lk.contact_name || lk.contact_phone) && (
                    <div style={{ fontSize: 11.5, color: '#666', marginTop: 3 }}>
                      Left contact: {[lk.contact_name, lk.contact_phone].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {ref && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        type="button"
                        disabled={!onBoard}
                        onClick={() => onChat(ref)}
                        title={onBoard ? undefined : 'Not currently on the board'}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6,
                          border: `1px solid ${onBoard ? GREEN : '#E5E5E5'}`, background: onBoard ? GREEN_BG : '#F7F7F5',
                          color: onBoard ? GREEN : '#BBB', fontWeight: 700, fontSize: 11.5, fontFamily: F,
                          cursor: onBoard ? 'pointer' : 'not-allowed',
                        }}>
                        <MessageCircle size={12} /> Chat
                      </button>
                      <button
                        type="button"
                        disabled={!onBoard}
                        onClick={() => onBook(ref)}
                        title={onBoard ? undefined : 'Not currently on the board'}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6,
                          border: `1px solid ${onBoard ? GREEN : '#E5E5E5'}`, background: onBoard ? GREEN_BG : '#F7F7F5',
                          color: onBoard ? GREEN : '#BBB', fontWeight: 700, fontSize: 11.5, fontFamily: F,
                          cursor: onBoard ? 'pointer' : 'not-allowed',
                        }}>
                        <CalendarPlus size={12} /> Book
                      </button>
                    </div>
                  )}
                </div>
              )})}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── MATCH — Property -> Clients (Kev's Prompt B, 2026-08-29) ────────────────
// Same engine as Client -> Properties (services/matchEngine.js), reached
// here from a property card's own MATCH button. Score + a plain-language
// reason list per client, so the agent can see AT A GLANCE whether the
// recommendation makes sense rather than trusting a bare percentage.
type MatchReason = { key: string; ok: boolean | null; label: string }
type MatchRow = { clientId: string; clientName: string; clientPhone: string | null; leadAgent: string | null; score: number; reasons: MatchReason[] }

function reasonGlyph(ok: boolean | null) {
  if (ok === true) return { sym: '✓', color: GREEN }
  if (ok === false) return { sym: '✗', color: '#B91C1C' }
  return { sym: '~', color: '#B8953F' }
}

export function MatchResultsPanel({ propertyRef, onClose }: { propertyRef: string; onClose: () => void }) {
  const [matches, setMatches] = useState<MatchRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [shareBusy, setShareBusy] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    crmJson(`schedule-board/property-matches/${encodeURIComponent(propertyRef)}`, 'GET')
      .then(d => setMatches(d.matches || []))
      .catch(e => setErr(e?.message || 'Could not load matches'))
  }, [propertyRef])

  // Reuses the SAME persistent, tokenised property link every time (Kev's
  // Prompt A) — nothing new is generated per click, per client, or per share.
  const share = async () => {
    setShareBusy(propertyRef)
    try {
      const d = await crmJson(`schedule-board/property-link/${encodeURIComponent(propertyRef)}`, 'GET')
      setShareUrl(d.url)
    } catch (e: any) {
      setErr(e?.message || 'Could not create the share link')
    } finally {
      setShareBusy(null)
    }
  }
  const copy = async () => {
    if (!shareUrl) return
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { /* clipboard blocked — the field itself is still selectable */ }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={sheet} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#1A1A1A', fontSize: 14 }}>
            🎯 Matching clients for #{propertyRef}
          </div>
          <button onClick={onClose} style={{ border: 0, background: 'none', cursor: 'pointer', color: '#999' }}><X size={18} /></button>
        </div>

        <div style={{ padding: '10px 18px 6px' }}>
          {!shareUrl ? (
            <button onClick={share} disabled={!!shareBusy} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8,
              border: `1px solid ${A}`, background: '#FFF', color: A, fontWeight: 700, fontSize: 12, fontFamily: F,
              cursor: shareBusy ? 'wait' : 'pointer',
            }}>
              <Link2 size={13} /> {shareBusy ? 'Getting link…' : 'Get share link for this listing'}
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={shareUrl} onFocus={e => e.currentTarget.select()}
                style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, border: '1px solid #E9E5DC', fontFamily: FM, fontSize: 11.5, color: '#333', background: '#FAFAF7' }} />
              <button onClick={copy} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: 'none',
                background: copied ? GREEN_BG : NAVY, color: copied ? GREEN : '#FFF', fontWeight: 700, fontSize: 12, cursor: 'pointer', flexShrink: 0,
              }}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          <p style={{ fontSize: 11, color: '#999', margin: '6px 0 0' }}>
            One link for this listing — paste it to whichever client you pick below, or reuse it anywhere.
          </p>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 18px 18px' }}>
          {err && <div style={{ padding: '16px 0', color: '#B91C1C', fontSize: 12.5 }}>{err}</div>}
          {!err && matches === null && <div style={{ padding: '40px 0', textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>Matching…</div>}
          {!err && matches && matches.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#BBB', fontSize: 12.5 }}>
              No active clients score high enough against this listing right now.
            </div>
          )}
          {!err && matches && matches.map((m, i) => (
            <div key={m.clientId} style={{ padding: '12px 0', borderBottom: i < matches.length - 1 ? '1px solid #F2F0EA' : 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 700, fontSize: 13.5, color: '#1A1A1A' }}>
                  {m.score}% — {m.clientName}
                </span>
                {m.leadAgent && <span style={{ fontSize: 10.5, color: '#999' }}>Lead: {m.leadAgent}</span>}
              </div>
              <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {m.reasons.map(r => {
                  const g = reasonGlyph(r.ok)
                  return (
                    <span key={r.key} style={{ fontSize: 11.5, color: '#555' }}>
                      <span style={{ color: g.color, fontWeight: 700, marginRight: 5 }}>{g.sym}</span>{r.label}
                    </span>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
