'use client'
// ARGUS owner profile → NEXUS area (Claude, 2026-11-11).
// One status card and ONE actions menu instead of a row of buttons. Everything
// goes through the authenticated CRM proxy (/api/crm/owner-nexus/…) — never the
// public /api/nexus bridge. Nothing here sends a message to the owner: the
// invitation link is only created and copied.
import { useCallback, useEffect, useRef, useState } from 'react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { A, F, FM, DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, fmtDate } from '@/lib/crm/ui'

type Freshness = { state: 'recently_confirmed' | 'reconfirmation_approaching' | 'confirmation_overdue' | 'unknown_stale'; label: string; lastConfirmedAt: string | null; ageHours: number | null; dueAt: string | null }
type NexusProperty = {
  id: number; ref: string; town: string; transactionType: 'rent' | 'sale' | null
  statuses: { imported: boolean; linked: boolean; canonicalPropertyId: string | null; ownerReview: string; claim: string | null; availability: string; freshness: Freshness; distribution: string; publication: string; sync: string }
  eligible: boolean; blockedReasons: string[]
  distribution: { channel: string; audienceRef: string | null; scopes: string[]; grantedAt: string }[]
  lastSyncAt: string | null; lastSyncError: string | null; pendingEvents: number
}
type Invitation = { id: number; state: 'active' | 'expired' | 'consumed' | 'revoked'; createdAt: string; expiresAt: string; copyCount: number; lastCopiedAt: string | null; url?: string }
export type NexusStatus = {
  contractVersion: string
  owner: { id: number; doNotContact: boolean }
  link: { id: string | null; state: 'not_invited' | 'invited' | 'claim_pending' | 'verified' | 'disputed' | 'revoked'; nexusAccountRef: string | null; verifiedAt?: string | null; verificationMethod?: string | null; disputeReason?: string | null; sync: { state: string; lastSyncAt?: string | null; lastError?: string | null } }
  invitation: Invitation | null
  receiver: { configured: boolean; note: string | null }
  queue: { waiting: number; errors: number }
  properties: NexusProperty[]
  nexusProfileUrl: string | null
}

const LINK_LABEL: Record<NexusStatus['link']['state'], { text: string; tone: Tone }> = {
  not_invited: { text: 'Not invited', tone: 'muted' },
  invited: { text: 'Invited — waiting for owner', tone: 'amber' },
  claim_pending: { text: 'Claimed — ownership not verified', tone: 'amber' },
  verified: { text: 'Owner verified', tone: 'green' },
  disputed: { text: 'Disputed', tone: 'red' },
  revoked: { text: 'Revoked', tone: 'muted' },
}
const REASON: Record<string, string> = {
  OWNER_LINK_NOT_VERIFIED: 'Owner not verified yet',
  OWNER_LINK_DISPUTED: 'Owner link is disputed',
  OWNER_CLAIM_NOT_CONFIRMED: 'Owner has not confirmed this property',
  OWNER_CLAIM_REJECTED: 'Owner rejected this property',
  OWNER_CLAIM_DISPUTED: 'Ownership of this property is disputed',
  NO_DISTRIBUTION_AUTHORIZATION: 'Owner has not authorised any distribution',
  DUPLICATE_REVIEW_PENDING: 'Duplicate review pending',
  PROPERTY_NOT_IDENTIFIED: 'Listing has no reference',
  PRICE_MISSING: 'Price missing',
  RENT_PRICE_INVALID: 'Rent price invalid',
  SALE_PRICE_LOOKS_LIKE_RENT: 'Sale price looks like a monthly rent — check the price field',
  RENT_AND_SALE_PRICE_BOTH_SET: 'Rent and sale price both set — choose one',
}
const CHANNEL: Record<string, string> = {
  origin_agency: '2906 Estate', selected_agency: 'Selected agency', approved_large_agencies: 'Approved large agencies', all_eligible_agencies: 'All eligible agencies',
  independent_agents: 'Independent agents', nexus_direct_from_owner: 'NEXUS Direct from Owner', other_approved: 'Other approved channel',
}
type Tone = 'green' | 'amber' | 'red' | 'muted' | 'blue'
const TONES: Record<Tone, { c: string; b: string }> = {
  green: { c: '#4ADE80', b: 'rgba(74,222,128,.14)' }, amber: { c: '#FBBF24', b: 'rgba(251,191,36,.14)' }, red: { c: '#F87171', b: 'rgba(248,113,113,.14)' },
  muted: { c: 'var(--crm-muted)', b: 'var(--crm-border)' }, blue: { c: '#7DD3FC', b: 'rgba(125,211,252,.14)' },
}
const FRESH_TONE: Record<Freshness['state'], Tone> = { recently_confirmed: 'green', reconfirmation_approaching: 'amber', confirmation_overdue: 'red', unknown_stale: 'muted' }
const SYNC_TONE: Record<string, Tone> = { synced: 'green', pending: 'amber', error: 'red', blocked: 'muted', never: 'muted' }

