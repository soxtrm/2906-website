'use client'
// The owner's one WhatsApp line with ARGUS Main, drawn like WhatsApp so it
// feels as familiar. ARGUS knows which account wrote each relayed message, so
// every bubble names the real person ("Daniel · Harbour Homes"), or "ARGUS" for
// system questions. Documents can be sent from Documents or straight from the
// phone; they stay private until the owner shares them with an agency.
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCheck, FileText, Paperclip, Search, SendHorizontal, Upload, X } from 'lucide-react'
import type { DocumentItem, Message } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { wishesFor } from '@/lib/owner/wishes'
import { NexusStar } from './brand'
import { initials, propColor, relDay } from './format'

const NAME_COLORS = ['#1f7aec', '#c2338a', '#0f8a6a', '#8a4bd6', '#d1462f', '#1e8aa0']
const KIND_LABEL: Record<DocumentItem['kind'], string> = { contract: 'Contract', inventory: 'Inventory', certificate: 'Certificate', id: 'ID', other: 'Document' }

function who(m: Message) {
  const s = m.sender
  if (m.from === 'owner') return { key: 'owner', name: 'You', sub: '', kind: 'owner' as const }
  if (!s || s.kind === 'system' || s.kind === 'argus') return { key: 'system', name: 'ARGUS', sub: 'System', kind: 'system' as const }
  if (s.kind === 'agent') return { key: `a:${s.name}:${s.agency}`, name: `${s.name}${s.agency ? ` · ${s.agency}` : ''}`, sub: 'Agent', kind: 'agent' as const }
  return { key: `c:${s.name}`, name: s.name || 'Client', sub: 'Client', kind: 'client' as const }
}
const colorFor = (key: string) => NAME_COLORS[[...key].reduce((n, c) => n + c.charCodeAt(0), 0) % NAME_COLORS.length]

function readFile(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
}

