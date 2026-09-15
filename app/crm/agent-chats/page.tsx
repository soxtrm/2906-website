'use client'
// ============================================================================
// /agent-chats — cross-agent overview of running Board-chat conversations
// (Kev, 2026-09-15). Admin-only, both here and server-side (routes/crm.js
// GET /api/crm/admin/agent-chats, `auth` + `adminOnly`). Deliberately not
// placed under app/crm/admin/ — proxy.ts's middleware matcher excludes any
// path starting with "admin" (reserved for the public site's own separate
// admin dashboard), so that would 404 on crm.2906.estate.
//
// Same services/bookRelay.js engine the per-agent Agent Workspace chat panel
// (public/agent-workspace/index.html, backend) and the WhatsApp !chat
// command already use — this route just isn't scoped to one agent_id, so
// Kev/Olga see every agent's open conversations in one place instead of
// opening each agent's own dashboard.
//
// "Full detail" = real agent identity + real message text. It deliberately
// does NOT mean real owner identity — the owner label is anonymized
// server-side the same way services/bookRelay.js's own getBoardSnapshot()
// already does for the per-agent chat window (the milchglas precedent this
// was built from: getOtherOwnerActivity()/anonOwnerLabel() — existence/
// kind/time only, never identity, is the whole firewall point of this relay
// system; here it's keyed by owner_id instead of thread_id specifically so
// the SAME owner shows the SAME label across every agent's thread — the
// actual job of an admin overview is catching two agents both working the
// same owner).
//
// No blurred view for non-admins: the route refuses non-admins outright
// rather than serving a partial milchglas version — the safer of the two
// options the spec left open, and the one actually implemented here.
// ============================================================================
import { useEffect, useMemo, useState, useCallback } from 'react'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch } from '@/lib/crm/api'

type ChatMessage = { direction: 'agent_to_owner' | 'owner_to_agent'; text: string; at: string }
type AgentChat = {
  threadId: number; ref: string; status: string
  agentId: number | null; agentName: string
  ownerLabel: string
  town: string | null; beds: number | null; price: number | null; image: string | null
  createdAt: string; updatedAt: string
  messages: ChatMessage[]
}

const STATUS_MAP: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  relaying:          { bg: '#DCFCE7', text: '#15803D', dot: '#22C55E', label: 'Open' },
  awaiting_details:  { bg: '#FEF9C3', text: '#A16207', dot: '#EAB308', label: 'Awaiting agent' },
  closed:            { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: 'Closed' },
}
function statusPill(status: string) {
  const s = STATUS_MAP[status] || { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: status }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ background: s.bg, color: s.text }}>
      <span className="w-[5px] h-[5px] rounded-full" style={{ background: s.dot }} />{s.label}
    </span>
  )
}
function fmtTimeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ChatCard({ c, open, onToggle }: { c: AgentChat; open: boolean; onToggle: () => void }) {
  const last = c.messages[c.messages.length - 1]
  return (
    <div className="rounded-lg border border-white/10 bg-[#141B29] overflow-hidden">
      <div onClick={onToggle} className="p-4 cursor-pointer hover:border-gold/40 transition-colors flex gap-3 items-start">
        {c.image
          ? <img src={c.image} alt={c.ref} className="w-11 h-11 rounded object-cover flex-shrink-0 bg-white/5" />
          : <div className="w-11 h-11 rounded flex-shrink-0 bg-white/5" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-sm text-white">
                #{c.ref}{c.town ? ` · ${c.town}` : ''}
              </div>
              <div className="text-[11px] text-white/40">
                {c.beds != null ? `${c.beds} bed${c.beds === 1 ? '' : 's'} · ` : ''}
                {c.price ? `€${Number(c.price).toLocaleString()}` : ''}
              </div>
            </div>
            {statusPill(c.status)}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gold/10 text-gold font-semibold">{c.agentName}</span>
            <span className="text-[10px] text-white/30">↔ {c.ownerLabel}</span>
          </div>
          {last && (
            <div className="text-[11px] text-white/50 mt-2 truncate">
              <span className="text-white/30">{last.direction === 'owner_to_agent' ? 'Owner: ' : `${c.agentName}: `}</span>
              {last.text}
            </div>
          )}
          <div className="text-[10px] text-white/25 mt-1">{fmtTimeAgo(c.updatedAt)} · {c.messages.length} message{c.messages.length === 1 ? '' : 's'}</div>
        </div>
      </div>
      {open && (
        <div className="border-t border-white/10 bg-black/20 p-4 max-h-80 overflow-y-auto">
          {c.messages.length === 0 && <div className="text-[11px] text-white/30 italic">No messages logged for this thread.</div>}
          {c.messages.map((m, i) => (
            <div key={i} className="mb-2.5 last:mb-0">
              <div className="text-[10px] text-white/30 mb-0.5">
                {m.direction === 'owner_to_agent' ? c.ownerLabel : c.agentName} · {fmtTime(m.at)}
              </div>
              <div className={`text-[12px] leading-snug rounded-lg px-3 py-1.5 inline-block max-w-full ${
                m.direction === 'owner_to_agent' ? 'bg-white/10 text-white/85' : 'bg-gold/15 text-white'
              }`}>
                {m.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentChatsInner() {
  const { me } = useCrm()
  const [chats, setChats] = useState<AgentChat[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [agentFilter, setAgentFilter] = useState<string>('all')

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    crmFetch('admin/agent-chats').then(d => setChats(d.chats || [])).catch(e => setErr(e?.data?.error || e?.message || 'Failed to load')).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const agentNames = useMemo(() => {
    const names = new Set(chats.map(c => c.agentName))
    return Array.from(names).sort()
  }, [chats])

  const visible = useMemo(() => {
    if (agentFilter === 'all') return chats
    return chats.filter(c => c.agentName === agentFilter)
  }, [chats, agentFilter])

  const openCount = useMemo(() => chats.filter(c => c.status === 'relaying').length, [chats])

  if (me && me.role !== 'admin') {
    return (
      <CrmShell title="Agent Chats" subtitle="Admins only" dark>
        <p className="text-sm text-white/40">This dashboard is admin-only.</p>
      </CrmShell>
    )
  }

  return (
    <CrmShell title="Agent Chats" subtitle={`${openCount} open · ${chats.length} in the last 14 days`} dark>
      <p className="text-xs text-white/30 mb-4 max-w-2xl">
        Every agent's owner conversation in one place. Owner identity is anonymized here the same way it is in each
        agent's own chat window — this is a monitor for agent activity, not an owner lookup.
      </p>

      {err && <div className="mb-3 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">{err}</div>}

      {agentNames.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-4">
          <button onClick={() => setAgentFilter('all')}
            className={`px-3 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
              agentFilter === 'all' ? 'border-gold text-gold bg-gold/10' : 'border-white/10 text-white/40 hover:text-white/70'
            }`}>All agents</button>
          {agentNames.map(name => (
            <button key={name} onClick={() => setAgentFilter(name)}
              className={`px-3 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                agentFilter === name ? 'border-gold text-gold bg-gold/10' : 'border-white/10 text-white/40 hover:text-white/70'
              }`}>{name}</button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-white/40">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-white/40">No agent chats in the last 14 days{agentFilter !== 'all' ? ` for ${agentFilter}` : ''}.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {visible.map(c => (
            <ChatCard key={c.threadId} c={c} open={openId === c.threadId}
              onToggle={() => setOpenId(openId === c.threadId ? null : c.threadId)} />
          ))}
        </div>
      )}
    </CrmShell>
  )
}

export default function AgentChatsPage() {
  return <CrmProvider><AgentChatsInner /></CrmProvider>
}
