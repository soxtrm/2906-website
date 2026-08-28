'use client'
// ============================================================================
// /crm/board-access — the one place Kev adds and removes board agents.
//
// The list IS agents.board_access, the same column the board checks on every
// request, so removing someone here bites on their next click rather than when
// a token expires. Staff rows are shown but only ever lose board access;
// deleting the account that owns half the listings is not a thing a cross on
// this page should be able to do.
// ============================================================================
import { useCallback, useEffect, useState } from 'react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { CrmProvider, CrmShell, NAVY, F, useIsMobile } from '@/lib/crm/ui'

type Row = {
  id: number; name: string | null; email: string | null; username: string
  role: string; active: boolean; board_access: boolean
  last_login_at: string | null; created_at: string | null
  whatsapp_phone: string
}

function when(v: string | null) {
  if (!v) return 'never'
  const d = new Date(v), days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function BoardAccess() {
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const [cookieText, setCookieText] = useState('')
  const [cookieBusy, setCookieBusy] = useState(false)
  const [cookieNote, setCookieNote] = useState<{ ok: boolean; text: string } | null>(null)

  const [queueCount, setQueueCount] = useState('16')
  const [queueBusy, setQueueBusy] = useState(false)
  const [queueNote, setQueueNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await crmFetch('board-access')
      setRows(d.agents || []); setErr(null)
    } catch (e: any) { setErr(e?.message || 'Could not load the list') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function add() {
    setBusy(true); setNote(null)
    try {
      const d = await crmJson('board-access', 'POST', {
        email: email.trim(), name: name.trim(),
        // Optional — leave blank and the agent stays magic-link-only
        // (routes/boardLogin.js). Set one and they can ALSO sign in at the
        // full CRM login with it (agents.password_hash is checked there
        // regardless of role).
        password: password.trim() || undefined,
        // Optional — stored in agents.whatsapp_phones, the same array every
        // WhatsApp-side lookup reads, so this agent is recognised there too.
        phone: phone.trim() || undefined,
      })
      setNote(d.reused
        ? `${email.trim()} already had an account — board access granted${password.trim() ? ' and password set' : ''}.`
        : `${email.trim()} can now request a sign-in link${password.trim() ? ', or sign in with the password you set' : ''}.`)
      setEmail(''); setName(''); setPassword(''); setPhone('')
      await load()
    } catch (e: any) { setNote(e?.data?.error || e?.message || 'Could not add that address') }
    finally { setBusy(false) }
  }

  async function toggle(r: Row) {
    setNote(null)
    try { await crmJson(`board-access/${r.id}`, 'PATCH', { active: !r.active }); await load() }
    catch (e: any) { setNote(e?.message || 'Could not update') }
  }

  async function savePhone(r: Row, value: string) {
    setNote(null)
    try { await crmJson(`board-access/${r.id}`, 'PATCH', { phone: value.trim() }); await load() }
    catch (e: any) { setNote(e?.message || 'Could not update the phone number') }
  }

  async function remove(r: Row) {
    const who = r.email || r.name || r.username
    const staff = r.role !== 'board'
    if (!confirm(staff
      ? `Remove board access from ${who}? Their CRM account stays untouched.`
      : `Remove ${who} from the board? They lose access immediately.`)) return
    setNote(null)
    try {
      const d = await crmFetch(`board-access/${r.id}`, { method: 'DELETE' })
      setNote(d.removed ? `${who} removed.` : `${who} no longer has board access.`)
      await load()
    } catch (e: any) { setNote(e?.message || 'Could not remove') }
  }

  async function uploadCookies() {
    setCookieBusy(true); setCookieNote(null)
    try {
      const parsed = JSON.parse(cookieText)
      const d = await crmJson('board-access/fb-cookies', 'POST', { cookies: parsed })
      setCookieNote({ ok: !!d.ok && d.loggedIn,
        text: d.loggedIn ? `Logged in as ${d.accountId}.` : 'Import ran, but login could not be verified — check with Kev.' })
      if (d.loggedIn) setCookieText('')
    } catch (e: any) {
      const msg = e instanceof SyntaxError ? 'That is not valid JSON — paste the exported cookie array as-is.'
        : (e?.data?.error || e?.message || 'Import failed')
      setCookieNote({ ok: false, text: msg })
    } finally { setCookieBusy(false) }
  }

  async function launchQueue() {
    const n = Number(queueCount)
    if (!Number.isInteger(n) || n < 1) { setQueueNote({ ok: false, text: 'Enter a whole number of listings.' }); return }
    setQueueBusy(true); setQueueNote(null)
    try {
      const d = await crmJson('board-access/queue-launch', 'POST', { count: n })
      setQueueNote({ ok: true,
        text: `Queued ${d.queued.length} listing${d.queued.length === 1 ? '' : 's'}` +
              (d.rejected?.length ? `, ${d.rejected.length} skipped` : '') +
              ` — backlog running at ${d.backlog.gapMinutes} min between listings (${d.backlog.queuedTotal} queued total).` })
    } catch (e: any) {
      setQueueNote({ ok: false, text: e?.data?.error || e?.message || 'Could not launch the queue' })
    } finally { setQueueBusy(false) }
  }

  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
    && (password.trim() === '' || password.trim().length >= 8)
  const agents = rows.filter(r => r.role === 'board')
  const staff  = rows.filter(r => r.role !== 'board')

  return (
    <CrmShell title="Board access" subtitle={`${agents.length} outside ${agents.length === 1 ? 'agent' : 'agents'} · ${staff.length} staff`}>
      <div style={{ maxWidth: 780 }}>
        {/* add */}
        <div style={{ background: '#FFFDFA', border: '1px solid #EDEBE5', borderRadius: 12, padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>Add an agent</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, lineHeight: 1.5 }}>
            They sign in at <strong>/board-login</strong> with this address — no password needed.
            Set one too and they can also sign in at the full CRM login with it.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexDirection: isMobile ? 'column' : 'row' }}>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="agent@agency.com"
              type="email" style={{ ...inp, flex: 2 }} onKeyDown={e => e.key === 'Enter' && valid && !busy && add()} />
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)"
              style={{ ...inp, flex: 1 }} onKeyDown={e => e.key === 'Enter' && valid && !busy && add()} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexDirection: isMobile ? 'column' : 'row' }}>
            <input value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password (optional, min 8 characters)" type="password" autoComplete="new-password"
              style={{ ...inp, flex: 2 }} onKeyDown={e => e.key === 'Enter' && valid && !busy && add()} />
            <input value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="Handynummer (optional, with country code)" type="tel"
              style={{ ...inp, flex: 1 }} onKeyDown={e => e.key === 'Enter' && valid && !busy && add()} />
            <button onClick={add} disabled={!valid || busy}
              style={{ background: NAVY, color: '#FFF', border: 'none', borderRadius: 9, padding: '11px 20px',
                       fontSize: 12.5, fontWeight: 700, fontFamily: F, cursor: valid && !busy ? 'pointer' : 'not-allowed',
                       opacity: valid && !busy ? 1 : 0.5, whiteSpace: 'nowrap', flex: isMobile ? undefined : '0 0 auto' }}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
          {note && <div style={{ marginTop: 10, fontSize: 12, color: NAVY, fontWeight: 600 }}>{note}</div>}
        </div>

        {/* Facebook cookie uploader — replaces pasting a cookie export into
            WhatsApp for someone to scp onto the VPS by hand. */}
        <div style={{ background: '#FFFDFA', border: '1px solid #EDEBE5', borderRadius: 12, padding: 18, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>Facebook cookie upload</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, lineHeight: 1.5 }}>
            Paste the exported cookie JSON (the array with c_user / xs / …) to re-log the Facebook poster in.
          </div>
          <textarea value={cookieText} onChange={e => setCookieText(e.target.value)}
            placeholder='[{"domain":".facebook.com","name":"c_user",…}, …]' rows={4}
            style={{ ...inp, width: '100%', marginTop: 10, fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }} />
          <button onClick={uploadCookies} disabled={!cookieText.trim() || cookieBusy}
            style={{ ...btn, marginTop: 10, opacity: cookieText.trim() && !cookieBusy ? 1 : 0.5,
                     cursor: cookieText.trim() && !cookieBusy ? 'pointer' : 'not-allowed' }}>
            {cookieBusy ? 'Importing & verifying…' : 'Import & verify'}
          </button>
          {cookieNote && (
            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: cookieNote.ok ? NAVY : '#B91C1C' }}>
              {cookieNote.text}
            </div>
          )}
        </div>

        {/* FB-groups backlog launcher — same selection fb_backlog_seed.js uses
            (never reached ≥5 groups, newest + photo listings first), same
            one-at-a-time backlog !upload/!price already share safely. */}
        <div style={{ background: '#FFFDFA', border: '1px solid #EDEBE5', borderRadius: 12, padding: 18, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>Launch FB-groups queue</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, lineHeight: 1.5 }}>
            Queues the N listings still under 5 groups (newest + photos first) and starts the backlog — one listing at a time, its own pacing.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input value={queueCount} onChange={e => setQueueCount(e.target.value.replace(/[^\d]/g, ''))}
              type="text" inputMode="numeric" placeholder="16" style={{ ...inp, width: 90 }}
              onKeyDown={e => e.key === 'Enter' && !queueBusy && launchQueue()} />
            <button onClick={launchQueue} disabled={queueBusy}
              style={{ ...btn, opacity: queueBusy ? 0.5 : 1, cursor: queueBusy ? 'not-allowed' : 'pointer' }}>
              {queueBusy ? 'Launching…' : 'Launch'}
            </button>
          </div>
          {queueNote && (
            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: queueNote.ok ? NAVY : '#B91C1C' }}>
              {queueNote.text}
            </div>
          )}
        </div>

        {err && <div style={{ marginTop: 16, color: '#B91C1C', fontSize: 13, fontWeight: 600 }}>{err}</div>}

        {/* Not rendered while loading: an empty list and a list that has not
            arrived yet look identical, and "Nobody yet — add the first address"
            is a lie that reads as fact for as long as the request takes. */}
        {loading ? (
          <div style={{ marginTop: 20, fontSize: 13, color: '#6b7280' }}>Loading…</div>
        ) : (
          <>
            <Section title="Board agents" hint="Outside agents. Removing one deletes the account." rows={agents}
              empty="Nobody yet — add the first address above." onToggle={toggle} onRemove={remove} onSavePhone={savePhone} isMobile={isMobile} />
            <Section title="Staff with board access" hint="Their CRM account is untouched; only board access is removed here."
              rows={staff} empty="No staff has board access." onToggle={toggle} onRemove={remove} onSavePhone={savePhone} isMobile={isMobile} />
          </>
        )}
      </div>
    </CrmShell>
  )
}

