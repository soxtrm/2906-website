'use client'
import { useCallback, useEffect, useState } from 'react'
import { Link2, Plus, ShieldCheck, UserPlus } from 'lucide-react'
import { api, Chip, CopyField, fmtWhen, Sheet } from './ui'
import type { Me } from './types'

const BASE = '/api/owner-portal'
type ShareLink = { id: number; label: string | null; property_ids: number[]; allow_requests: boolean; expires_at: string | null; revoked_at: string | null; views: number; created_at: string }
type Delegate = { id: number; name: string; role: string; property_ids: number[]; scopes: string[]; state: string; created_at: string }
const SCOPE_LABEL: Record<string, string> = { schedule: 'Availability', requests: 'Viewing requests', inventory: 'Property details & photos', sharing: 'Property links' }

export function Sharing({ me, notify }: { me: Me; notify: (m: string) => void }) {
  const [links, setLinks] = useState<ShareLink[]>([])
  const [delegates, setDelegates] = useState<Delegate[]>([])
  const [newLink, setNewLink] = useState(false)
  const [newDelegate, setNewDelegate] = useState(false)
  const [created, setCreated] = useState<{ title: string; url: string; note: string } | null>(null)
  const canShare = me.scopes.includes('sharing')
  const load = useCallback(() => {
    if (canShare) api<ShareLink[]>(BASE, '/share-links').then(setLinks).catch(() => {})
    if (me.role === 'owner') api<Delegate[]>(BASE, '/delegates').then(setDelegates).catch(() => {})
  }, [canShare, me.role])
  useEffect(() => { load() }, [load])
  const ref = (id: number) => me.properties.find(p => p.id === id)?.ref || id

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="op-section-head">
        <div>
          <div className="op-eyebrow">Sharing</div>
          <h1 className="op-h1">One link for every agent</h1>
          <p className="op-lede">Send agents a single property link instead of repeating details on WhatsApp. They see the approved facts and free viewing times and send structured requests. They never see your contact details.</p>
        </div>
      </div>

      {canShare && <section className="op-card op-card-pad" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="op-eyebrow">Property links for agents</div>
          <button className="op-btn op-btn-primary op-btn-sm" onClick={() => setNewLink(true)}><Link2 size={15} /> New link</button>
        </div>
        {!links.length && <div className="op-empty" style={{ padding: 12 }}>No link yet.</div>}
        {links.map(l => (
          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--op-line)', flexWrap: 'wrap' }}>
            <div><b>{l.label || 'Property link'}</b><div style={{ color: 'var(--op-muted)', fontSize: 13 }}>{l.property_ids.map(id => `#${ref(id)}`).join(', ')} · {l.views} views · {l.allow_requests ? 'requests on' : 'view only'}</div></div>
            {l.revoked_at ? <Chip tone="bad">Turned off</Chip> : <button className="op-btn op-btn-sm op-btn-ghost op-btn-danger" onClick={async () => { await api(BASE, `/share-links/${l.id}`, { method: 'DELETE' }).catch(e => notify(e.message)); notify('Link turned off'); load() }}>Turn off</button>}
          </div>
        ))}
        <p style={{ margin: 0, color: 'var(--op-muted)', fontSize: 13 }}>For your safety the full link is shown only once, when you create it. Turn a link off any time; a new one takes a second.</p>
      </section>}

      {me.role === 'owner' && <section className="op-card op-card-pad" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="op-eyebrow">Property managers</div>
          <button className="op-btn op-btn-sm" onClick={() => setNewDelegate(true)}><UserPlus size={15} /> Add manager</button>
        </div>
        {!delegates.length && <div className="op-empty" style={{ padding: 12 }}>Only you manage your properties.</div>}
        {delegates.map(d => (
          <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--op-line)', flexWrap: 'wrap' }}>
            <div><b>{d.name}</b><div style={{ color: 'var(--op-muted)', fontSize: 13 }}>{d.property_ids.map(id => `#${ref(id)}`).join(', ')} · {d.scopes.map(s => SCOPE_LABEL[s]).join(', ')}</div></div>
            {d.state === 'revoked' ? <Chip tone="bad">Removed</Chip> : <span style={{ display: 'flex', gap: 6 }}><Chip tone={d.state === 'active' ? 'ok' : 'warn'}>{d.state === 'active' ? 'Active' : 'Invited'}</Chip>
              <button className="op-btn op-btn-sm op-btn-ghost op-btn-danger" onClick={async () => { await api(BASE, `/delegates/${d.id}`, { method: 'DELETE' }).catch(e => notify(e.message)); notify(`${d.name} no longer has access`); load() }}>Remove</button></span>}
          </div>
        ))}
        <p style={{ margin: 0, color: 'var(--op-muted)', fontSize: 13 }}><ShieldCheck size={14} style={{ verticalAlign: -2 }} /> A manager only sees the properties and tasks you choose, never your other properties or account settings.</p>
      </section>}

      <NewLink open={newLink} me={me} onClose={() => setNewLink(false)} onCreated={(url) => { setNewLink(false); setCreated({ title: 'Your property link', url, note: 'Send this to agents. It shows approved facts and free times only, and lets them request viewings.' }); load() }} />
      <NewDelegate open={newDelegate} me={me} onClose={() => setNewDelegate(false)} onCreated={(url, name) => { setNewDelegate(false); setCreated({ title: `Invitation for ${name}`, url, note: 'Give this to your manager personally. It works once and expires in 14 days.' }); load() }} />
      <Sheet open={!!created} title={created?.title || ''} onClose={() => setCreated(null)} footer={<button className="op-btn op-btn-primary" onClick={() => setCreated(null)}>Done</button>}>
        {created && <><p style={{ margin: 0 }}>{created.note}</p><CopyField label="Link" value={created.url} /></>}
      </Sheet>
    </div>
  )
}

