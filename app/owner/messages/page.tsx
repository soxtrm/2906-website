'use client'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useOwner } from '@/lib/owner/store'
import { when } from '@/components/owner/format'

function MessagesInner() {
  const s = useOwner()
  const q = useSearchParams().get('t')
  const [active, setActive] = useState(q || s.threads[0]?.id)
  const [text, setText] = useState('')
  const t = s.threads.find(x => x.id === active)
  useEffect(() => { if (t?.unread) s.readThread(t.id) }, [t?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="ow-head"><div>
        <h1>Messages</h1>
        <p className="ow-muted">ARGUS Main passes messages between you, agents and tenants. Your phone number is never shared. For times and answers, use the buttons: everyone gets the same update.</p>
      </div></div>
      <div className="ow-msgs">
        <div className="ow-thread-list" role="group" aria-label="Conversations">
          {s.threads.map(th => (
            <button key={th.id} aria-pressed={th.id === active} onClick={() => setActive(th.id)}>
              <b>{th.title}</b>
              <span className="ow-faint">{th.messages[th.messages.length - 1]?.text.slice(0, 60)}…</span>
              {th.unread > 0 && <span className="ow-chip honey" style={{ justifySelf: 'start' }}>{th.unread} new</span>}
            </button>
          ))}
        </div>
        {t && (
          <div className="ow-panel" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--ow-line)' }}><h2>{t.title}</h2></div>
            <div className="ow-bubbles">
              {t.messages.map(m => {
                const req = m.actions?.[0] ? s.requests.find(r => r.id === m.actions![0].requestId) : null
                return (
                  <div key={m.id} className="ow-bubble" data-from={m.from}>
                    {m.from === 'argus' && <span className="who">ARGUS Main</span>}
                    <p>{m.text}</p>
                    {m.actions && req && req.status === 'awaiting_owner' && (
                      <div className="ow-req-actions" style={{ marginTop: 10 }}>
                        {m.actions.map(a => a.action === 'accept'
                          ? <button key={a.label} className="ow-btn small primary" onClick={() => s.decide(a.requestId, { type: 'accept' })}>{a.label}</button>
                          : a.action === 'decline'
                            ? <button key={a.label} className="ow-btn small quiet danger" onClick={() => s.decide(a.requestId, { type: 'decline' })}>{a.label}</button>
                            : <Link key={a.label} className="ow-btn small" href={`/owner/requests?compare=${a.requestId}`}>{a.label}</Link>)}
                      </div>
                    )}
                    {m.actions && req && req.status !== 'awaiting_owner' && <p className="ow-faint" style={{ marginTop: 6 }}>Answered: {req.status.replace(/_/g, ' ')}</p>}
                    <time>{when(m.at, s.today)}</time>
                  </div>
                )
              })}
            </div>
            <form className="ow-compose" onSubmit={e => { e.preventDefault(); if (text.trim()) { s.sendMessage(t.id, text.trim()); setText('') } }}>
              <input aria-label="Message" value={text} onChange={e => setText(e.target.value)} placeholder={t.with === 'ARGUS Main' ? 'Ask ARGUS Main anything about your properties' : `Message ${t.with} through ARGUS`} />
              <button className="ow-btn primary" type="submit">Send</button>
            </form>
          </div>
        )}
      </div>
    </>
  )
}

export default function Messages() {
  return <Suspense fallback={null}><MessagesInner /></Suspense>
}
