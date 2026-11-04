'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, CalendarClock, ChevronUp, FileText, History, Loader2, PhoneCall, Search, ShieldCheck, UserRoundCheck } from 'lucide-react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { cn } from '@/lib/utils'

type Message = {
  id:number; stableId:string; direction:'incoming'|'outgoing'; senderRole:'OWNER'|'AGENT'|'ARGUS_AI'|'2906_SYSTEM'
  text:string; redactions:string[]; restricted?:boolean; at:string; propertyRef?:string|null
  provenance:{ source:string; sourceMessageId?:string|null; originalPreserved:boolean }
  attachment?:{ filename:string;mimeType?:string;url?:string|null;restricted?:boolean;unavailable?:boolean;label?:string }|null
}
type Fact = { key:string;label:string;source:{ type:string;id:number;field:string;at?:string|null } }
type HistoryData = {
  ownerLabel:string; messages:Message[]; facts:Fact[]; nextCursor?:string|null
  conversationStates?:{status:string;count:number}[]
}

function dayLabel(value:string) {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return 'Today'
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { day:'2-digit',month:'short',year:'numeric' })
}
function timeLabel(value:string) { return new Date(value).toLocaleTimeString([], { hour:'2-digit',minute:'2-digit' }) }
function roleLabel(role:Message['senderRole']) {
  return role === 'OWNER' ? 'Owner' : role === 'ARGUS_AI' ? 'ARGUS AI' : role === 'AGENT' ? 'Agent' : '2906 system'
}

