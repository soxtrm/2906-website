'use client'
// Who is talking to an owner, under which WhatsApp account, and what state
// the chat is in (Kev, 2026-10-31). Data: GET /crm/owners[/:id] → attribution
// (services/ownerAttribution.js on the backend — metadata, never message
// text). UNKNOWN is shown as UNKNOWN; "handling now" only with a real claim.

export type OwnerAttribution = {
  status: string; statusLabel: string; replyNeeded: boolean
  contactedBy: { person: string; account: string; at: string | null; source: string | null } | null
  lastMessageBy: { person: string; account: string; at: string | null } | null
  lastOwnerReply: { account: string; at: string | null } | null
  assignedTo: { person: string; account: string | null; at: string | null; by: string | null } | null
  handlingNow: { name: string; via: string; since: string | null } | null
  identityConflict: string[] | null
  accounts: { account: string; person: string; firstSeenAt: string | null; lastOutboundAt: string | null; lastInboundAt: string | null; messagesOut: number | null; messagesIn: number | null }[]
}

export const OWNER_STATUS: Record<string, { glyph: string; color: string }> = {
  agent_action_needed: { glyph: '!', color: '#E8A33B' },
  human_takeover: { glyph: '👤', color: '#7FA8FF' },
  bot_responding: { glyph: '⚙', color: '#9AA5BB' },
  awaiting_owner: { glyph: '⏳', color: '#9AA5BB' },
  no_response: { glyph: '…', color: '#7A8396' },
  resolved: { glyph: '✓', color: '#5FC48F' },
  unknown: { glyph: '?', color: '#7A8396' },
}

export function fmtWhen(at?: string | null) {
  if (!at) return '—'
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(at))
}

export function OwnerStatusChip({ a }: { a: OwnerAttribution | null | undefined }) {
  const status = a?.status || 'unknown'
  const st = OWNER_STATUS[status] || OWNER_STATUS.unknown
  return (
    <span title={a?.replyNeeded ? 'The owner wrote last — someone has to answer' : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 999, border: `1px solid ${st.color}`, color: st.color, fontSize: 10.5, fontWeight: 800, whiteSpace: 'nowrap' }}>
      <span aria-hidden>{st.glyph}</span>{a?.statusLabel || 'Unknown'}
    </span>
  )
}

const line: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.45 }
const dim: React.CSSProperties = { color: '#8A94A8' }

// Compact form for list rows / cards.
export function OwnerAttributionLines({ a }: { a: OwnerAttribution | null | undefined }) {
  if (!a || !a.accounts.length) return <span style={{ ...line, ...dim }}>No WhatsApp conversation logged</span>
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div style={line}><span style={dim}>Contacted by </span><b>{a.contactedBy?.person || 'UNKNOWN'}</b><span style={dim}> · {a.contactedBy?.account || '—'}</span></div>
      <div style={line}><span style={dim}>Last message by </span><b>{a.lastMessageBy?.person || '—'}</b><span style={dim}> · {fmtWhen(a.lastMessageBy?.at)}</span></div>
      <div style={line}><span style={dim}>Last owner reply </span>{a.lastOwnerReply ? fmtWhen(a.lastOwnerReply.at) : '—'}</div>
      {a.assignedTo && <div style={line}><span style={dim}>Assigned to </span><b>{a.assignedTo.person}</b></div>}
      {a.accounts.length > 1 && <div style={{ ...line, ...dim }}>{a.accounts.length} accounts: {a.accounts.map(x => `${x.person} (${x.account})`).join(', ')}</div>}
      {a.identityConflict && <div style={{ ...line, color: '#E8A33B', fontWeight: 700 }}>⚠ Several identities in 30 days: {a.identityConflict.join(' / ')}</div>}
    </div>
  )
}

// Full block for the owner page: every account with its own timeline.
export function OwnerAttributionPanel({ a, onAssign }: { a: OwnerAttribution | null | undefined; onAssign?: () => void }) {
  if (!a) return null
  return (
    <section aria-label="Who is talking to this owner" style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid #2A3550', borderRadius: 12, background: '#0E1420', color: '#E4E8F4' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <OwnerStatusChip a={a} />
        {a.handlingNow && <span style={{ fontSize: 11.5, color: '#7FA8FF', fontWeight: 700 }}>Handling now: {a.handlingNow.name} · {a.handlingNow.via}</span>}
        {onAssign && <button type="button" onClick={onAssign} style={{ marginLeft: 'auto', minHeight: 34, padding: '6px 12px', borderRadius: 8, border: '1px solid #3A4766', background: 'transparent', color: '#C9D0E2', cursor: 'pointer', fontWeight: 700 }}>Assign handler</button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
        {[['Contacted by', a.contactedBy ? `${a.contactedBy.person} · ${a.contactedBy.account}` : 'UNKNOWN', a.contactedBy?.at],
          ['Assigned to', a.assignedTo ? `${a.assignedTo.person}${a.assignedTo.account ? ` · ${a.assignedTo.account}` : ''}` : 'Not assigned', a.assignedTo?.at],
          ['Last message by', a.lastMessageBy ? `${a.lastMessageBy.person} · ${a.lastMessageBy.account}` : '—', a.lastMessageBy?.at],
          ['Last owner reply', a.lastOwnerReply ? a.lastOwnerReply.account : '—', a.lastOwnerReply?.at]].map(([k, v, at]) => (
          <div key={k as string} style={{ padding: 10, border: '1px solid #222C40', borderRadius: 10 }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', ...dim }}>{k}</div>
            <div style={{ fontSize: 13, fontWeight: 800, marginTop: 2 }}>{v}</div>
            <div style={{ fontSize: 10.5, ...dim }}>{fmtWhen(at as string | null)}</div>
          </div>
        ))}
      </div>
      {a.identityConflict && <div style={{ fontSize: 12, color: '#E8A33B', fontWeight: 700 }}>⚠ Several identities wrote to this owner in the last 30 days: {a.identityConflict.join(' / ')}. Agree on one handler.</div>}
      <div style={{ display: 'grid', gap: 4 }}>
        {a.accounts.map(x => (
          <div key={x.account} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11.5, padding: '6px 0', borderTop: '1px solid #1B2436' }}>
            <b style={{ minWidth: 150 }}>{x.person} · {x.account}</b>
            <span style={dim}>since {fmtWhen(x.firstSeenAt)}</span>
            <span style={dim}>we wrote {fmtWhen(x.lastOutboundAt)}</span>
            <span style={dim}>owner replied {fmtWhen(x.lastInboundAt)}</span>
            <span style={dim}>{x.messagesOut ?? 0} out / {x.messagesIn ?? 0} in</span>
          </div>
        ))}
      </div>
    </section>
  )
}