function PropertyPicker({ me, value, onChange }: { me: Me; value: number[]; onChange: (v: number[]) => void }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{me.properties.map(p => <button key={p.id} type="button" className="op-toggle" aria-pressed={value.includes(p.id)} onClick={() => onChange(value.includes(p.id) ? value.filter(x => x !== p.id) : [...value, p.id])}>#{p.ref} · {p.town}</button>)}</div>
}

function NewLink({ open, me, onClose, onCreated }: { open: boolean; me: Me; onClose: () => void; onCreated: (url: string) => void }) {
  const [ids, setIds] = useState<number[]>(me.properties.map(p => p.id))
  const [label, setLabel] = useState('For agents')
  const [requests, setRequests] = useState(true)
  const [err, setErr] = useState('')
  return (
    <Sheet open={open} title="New property link" onClose={onClose} footer={<>
      <button className="op-btn op-btn-ghost" onClick={onClose}>Cancel</button>
      <button className="op-btn op-btn-accent" disabled={!ids.length} onClick={async () => { try { const r = await api<{ url: string }>(BASE, '/share-links', { method: 'POST', json: { propertyIds: ids, label, allowRequests: requests } }); onCreated(r.url) } catch (e: any) { setErr(e.message) } }}><Plus size={15} /> Create link</button>
    </>}>
      <label className="op-field"><span>Name (only you see it)</span><input className="op-input" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
      <div className="op-field"><span>Properties</span><PropertyPicker me={me} value={ids} onChange={setIds} /></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={requests} onChange={e => setRequests(e.target.checked)} /> Agents can request viewings</label>
      {err && <div className="op-error" role="alert">{err}</div>}
    </Sheet>
  )
}

function NewDelegate({ open, me, onClose, onCreated }: { open: boolean; me: Me; onClose: () => void; onCreated: (url: string, name: string) => void }) {
  const [name, setName] = useState('')
  const [ids, setIds] = useState<number[]>([])
  const [scopes, setScopes] = useState<string[]>(['schedule', 'requests'])
  const [err, setErr] = useState('')
  return (
    <Sheet open={open} title="Add a property manager" onClose={onClose} footer={<>
      <button className="op-btn op-btn-ghost" onClick={onClose}>Cancel</button>
      <button className="op-btn op-btn-accent" disabled={!name.trim() || !ids.length || !scopes.length} onClick={async () => { try { const r = await api<{ url: string }>(BASE, '/delegates', { method: 'POST', json: { name, propertyIds: ids, scopes } }); onCreated(r.url, name); setName(''); setIds([]) } catch (e: any) { setErr(e.message) } }}>Create invitation</button>
    </>}>
      <label className="op-field"><span>Name</span><input className="op-input" maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
      <div className="op-field"><span>Properties they manage</span><PropertyPicker me={me} value={ids} onChange={setIds} /></div>
      <div className="op-field"><span>What they can do</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{Object.entries(SCOPE_LABEL).map(([k, v]) => <button key={k} type="button" className="op-toggle" aria-pressed={scopes.includes(k)} onClick={() => setScopes(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k])}>{v}</button>)}</div></div>
      {err && <div className="op-error" role="alert">{err}</div>}
    </Sheet>
  )
}

const ACTION: Record<string, string> = {
  signed_in: 'Signed in', invitation_created: 'Invitation created by ARGUS', recovery_link_created: 'Recovery link created by ARGUS', properties_confirmed: 'Property list confirmed',
  availability_updated: 'Availability updated', change_proposed: 'Change sent for review', proposal_accepted: 'Change accepted by ARGUS', proposal_rejected: 'Change not accepted',
  media_added: 'File added', media_arranged: 'Photos rearranged', share_link_created: 'Property link created', share_link_revoked: 'Property link turned off',
  delegate_invited: 'Manager invited', delegate_revoked: 'Manager removed', distribution_changed: 'Distribution changed', property_submitted: 'New property sent',
  viewing_requested: 'Viewing requested by an agent', viewing_propose: 'Slot proposed', viewing_decline: 'Request declined', viewing_cancel: 'Viewing cancelled',
  viewing_complete: 'Viewing completed', viewing_no_show: 'No show recorded', viewing_reschedule: 'Another time requested', agent_confirm: 'Agent confirmed with client',
  agent_checking: 'Agent checking with client', agent_other_time: 'Agent asked for another time', agent_cancel: 'Agent cancelled', pilot_state: 'Pilot status updated',
  sessions_revoked: 'Signed out everywhere', account_active: 'Account reactivated', account_suspended: 'Account paused',
}

export function Activity({ me, notify }: { me: Me; notify: (m: string) => void }) {
  const [log, setLog] = useState<{ action: string; actor_kind: string; property_id: number | null; created_at: string }[]>([])
  const [mode, setMode] = useState(me.notifyMode)
  const [urgent, setUrgent] = useState(me.urgentSeparately)
  useEffect(() => { api(BASE, '/audit').then(setLog).catch(() => {}) }, [])
  const ref = (id: number | null) => id ? `#${me.properties.find(p => p.id === id)?.ref || id}` : ''
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="op-section-head"><div><div className="op-eyebrow">Activity</div><h1 className="op-h1">Everything that changed</h1><p className="op-lede">Every change to your properties, availability and viewings is recorded here.</p></div></div>
      {me.role === 'owner' && <section className="op-card op-card-pad" style={{ display: 'grid', gap: 10 }}>
        <div className="op-eyebrow">How we keep you posted</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Notifications">
          {[['digest_2h', 'Every 2 hours'], ['immediate', 'Right away'], ['daily', 'Once a day'], ['off', 'Only in the portal']].map(([k, v]) => <button key={k} type="button" className="op-toggle" aria-pressed={mode === k} onClick={() => setMode(k)}>{v}</button>)}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} /> Tell me straight away when a confirmed viewing changes</label>
        <div><button className="op-btn op-btn-sm op-btn-primary" onClick={async () => { await api(BASE, '/me/preferences', { method: 'PUT', json: { notifyMode: mode, urgentSeparately: urgent } }).then(() => notify('Saved')).catch(e => notify(e.message)) }}>Save</button></div>
        <p style={{ margin: 0, color: 'var(--op-muted)', fontSize: 13 }}>Messages are not sent yet during the pilot: you see everything here first.</p>
      </section>}
      <section className="op-card">
        {!log.length && <div className="op-empty">Nothing yet.</div>}
        {log.map((x, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 18px', borderTop: i ? '1px solid var(--op-line)' : 0 }}>
            <span>{ACTION[x.action] || x.action.replace(/_/g, ' ')} {ref(x.property_id)}</span>
            <span style={{ color: 'var(--op-faint)', fontSize: 13, whiteSpace: 'nowrap' }}>{fmtWhen(x.created_at)}</span>
          </div>
        ))}
      </section>
    </div>
  )
}
