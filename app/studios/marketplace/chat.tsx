'use client'
// NEXUS Marketplace conversation panel (2026-11-21): a real, server-persisted chat with the listing agency.
// Start -> ARGUS creates the conversation and returns a token (kept only in this browser). Messages show
// "Sending…" until ARGUS stored them; viewing requests show their real state: with the agency -> waiting for
// the owner (a booked ARGUS viewing) -> confirmed by the owner. Nothing is shown as booked before that.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CalendarDays, Check, CheckCheck, ChevronDown, Clock, Download, ExternalLink, FileText, Lock, Paperclip, RotateCw, Send, ShieldCheck, X } from 'lucide-react'
import type { ListingCard } from '@/lib/marketplace/model'

type Msg = { id: number; from: 'visitor' | 'staff' | 'system'; kind: string; text: string; at: string; meta?: Record<string, unknown> }
type Req = { id: number; state: 'requested' | 'waiting_owner' | 'confirmed' | 'declined' | 'not_possible' | 'cancelled'; preferred: { date: string; part: string }[]; startsAt: string | null }
type DealDoc = { id: number; kind: string; title: string; mime: string | null; size: number | null; version: number; from: string; scan: string; at: string }
type DealPay = { id: number; kind: string; label: string; amount: number; currency: string; status: string; statusLabel: string }
type Deal = { id: string; stage: string; label: string; stages: { key: string; label: string; state: 'done' | 'now' | 'next' | 'off' }[]; documents?: DealDoc[]; payments?: DealPay[] }
type Conv = { id: string; ref: string; title: string; status: string; agent: { id: number; name: string; photo: string | null } | null; messages: Msg[]; requests: Req[]; unread: number; deal?: Deal | null }
type Pending = { key: string; text: string; failed?: string }

