'use client'
// Real NEXUS SYNC accounts (2026-11-21): representatives and private documents, both kept in ARGUS.
// The browser holds nothing of its own here: every list is read from the server, every change is
// written there first and the list is read again.
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Eye, FileText, Share2, Trash2, Upload, UserPlus, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { liveProperties, sync } from '@/lib/owner/live'

const PERMS: { v: string; label: string; hint: string }[] = [
  { v: 'message', label: 'Messages', hint: 'Write to ARGUS about these homes' },
  { v: 'schedule', label: 'Viewings', hint: 'Viewing hours, accept or decline viewings' },
  { v: 'edit', label: 'Changes', hint: 'Availability, price proposals, house rules' },
]
const STATE: Record<string, string> = { invited: 'Invitation open', active: 'Active', revoked: 'Ended', declined: 'Declined', expired: 'Expired' }
interface Rep { id: string; name: string; kind: 'email' | 'phone'; target?: string; permissions: string[]; propertyIds: number[]; state: string; expiresAt: string; acceptedAt: string | null; ownerName?: string }

function homeLabel(id: number, homes: ReturnType<typeof liveProperties>) {
  const h = homes.find(x => x.sourcePropertyId === id)
  return h ? `${h.state?.nickname || `${h.facts.type || 'Home'} in ${h.facts.locality}`} · ${h.ref}` : `Home ${id}`
}

