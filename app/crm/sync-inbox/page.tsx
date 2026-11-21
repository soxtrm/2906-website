'use client'
// ============================================================================
// /crm/sync-inbox — owners who signed up on nexussync.one (Claude, 2026-11-19).
// Left: SYNC accounts with their claims and unread messages. Right: the chat,
// answered as yourself (the owner sees your name and the agency). Ownership is
// confirmed on the owner profile (NEXUS area → Verify), never here.
// Data: /api/crm/sync-inbox/* (staff only).
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

type Thread = { accountId: string; name: string | null; email: string | null; phone: string | null; phoneVerified: boolean
  links: { ownerId: number; state: string }[]; lastAt: string | null; lastText: string | null; unread: number; createdAt: string }
type ClaimHome = { id: number; ref: string; town: string | null; type: string | null; bedrooms: number | null; rent: number | null; agent: string | null; claimState: string }
type Claim = { accountId: string; waitingSince: string; account: { name: string | null; email: string | null; phone: { e164: string; verified: boolean } | null }
  links: { ownerId: number; ownerName: string | null; state: string; properties: ClaimHome[] }[] }
type Msg = { id: number; at: string; from: 'owner' | 'argus'; sender: { kind: string; name: string | null; org: string | null }; text: string }

const STATE: Record<string, string> = { claim_pending: 'Claimed: verify ownership', verified: 'Owner verified', disputed: 'Disputed', invited: 'Invited', not_invited: 'Not linked', revoked: 'Revoked' }
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

export default function SyncInboxPage() {
  return <CrmProvider><SyncInbox /></CrmProvider>
}

