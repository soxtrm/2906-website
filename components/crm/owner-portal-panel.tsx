'use client'
// Staff controls for the ARGUS Owner Portal on the internal owner profile:
// founding-owner pilot status, invitation (identity method required, nothing
// is sent), revocation, sessions and the owner-change review queue.
import { useCallback, useEffect, useState } from 'react'
import { crmFetch } from '@/lib/crm/api'

type Overview = {
  ownerId: number
  account: { state: string; identityMethod: string | null; propertiesConfirmedAt: string | null; notifyMode: string; createdAt: string } | null
  pilot: { state: string; note: string | null; updated_at: string } | null
  invitation: { purpose: string; createdAt: string; expiresAt: string; state: string } | null
  sessions: number; pendingProposals: number
  delegates: { id: number; name: string; role: string; property_ids: number[]; scopes: string[]; state: string }[]
}
type Proposal = { id: number; property_id: number; ref: string; fields: Record<string, any>; actor_kind: string; created_at: string; owner_id: number }

const PILOT: [string, string][] = [['interested', 'Interested'], ['pilot_invited', 'Pilot invited'], ['onboarding', 'Onboarding'], ['active_pilot', 'Active pilot'], ['feedback_received', 'Feedback received']]
const card: React.CSSProperties = { background: 'var(--crm-surface, #fff)', border: '1px solid var(--crm-border, rgba(0,0,0,.08))', borderRadius: 12, padding: 16, display: 'grid', gap: 10 }
const btn: React.CSSProperties = { minHeight: 36, padding: '0 14px', borderRadius: 9, border: '1px solid var(--crm-border, rgba(0,0,0,.14))', background: 'var(--crm-surface, #fff)', color: 'inherit', fontWeight: 650, cursor: 'pointer' }
const primary: React.CSSProperties = { ...btn, background: 'var(--crm-text, #111)', color: 'var(--crm-surface, #fff)', borderColor: 'transparent' }
const when = (s?: string | null) => s ? new Date(s).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