function PhoneCell({ r, onSave }: { r: Row; onSave: (r: Row, value: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(r.whatsapp_phone || '')
  useEffect(() => { setValue(r.whatsapp_phone || '') }, [r.whatsapp_phone])
  if (editing) {
    return (
      <input value={value} onChange={e => setValue(e.target.value)} placeholder="+356…" type="tel" autoFocus
        style={{ ...inp, padding: '5px 8px', fontSize: 11.5, width: 130 }}
        onBlur={() => { setEditing(false); if (value.trim() !== (r.whatsapp_phone || '')) onSave(r, value) }}
        onKeyDown={e => {
          if (e.key === 'Enter') { setEditing(false); if (value.trim() !== (r.whatsapp_phone || '')) onSave(r, value) }
          if (e.key === 'Escape') { setValue(r.whatsapp_phone || ''); setEditing(false) }
        }} />
    )
  }
  return (
    <div onClick={() => setEditing(true)} title="Click to edit"
      style={{ fontSize: 11.5, color: r.whatsapp_phone ? '#1A1A1A' : '#8b8f98', cursor: 'pointer', minWidth: 110 }}>
      {r.whatsapp_phone ? `+${r.whatsapp_phone}` : 'no phone — click to add'}
    </div>
  )
}

function Section({ title, hint, rows, empty, onToggle, onRemove, onSavePhone, isMobile }: {
  title: string; hint: string; rows: Row[]; empty: string
  onToggle: (r: Row) => void; onRemove: (r: Row) => void; onSavePhone: (r: Row, value: string) => void; isMobile: boolean
}) {
  return (
    <div style={{ marginTop: 26 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: NAVY, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{title}</div>
      <div style={{ fontSize: 11.5, color: '#8b8f98', marginTop: 3 }}>{hint}</div>
      <div style={{ marginTop: 10, background: '#FFFDFA', border: '1px solid #EDEBE5', borderRadius: 12, overflow: 'hidden' }}>
        {!rows.length && <div style={{ padding: 16, fontSize: 12.5, color: '#8b8f98' }}>{empty}</div>}
        {rows.map((r, i) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                                   borderTop: i ? '1px solid #F1EFE9' : 'none',
                                   flexWrap: isMobile ? 'wrap' : 'nowrap', opacity: r.active ? 1 : 0.55 }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>
                {r.name || r.username}
                {!r.active && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#B45309',
                                             background: '#FEF3C7', padding: '2px 7px', borderRadius: 5 }}>SUSPENDED</span>}
              </div>
              <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 2 }}>{r.email || 'no address — cannot sign in'}</div>
            </div>
            <PhoneCell r={r} onSave={onSavePhone} />
            <div style={{ fontSize: 11.5, color: '#8b8f98', minWidth: 110 }}>last in: {when(r.last_login_at)}</div>
            <button onClick={() => onToggle(r)} style={ghost}>{r.active ? 'Suspend' : 'Re-enable'}</button>
            <button onClick={() => onRemove(r)} style={{ ...ghost, color: '#B91C1C', borderColor: '#F3D6D6' }}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Page() {
  return <CrmProvider><BoardAccess /></CrmProvider>
}

const inp: React.CSSProperties = {
  background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 9, padding: '11px 13px',
  fontSize: 12.5, color: '#1A1A1A', fontFamily: F, outline: 'none', minWidth: 0,
}
const btn: React.CSSProperties = {
  background: NAVY, color: '#FFF', border: 'none', borderRadius: 9, padding: '11px 20px',
  fontSize: 12.5, fontWeight: 700, fontFamily: F, whiteSpace: 'nowrap',
}
const ghost: React.CSSProperties = {
  background: 'transparent', border: '1px solid #E4E0D6', color: NAVY, borderRadius: 8,
  padding: '7px 13px', fontSize: 11.5, fontWeight: 700, fontFamily: F, cursor: 'pointer',
}
