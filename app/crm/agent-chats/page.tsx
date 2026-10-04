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

type ChatMessage = { direction: 'agent_to_owner' | 'owner_to_agent'; text: string; at: string; redacted?: boolean }
type AgentChat = {
  threadId: number; ref: string; status: string
  agentId: number | null; agentName: string
  ownerLabel: string
  town: string | null; beds: number | null; price: number | null; image: string | null
  createdAt: string; updatedAt: string
  privateDeviceChat?: boolean
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
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
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
    <article className="overflow-hidden rounded-2xl border border-[var(--crm-border)] bg-[var(--crm-surface)] shadow-[0_10px_30px_rgba(10,20,40,.08)]">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex min-h-24 w-full items-start gap-3 p-4 text-left transition-colors hover:bg-[var(--crm-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--crm-accent)] sm:p-5">
        {c.image
          ? <img src={c.image} alt="" className="h-14 w-14 flex-shrink-0 rounded-xl bg-[var(--crm-raised)] object-cover sm:h-16 sm:w-16" />
          : <div className="h-14 w-14 flex-shrink-0 rounded-xl bg-[var(--crm-raised)] sm:h-16 sm:w-16" aria-hidden />}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 pr-1">
              <div className="break-words text-[15px] font-bold leading-snug text-[var(--crm-text)] sm:text-base">
                #{c.ref}{c.town ? ` · ${c.town}` : ''}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-[var(--crm-muted)] sm:text-[13px]">
                {c.beds != null ? `${c.beds} bed${c.beds === 1 ? '' : 's'} · ` : ''}
                {c.price ? `€${Number(c.price).toLocaleString()}` : ''}
              </div>
            </div>
            {statusPill(c.status)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[var(--crm-accent-soft)] px-2 py-1 text-xs font-bold text-[var(--crm-accent)]">{c.agentName}</span>
            <span className="text-xs font-medium text-[var(--crm-muted)]">↔ {c.ownerLabel}</span>
          </div>
          {last && (
            <div className="mt-2 line-clamp-2 break-words text-[13px] leading-relaxed text-[var(--crm-muted)]">
              <span className="font-semibold text-[var(--crm-text)]">{last.direction === 'owner_to_agent' ? 'Owner: ' : `${c.agentName}: `}</span>
              {last.redacted ? <span className="inline-block h-2 w-24 rounded-full bg-current opacity-25 blur-[2.5px]" aria-label="Private message hidden" /> : last.text}
            </div>
          )}
          <div className="mt-1.5 text-xs font-medium text-[var(--crm-faint)]">{fmtTimeAgo(c.updatedAt)} · {c.messages.length} message{c.messages.length === 1 ? '' : 's'}</div>
        </div>
      </button>
      {open && (
        <div className="max-h-[55dvh] overflow-y-auto border-t border-[var(--crm-border)] bg-[var(--crm-raised)] p-4 sm:max-h-96 sm:p-5">
          {c.messages.length === 0 && <div className="text-sm italic text-[var(--crm-muted)]">No messages logged for this thread.</div>}
          {c.messages.map((m, i) => (
            <div key={i} className="mb-2.5 last:mb-0">
              <div className="mb-1 text-xs font-medium text-[var(--crm-muted)]">
                {m.direction === 'owner_to_agent' ? c.ownerLabel : c.agentName} · {fmtTime(m.at)}
              </div>
              <div className={`inline-block max-w-[92%] whitespace-pre-wrap break-words rounded-2xl border px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[78%] ${
                m.direction === 'owner_to_agent'
                  ? 'border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text)]'
                  : 'border-[color-mix(in_srgb,var(--crm-accent)_35%,transparent)] bg-[var(--crm-accent-soft)] text-[var(--crm-text)]'
              }`}>
                {m.redacted ? (
                  <span className="block min-w-[118px] py-1" aria-label="Private message content hidden">
                    <span className="block h-2 w-28 rounded-full bg-current opacity-25 blur-[2.5px]" />
                    <span className="mt-1.5 block h-2 w-20 rounded-full bg-current opacity-20 blur-[2.5px]" />
                  </span>
                ) : m.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function AgentChatsInner() {
  const { me } = useCrm()
  const [chats, setChats] = useState<AgentChat[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [agentFilter, setAgentFilter] = useState<string>('all')

  const load = useCallback((showLoader = true) => {
    if (showLoader) setLoading(true)
    setErr(null)
    crmFetch('admin/agent-chats').then(d => setChats(d.chats || [])).catch(e => setErr(e?.data?.error || e?.message || 'Failed to load')).finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(() => load(false), 2000)
    return () => clearInterval(timer)
  }, [load])

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
        <p className="text-sm text-[var(--crm-muted)]">This dashboard is admin-only.</p>
      </CrmShell>
    )
  }

  return (
    <CrmShell title="Agent Chats" subtitle={`${openCount} open · ${chats.length} in the last 14 days`} dark>
      <p className="mb-5 max-w-2xl text-sm leading-relaxed text-[var(--crm-muted)]">
        Every agent's owner conversation in one place. Owner identity is anonymized here the same way it is in each
        agent's own chat window — this is a monitor for agent activity, not an owner lookup.
      </p>

      {err && <div role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm font-medium text-red-600 dark:text-red-300">{err}</div>}

      {agentNames.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2" aria-label="Filter chats by agent">
          <button onClick={() => setAgentFilter('all')}
            aria-pressed={agentFilter === 'all'} className={`min-h-11 rounded-full border px-4 py-2 text-xs font-bold transition-colors ${
              agentFilter === 'all' ? 'border-[var(--crm-accent)] bg-[var(--crm-accent-soft)] text-[var(--crm-accent)]' : 'border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-muted)] hover:text-[var(--crm-text)]'
            }`}>All agents</button>
          {agentNames.map(name => (
            <button key={name} onClick={() => setAgentFilter(name)}
              aria-pressed={agentFilter === name} className={`min-h-11 rounded-full border px-4 py-2 text-xs font-bold transition-colors ${
                agentFilter === name ? 'border-[var(--crm-accent)] bg-[var(--crm-accent-soft)] text-[var(--crm-accent)]' : 'border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-muted)] hover:text-[var(--crm-text)]'
              }`}>{name}</button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--crm-muted)]">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-[var(--crm-muted)]">No agent chats in the last 14 days{agentFilter !== 'all' ? ` for ${agentFilter}` : ''}.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4">
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