function Chip({ tone = 'muted', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  const t = TONES[tone]
  return <span title={title} style={{ fontSize: 10.5, fontWeight: 700, color: t.c, background: t.b, borderRadius: 99, padding: '3px 9px', whiteSpace: 'nowrap', letterSpacing: '.01em' }}>{children}</span>
}
const card: React.CSSProperties = { background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 16, padding: '18px 20px' }
const head: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: DTEXT_FAINT, letterSpacing: '0.12em', textTransform: 'uppercase' }
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  background: primary ? A : DBORDER, color: primary ? '#151C2C' : DTEXT_DIM, border: primary ? 'none' : `1px solid ${DCARD_BORDER}`, borderRadius: 9, padding: '9px 14px', minHeight: 38,
  fontSize: 12, fontWeight: 700, fontFamily: F, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
})
function ago(iso: string | null) {
  if (!iso) return 'never'
  const h = (Date.now() - new Date(iso).getTime()) / 36e5
  if (h < 1) return 'under an hour ago'
  if (h < 48) return `${Math.round(h)} h ago`
  return `${Math.round(h / 24)} days ago`
}

type Ask = { title: string; label: string; field: string; path: string; confirm: string; hint?: string }

export function OwnerNexusPanel({ ownerId }: { ownerId: number }) {
  const [s, setS] = useState<NexusStatus | null>(null)
  const [err, setErr] = useState<{ status?: number; message: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const [menu, setMenu] = useState(false)
  const [menuSide, setMenuSide] = useState<'left' | 'right' | 'sheet'>('right')
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [askValue, setAskValue] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => crmFetch(`owner-nexus/${ownerId}`).then((d: NexusStatus) => { setS(d); setErr(null) }).catch((e: any) => setErr({ status: e?.status, message: e?.message || 'Failed to load' })), [ownerId])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4200); return () => clearTimeout(t) }, [toast])
  useEffect(() => {
    if (!menu && !ask) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); setAsk(null) } }
    const click = (e: MouseEvent) => { if (menu && menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false) }
    document.addEventListener('keydown', key); document.addEventListener('mousedown', click)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', click) }
  }, [menu, ask])

  async function act<T = any>(key: string, path: string, body: any, ok: (r: T) => string) {
    setMenu(false); setBusy(key)
    try { const r = await crmJson(`owner-nexus/${ownerId}/${path}`, 'POST', body); setToast({ ok: true, text: ok(r) }); return r as T }
    catch (e: any) { setToast({ ok: false, text: e?.message || 'Request failed' }); return null }
    finally { setBusy(''); load() }
  }
  async function showLink(r: { invitation: Invitation } | null) {
    const url = r?.invitation?.url
    if (!url) return
    setLink(url)
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { setCopied(false) }
  }
  const delivery = (d: any) => !d ? '' : d.receiverConfigured ? ` · ${d.delivered} delivered${d.failed ? `, ${d.failed} failed` : ''}` : ' · queued — NEXUS receiver not connected yet'

  if (err?.status === 403) return <div style={card} data-testid="nexus-panel"><div style={head}>NEXUS</div><p style={{ color: DTEXT_DIM, fontSize: 12.5, margin: '10px 0 0' }}>NEXUS owner controls are not enabled for your account. Ask an administrator.</p></div>
  if (err) return <div style={card} data-testid="nexus-panel"><div style={head}>NEXUS</div><p style={{ color: '#F87171', fontSize: 12.5, margin: '10px 0 0' }}>{err.message}</p><button style={{ ...btn(), marginTop: 10 }} onClick={load}>Try again</button></div>
  if (!s) return <div style={card} data-testid="nexus-panel"><div style={head}>NEXUS</div><p style={{ color: DTEXT_FAINT, fontSize: 12.5, margin: '10px 0 0' }}>Loading…</p></div>

  const st = s.link.state, inv = s.invitation, activeInv = inv?.state === 'active'
  const verified = st === 'verified', dnc = s.owner.doNotContact
  const items: { key: string; label: string; hint?: string; disabled?: string | false; run: () => void }[] = [
    { key: 'invite', label: 'Invite owner to NEXUS', hint: 'Creates a secure activation link. Nothing is sent.',
      disabled: dnc ? 'Owner is do-not-contact' : verified ? 'Already verified' : st === 'disputed' ? 'Resolve the dispute first' : activeInv ? 'An invitation is already active' : !s.properties.length ? 'No complete listing to review' : false,
      run: async () => showLink(await act('invite', 'invitation', {}, () => 'Invitation created')) },
    { key: 'copy', label: 'Copy invitation link', disabled: activeInv ? false : 'No active invitation',
      run: async () => showLink(await act('copy', 'invitation/copy', {}, () => 'Invitation link ready')) },
    { key: 'rotate', label: 'Replace invitation link', hint: 'The old link stops working.', disabled: activeInv ? false : 'No active invitation',
      run: async () => { if (window.confirm('Create a new link? The current invitation link will stop working.')) showLink(await act('rotate', 'invitation', { rotate: true }, () => 'New invitation link created')) } },
    { key: 'revoke', label: 'Revoke invitation', disabled: activeInv ? false : 'No active invitation',
      run: () => setAskOpen({ title: 'Revoke invitation', label: 'Reason', field: 'reason', path: 'invitation/revoke', confirm: 'Revoke' }) },
    { key: 'verify', label: 'Confirm ownership verified…', hint: 'Only after you checked ownership yourself.', disabled: st === 'claim_pending' ? false : verified ? 'Already verified' : st === 'disputed' ? 'Resolve the dispute first' : 'Owner has not claimed the profile yet',
      run: () => setAskOpen({ title: 'Confirm ownership', label: 'How was ownership verified?', field: 'method', path: 'verify', confirm: 'Mark verified', hint: 'For example: contract on file, ID checked on a call. A phone number on file is not proof.' }) },
    st === 'disputed'
      ? { key: 'resolve', label: 'Resolve dispute…', run: () => setAskOpen({ title: 'Resolve dispute', label: 'How was it resolved?', field: 'note', path: 'dispute/resolve', confirm: 'Resolve' }) }
      : { key: 'dispute', label: 'Open dispute…', disabled: s.link.id ? false : 'Nothing to dispute yet', run: () => setAskOpen({ title: 'Open dispute', label: 'What is disputed?', field: 'reason', path: 'dispute', confirm: 'Open dispute', hint: 'Sync for this owner stops until the dispute is resolved.' }) },
    { key: 'sync-owner', label: 'Sync owner to NEXUS', hint: 'Name and link only — no phone, e-mail or notes.', disabled: verified ? false : 'Owner must be verified first',
      run: () => act<any>('sync-owner', 'sync-owner', {}, r => r.unchanged ? 'Owner already up to date' : r.queued ? `Owner profile queued${delivery(r.delivery)}` : 'Not sent: owner not verified') },
    { key: 'sync-props', label: 'Sync properties to NEXUS', hint: 'Only owner-verified, authorised listings are sent.', disabled: s.properties.length ? false : 'No listings',
      run: () => act<any>('sync-props', 'sync-properties', {}, r => { const q = r.properties.filter((p: any) => p.queued).length, b = r.properties.filter((p: any) => p.blockedReasons.length).length; return `${q} queued, ${b} not eligible${delivery(r.delivery)}` }) },
    { key: 'retry', label: 'Retry sync', disabled: s.queue.waiting || s.queue.errors ? false : 'Nothing waiting',
      run: () => act<any>('retry', 'retry', {}, r => `${r.retried} event${r.retried === 1 ? '' : 's'} retried${delivery(r.delivery)}`) },
    { key: 'distribution', label: 'Manage distribution', hint: 'Shows what the owner authorised.', run: () => { setMenu(false); document.getElementById('nexus-distribution')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } },
    { key: 'open', label: 'Open NEXUS profile', disabled: s.nexusProfileUrl ? false : 'Available once the owner is verified in NEXUS', run: () => { setMenu(false); window.open(s.nexusProfileUrl!, '_blank', 'noopener') } },
  ]
  // When the header wraps (phones) the button sits at the left edge: open the
  // menu towards whichever side has room so it never leaves the viewport.
  function toggleMenu() {
    const r = menuRef.current?.getBoundingClientRect()
    // Phones: a bottom sheet above the navigation island, so no item can end up underneath it.
    if (window.innerWidth < 640) setMenuSide('sheet')
    else if (r) setMenuSide(r.right >= 328 ? 'right' : 'left')
    setMenu(m => !m)
  }
  function setAskOpen(a: Ask) { setMenu(false); setAskValue(''); setAsk(a) }
  async function submitAsk() {
    if (!ask || !askValue.trim()) return
    const a = ask; setAsk(null)
    await act(a.path, a.path, { [a.field]: askValue.trim() }, () => `${a.title}: done`)
  }
  const label = LINK_LABEL[st]

  return (
    <div data-testid="nexus-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: F }}>
      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={head}>NEXUS Owner Portal</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              <span data-testid="nexus-link-state"><Chip tone={label.tone}>{label.text}</Chip></span>
              <span data-testid="nexus-sync-state"><Chip tone={SYNC_TONE[s.link.sync.state] || 'muted'}>Owner sync: {s.link.sync.state}</Chip></span>
              {dnc && <Chip tone="red">Do not contact</Chip>}
            </div>
          </div>
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button data-testid="nexus-actions" aria-haspopup="menu" aria-expanded={menu} onClick={toggleMenu} disabled={!!busy} style={btn(true, !!busy)}>{busy ? 'Working…' : 'NEXUS actions ▾'}</button>
            {menu && (
              <div role="menu" data-testid="nexus-menu" style={{ ...(menuSide === 'sheet'
                ? { position: 'fixed' as const, left: 12, right: 12, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)', zIndex: 2000 }
                : { position: 'absolute' as const, [menuSide]: 0, top: 'calc(100% + 6px)', zIndex: 30, width: 320 }), background: 'var(--crm-raised, var(--crm-surface))', border: `1px solid ${DCARD_BORDER}`, borderRadius: 12, padding: 6, boxShadow: '0 18px 50px rgba(0,0,0,.45)', maxHeight: menuSide === 'sheet' ? 'calc(100dvh - 190px)' : '70vh', overflowY: 'auto', overscrollBehavior: 'contain' }}>
                {items.map(it => (
                  <button key={it.key} role="menuitem" data-testid={`nexus-item-${it.key}`} disabled={!!it.disabled} title={it.disabled || undefined} onClick={it.run}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 8, padding: '9px 10px', minHeight: 40, cursor: it.disabled ? 'not-allowed' : 'pointer', opacity: it.disabled ? 0.45 : 1, fontFamily: F }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: DTEXT }}>{it.label}</span>
                    {(it.disabled || it.hint) && <span style={{ display: 'block', fontSize: 10.5, color: DTEXT_FAINT, marginTop: 2 }}>{it.disabled || it.hint}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {!s.receiver.configured && (
          <div data-testid="nexus-receiver-note" style={{ marginTop: 14, fontSize: 12, color: '#FBBF24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.25)', borderRadius: 10, padding: '9px 12px' }}>
            NEXUS sync is pending: the NEXUS receiver is not connected yet. Approved changes are queued here and nothing is shown as synced until NEXUS confirms it.
          </div>
        )}

        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px 20px', margin: '16px 0 0' }}>
          <Fact label="Invitation" value={!inv ? 'None' : inv.state === 'active' ? `Active · expires ${fmtDate(inv.expiresAt) || ''}` : inv.state[0].toUpperCase() + inv.state.slice(1)} />
          <Fact label="Link copied" value={inv?.copyCount ? `${inv.copyCount}× · last ${ago(inv.lastCopiedAt)}` : '—'} />
          <Fact label="NEXUS account" value={s.link.nexusAccountRef || '—'} mono />
          <Fact label="Verified" value={s.link.verifiedAt ? `${fmtDate(s.link.verifiedAt)} · ${s.link.verificationMethod || ''}` : 'No'} />
          <Fact label="Last owner sync" value={s.link.sync.lastSyncAt ? ago(s.link.sync.lastSyncAt) : 'Never'} />
          <Fact label="Queue" value={`${s.queue.waiting} waiting · ${s.queue.errors} error${s.queue.errors === 1 ? '' : 's'}`} warn={s.queue.errors > 0} />
        </dl>
        {s.link.disputeReason && <p style={{ margin: '12px 0 0', fontSize: 12, color: '#F87171' }}>Dispute: {s.link.disputeReason}</p>}
        {s.link.sync.lastError && <p style={{ margin: '12px 0 0', fontSize: 12, color: '#F87171' }}>Last owner sync error: {s.link.sync.lastError}</p>}

        {link && (
          <div data-testid="nexus-invite-link" style={{ marginTop: 14, borderTop: `1px solid ${DBORDER}`, paddingTop: 14 }}>
            <div style={{ ...head, marginBottom: 8 }}>{copied ? 'Invitation link copied' : 'Invitation link'}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input readOnly value={link} onFocus={e => e.currentTarget.select()} aria-label="Invitation link" style={{ flex: '1 1 220px', minWidth: 0, background: 'var(--crm-bg)', border: `1px solid ${DBORDER}`, borderRadius: 9, padding: '9px 11px', fontSize: 11.5, fontFamily: FM, color: DTEXT }} />
              <button style={btn()} onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { /* the field stays selectable */ } }}>{copied ? 'Copied' : 'Copy'}</button>
              <button style={btn()} onClick={() => setLink(null)}>Hide</button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: DTEXT_FAINT }}>Share it with the owner yourself, in a conversation you are already having. ARGUS does not send it. Opening the link lets the owner review the listings — it does not prove ownership.</p>
          </div>
        )}
      </section>

      <section style={card} id="nexus-distribution">
        <div style={head}>Properties · sync status</div>
        <p style={{ margin: '8px 0 0', fontSize: 11.5, color: DTEXT_FAINT }}>Distribution is decided by the owner in the NEXUS Owner Portal. Nothing is pre-selected and ARGUS cannot grant it on the owner&apos;s behalf.</p>
        {!s.properties.length && <p style={{ margin: '12px 0 0', fontSize: 12.5, color: DTEXT_DIM }}>No complete, active listings for this owner.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 10, marginTop: 14 }}>
          {s.properties.map(p => (
            <article key={p.id} data-testid={`nexus-property-${p.ref}`} style={{ border: `1px solid ${DBORDER}`, borderRadius: 12, padding: '12px 14px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: DTEXT, fontFamily: FM }}>#{p.ref}</span>
                <span style={{ fontSize: 11, color: DTEXT_FAINT }}>{p.town} · {p.transactionType === 'sale' ? 'Sale' : p.transactionType === 'rent' ? 'Rent' : 'Rent/sale unclear'}</span>
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 }}>
                <Chip tone={p.statuses.linked ? 'green' : 'muted'}>{p.statuses.linked ? 'Linked' : 'Imported'}</Chip>
                <Chip tone={p.statuses.ownerReview === 'verified' ? 'green' : p.statuses.ownerReview === 'pending' ? 'amber' : 'red'}>Owner review: {p.statuses.ownerReview}</Chip>
                <Chip tone={p.statuses.distribution === 'approved' ? 'green' : p.statuses.distribution === 'withdrawn' ? 'red' : 'muted'}>Distribution: {p.statuses.distribution.replace('_', ' ')}</Chip>
                <Chip tone={p.statuses.publication === 'published' ? 'green' : p.statuses.publication === 'unpublished' ? 'muted' : 'amber'}>{p.statuses.publication[0].toUpperCase() + p.statuses.publication.slice(1)}</Chip>
                <Chip tone={SYNC_TONE[p.statuses.sync] || 'muted'}>Sync: {p.statuses.sync}</Chip>
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                <Chip tone="blue">{p.statuses.availability.replace(/_/g, ' ')}</Chip>
                <span data-testid={`nexus-freshness-${p.ref}`}><Chip tone={FRESH_TONE[p.statuses.freshness.state]} title={p.statuses.freshness.lastConfirmedAt || 'No owner confirmation recorded'}>{p.statuses.freshness.label} · {ago(p.statuses.freshness.lastConfirmedAt)}</Chip></span>
              </div>
              {p.distribution.length > 0 && <p style={{ margin: '9px 0 0', fontSize: 11, color: DTEXT_DIM }}>Authorised: {p.distribution.map(g => `${CHANNEL[g.channel] || g.channel}${g.audienceRef ? ` (${g.audienceRef})` : ''} — ${g.scopes.join(', ').replace(/_/g, ' ')}`).join(' · ')}</p>}
              {p.blockedReasons.length > 0 && <ul style={{ margin: '9px 0 0', padding: '0 0 0 16px', fontSize: 11, color: DTEXT_FAINT }}>{p.blockedReasons.map(r => <li key={r}>{REASON[r] || r}</li>)}</ul>}
              {p.lastSyncError && <p style={{ margin: '8px 0 0', fontSize: 11, color: '#F87171' }}>{p.lastSyncError}</p>}
              {p.lastSyncAt && <p style={{ margin: '8px 0 0', fontSize: 10.5, color: DTEXT_FAINT }}>Last synced {ago(p.lastSyncAt)}</p>}
            </article>
          ))}
        </div>
      </section>

      {ask && (
        <div role="dialog" aria-modal="true" aria-label={ask.title} data-testid="nexus-ask" onMouseDown={e => { if (e.target === e.currentTarget) setAsk(null) }} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div style={{ ...card, width: 'min(440px, 100%)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: DTEXT }}>{ask.title}</div>
            {ask.hint && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: DTEXT_FAINT }}>{ask.hint}</p>}
            <label style={{ display: 'block', marginTop: 14, fontSize: 11, fontWeight: 600, color: DTEXT_DIM }}>{ask.label}
              <textarea autoFocus value={askValue} onChange={e => setAskValue(e.target.value)} rows={3} maxLength={500} style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, background: 'var(--crm-bg)', border: `1px solid ${DBORDER}`, borderRadius: 9, padding: '9px 11px', fontSize: 12.5, fontFamily: F, color: DTEXT, resize: 'vertical' }} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button style={btn()} onClick={() => setAsk(null)}>Cancel</button>
              <button data-testid="nexus-ask-confirm" style={btn(true, !askValue.trim())} disabled={!askValue.trim()} onClick={submitAsk}>{ask.confirm}</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div role="status" data-testid="nexus-toast" style={{ position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 90, maxWidth: 'calc(100vw - 32px)', background: toast.ok ? '#14532D' : '#7F1D1D', color: '#fff', borderRadius: 10, padding: '10px 16px', fontSize: 12.5, fontWeight: 600, boxShadow: '0 10px 30px rgba(0,0,0,.4)' }}>{toast.text}</div>}
    </div>
  )
}

function Fact({ label, value, mono, warn }: { label: string; value: string; mono?: boolean; warn?: boolean }) {
  return <div style={{ minWidth: 0 }}><dt style={{ fontSize: 9.5, fontWeight: 700, color: DTEXT_FAINT, letterSpacing: '.08em', textTransform: 'uppercase' }}>{label}</dt><dd style={{ margin: '4px 0 0', fontSize: 12.5, color: warn ? '#F87171' : DTEXT, fontFamily: mono ? FM : F, overflowWrap: 'anywhere' }}>{value}</dd></div>
}
