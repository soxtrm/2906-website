'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Clock3, ShieldCheck, Star, Users, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { crmFetch, crmJson } from '@/lib/crm/api'

type RequestState = {
  requestId: string; status: string; approvalPolicy: string; expiresAt: string
  groupName?: string | null; lastError?: string | null
}
type Context = {
  property: { id: number; ref: string; town?: string | null }
  owner: { label: string; contact: 'masked' }
  agent: { id: number; name: string }
  approvalPolicy: string
  clients: { id: string; name: string; moveInDate?: string | null; relationship?: string | null; nationality?: string | null; work?: string | null }[]
  latest?: RequestState | null
}

const PENDING = new Set(['GROUP_REQUEST_DRAFT', 'GROUP_REQUEST_PENDING', 'GROUP_REQUEST_APPROVED', 'GROUP_CREATING'])
const LABEL: Record<string, string> = {
  GROUP_REQUEST_DRAFT: 'Preparing request', GROUP_REQUEST_PENDING: 'Awaiting owner response',
  GROUP_REQUEST_APPROVED: 'Owner approved', GROUP_REQUEST_DECLINED: 'Owner declined group request',
  GROUP_REQUEST_TIMEOUT: 'Approval window expired', GROUP_CREATING: 'Creating group',
  GROUP_CREATED: 'Group created', GROUP_ACTIVE: 'Group active', GROUP_CLOSED: 'Group closed',
  GROUP_REQUEST_FAILED: 'Request failed', GROUP_CREATION_AMBIGUOUS: 'Creation needs admin review',
  GROUP_REQUEST_CANCELLED: 'Request cancelled',
}