function SyncInbox() {
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const [claims, setClaims] = useState<{ claims: Claim[]; canDecide: boolean } | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const loadClaims = useCallback(async () => { try { setClaims(await crmFetch('sync-inbox/claims')) } catch { /* the inbox below still works */ } }, [])
  useEffect(() => { loadClaims(); const iv = setInterval(loadClaims, 30000); return () => clearInterval(iv) }, [loadClaims])
  async function decide(c: Claim, ownerId: number, decision: 'approve' | 'reject') {
    const who = c.account.name || 'this owner'
    if (!window.confirm(decision === 'approve'
      ? `Confirm that ${who} owns these homes? Only after you checked it (title, contract or a call). The homes then appear in their SYNC account.`
      : `Reject the claim of ${who}? Nothing is linked; they get a message that it could not be confirmed.`)) return
    setDeciding(`${c.accountId}:${ownerId}`)
    try { await crmJson(`sync-inbox/threads/${c.accountId}/claim`, 'POST', { ownerId, decision }); await loadClaims(); load() }
    catch (e) { setErr(e instanceof Error ? e.message : 'The decision was not saved.') }
    setDeciding(null)
  }

  const load = useCallback(async () => {
    try { const d = await crmFetch('sync-inbox/threads'); setThreads(d.threads || []); setErr(null) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the SYNC inbox.') }
  }, [])
  const open = useCallback(async (id: string) => {
    try { const d = await crmFetch(`sync-inbox/threads/${id}`); setMsgs(d.messages || []); setThreads(t => t?.map(x => (x.accountId === id ? { ...x, unread: 0 } : x)) || t) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not open the chat.') }
  }, [])
  useEffect(() => { load(); const iv = setInterval(load, 20000); return () => clearInterval(iv) }, [load])
  useEffect(() => { if (!sel) return; open(sel); const iv = setInterval(() => open(sel), 10000); return () => clearInterval(iv) }, [sel, open])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs.length])

  async function reply(e: React.FormEvent) {
    e.preventDefault(); if (!sel || !text.trim()) return
    try { await crmJson(`sync-inbox/threads/${sel}/reply`, 'POST', { text: text.trim() }); setText(''); open(sel); load() }
    catch (e2) { setErr(e2 instanceof Error ? e2.message : 'The reply was not sent.') }
  }

  const t = threads?.find(x => x.accountId === sel) || null
  const card: React.CSSProperties = { background: 'var(--crm-card)', border: '1px solid var(--crm-border)', borderRadius: 14 }

  return (
    <CrmShell title="SYNC inbox" subtitle="Owners from nexussync.one: their messages and claims">
      {err && <p style={{ color: '#F87171', margin: '0 0 12px' }}>{err}</p>}
      {claims && claims.claims.length > 0 && (
        <section style={{ ...card, padding: 14, marginBottom: 16, borderColor: '#FBBF24' }} aria-label="Waiting for review">
          <b style={{ fontSize: 16 }}>Waiting for review · {claims.claims.length}</b>
          <p style={{ margin: '4px 0 10px', color: 'var(--crm-muted)', fontSize: 13 }}>Owners who confirmed homes in SYNC. Check ownership (title, contract or a call), then approve or reject. The owner gets a message either way.</p>
          <div style={{ display: 'grid', gap: 10 }}>
            {claims.claims.map(c => c.links.map(l => (
              <div key={`${c.accountId}:${l.ownerId}`} className="sync-claim" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 12, border: '1px solid var(--crm-border)' }}>
                <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                  <b>{c.account.name || c.account.email || 'SYNC owner'} <span style={{ fontWeight: 400, color: 'var(--crm-muted)', fontSize: 13 }}>claims owner #{l.ownerId}{l.ownerName ? ` (${l.ownerName})` : ''}</span></b>
                  <small style={{ color: 'var(--crm-muted)' }}>{c.account.phone ? `${c.account.phone.e164}${c.account.phone.verified ? ' ✓ confirmed by WhatsApp' : ''}` : 'Mobile not confirmed'} · waiting since {when(c.waitingSince)}</small>
                  {l.properties.map(p => <small key={p.id}>#{p.ref} · {[p.type, p.bedrooms ? `${p.bedrooms} bed` : null, p.town].filter(Boolean).join(', ')}{p.agent ? ` · listing agent ${p.agent}` : ''}</small>)}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a href={`/crm/owner/${l.ownerId}`} style={{ fontSize: 13, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--crm-border)', color: 'inherit', textDecoration: 'none' }}>Owner profile</a>
                  {claims.canDecide ? <>
                    <button disabled={!!deciding} onClick={() => decide(c, l.ownerId, 'reject')} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #F87171', background: 'transparent', color: '#F87171', fontWeight: 600, cursor: 'pointer' }}>Reject</button>
                    <button disabled={!!deciding} onClick={() => decide(c, l.ownerId, 'approve')} style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#16a34a', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>{deciding === `${c.accountId}:${l.ownerId}` ? 'Saving…' : 'Approve ownership'}</button>
                  </> : <small style={{ color: 'var(--crm-muted)' }}>An admin decides</small>}
                </div>
              </div>
            )))}
          </div>
        </section>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }} className="sync-inbox-grid">
        <div style={{ ...card, padding: 6, maxHeight: '75vh', overflow: 'auto' }}>
          {!threads ? <p style={{ padding: 12, color: 'var(--crm-muted)' }}>Loading…</p> : !threads.length ? <p style={{ padding: 12, color: 'var(--crm-muted)' }}>No SYNC accounts yet.</p> : threads.map(x => (
            <button key={x.accountId} onClick={() => setSel(x.accountId)}
              style={{ display: 'grid', gap: 3, width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: 0, cursor: 'pointer', background: sel === x.accountId ? 'var(--crm-border)' : 'transparent', color: 'inherit' }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b>{x.name || x.email || 'SYNC owner'}</b>
                {x.unread > 0 && <span style={{ background: '#4f6bff', color: '#fff', borderRadius: 99, padding: '0 8px', fontSize: 12 }}>{x.unread}</span>}
              </span>
              <small style={{ color: 'var(--crm-muted)' }}>{x.phone ? `${x.phone}${x.phoneVerified ? ' ✓' : ''}` : x.phoneVerified ? 'Mobile confirmed' : 'Mobile not confirmed'} · {when(x.lastAt || x.createdAt)}</small>
              {x.links.map(l => <small key={l.ownerId} style={{ color: l.state === 'verified' ? '#4ADE80' : '#FBBF24' }}>{STATE[l.state] || l.state} · owner #{l.ownerId}</small>)}
              {x.lastText && <small style={{ color: 'var(--crm-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.lastText}</small>}
            </button>
          ))}
        </div>
        <div style={{ ...card, padding: 14, minHeight: 360, display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 10 }}>
          {!t ? <p style={{ color: 'var(--crm-muted)' }}>Choose an owner on the left.</p> : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
                <div><b>{t.name || 'SYNC owner'}</b><div style={{ color: 'var(--crm-muted)', fontSize: 13 }}>{t.email || ''}{t.phone ? ` · ${t.phone}` : ''}</div></div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {t.links.map(l => <a key={l.ownerId} href={`/crm/owner/${l.ownerId}`} style={{ fontSize: 13, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--crm-border)', color: 'inherit', textDecoration: 'none' }}>
                    {l.state === 'claim_pending' ? 'Verify ownership' : 'Owner profile'} #{l.ownerId}</a>)}
                </div>
              </div>
              <div style={{ overflow: 'auto', maxHeight: '55vh', display: 'grid', gap: 8, alignContent: 'start' }}>
                {!msgs.length && <p style={{ color: 'var(--crm-muted)' }}>No messages yet.</p>}
                {msgs.map(m => (
                  <div key={m.id} style={{ justifySelf: m.from === 'owner' ? 'start' : 'end', maxWidth: '78%', padding: '8px 12px', borderRadius: 12,
                    background: m.from === 'owner' ? 'var(--crm-border)' : 'rgba(79,107,255,.18)' }}>
                    <div style={{ fontSize: 12, color: 'var(--crm-muted)' }}>{m.from === 'owner' ? (m.sender.name || 'Owner') : `${m.sender.name || 'ARGUS'}${m.sender.org ? ` · ${m.sender.org}` : ''}`} · {when(m.at)}</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                  </div>
                ))}
                <div ref={end} />
              </div>
              <form onSubmit={reply} style={{ display: 'flex', gap: 8 }}>
                <input value={text} onChange={e => setText(e.target.value)} placeholder="Reply as yourself (the owner sees your name and 2906)"
                  style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }} />
                <button type="submit" disabled={!text.trim()} style={{ padding: '10px 16px', borderRadius: 10, border: 0, background: '#4f6bff', color: '#fff', fontWeight: 600 }}>Send</button>
              </form>
            </>
          )}
        </div>
      </div>
      <style>{`@media (max-width: 760px) { .sync-inbox-grid { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
    </CrmShell>
  )
}
