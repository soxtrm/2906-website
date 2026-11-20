'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { addDays, competing, slotsFor } from '@/lib/owner/engine'
import { SOURCE_LABEL, type ViewingRequest } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { niceDate, occupants, relDay, when } from './format'

const STATUS: Record<ViewingRequest['status'], { label: string; tone: '' | 'honey' | 'rose' | 'plain' }> = {
  awaiting_owner: { label: 'Waiting for you', tone: 'honey' },
  question: { label: 'Waiting for their answer', tone: 'plain' },
  new_time_proposed: { label: 'New time suggested', tone: 'plain' },
  confirmed: { label: 'Confirmed', tone: '' },
  declined: { label: 'Declined', tone: 'rose' },
  cancelled: { label: 'Cancelled', tone: 'rose' },
  completed: { label: 'Viewed', tone: 'plain' },
}

export function RequestCard({ r, compact = false }: { r: ViewingRequest; compact?: boolean }) {
  const { properties, agencies, requests, rules, exceptions, today, decide } = useOwner()
  const p = properties.find(x => x.id === r.propertyId)!
  const room = r.roomId ? p.rooms.find(x => x.id === r.roomId) : null
  const agency = r.requester.agencyId ? agencies.find(a => a.id === r.requester.agencyId) : null
  const others = competing(requests, r)
  const [mode, setMode] = useState<'none' | 'propose' | 'ask' | 'decline'>('none')
  const [text, setText] = useState('')
  const [slot, setSlot] = useState('')
  const open = r.status === 'awaiting_owner' || r.status === 'question'

  const options = useMemo(() => {
    const out: { value: string; label: string }[] = []
    for (let i = 0; i < 14 && out.length < 24; i++) {
      const d = addDays(today, i)
      for (const t of slotsFor(rules, exceptions, r.propertyId, d, r.minutes, r.roomId)) {
        const iso = `${d}T${t}`
        if (iso !== r.start && iso > `${today}T09:00`) out.push({ value: iso, label: `${relDay(d, today)} ${t}` })
      }
    }
    return out
  }, [rules, exceptions, r, today])

  const title = `${room ? `${room.label}, ` : ''}${p.name}`
  return (
    <article className="ow-req" data-status={r.status} aria-label={`Viewing request for ${title}`}>
      <div className="ow-req-top">
        <div>
          <p className="ow-faint">{title} · Viewing request</p>
          <p className="ow-req-when">{when(r.start, today)}</p>
          {r.status === 'new_time_proposed' && r.proposedStart && <p className="ow-muted">You suggested {when(r.proposedStart, today)}. Waiting for their answer.</p>}
        </div>
        <span className={`ow-chip ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
      </div>

      {!compact && (
        <dl className="ow-req-facts">
          <div><dt>People</dt><dd>{occupants(r.applicant)}</dd></div>
          <div><dt>Move in</dt><dd>{niceDate(r.applicant.moveIn, false)}</dd></div>
          <div><dt>Stay</dt><dd>{r.applicant.months} months</dd></div>
          <div><dt>Pets</dt><dd>{r.applicant.pets || 'None'}</dd></div>
          {r.applicant.working && <div><dt>Work</dt><dd>{r.applicant.working}</dd></div>}
          <div><dt>Requested by</dt><dd>{agency ? `${agency.name}${r.requester.agentName ? ` (${r.requester.agentName})` : ''}` : 'Private person'}</dd></div>
          <div><dt>Came from</dt><dd>{SOURCE_LABEL[r.source]}</dd></div>
        </dl>
      )}

      {r.status === 'question' && r.question && <p className="ow-req-note">You asked: {r.question}</p>}
      {open && others.length > 0 && (
        <p className="ow-req-also">{others.length === 1 ? 'One more request' : `${others.length} more requests`} for this time. <Link href={`/owner/requests?compare=${r.id}`}>Compare them</Link>. Neither side sees the other.</p>
      )}

      {open && mode === 'none' && (
        <div className="ow-req-actions">
          <button className="ow-btn primary" onClick={() => decide(r.id, { type: 'accept' })}>Accept</button>
          <button className="ow-btn" onClick={() => setMode('propose')}>Suggest another time</button>
          {r.status === 'awaiting_owner' && <button className="ow-btn" onClick={() => setMode('ask')}>Ask a question</button>}
          <button className="ow-btn quiet danger" onClick={() => setMode('decline')}>Decline</button>
        </div>
      )}
      {r.status === 'confirmed' && mode === 'none' && (
        <div className="ow-req-actions">
          <button className="ow-btn" onClick={() => setMode('propose')}>Move to another time</button>
          <button className="ow-btn quiet danger" onClick={() => setMode('decline')}>Cancel viewing</button>
        </div>
      )}

      {mode === 'propose' && (
        <form className="ow-inline-form" onSubmit={e => { e.preventDefault(); if (slot && decide(r.id, { type: 'propose', start: slot })) setMode('none') }}>
          <label className="ow-label" htmlFor={`slot-${r.id}`}>From your free viewing times</label>
          <select id={`slot-${r.id}`} value={slot} onChange={e => setSlot(e.target.value)} required>
            <option value="">Choose a time</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="ow-btn primary" type="submit">Send this time</button>
          <button className="ow-btn quiet" type="button" onClick={() => setMode('none')}>Back</button>
          {!options.length && <p className="ow-error">No free times in the next two weeks. Add viewing hours in the calendar first.</p>}
        </form>
      )}
      {mode === 'ask' && (
        <form className="ow-inline-form" onSubmit={e => { e.preventDefault(); if (decide(r.id, { type: 'ask', question: text })) { setMode('none'); setText('') } }}>
          <input aria-label="Your question" value={text} onChange={e => setText(e.target.value)} placeholder="For example: do they have a car?" style={{ flex: 1, minWidth: 220 }} />
          <button className="ow-btn primary" type="submit">Send question</button>
          <button className="ow-btn quiet" type="button" onClick={() => setMode('none')}>Back</button>
        </form>
      )}
      {mode === 'decline' && (
        <form className="ow-inline-form" onSubmit={e => { e.preventDefault(); if (decide(r.id, r.status === 'confirmed' ? { type: 'cancel', note: text } : { type: 'decline', note: text })) setMode('none') }}>
          <input aria-label="Reason (optional)" value={text} onChange={e => setText(e.target.value)} placeholder="Reason, optional. Only ARGUS sees it." style={{ flex: 1, minWidth: 220 }} />
          <button className="ow-btn danger" type="submit">{r.status === 'confirmed' ? 'Cancel viewing' : 'Decline'}</button>
          <button className="ow-btn quiet" type="button" onClick={() => setMode('none')}>Back</button>
        </form>
      )}
      {open && <p className="ow-faint">Accepting confirms the viewing only. You still decide on the tenant later.</p>}
    </article>
  )
}