export function OwnerPortalPanel({ ownerId }: { ownerId: number }) {
  const [o, setO] = useState<Overview | null>(null)
  const [props, setProps] = useState<Proposal[]>([])
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [method, setMethod] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      setO(await crmFetch(`owner-portal/${ownerId}`))
      setProps(((await crmFetch('owner-portal/review/proposals')) as Proposal[]).filter(p => p.owner_id === ownerId))
      setError('')
    } catch (e: any) { setError(e.status === 403 ? 'Owner portal controls are limited to admins and entitled agents.' : e.message) }
  }, [ownerId])
  useEffect(() => { load() }, [load])
  const post = async (path: string, body?: object, method = 'POST') => {
    setBusy(true); setMsg('')
    try { const r = await crmFetch(`owner-portal/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); await load(); return r }
    catch (e: any) { setMsg(e.message); return null } finally { setBusy(false) }
  }
  if (error) return <div style={card}>{error}</div>
  if (!o) return <div style={card}>Loading…</div>
  return (
    <div style={{ display: 'grid', gap: 14 }} data-testid="owner-portal-panel">
      <section style={card}>
        <b>Founding owner pilot</b>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PILOT.map(([k, v]) => <button key={k} type="button" style={o.pilot?.state === k ? primary : btn} disabled={busy} aria-pressed={o.pilot?.state === k}
            onClick={() => post(`${ownerId}/pilot`, { state: k, note: note || o.pilot?.note || undefined }, 'PUT')}>{v}</button>)}
        </div>
        <input placeholder="Note (e.g. how she heard about it)" value={note} onChange={e => setNote(e.target.value)} maxLength={500} style={{ ...btn, fontWeight: 400, cursor: 'text' }} />
        {o.pilot && <small style={{ opacity: .7 }}>Updated {when(o.pilot.updated_at)}{o.pilot.note ? ` · ${o.pilot.note}` : ''}</small>}
      </section>

      <section style={card}>
        <b>Owner portal access</b>
        <div style={{ fontSize: 13.5 }}>
          Account: <b>{o.account?.state || 'none'}</b> · Sessions: <b>{o.sessions}</b> · Properties confirmed: <b>{o.account?.propertiesConfirmedAt ? when(o.account.propertiesConfirmedAt) : 'not yet'}</b>
          {o.invitation && <> · Last link: <b>{o.invitation.state}</b> ({o.invitation.purpose}, expires {when(o.invitation.expiresAt)})</>}
        </div>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>How did you confirm this is the owner? (required)
          <input value={method} onChange={e => setMethod(e.target.value)} placeholder="e.g. Called the number on file and spoke to her" maxLength={200} style={{ ...btn, fontWeight: 400, cursor: 'text' }} />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" style={primary} disabled={busy || method.trim().length < 3} onClick={async () => { const r = await post(`${ownerId}/invitation`, { identityMethod: method, purpose: o.account?.state === 'active' ? 'recovery' : 'invite' }); if (r) setLink(r.url) }}>{o.account?.state === 'active' ? 'Create recovery link' : 'Create invitation link'}</button>
          {o.invitation?.state === 'open' && <button type="button" style={btn} disabled={busy} onClick={() => post(`${ownerId}/invitation/revoke`)}>Revoke open link</button>}
          {o.sessions > 0 && <button type="button" style={btn} disabled={busy} onClick={() => post(`${ownerId}/sessions/revoke`)}>Sign out everywhere</button>}
          {o.account?.state === 'active' && <button type="button" style={btn} disabled={busy} onClick={() => post(`${ownerId}/state`, { state: 'suspended' })}>Pause access</button>}
          {o.account?.state === 'suspended' && <button type="button" style={btn} disabled={busy} onClick={() => post(`${ownerId}/state`, { state: 'active' })}>Resume access</button>}
        </div>
        {link && <div style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 10, background: 'rgba(64,86,232,.08)' }}>
          <small>Shown once. Nothing was sent. Hand it to the owner yourself once her identity is confirmed. It works once and expires in 14 days.</small>
          <input readOnly value={link} onFocus={e => e.currentTarget.select()} style={{ ...btn, fontWeight: 400 }} aria-label="Invitation link" />
          <button type="button" style={btn} onClick={() => navigator.clipboard.writeText(link).catch(() => {})}>Copy</button>
        </div>}
        {msg && <div role="alert" style={{ color: '#c2364a', fontSize: 13 }}>{msg}</div>}
      </section>

      {o.delegates.length > 0 && <section style={card}><b>Property managers</b>{o.delegates.map(d => <div key={d.id} style={{ fontSize: 13.5 }}>{d.name} · {d.state} · {d.scopes.join(', ')} · {d.property_ids.length} properties</div>)}</section>}

      <section style={card}>
        <b>Owner changes waiting for review ({props.length})</b>
        {!props.length && <small style={{ opacity: .7 }}>Nothing waiting.</small>}
        {props.map(p => (
          <div key={p.id} style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: '1px solid var(--crm-border, rgba(0,0,0,.08))' }}>
            <div style={{ fontSize: 13.5 }}><b>#{p.ref}</b> · {p.actor_kind} · {when(p.created_at)}</div>
            <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(p.fields, null, 2)}</pre>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={primary} disabled={busy} onClick={() => post(`review/proposals/${p.id}`, { decision: 'accepted' })}>Accept (then update the listing)</button>
              <button type="button" style={btn} disabled={busy} onClick={() => post(`review/proposals/${p.id}`, { decision: 'rejected' })}>Reject</button>
            </div>
          </div>
        ))}
        <small style={{ opacity: .7 }}>Accepting records the decision. Apply it in the property editor: commission and agency terms are never changed by the owner.</small>
      </section>
    </div>
  )
}