const KEY = (ref: string) => `nx-mp-chat:${ref}`
const load = (ref: string): { id: string; token: string } | null => { try { const v = JSON.parse(localStorage.getItem(KEY(ref)) || 'null'); return v && v.id && v.token ? v : null } catch { return null } }
const save = (ref: string, v: { id: string; token: string }) => { try { localStorage.setItem(KEY(ref), JSON.stringify(v)) } catch { /* private mode: the chat lasts for this visit */ } }
async function call(path: string, method: 'GET' | 'POST', body?: unknown, token?: string) {
  const r = await fetch(`/api/marketplace/chat/${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-mp-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d.ok === false) throw Object.assign(new Error(d.message || 'Not sent. Please try again.'), { code: d.error, status: r.status })
  return d
}
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit' })
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short' })
const STATE: Record<Req['state'], { label: string; tone: string }> = {
  requested: { label: 'With the agency', tone: 'wait' }, waiting_owner: { label: 'Time requested · waiting for the owner', tone: 'wait' },
  confirmed: { label: 'Confirmed by the owner', tone: 'ok' }, declined: { label: 'No viewing on these days', tone: 'no' },
  not_possible: { label: 'The owner could not confirm', tone: 'no' }, cancelled: { label: 'Cancelled', tone: 'no' },
}

export type ChatMeta = { name: string; photo: string | null; unread: number; started: boolean }
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')

export function ChatPanel({ l, onMeta, focusKey = 0, onClose }: { l: ListingCard; onMeta?: (m: ChatMeta) => void; focusKey?: number; onClose?: () => void }) {
  const reduce = useReducedMotion()
  const [auth, setAuth] = useState<{ id: string; token: string } | null>(null)
  const [conv, setConv] = useState<Conv | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [text, setText] = useState('')
  const [picking, setPicking] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const agency = l.provider.kind === 'agency' ? l.provider.agency : null
  const who = conv?.agent?.name || (l.provider.kind === 'agency' ? l.provider.agent?.name : null) || agency?.name || 'Agency'
  const photo = conv?.agent?.photo || null
  useEffect(() => { onMeta?.({ name: who, photo, unread: conv?.unread || 0, started: !!auth }) }, [who, photo, conv?.unread, auth]) // eslint-disable-line react-hooks/exhaustive-deps
  // "Message" on a card / the floating tab: put the cursor where the visitor writes
  useEffect(() => { if (focusKey) setTimeout(() => root.current?.querySelector<HTMLElement>('.mc-compose textarea, .mc-start input')?.focus({ preventScroll: true }), 60) }, [focusKey])

  const refresh = useCallback(async (a = auth) => {
    if (!a) return
    try { const d = await call(`conversations/${a.id}`, 'GET', undefined, a.token); setConv(d.conversation); setErr(null) }
    catch (e) { if ((e as { status?: number }).status === 404) { try { localStorage.removeItem(KEY(l.id)) } catch { /* */ } setAuth(null); setConv(null) } else setErr((e as Error).message) }
  }, [auth, l.id])
  useEffect(() => { const a = load(l.id); setAuth(a); setConv(null); if (a) refresh(a) }, [l.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!auth) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 12000)
    return () => clearInterval(t)
  }, [auth, refresh])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }) }, [conv?.messages.length, pending.length, reduce])

  if (!agency) return <div className="mc-chat"><p className="mp-muted small">The provider of this listing is being confirmed, so messages are not open yet.</p></div>

  const sendText = async (body: string) => {
    if (!auth || !body.trim()) return
    const key = `p${Date.now()}`
    setPending(p => [...p, { key, text: body.trim() }]); setText('')
    try { const d = await call(`conversations/${auth.id}/messages`, 'POST', { body }, auth.token); setConv(d.conversation); setPending(p => p.filter(x => x.key !== key)) }
    catch (e) { setPending(p => p.map(x => (x.key === key ? { ...x, failed: (e as Error).message } : x))) }
  }

  return (
    <div className="mc-chat" ref={root}>
      <header className="mc-chat-head">
        {photo
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={photo} alt="" className="mc-chat-av" />
          : <span className="mc-chat-av" aria-hidden="true">{initialsOf(who)}</span>}
        <span className="mc-chat-who">
          <b>{who}</b>
          <small className="mc-chat-org">
            {agency.logo
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={agency.logo} alt={agency.name} title={agency.name} />
              : <span>{agency.name}</span>}
            {agency.verified && <ShieldCheck size={12} aria-label="verified agency" />}
            <span className="mc-chat-ref">· Ref {l.id}</span>
          </small>
        </span>
        <span className="mc-chat-live" data-on={!!conv || undefined}>{conv ? (conv.status === 'open' ? 'Conversation open' : 'Closed') : 'Replies arrive here'}</span>
        {onClose && <button type="button" className="mc-chat-x" onClick={onClose} aria-label="Minimise chat"><X size={16} /></button>}
      </header>

      {conv?.deal && auth && <DealStrip deal={conv.deal} auth={auth} onDeal={d => setConv(c => (c ? { ...c, deal: d } : c))} />}
      {!auth ? <StartForm l={l} onStarted={(a, c) => { save(l.id, a); setAuth(a); setConv(c) }} /> : <>
        <div className="mc-thread" ref={list} aria-live="polite">
          {!conv && !err && <div className="mp-lines" aria-busy="true"><i /><i /></div>}
          {conv?.messages.map((m, i) => {
            const newDay = i === 0 || day(m.at) !== day(conv.messages[i - 1].at)
            return (
              <div key={m.id}>
                {newDay && <p className="mc-day">{day(m.at)}</p>}
                {m.from === 'system'
                  ? <p className="mc-sys"><CalendarDays size={13} aria-hidden="true" />{m.text}</p>
                  : <motion.div className={`mc-bubble ${m.from === 'visitor' ? 'me' : 'them'}`} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                    {m.kind === 'viewing_request' && <span className="mc-bubble-tag"><CalendarDays size={12} aria-hidden="true" />Viewing request</span>}
                    <span>{m.text}</span><small>{time(m.at)}{m.from === 'visitor' && <CheckCheck size={13} aria-label="stored by the agency system" />}</small>
                  </motion.div>}
              </div>
            )
          })}
          {pending.map(p => (
            <div key={p.key} className="mc-bubble me pending" data-failed={p.failed ? true : undefined}>
              <span>{p.text}</span>
              <small>{p.failed ? <button onClick={() => { setPending(x => x.filter(y => y.key !== p.key)); sendText(p.text) }}><RotateCw size={12} />Not sent · retry</button> : <><Clock size={12} />Sending…</>}</small>
            </div>
          ))}
          {conv?.requests.map(r => (
            <div key={`r${r.id}`} className="mc-req" data-tone={STATE[r.state]?.tone}>
              <b>{r.state === 'confirmed' ? <Check size={14} /> : <Clock size={14} />}{STATE[r.state]?.label || r.state}</b>
              <span>{r.startsAt ? `${day(r.startsAt)}, ${time(r.startsAt)}` : r.preferred.map(p => `${day(`${p.date}T12:00:00Z`)}${p.part !== 'any' ? ` ${p.part}` : ''}`).join(' · ')}</span>
            </div>
          ))}
        </div>
        {err && <p className="mp-err">{err}</p>}
        <AnimatePresence>{picking && conv && <ViewingPicker key="pick" auth={auth} onDone={c => { setConv(c); setPicking(false) }} onCancel={() => setPicking(false)} />}</AnimatePresence>
        {conv?.status === 'open' && !picking && (
          <form className="mc-compose" onSubmit={e => { e.preventDefault(); sendText(text) }}>
            <textarea rows={1} value={text} maxLength={2000} onChange={e => setText(e.target.value)} placeholder="Write a message" aria-label="Message"
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(text) } }} />
            <button className="mc-send" disabled={!text.trim()} aria-label="Send"><Send size={17} /></button>
          </form>
        )}
        {conv?.status === 'open' && !picking && !conv.requests.some(r => ['requested', 'waiting_owner', 'confirmed'].includes(r.state)) && l.availability.kind !== 'from' && (
          <button className="mc-book" onClick={() => setPicking(true)}><CalendarDays size={16} />Request a viewing</button>
        )}
      </>}
      <p className="mc-foot-note"><span><Lock size={11} aria-hidden="true" /> Private NEXUS conversation with {agency.name}. No phone numbers are shared.</span>
        <a href={`/marketplace?agency=${encodeURIComponent(agency.key)}&market=${l.market}`}>All homes from {agency.name}</a>{agency.website && <a href={agency.website} target="_blank" rel="noopener">Website<ExternalLink size={10} aria-hidden="true" /></a>}</p>
    </div>
  )
}

// NEXUS Deal Room, client view: where this enquiry stands, the documents meant for the client, payment requests
// with their real state (a request is never a receipt), and a way to add photos or documents as evidence.
const kb = (n: number | null) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
function DealStrip({ deal, auth, onDeal }: { deal: Deal; auth: { id: string; token: string }; onDeal: (d: Deal) => void }) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const [kind, setKind] = useState('condition_evidence')
  const file = useRef<HTMLInputElement>(null)
  const steps = deal.stages.filter(s => s.key !== 'completed' || deal.stage === 'completed')
  const docs = deal.documents || [], pays = deal.payments || []
  const upload = async (f: File) => {
    setErr('')
    if (f.size > 3 * 1024 * 1024) { setErr('Files up to 3 MB here. Ask the agent for a link for larger videos.'); return }
    setBusy(true)
    try {
      const dataBase64 = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(new Error('read')); r.readAsDataURL(f) })
      const res = await fetch(`/api/marketplace/deal/${auth.id}/documents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mp-token': auth.token },
        body: JSON.stringify({ kind, title: f.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'Document', filename: f.name, dataBase64, captureMeta: { capturedAt: new Date(f.lastModified).toISOString() } }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.deal) throw new Error(d.message || 'Not uploaded.')
      onDeal(d.deal)
    } catch (e) { setErr((e as Error).message) }
    setBusy(false); if (file.current) file.current.value = ''
  }
  const download = async (d: DealDoc) => {
    setErr('')
    const r = await fetch(`/api/marketplace/deal/${auth.id}/documents/${d.id}`, { headers: { 'x-mp-token': auth.token } })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.message || 'Not available.'); return }
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a')
    a.href = url; a.download = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || d.title; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  return (
    <motion.div className="mc-deal" initial={reduce ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
      <button type="button" className="mc-deal-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <b>Deal Room</b><span>{deal.stage === 'cancelled' ? 'Closed' : deal.label}{(docs.length + pays.length) > 0 && ` · ${docs.length} doc${docs.length === 1 ? '' : 's'}${pays.length ? ` · ${pays.length} request${pays.length === 1 ? '' : 's'}` : ''}`}<ChevronDown size={14} aria-hidden="true" /></span>
      </button>
      {deal.stage !== 'cancelled' && <ol aria-label="Progress">{steps.map(s => <li key={s.key} data-state={s.state} title={s.label}><i />{s.state === 'now' && <small>{s.label}</small>}</li>)}</ol>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" className="mc-deal-body" initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={reduce ? undefined : { opacity: 0, height: 0 }}>
            {pays.length > 0 && <div className="mc-deal-sec"><b>Payment requests</b>{pays.map(p => <p key={p.id} className="mc-deal-pay" data-status={p.status}><span>{p.label}</span><span>€{p.amount.toLocaleString('en-GB')}</span><small>{p.statusLabel}</small></p>)}
              <small className="mc-deal-note">NEXUS does not hold money. Pay only through the details the agency gives you; a payment counts once it is verified.</small></div>}
            <div className="mc-deal-sec"><b>Documents</b>
              {!docs.length ? <small className="mc-deal-note">No documents yet.</small> : docs.map(d => (
                <button key={d.id} type="button" className="mc-deal-doc" onClick={() => download(d)} disabled={d.scan === 'pending'} title={d.scan === 'pending' ? 'Being checked' : 'Download'}>
                  <FileText size={14} aria-hidden="true" /><span>{d.title}{d.version > 1 ? ` (v${d.version})` : ''}<small>{d.from} · {new Date(d.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{d.size ? ` · ${kb(d.size)}` : ''}{d.scan === 'pending' ? ' · being checked' : ''}</small></span><Download size={14} aria-hidden="true" />
                </button>))}
            </div>
            {!['completed', 'cancelled'].includes(deal.stage) && <div className="mc-deal-up">
              <select value={kind} onChange={e => setKind(e.target.value)} aria-label="What is it?"><option value="condition_evidence">Condition photo</option><option value="photo">Photo</option><option value="document">Document (PDF)</option><option value="signed_document">Signed document</option></select>
              <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,video/mp4,video/quicktime" capture={kind === 'photo' || kind === 'condition_evidence' ? 'environment' : undefined} onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} hidden />
              <button type="button" onClick={() => file.current?.click()} disabled={busy}><Paperclip size={14} aria-hidden="true" />{busy ? 'Uploading…' : 'Add a file'}</button>
            </div>}
            {err && <p className="mp-err">{err}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function StartForm({ l, onStarted }: { l: ListingCard; onStarted: (a: { id: string; token: string }, c: Conv) => void }) {
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [phone, setPhone] = useState('')
  const [role, setRole] = useState<'home-seeker' | 'agent'>('home-seeker')
  const [message, setMessage] = useState(`Hi, is this home still available? I'm interested in Ref ${l.id}.`)
  const [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    try { const d = await call('conversations', 'POST', { ref: l.id, name, email, phone, role, message }); onStarted({ id: d.conversation.id, token: d.token }, d.conversation) }
    catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  // compact first: the message; name and a way to reach you open as soon as the visitor starts (Kev: compact panel)
  const [more, setMore] = useState(false)
  const reduce = useReducedMotion()
  return (
    <form className="mc-start" onSubmit={e => { e.preventDefault(); if (!more) { setMore(true); return } go() }} onFocus={() => setMore(true)}>
      <label className="mc-start-msg"><span className="sr">Message</span><textarea rows={2} maxLength={2000} value={message} onChange={e => setMessage(e.target.value)} aria-label="Message" /></label>
      <AnimatePresence initial={false}>
        {more && (
          <motion.div key="who" className="mc-start-who" initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={reduce ? undefined : { opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
            <div className="mp-seg small" role="group" aria-label="I am">
              <button type="button" aria-pressed={role === 'home-seeker'} onClick={() => setRole('home-seeker')}>Looking for myself</button>
              <button type="button" aria-pressed={role === 'agent'} onClick={() => setRole('agent')}>Agent for a client</button>
            </div>
            <label>Your name<input required value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>
            <div className="mc-start-row">
              <label>E-mail<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
              <label>or phone<input type="tel" value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" /></label>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {err && <p className="mp-err">{err}</p>}
      <button className="mp-send" disabled={busy || !message.trim() || (more && (!name.trim() || (!email.includes('@') && phone.replace(/\D/g, '').length < 7)))}><Send size={16} />{busy ? 'Sending…' : more ? 'Start conversation' : 'Write to the agent'}</button>
      {more && <p className="mp-muted small">Your details go only to {l.provider.kind === 'agency' ? l.provider.agency.name : 'the agency'}. This chat stays open on this device.</p>}
    </form>
  )
}

function ViewingPicker({ auth, onDone, onCancel }: { auth: { id: string; token: string }; onDone: (c: Conv) => void; onCancel: () => void }) {
  const days = Array.from({ length: 14 }, (_, i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date(Date.now() + (i + 1) * 86400e3)))
  const [sel, setSel] = useState<string[]>([]), [part, setPart] = useState('any'), [note, setNote] = useState('')
  const [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    try { const d = await call(`conversations/${auth.id}/viewing`, 'POST', { preferred: sel.map(date => ({ date, part })), note }, auth.token); onDone(d.conversation) }
    catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  return (
    <motion.div className="mc-pick" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
      <div className="mc-pick-head"><b>Which days suit you?</b><button onClick={onCancel} aria-label="Cancel"><X size={16} /></button></div>
      <div className="mc-days">{days.map(d => (
        <button key={d} type="button" aria-pressed={sel.includes(d)} disabled={!sel.includes(d) && sel.length >= 3} onClick={() => setSel(s => (s.includes(d) ? s.filter(x => x !== d) : [...s, d]))}>
          <small>{day(`${d}T12:00:00Z`).split(' ')[0]}</small><b>{Number(d.slice(8))}</b>
        </button>))}</div>
      <div className="mp-seg small" role="group" aria-label="Time of day">{['any', 'morning', 'afternoon', 'evening'].map(p => <button key={p} type="button" aria-pressed={part === p} onClick={() => setPart(p)}>{p === 'any' ? 'Any time' : p[0].toUpperCase() + p.slice(1)}</button>)}</div>
      <input value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="Anything the agency should know (optional)" aria-label="Note" />
      {err && <p className="mp-err">{err}</p>}
      <button className="mp-send" disabled={busy || !sel.length} onClick={go}><CalendarDays size={16} />{busy ? 'Sending…' : `Send request (${sel.length} ${sel.length === 1 ? 'day' : 'days'})`}</button>
      <p className="mp-muted small">The agency picks a time inside the owner&apos;s viewing hours. It is confirmed only when the owner accepts.</p>
    </motion.div>
  )
}