export function LiveRepresentatives() {
  const s = useOwner()
  const own = (s.live.owner?.links || []).filter(l => !(l as { role?: string }).role).flatMap(l => l.properties || [])
  const [data, setData] = useState<{ delegates: Rep[]; actingFor: Rep[] } | null>(null)
  const [form, setForm] = useState({ name: '', kind: 'phone' as 'phone' | 'email', target: '', homes: [] as number[], perms: ['schedule'] as string[] })
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { const r = await sync<{ delegates: Rep[]; actingFor: Rep[] }>('delegates'); if (r.ok) setData({ delegates: r.delegates, actingFor: r.actingFor }); else s.say(r.message, 'err') }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  const invite = async () => {
    setBusy(true)
    const r = await sync<{ link: string }>('delegates/invite', { name: form.name, kind: form.kind, target: form.target, propertyIds: form.homes, permissions: form.perms })
    setBusy(false)
    if (!r.ok) { s.say(r.message, 'err'); return }
    setLink(r.link); setForm(f => ({ ...f, name: '', target: '' })); await load()
  }
  const revoke = async (id: string, self = false) => {
    setBusy(true); const r = await sync('delegates/revoke', { delegateId: id }); setBusy(false)
    if (!r.ok) s.say(r.message, 'err'); else { s.say(self ? 'You no longer look after these homes.' : 'Access ended. It stops working right now.'); await load(); if (self) await s.refreshLive() }
  }

  return (
    <div className="lv">
      <header className="lv-hello"><h1>Representatives</h1><p className="lv-faint">People who look after some of your homes for you: family, a caretaker, a property manager.</p></header>

      {own.length > 0 && (
        <section className="lv-section">
          <h2>Invite someone</h2>
          <div className="lv-field"><label htmlFor="rep-name">Name</label><input id="rep-name" className="lv-input" maxLength={80} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
          <div className="lv-chips">
            <button aria-pressed={form.kind === 'phone'} onClick={() => setForm(f => ({ ...f, kind: 'phone' }))}>Mobile number</button>
            <button aria-pressed={form.kind === 'email'} onClick={() => setForm(f => ({ ...f, kind: 'email' }))}>E-mail</button>
          </div>
          <div className="lv-field"><label htmlFor="rep-target">{form.kind === 'phone' ? 'Their mobile number' : 'Their e-mail address'}</label>
            <input id="rep-target" className="lv-input" inputMode={form.kind === 'phone' ? 'tel' : 'email'} placeholder={form.kind === 'phone' ? '+356 7900 1234' : 'name@example.com'} value={form.target} onChange={e => setForm(f => ({ ...f, target: e.target.value }))} />
            <small className="lv-faint">Only this person can accept: they must confirm this {form.kind === 'phone' ? 'number' : 'address'} in their own SYNC account.</small>
          </div>
          <h3 className="rp-h3">Which homes</h3>
          <div className="lv-chips">{own.map(h => <button key={h.sourcePropertyId} aria-pressed={form.homes.includes(h.sourcePropertyId)} onClick={() => setForm(f => ({ ...f, homes: toggle(f.homes, h.sourcePropertyId) }))}>{homeLabel(h.sourcePropertyId, own)}</button>)}</div>
          <h3 className="rp-h3">What they may do <small>(they can always see the homes you choose)</small></h3>
          <div className="rp-perms">
            {PERMS.map(p => (
              <label key={p.v} className="lv-switch"><span><b>{p.label}</b><small>{p.hint}</small></span>
                <input type="checkbox" checked={form.perms.includes(p.v)} onChange={() => setForm(f => ({ ...f, perms: toggle(f.perms, p.v) }))} /></label>
            ))}
          </div>
          <p className="lv-faint">Sharing with agencies and your documents always stay with you.</p>
          <button className="lv-btn ok big" disabled={busy || !form.name.trim() || !form.target.trim() || !form.homes.length} onClick={invite}><UserPlus size={18} />Create invitation</button>
          {link && (
            <div className="rp-link">
              <b>Send this link to {form.kind === 'phone' ? 'them' : 'them'} yourself (valid 7 days, works once):</b>
              <code>{link}</code>
              <button className="lv-btn" onClick={async () => { try { await navigator.clipboard.writeText(link); s.say('Link copied.') } catch { s.say('Copy the link by hand.', 'warn') } }}><Copy size={16} />Copy link</button>
            </div>
          )}
        </section>
      )}

      <section className="lv-section">
        <h2>Your representatives</h2>
        {!data ? <p className="lv-faint">Loading…</p> : !data.delegates.length ? <p className="lv-faint">Nobody yet.</p> : (
          <ul className="rp-list">
            {data.delegates.map(d => (
              <li key={d.id} data-state={d.state}>
                <div><b>{d.name}</b><small>{d.target} · {STATE[d.state] || d.state}{d.state === 'invited' ? ` until ${new Date(d.expiresAt).toLocaleDateString('en-GB')}` : ''}</small>
                  <small>{d.propertyIds.map(id => homeLabel(id, own)).join(', ')}</small>
                  <small>{['See the homes', ...PERMS.filter(p => d.permissions.includes(p.v)).map(p => p.label)].join(' · ')}</small></div>
                {(d.state === 'active' || d.state === 'invited') && <button className="lv-btn quiet" disabled={busy} onClick={() => revoke(d.id)}><X size={16} />{d.state === 'invited' ? 'Withdraw' : 'End access'}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data && data.actingFor.length > 0 && (
        <section className="lv-section">
          <h2>Homes you look after</h2>
          <ul className="rp-list">
            {data.actingFor.map(d => (
              <li key={d.id}><div><b>For {d.ownerName}</b><small>{['See the homes', ...PERMS.filter(p => d.permissions.includes(p.v)).map(p => p.label)].join(' · ')}</small></div>
                <button className="lv-btn quiet" disabled={busy} onClick={() => revoke(d.id, true)}>Step down</button></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// ── documents ────────────────────────────────────────────────────────────────
const CAT: Record<string, string> = { contract: 'Contract', id: 'ID', energy_certificate: 'Energy certificate', insurance: 'Insurance', inventory: 'Inventory', invoice: 'Invoice', floor_plan: 'Floor plan', permit: 'Permit', other: 'Other' }
interface Doc { id: number; title: string; category: string; propertyId: number | null; mime: string; size: number; shared: boolean; createdAt: string }
const MAX = 3 * 1024 * 1024

export function LiveDocuments() {
  const s = useOwner()
  const own = (s.live.owner?.links || []).filter(l => !(l as { role?: string }).role).flatMap(l => l.properties || [])
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [cat, setCat] = useState('contract')
  const [home, setHome] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const load = useCallback(async () => { const r = await sync<{ documents: Doc[] }>('documents'); if (r.ok) setDocs(r.documents); else s.say(r.message, 'err') }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  const upload = async (f: File) => {
    if (f.size > MAX) { s.say('Files can be up to 3 MB.', 'warn'); return }
    if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(f.type)) { s.say('Only PDF, JPG, PNG or WebP files.', 'warn'); return }
    setBusy(true)
    const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f) })
    const r = await sync('documents/upload', { category: cat, title: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), propertyId: home === '' ? null : home, dataBase64: data })
    setBusy(false)
    if (!r.ok) { s.say(r.message, 'err'); return }
    s.say('Saved privately. Only you can see it.'); await load()
  }
  const open = async (d: Doc, download: boolean) => {
    const r = await sync<{ file: { name: string; mime: string; dataBase64: string } }>('documents/file', { id: d.id })
    if (!r.ok) { s.say(r.message, 'err'); return }
    const bytes = Uint8Array.from(atob(r.file.dataBase64), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: r.file.mime }))
    const a = document.createElement('a'); a.href = url; a.rel = 'noopener'
    if (download) a.download = `${r.file.name}.${r.file.mime === 'application/pdf' ? 'pdf' : r.file.mime.split('/')[1].replace('jpeg', 'jpg')}`; else a.target = '_blank'
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const act = async (op: string, body: Record<string, unknown>, ok: string) => { setBusy(true); const r = await sync(op, body); setBusy(false); if (!r.ok) s.say(r.message, 'err'); else { s.say(ok); await load() } }

  return (
    <div className="lv">
      <header className="lv-hello"><h1>Documents</h1><p className="lv-faint">Kept privately in ARGUS, not in this browser. Nobody else sees a document until you share it.</p></header>
      {own.length > 0 ? (
        <section className="lv-section">
          <h2>Add a document</h2>
          <div className="lv-chips">{Object.entries(CAT).map(([k, l]) => <button key={k} aria-pressed={cat === k} onClick={() => setCat(k)}>{l}</button>)}</div>
          <div className="lv-field"><label htmlFor="doc-home">For which home</label>
            <select id="doc-home" className="lv-input" value={home} onChange={e => setHome(e.target.value ? Number(e.target.value) : '')}>
              <option value="">All my homes / no specific home</option>
              {own.map(h => <option key={h.sourcePropertyId} value={h.sourcePropertyId}>{homeLabel(h.sourcePropertyId, own)}</option>)}
            </select></div>
          <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f) }} />
          <button className="lv-btn ok big" disabled={busy} onClick={() => input.current?.click()}><Upload size={18} />{busy ? 'Saving…' : 'Choose a file (PDF or photo, up to 3 MB)'}</button>
        </section>
      ) : <section className="lv-section"><p className="lv-faint">Documents are for owners. If you look after homes for someone, ask them to keep the documents.</p></section>}
      <section className="lv-section">
        <h2>Your documents</h2>
        {!docs ? <p className="lv-faint">Loading…</p> : !docs.length ? <p className="lv-faint">No documents yet.</p> : (
          <ul className="rp-list">
            {docs.map(d => (
              <li key={d.id}>
                <div><b><FileText size={16} aria-hidden="true" /> {d.title}</b>
                  <small>{CAT[d.category] || d.category} · {d.propertyId ? homeLabel(d.propertyId, own) : 'All homes'} · {(d.size / 1024).toFixed(0)} KB · {new Date(d.createdAt).toLocaleDateString('en-GB')}</small>
                  <small className={d.shared ? 'rp-shared' : ''}>{d.shared ? 'Shared with your agency (2906)' : 'Private'}</small></div>
                <span className="rp-actions">
                  <button className="lv-btn quiet" aria-label={`Open ${d.title}`} onClick={() => open(d, false)}><Eye size={16} /></button>
                  <button className="lv-btn quiet" aria-label={`Download ${d.title}`} onClick={() => open(d, true)}><Download size={16} /></button>
                  <button className="lv-btn quiet" disabled={busy} onClick={() => act('documents/share', { id: d.id, share: !d.shared }, d.shared ? 'No longer shared.' : 'Shared with your agency.')}>{d.shared ? <><X size={16} />Stop sharing</> : <><Share2 size={16} />Share</>}</button>
                  <button className="lv-btn quiet" aria-label={`Delete ${d.title}`} disabled={busy} onClick={() => { if (window.confirm(`Delete "${d.title}" for good? The file is removed from ARGUS.`)) act('documents/delete', { id: d.id }, 'Deleted.') }}><Trash2 size={16} /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── invitation link: /invite/<token> ────────────────────────────────────────
interface Preview { ownerName: string; name: string; kind: 'email' | 'phone'; target: string; homes: number; permissions: string[]; expiresAt: string }
export function InviteAccept({ token }: { token: string }) {
  const s = useOwner()
  const [pv, setPv] = useState<Preview | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { sync<{ invite: Preview }>('invites/preview', { token }).then(r => (r.ok ? setPv(r.invite) : setMsg(r.message))) }, [token])
  const go = async (op: 'invites/accept' | 'invites/decline') => {
    setBusy(true); const r = await sync(op, { token }); setBusy(false)
    if (!r.ok) { setMsg(r.message); return }
    setDone(op === 'invites/accept' ? 'accepted' : 'declined'); if (op === 'invites/accept') await s.refreshLive()
  }
  return (
    <div className="lv rp-invite">
      <section className="lv-section">
        {done === 'accepted' ? <><h1>Done</h1><p>You now look after {pv?.homes === 1 ? 'this home' : 'these homes'} for {pv?.ownerName}.</p><Link className="lv-btn ok big" href="/owner/properties">Open the homes</Link></>
          : done === 'declined' ? <><h1>Declined</h1><p>Nothing was changed.</p></>
          : !pv ? <><h1>Invitation</h1><p>{msg || 'Loading…'}</p></>
          : <>
            <h1>{pv.ownerName} invites you</h1>
            <p>To look after {pv.homes} home{pv.homes === 1 ? '' : 's'} in NEXUS SYNC. You may: {['see the homes', ...PERMS.filter(p => pv.permissions.includes(p.v)).map(p => p.label.toLowerCase())].join(', ')}.</p>
            <p className="lv-faint">Sent to {pv.target}. Valid until {new Date(pv.expiresAt).toLocaleDateString('en-GB')}.</p>
            {msg && <p className="rp-warn">{msg}{/mobile|number/.test(msg) && <> <Link href="/owner/settings">Confirm your number</Link></>}</p>}
            {!s.live.ready ? <p className="lv-faint">Checking your account…</p> : !s.live.account ? (
              <div className="lv-row">
                <Link className="lv-btn ok big" href={`/owner/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
                <Link className="lv-btn big" href={`/owner/signup?next=${encodeURIComponent(`/invite/${token}`)}`}>Create an account</Link>
              </div>
            ) : (
              <div className="lv-row">
                <button className="lv-btn ok big" disabled={busy} onClick={() => go('invites/accept')}><Check size={18} />Accept</button>
                <button className="lv-btn big" disabled={busy} onClick={() => go('invites/decline')}>Decline</button>
              </div>
            )}
          </>}
      </section>
    </div>
  )
}