export function OwnerGroupRequestDialog({ propertyRef, viewingId, onClose, onChange }: {
  propertyRef: string; viewingId?: number | null; onClose: () => void; onChange?: (request: RequestState) => void
}) {
  const [context, setContext] = useState<Context | null>(null)
  const [request, setRequest] = useState<RequestState | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [relationship, setRelationship] = useState('')
  const [moveInDate, setMoveInDate] = useState('')
  const [viewingIntent, setViewingIntent] = useState('Coordinate a viewing')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    const d = await crmFetch(`schedule-board/listings/${encodeURIComponent(propertyRef)}/group-request-context`)
    setContext(d)
    if (d.latest && PENDING.has(d.latest.status)) setRequest(d.latest)
  }, [propertyRef])
  useEffect(() => { load().catch(e => setError(e?.data?.error || e.message)) }, [load])
  useEffect(() => {
    if (!request || !PENDING.has(request.status)) return
    const tick = setInterval(async () => {
      setNow(Date.now())
      try {
        const d = await crmFetch(`schedule-board/listings/${encodeURIComponent(propertyRef)}/group-request-status`)
        if (d.request) { setRequest(d.request); onChange?.(d.request) }
      } catch { /* next poll retries; status remains visible */ }
    }, 3000)
    return () => clearInterval(tick)
  }, [request?.requestId, request?.status, propertyRef, onChange])

  const remaining = useMemo(() => request?.expiresAt ? Math.max(0, Date.parse(request.expiresAt) - now) : 0, [request?.expiresAt, now])
  const mm = Math.floor(remaining / 60000)
  const ss = Math.floor((remaining % 60000) / 1000)
  const chosen = context?.clients.filter(c => selected.includes(c.id)) || []

  async function submit() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(propertyRef)}/group-request`, 'POST', {
        clientIds:selected, relationship:relationship || null, moveInDate:moveInDate || null,
        viewingIntent:viewingIntent || null, note:note || null, viewingId:viewingId || null,
      })
      setRequest(d.request); onChange?.(d.request)
    } catch (e: any) { setError(e?.data?.error || e.message || 'Could not send request.') }
    finally { setBusy(false) }
  }

  const status = request?.status
  const success = status === 'GROUP_CREATED' || status === 'GROUP_ACTIVE'
  return <>
    <div className="fixed inset-0 z-[1000] bg-black/60 backdrop-blur-sm" onClick={onClose} />
    <motion.div initial={{ opacity:0, y:22, scale:.98 }} animate={{ opacity:1, y:0, scale:1 }}
      className="owner-group-modal fixed z-[1001] inset-x-3 top-20 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] overflow-y-auto rounded-2xl border border-[#B8953F]/35 bg-[#0d1525] p-5 shadow-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[560px] sm:max-h-[92dvh] sm:-translate-x-1/2 sm:-translate-y-1/2">
      <style>{`.owner-group-modal .text-white{color:#fff!important}.owner-group-modal input.text-white,.owner-group-modal textarea.text-white{color:#fff!important}`}</style>
      <div className="flex items-start justify-between gap-4">
        <div><div className="flex items-center gap-2 text-[#E8CC82]"><Star size={16} fill="currentColor"/><span className="text-xs font-bold tracking-[.16em]">PRIVILEGED FLOW</span></div>
          <h2 className="mt-1 text-xl font-semibold text-white">Create Owner Group ★</h2>
          <p className="mt-1 text-sm text-white/55">Owner approval is requested before the existing 2906 group engine runs.</p></div>
        <button onClick={onClose} aria-label="Close" className="rounded-full p-2 text-white/55 hover:bg-white/10 hover:text-white"><X size={18}/></button>
      </div>

      {!context && !error && <div className="py-12 text-center text-sm text-white/50">Loading request context…</div>}
      {context && !request && <div className="mt-5 space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/8 bg-white/[.035] p-3 text-xs">
          <Info label="Property" value={`#${context.property.ref}${context.property.town ? ` · ${context.property.town}` : ''}`}/>
          <Info label="Owner" value={`${context.owner.label} · masked`}/><Info label="Agent" value={context.agent.name}/>
        </div>
        <label className="block text-xs font-semibold text-white/70">Linked clients</label>
        <div className="max-h-44 space-y-2 overflow-y-auto rounded-xl border border-white/8 p-2">
          {context.clients.length ? context.clients.map(c => <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-white/5">
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => setSelected(s => s.includes(c.id) ? s.filter(x => x !== c.id) : [...s,c.id])} className="mt-1 accent-[#B8953F]"/>
            <span><span className="block text-sm font-medium text-white">{c.name}</span><span className="text-xs text-white/45">{[c.relationship,c.moveInDate].filter(Boolean).join(' · ') || 'No extra details supplied'}</span></span>
          </label>) : <div className="p-3 text-xs text-white/45">No active client records found. You can still request a property group.</div>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Relationship / household" value={relationship} onChange={setRelationship} placeholder="Couple, family, colleagues…"/>
          <Field label="Move-in" value={moveInDate} onChange={setMoveInDate} type="date"/></div>
        <Field label="Reason" value={viewingIntent} onChange={setViewingIntent} placeholder="Coordinate a viewing"/>
        <label className="block text-xs font-semibold text-white/70">Optional note
          <textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={500} rows={3} className="mt-1.5 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-[#B8953F]/60" placeholder="Only facts you want the owner to see."/>
        </label>
        {!!chosen.length && <div className="rounded-xl bg-[#B8953F]/8 p-3 text-xs text-white/60"><Users size={14} className="mr-2 inline text-[#E8CC82]"/>{chosen.map(c=>c.name).join(', ')}</div>}
        <div className="flex items-center gap-2 rounded-xl border border-[#B8953F]/20 bg-[#B8953F]/7 p-3 text-xs text-white/60"><ShieldCheck size={16} className="shrink-0 text-[#E8CC82]"/>
          {context.approvalPolicy === 'TRUSTED_AGENT_TIMEOUT_CREATE' ? 'Trusted timeout creation is enabled for this owner relationship.' : 'Explicit owner approval is required. No response will not create a group.'}</div>
        <button onClick={submit} disabled={busy} className="w-full rounded-xl bg-[#B8953F] px-4 py-3 text-sm font-bold text-[#101726] shadow-[0_8px_24px_rgba(184,149,63,.2)] disabled:opacity-50">{busy ? 'Sending…' : 'Send owner request'}</button>
      </div>}

      {request && <div className="mt-6 rounded-2xl border border-white/8 bg-white/[.035] p-5 text-center">
        {success ? <Check className="mx-auto text-emerald-400" size={32}/> : <Clock3 className="mx-auto text-[#E8CC82]" size={32}/>}
        <div className="mt-3 text-base font-semibold text-white">{LABEL[status || ''] || status?.replace(/_/g,' ')}</div>
        {status === 'GROUP_REQUEST_PENDING' && <div className="mt-1 font-mono text-2xl text-[#E8CC82]">{String(mm).padStart(2,'0')}:{String(ss).padStart(2,'0')}</div>}
        <div className="mt-2 text-xs text-white/45">Policy: {request.approvalPolicy.replace(/_/g,' ').toLowerCase()}</div>
        {request.groupName && <div className="mt-3 text-sm text-white/70">{request.groupName}</div>}
        {request.lastError && <div className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{request.lastError}</div>}
      </div>}
      {error && <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
    </motion.div>
  </>
}

function Info({label,value}:{label:string;value:string}) { return <div><div className="text-white/35">{label}</div><div className="mt-1 truncate font-medium text-white/80">{value}</div></div> }
function Field({label,value,onChange,placeholder,type='text'}:{label:string;value:string;onChange:(v:string)=>void;placeholder?:string;type?:string}) { return <label className="block text-xs font-semibold text-white/70">{label}<input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-[#B8953F]/60"/></label> }
