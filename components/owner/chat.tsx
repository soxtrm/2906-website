'use client'
// The owner's one WhatsApp line with ARGUS Main. ARGUS knows which account
// wrote each relayed message, so every bubble names the real person behind it
// ("Daniel · Harbour Homes"), or "ARGUS" for system questions such as
// "is it still available?". The owner's number is never passed on.
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import type { Message } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { NexusStar } from './brand'
import { initials, propColor, when } from './format'
import { wishesFor } from '@/lib/owner/wishes'

function who(m: Message) {
  const s = m.sender
  if (m.from === 'owner') return { key: 'owner', name: 'You', sub: '', kind: 'owner' as const }
  if (!s || s.kind === 'system' || s.kind === 'argus') return { key: 'system', name: 'ARGUS', sub: 'System', kind: 'system' as const }
  if (s.kind === 'agent') return { key: `a:${s.name}:${s.agency}`, name: `${s.name}${s.agency ? ` · ${s.agency}` : ''}`, sub: 'Agent, via ARGUS Main', kind: 'agent' as const }
  return { key: `c:${s.name}`, name: s.name || 'Client', sub: 'Client, via ARGUS Main', kind: 'client' as const }
}

export function ArgusChat({ className = '' }: { className?: string }) {
  const s = useOwner()
  const t = s.threads.find(x => x.with === 'ARGUS Main') || s.threads[0]
  const ids = s.properties.map(p => p.id)
  const lastProp = useMemo(() => [...(t?.messages || [])].reverse().find(m => m.propertyId)?.propertyId ?? null, [t])
  const [about, setAbout] = useState<number | null>(lastProp)
  const [text, setText] = useState('')
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { if (t?.unread) s.readThread(t.id) }, [t?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // scroll only the chat itself, never the page around it
  useEffect(() => { const b = body.current; if (b) b.scrollTop = b.scrollHeight }, [t?.messages.length])
  if (!t) return null

  return (
    <section className={`ow-chat ${className}`} aria-label="Chat with ARGUS Main">
      <header className="ow-chat-head">
        <span className="ow-avatar main"><NexusStar size={16} color="#fff" /></span>
        <div>
          <b>ARGUS Main</b>
          <span>Agents and clients reach you here. Your number stays private.</span>
        </div>
      </header>
      <FitLine about={about} />

      <div className="ow-chat-body" role="log" aria-live="polite" ref={body}>
        {t.messages.map((m, i) => {
          const w = who(m)
          const prev = t.messages[i - 1]
          const first = !prev || who(prev).key !== w.key || prev.propertyId !== m.propertyId
          const p = m.propertyId ? s.properties.find(x => x.id === m.propertyId) : null
          const req = m.actions?.[0] ? s.requests.find(r => r.id === m.actions![0].requestId) : null
          return (
            <div key={m.id} className="ow-msg" data-kind={w.kind} data-first={first}>
              {w.kind !== 'owner' && (
                <span className="ow-avatar" data-kind={w.kind} aria-hidden="true" style={{ visibility: first ? 'visible' : 'hidden' }}>
                  {w.kind === 'system' ? <NexusStar size={13} color="#fff" /> : initials(w.name)}
                </span>
              )}
              <div className="ow-msg-bubble">
                {first && w.kind !== 'owner' && (
                  <p className="ow-msg-who"><b>{w.name}</b>{w.sub && <span>{w.sub}</span>}</p>
                )}
                {first && p && (
                  <p className="ow-msg-prop"><i style={{ background: propColor(ids, p.id) }} />{p.name}</p>
                )}
                <p>{m.text}</p>
                {m.actions && req && req.status === 'awaiting_owner' && (
                  <div className="ow-msg-actions">
                    {m.actions.map(a => a.action === 'accept'
                      ? <button key={a.label} className="ow-btn small primary" onClick={() => s.decide(a.requestId, { type: 'accept' })}>{a.label}</button>
                      : a.action === 'decline'
                        ? <button key={a.label} className="ow-btn small quiet danger" onClick={() => s.decide(a.requestId, { type: 'decline' })}>{a.label}</button>
                        : <Link key={a.label} className="ow-btn small" href={`/owner/requests?compare=${a.requestId}`}>{a.label}</Link>)}
                  </div>
                )}
                {m.actions && req && req.status !== 'awaiting_owner' && <p className="ow-msg-done">Answered: {req.status.replace(/_/g, ' ')}</p>}
                <time>{when(m.at, s.today)}</time>
              </div>
            </div>
          )
        })}
      </div>

      <form className="ow-chat-compose" onSubmit={e => { e.preventDefault(); if (text.trim()) { s.sendMessage(t.id, text.trim(), about); setText('') } }}>
        <label className="ow-about">
          <span className="sr-only">About</span>
          <i style={{ background: propColor(ids, about) }} />
          <select value={about ?? ''} onChange={e => setAbout(e.target.value ? Number(e.target.value) : null)} aria-label="Which property is this about">
            <option value="">All properties</option>
            {s.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <input aria-label="Message" value={text} onChange={e => setText(e.target.value)} placeholder="Write to ARGUS Main" />
        <button className="ow-send" type="submit" aria-label="Send" disabled={!text.trim()}><SendHorizontal size={20} /></button>
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