export function ArgusChat({ className = '' }: { className?: string }) {
  const s = useOwner()
  const t = s.threads.find(x => x.with === 'ARGUS Main') || s.threads[0]
  const ids = s.properties.map(p => p.id)
  const lastProp = useMemo(() => [...(t?.messages || [])].reverse().find(m => m.propertyId)?.propertyId ?? null, [t])
  const [about, setAbout] = useState<number | null>(lastProp)
  const [text, setText] = useState('')
  const [find, setFind] = useState<string | null>(null)
  const [attach, setAttach] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => { if (t?.unread) s.readThread(t.id) }, [t?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // scroll only the chat itself, never the page around it
  useEffect(() => {
    const b = body.current; if (!b) return
    const down = () => { b.scrollTop = b.scrollHeight }
    down()
    // the chat stretches to the column next to it after layout; stay at the newest message
    const ro = new ResizeObserver(down); ro.observe(b)
    const stop = setTimeout(() => ro.disconnect(), 1200)
    return () => { clearTimeout(stop); ro.disconnect() }
  }, [t?.messages.length])
  if (!t) return null

  // the header names whoever wrote last (like a WhatsApp group), ARGUS Main underneath
  const lastIn = [...t.messages].reverse().find(m => m.from !== 'owner')
  const writer = lastIn ? who(lastIn) : null
  const headName = !writer || writer.kind === 'system' ? 'ARGUS Main' : writer.name
  const headSub = !writer || writer.kind === 'system' ? 'online' : `${writer.sub} · via ARGUS Main`

  const shown = find ? t.messages.filter(m => m.text.toLowerCase().includes(find.toLowerCase())) : t.messages

  async function upload(list: FileList | null) {
    const f = list?.[0]; if (!f) return
    const dataUrl = f.size < 3_000_000 ? await readFile(f) : undefined
    const id = s.addDocument({ title: f.name.replace(/\.[^.]+$/, ''), kind: 'other', propertyId: about ?? s.properties[0].id, dataUrl, fileName: f.name })
    setTimeout(() => s.sendDocument(id), 0)
    setAttach(false)
  }

  return (
    <section className={`ow-chat ow-wa ${className}`} aria-label="Chat with ARGUS Main">
      <header className="ow-wa-head">
        <span className="ow-wa-avatar" style={writer && writer.kind !== 'system' ? { background: colorFor(writer.key) } : undefined}>
          {writer && writer.kind !== 'system' ? <b>{initials(writer.name)}</b> : <NexusStar size={18} color="#fff" />}
          <i className="ow-wa-badge"><NexusStar size={9} color="#fff" /></i>
        </span>
        <div className="ow-wa-title">
          <b key={headName} className="ow-wa-name">{headName}</b>
          <span>{headSub}{writer && writer.kind !== 'system' ? '' : ` · ${({ whatsapp: 'synced with your WhatsApp', sms: 'also by SMS', email: 'also by email', app: 'here in SYNC' } as const)[s.profile.notify.channel || 'whatsapp']}`}</span>
        </div>
        <button type="button" className="ow-wa-icon" aria-label="Search the chat" aria-pressed={find !== null} onClick={() => setFind(f => (f === null ? '' : null))}><Search size={19} /></button>
      </header>
      {find !== null && (
        <div className="ow-wa-search">
          <input autoFocus value={find} onChange={e => setFind(e.target.value)} placeholder="Search messages" aria-label="Search messages" />
          <button type="button" aria-label="Close search" onClick={() => setFind(null)}><X size={16} /></button>
        </div>
      )}
      <FitLine about={about} />

      <div className="ow-wa-body" role="log" aria-live="polite" ref={body}>
        {shown.map((m, i) => {
          const w = who(m)
          const prev = shown[i - 1]
          const newDay = !prev || prev.at.slice(0, 10) !== m.at.slice(0, 10)
          const first = newDay || !prev || who(prev).key !== w.key || prev.propertyId !== m.propertyId
          const p = m.propertyId ? s.properties.find(x => x.id === m.propertyId) : null
          const req = m.actions?.[0] ? s.requests.find(r => r.id === m.actions![0].requestId) : null
          const doc = m.attachment ? s.documents.find(d => d.id === m.attachment!.docId) : null
          return (
            <div key={m.id} className="ow-wa-row-wrap">
              {newDay && <p className="ow-wa-day"><span>{relDay(m.at.slice(0, 10), s.today)}</span></p>}
              <div className="ow-wa-row" data-kind={w.kind} data-first={first}>
                <div className="ow-wa-bubble">
                  {first && w.kind !== 'owner' && (
                    <p className="ow-wa-who" style={{ color: w.kind === 'system' ? '#071449' : colorFor(w.key) }}>
                      {w.kind === 'system' ? <NexusStar size={11} /> : <span className="ow-wa-ini" style={{ background: colorFor(w.key) }}>{initials(w.name)}</span>}
                      <b>{w.name}</b><span>{w.sub}</span>
                    </p>
                  )}
                  {first && p && <p className="ow-wa-prop"><i style={{ background: propColor(ids, p.id) }} />{p.name}</p>}
                  {m.attachment ? (
                    <div className="ow-wa-doc">
                      <span className="ow-wa-doc-icon"><FileText size={22} /></span>
                      <span><b>{m.attachment.title}</b><small>{KIND_LABEL[m.attachment.kind]}{doc?.sharedWith.length ? ` · shared with ${doc.sharedWith.length}` : ' · private'}</small></span>
                      {doc?.dataUrl && <a href={doc.dataUrl} target="_blank" rel="noopener" download={doc.fileName}>Open</a>}
                    </div>
                  ) : <p className="ow-wa-text">{m.text}</p>}
                  {m.actions && req && req.status === 'awaiting_owner' && (
                    <div className="ow-wa-actions">
                      {m.actions.map(a => a.action === 'accept'
                        ? <button key={a.label} onClick={() => s.decide(a.requestId, { type: 'accept' })}>{a.label}</button>
                        : a.action === 'decline'
                          ? <button key={a.label} className="no" onClick={() => s.decide(a.requestId, { type: 'decline' })}>{a.label}</button>
                          : <Link key={a.label} href={`/owner/requests?compare=${a.requestId}`}>{a.label}</Link>)}
                    </div>
                  )}
                  {m.actions && req && req.status !== 'awaiting_owner' && <p className="ow-wa-done">Answered: {req.status.replace(/_/g, ' ')}</p>}
                  <span className="ow-wa-meta">{m.at.slice(11, 16)}{w.kind === 'owner' && <CheckCheck size={15} className="ow-wa-ticks" aria-label="Read" />}</span>
                </div>
              </div>
            </div>
          )
        })}
        {find && !shown.length && <p className="ow-wa-day"><span>Nothing found</span></p>}
      </div>

      {attach && (
        <div className="ow-wa-attach" role="dialog" aria-label="Send a document">
          <div className="ow-wa-attach-head"><b>Send a document</b><button type="button" aria-label="Close" onClick={() => setAttach(false)}><X size={16} /></button></div>
          <button type="button" className="ow-wa-attach-up" onClick={() => file.current?.click()}><Upload size={18} />From this device</button>
          <input ref={file} type="file" hidden onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <p className="ow-faint">From your documents</p>
          <ul>
            {s.documents.map(d => (
              <li key={d.id}><button type="button" onClick={() => { s.sendDocument(d.id); setAttach(false) }}>
                <FileText size={16} /><span>{d.title}</span><small>{s.properties.find(p => p.id === d.propertyId)?.name.split(' ').slice(0, 2).join(' ')}</small>
              </button></li>
            ))}
          </ul>
        </div>
      )}

      <form className="ow-wa-compose" onSubmit={e => { e.preventDefault(); if (text.trim()) { s.sendMessage(t.id, text.trim(), about); setText('') } }}>
        <button type="button" className="ow-wa-icon" aria-label="Send a document" aria-expanded={attach} onClick={() => setAttach(a => !a)}><Paperclip size={20} /></button>
        <label className="ow-about">
          <i style={{ background: propColor(ids, about) }} />
          <select value={about ?? ''} onChange={e => setAbout(e.target.value ? Number(e.target.value) : null)} aria-label="Which property is this about">
            <option value="">All homes</option>
            {s.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <input aria-label="Message" value={text} onChange={e => setText(e.target.value)} placeholder="Type a message" />
        <button className="ow-wa-send" type="submit" aria-label="Send" disabled={!text.trim()}><SendHorizontal size={20} /></button>
      </form>
    </section>
  )
}

// Always visible above the conversation, however far the chat scrolls: what
// does not fit (and what is wanted) for the home the chat is about right now.
function FitLine({ about }: { about: number | null }) {
  const s = useOwner()
  const list = wishesFor(s.wishes, s.properties.map(p => p.id), about)
  const no = list.filter(w => w.polarity === 'minus').map(w => w.label)
  const yes = list.filter(w => w.polarity === 'plus').map(w => w.label)
  if (!no.length && !yes.length) return null
  return (
    <div className="ow-fitline" aria-label="What fits this home">
      {no.length > 0 && <p><b className="no">Not a fit</b>{no.join(' · ')}</p>}
      {yes.length > 0 && <p><b className="yes">Looking for</b>{yes.join(' · ')}</p>}
    </div>
  )
}