export function SharedOwnerHistory({ propertyRef, ownerId, embedded=false, pollMs=0, className }: {
  propertyRef?:string; ownerId?:number; embedded?:boolean; pollMs?:number; className?:string
}) {
  const [data,setData] = useState<HistoryData|null>(null)
  const [query,setQuery] = useState('')
  const [appliedQuery,setAppliedQuery] = useState('')
  const [busy,setBusy] = useState(true)
  const [olderBusy,setOlderBusy] = useState(false)
  const [actionBusy,setActionBusy] = useState('')
  const [notice,setNotice] = useState('')
  const [error,setError] = useState('')
  const base = propertyRef
    ? `schedule-board/listings/${encodeURIComponent(propertyRef)}/owner-history`
    : `owners/${ownerId}/history`

  const load = useCallback(async ({ cursor,append=false,search=appliedQuery }:{cursor?:string|null;append?:boolean;search?:string}={}) => {
    if (!propertyRef && !ownerId) return
    if (!append) setBusy(true); else setOlderBusy(true)
    try {
      const params = new URLSearchParams({ limit:'40' })
      if (cursor) params.set('cursor',cursor)
      if (search.trim()) params.set('search',search.trim())
      const next = await crmFetch(`${base}?${params.toString()}`)
      setData(previous => append && previous
        ? { ...next,messages:[...next.messages,...previous.messages] }
        : next)
      setError('')
    } catch(e:any) {
      setError(e?.data?.error || e?.message || 'Conversation history could not be loaded.')
    } finally { setBusy(false);setOlderBusy(false) }
  },[base,ownerId,propertyRef,appliedQuery])

  useEffect(() => { load({ search:appliedQuery }) },[load,appliedQuery])
  useEffect(() => {
    if (!pollMs) return
    const timer = window.setInterval(() => load({ search:appliedQuery }),pollMs)
    return () => window.clearInterval(timer)
  },[pollMs,load,appliedQuery])

  const timeline = useMemo(() => data?.messages || [],[data?.messages])

  async function saveAction(action:'AWAITING_RESPONSE'|'FOLLOW_UP_REMINDER'|'REQUEST_CALLBACK'|'ESCALATE') {
    if (!propertyRef || actionBusy) return
    setActionBusy(action);setNotice('');setError('')
    try {
      const dueAt = action === 'FOLLOW_UP_REMINDER' ? new Date(Date.now() + 24*60*60*1000).toISOString() : null
      const result = await crmJson(`${base}/actions`,'POST',{ action,dueAt })
      setNotice(result.messageSent === false ? 'Saved as an internal action. No message or call was started.' : 'Action saved.')
    } catch(e:any) { setError(e?.data?.error || e?.message || 'Could not save this action.') }
    finally { setActionBusy('') }
  }

  return <section className={cn('crm-shared-history',embedded && 'crm-shared-history-embedded',className)} aria-label="Owner conversation history">
    <header className="crm-shared-history-header">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><History aria-hidden/><h3>Owner Conversation / History</h3></div>
        <p>Original persisted business messages · private details redacted by the server</p>
      </div>
      {!!data?.conversationStates?.length && <div className="crm-shared-history-states" aria-label="Conversation states">
        {data.conversationStates.map(state => <span key={state.status}>{state.status} · {state.count}</span>)}
      </div>}
    </header>

    {!!data?.facts?.length && <div className="crm-shared-history-facts" aria-label="Property facts">
      <b>Property facts</b>
      {data.facts.map(fact => <span key={fact.key} title={`Source: ${fact.source.type} ${fact.source.id} · ${fact.source.field}`}>{fact.label}</span>)}
    </div>}

    <form className="crm-shared-history-search" onSubmit={event => { event.preventDefault();setAppliedQuery(query.trim()) }}>
      <Search aria-hidden/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search permitted conversation text" aria-label="Search owner history"/>
      <button type="submit">Search</button>
      {appliedQuery && <button type="button" onClick={() => { setQuery('');setAppliedQuery('') }}>Clear</button>}
    </form>

    {propertyRef && <div className="crm-shared-history-actions" aria-label="Owner follow-up actions">
      <button type="button" onClick={() => saveAction('AWAITING_RESPONSE')} disabled={!!actionBusy}><CalendarClock/>Awaiting response</button>
      <button type="button" onClick={() => saveAction('FOLLOW_UP_REMINDER')} disabled={!!actionBusy}><Bell/>Remind tomorrow</button>
      <button type="button" onClick={() => saveAction('REQUEST_CALLBACK')} disabled={!!actionBusy}><PhoneCall/>Request callback</button>
      <button type="button" onClick={() => saveAction('ESCALATE')} disabled={!!actionBusy}><UserRoundCheck/>Escalate</button>
    </div>}
    {notice && <p className="crm-shared-history-notice" role="status">{notice}</p>}
    {error && <p className="crm-shared-history-error" role="alert">{error}</p>}

    <div className="crm-shared-history-log" role="log" aria-live="polite" aria-busy={busy}>
      {data?.nextCursor && <button className="crm-shared-history-older" type="button" onClick={() => load({cursor:data.nextCursor,append:true})} disabled={olderBusy}>
        {olderBusy ? <Loader2 className="animate-spin"/> : <ChevronUp/>} Load older history
      </button>}
      {busy && !data && <div className="crm-shared-history-empty"><Loader2 className="animate-spin"/>Loading real conversation…</div>}
      {!busy && !error && !timeline.length && <div className="crm-shared-history-empty">No persisted business messages were found. This is not caused by missing property details.</div>}
      {timeline.map((message,index) => {
        const showDate = index === 0 || dayLabel(timeline[index-1].at) !== dayLabel(message.at)
        const outgoing = message.direction === 'outgoing'
        return <div key={message.stableId || message.id}>
          {showDate && <div className="crm-shared-history-date"><span>{dayLabel(message.at)}</span></div>}
          <article className={cn('crm-shared-history-message',outgoing ? 'is-outgoing' : 'is-incoming')}>
            <div className="crm-shared-history-bubble">
              <div className="crm-shared-history-meta"><b>{roleLabel(message.senderRole)}</b><time dateTime={message.at}>{timeLabel(message.at)}</time></div>
              <p>{message.text}</p>
              {!!message.redactions?.length && <div className="crm-shared-history-redactions"><ShieldCheck/>{message.redactions.map(label => <span key={label}>{label}</span>)}</div>}
              {message.attachment && <div className="crm-shared-history-attachment">
                <FileText/>
                {message.attachment.url && !message.attachment.restricted
                  ? <a href={message.attachment.url} target="_blank" rel="noreferrer">{message.attachment.filename}</a>
                  : <span>{message.attachment.label || message.attachment.filename}{message.attachment.unavailable ? ' · source file unavailable' : ''}</span>}
              </div>}
              <small title={`Source: ${message.provenance.source}`}>Persisted · {message.provenance.source}</small>
            </div>
          </article>
        </div>
      })}
    </div>
  </section>
}
