'use client'
import { use, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch, crmJson } from '@/lib/crm/api'
import {
  CrmProvider, CrmShell, Masked, Thumbs, A, AD, AB, NAVY, F, FM, fmtMoney, fmtDate, useCrm, describe,
  DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, glowFor,
} from '@/lib/crm/ui'

export default function OwnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CrmProvider><OwnerDetail id={parseInt(id)} /></CrmProvider>
}

// ── design tokens (local to this page — same dark palette lib/crm/ui.tsx
// exports, plus a per-owner glow) ────────────────────────────────────────────
// Kev, 2026-09-11: "das owner profile kann ruhig bisschen fanciger" — the
// same dark cards Inventory and Schedule Board now use, but CARD itself gets
// an per-owner-id colour glow (see glowFor) instead of a plain hairline, and
// the hero banner below adds the ambient gradient wash from the mockup.
const CARD: React.CSSProperties = { background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 16, padding: '20px 22px' }
const HEAD: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: DTEXT_FAINT, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }
const MUTED = DTEXT_FAINT
const INK = DTEXT
const HAIRLINE = DBORDER
const BG = '#0E1420'

function initials(name?: string | null) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

// Deterministic soft colour from the name so two owners don't look identical
// at a glance in a list, while staying inside the brand's own palette family.
const AVATAR_HUES = ['#B8953F', '#8C6E8F', '#5C7A8A', '#7A8A5C', '#A3654F', '#6E7DB8']
function avatarColor(id: number) { return AVATAR_HUES[id % AVATAR_HUES.length] }

function daysAgo(d?: string | null) {
  if (!d) return null
  const ms = Date.now() - new Date(d).getTime()
  const days = Math.floor(ms / 86400000)
  if (days < 0) return null
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  return fmtDate(d)
}
// Success-criteria §15's 11th question ("what's the next action?") has no
// single field to point at — it's a synthesis of everything else on this
// page. Computed here, client-side, from data already fetched; not a new
// backend concept, just the one thing the rest of the tabs imply but never
// say out loud.
function nextAction(d: any, o: any, props: any[]) {
  if (o.doNotContact) return { text: 'No further contact — marked do-not-contact', tone: 'muted' as const }
  if (d.incompleteCount > 0) return { text: `Complete ${d.incompleteCount} pending property record${d.incompleteCount === 1 ? '' : 's'}`, tone: 'warn' as const }
  const awaiting = props.find(p => p.pendingCheckSentAt)
  if (awaiting) return { text: `Awaiting owner's reply on #${awaiting.ref}'s availability check`, tone: 'info' as const }
  const upcoming = props.find(p => propertyStatus(p).key === 'upcoming')
  if (upcoming) return { text: `Follow up on #${upcoming.ref} ahead of ${fmtDate(upcoming.availableDate)}`, tone: 'info' as const }
  const daysSinceContact = o.lastContactAt ? Math.floor((Date.now() - new Date(o.lastContactAt).getTime()) / 86400000) : null
  if (!props.length && (o.warmth === 'warm' || o.warmth === 'hot')) return { text: 'No active listings — a good candidate for an upcoming-inventory check-in', tone: 'info' as const }
  if (daysSinceContact != null && daysSinceContact > 30 && !d.automation?.states?.some((s: any) => s.enabled)) return { text: `No contact in ${daysSinceContact}d and no automation armed — consider a check-in`, tone: 'warn' as const }
  return { text: 'No urgent action — relationship steady', tone: 'muted' as const }
}
function inDays(d?: string | null) {
  if (!d) return null
  const ms = new Date(d).getTime() - Date.now()
  const days = Math.ceil(ms / 86400000)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days}d`
}

// ── property status vocabulary (brief §5): AVAILABLE / UPCOMING / OFF
// MARKET / RENTED / UNKNOWN — built from the REAL available_status enum
// (available, available_confirmed, not_available, rented, pending_check,
// archived), not the older Pill/AVAIL map in lib/crm/ui.tsx, which only
// covers half of those values and silently mislabels the rest as
// "Available" (falls back to its first map key). Scoped to this page only.
function propertyStatus(p: any): { key: string; label: string; bg: string; text: string; dot: string } {
  const s = p.availableStatus
  if (s === 'rented') return { key: 'rented', label: 'Rented', bg: '#FEE2E2', text: '#B91C1C', dot: '#EF4444' }
  if (s === 'archived' || s === 'not_available') return { key: 'off_market', label: 'Off Market', bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF' }
  if (s === 'pending_check' || !s) return { key: 'unknown', label: 'Unknown', bg: '#F3F4F6', text: '#92400E', dot: '#D97706' }
  const upcoming = p.availableDate && new Date(p.availableDate).getTime() > Date.now()
  if (upcoming) return { key: 'upcoming', label: 'Upcoming', bg: '#FEF9C3', text: '#A16207', dot: '#EAB308' }
  return { key: 'available', label: 'Available', bg: '#DCFCE7', text: '#15803D', dot: '#22C55E' }
}
function StatusPill({ p, small }: { p: any; small?: boolean }) {
  const s = propertyStatus(p)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: small ? '2px 7px' : '3px 9px', borderRadius: 99, background: s.bg, color: s.text, fontSize: small ? 9 : 10, fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: '0.03em' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />{s.label}
    </span>
  )
}
function Badge({ children, tone = 'gold' }: { children: React.ReactNode; tone?: 'gold' | 'green' | 'navy' }) {
  // 'navy' reads fine as dark-text-on-light-tint over the CRM's usual cream
  // background, but NAVY text on a near-black card is close to invisible —
  // this tone gets a light cool-blue instead once the page went dark.
  const map = {
    gold: { bg: AD, text: A, bd: AB },
    green: { bg: 'rgba(34,197,94,0.14)', text: '#4ADE80', bd: 'rgba(34,197,94,0.35)' },
    navy: { bg: 'rgba(93,138,242,0.14)', text: '#8FADF7', bd: 'rgba(93,138,242,0.32)' },
  }[tone]
  return <span style={{ fontSize: 10, fontWeight: 700, color: map.text, background: map.bg, border: `1px solid ${map.bd}`, borderRadius: 99, padding: '4px 10px', letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>{children}</span>
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'properties', label: 'Properties' },
  { key: 'insights', label: 'Contact & Insights' },
  { key: 'flows', label: 'Flows' },
  { key: 'documents', label: 'Documents' },
  { key: 'history', label: 'History' },
] as const
type TabKey = typeof TABS[number]['key']

const PROPERTY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'rent', label: 'For Rent' },
  { key: 'sale', label: 'For Sale' },
  { key: 'active', label: 'Active' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'off_market', label: 'Off Market' },
  { key: 'historic', label: 'Historic' },
] as const

function OwnerDetail({ id }: { id: number }) {
  const router = useRouter()
  const { me } = useCrm()
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<TabKey>('overview')
  const [msg, setMsg] = useState('')

  const load = () => crmFetch(`owners/${id}`).then(setD).catch(e => setErr(e?.message || 'Failed to load'))
  useEffect(() => { load() }, [id])

  const o = d?.owner
  const props: any[] = d?.properties || []
  const realPhone = useRef<string | null>(null)

  if (err) return <CrmShell title="Owner" dark><div style={{ padding: 26, color: '#B91C1C' }}>{err}</div></CrmShell>
  if (!o) return <CrmShell title="Owner" dark><div style={{ padding: 26, color: MUTED }}>Loading…</div></CrmShell>

  const activeCount = props.filter(p => propertyStatus(p).key === 'available').length
  const upcomingCount = props.filter(p => propertyStatus(p).key === 'upcoming').length
  const automationOn = (d.automation?.states || []).some((s: any) => s.enabled)

  return (
    <CrmShell title={o.name || 'Owner'} subtitle={`ON-${String(o.id).padStart(4, '0')}`} dark>
      <div style={{ padding: '20px 20px 40px', fontFamily: F, maxWidth: 1120, margin: '0 auto' }}>
        <button onClick={() => router.push('/crm/owners')} style={backBtn}>← Owners</button>

        {/* ══ HEADER ═══════════════════════════════════════════════════════
            Kev, 2026-09-11: "das owner profile kann ruhig bisschen
            fanciger" — a per-owner glow (glowFor(o.id), same deterministic
            palette as Inventory's card glow) now rings the avatar and washes
            the banner corner instead of the old flat navy gradient alone. */}
        {(() => { const heroGlow = glowFor(o.id); return (
        <div style={{
          marginTop: 12, borderRadius: 18, overflow: 'hidden',
          boxShadow: `0 0 0 1px rgba(255,255,255,0.03), 0 24px 60px -28px ${heroGlow.glow}`,
          position: 'relative',
        }}>
          <PhotoUpload
            ownerId={o.id} kind="cover" imageUrl={o.coverUrl} onSaved={load}
            style={{
              height: 76, position: 'relative',
              background: o.coverUrl
                ? `center/cover no-repeat url(${o.coverUrl})`
                : `radial-gradient(ellipse 480px 200px at 85% -30%, ${heroGlow.soft}, transparent), linear-gradient(115deg, ${NAVY} 0%, #172038 55%, #0E1420 140%)`,
            }}
          />
          <div style={{ background: DCARD, padding: '0 24px 20px', borderTop: `1px solid ${DCARD_BORDER}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: -34, flexWrap: 'wrap' }}>
              <PhotoUpload
                ownerId={o.id} kind="avatar" imageUrl={o.avatarUrl} onSaved={load}
                style={{
                  width: 76, height: 76, borderRadius: '50%',
                  background: o.avatarUrl ? `center/cover no-repeat url(${o.avatarUrl})` : avatarColor(o.id),
                  border: `3px solid ${heroGlow.a}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF', fontSize: 26, fontWeight: 800, fontFamily: F, flexShrink: 0,
                  boxShadow: `0 0 0 5px ${DCARD}, 0 0 0 6px ${heroGlow.glow}, 0 0 24px 2px ${heroGlow.glow}`,
                }}
              >
                {!o.avatarUrl && initials(o.name)}
              </PhotoUpload>
              <div style={{ flex: 1, minWidth: 220, paddingBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h1 style={{ fontSize: 21, fontWeight: 800, color: INK, margin: 0, letterSpacing: '-0.02em' }}>{o.name || 'Unnamed owner'}</h1>
                  {o.doNotContact && <Badge tone="navy">🚫 DO NOT CONTACT</Badge>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {o.warmth && <Badge tone={o.warmth === 'hot' || o.warmth === 'warm' ? 'green' : 'navy'}>{o.warmth === 'hot' ? '🔥 HOT OWNER' : o.warmth === 'warm' ? '☀ WARM OWNER' : o.warmth.toUpperCase()}</Badge>}
                  {activeCount > 0 && <Badge tone="green">{activeCount} ACTIVE LISTING{activeCount === 1 ? '' : 'S'}</Badge>}
                  {upcomingCount > 0 && <Badge>UPCOMING INVENTORY</Badge>}
                  {automationOn && <Badge tone="navy">⚙ AUTOMATION ACTIVE</Badge>}
                  {!o.warmth && !activeCount && !upcomingCount && !automationOn && <span style={{ fontSize: 11, color: DTEXT_FAINT }}>No signals yet</span>}
                </div>
              </div>
              <HeaderActions o={o} onSaved={load} setMsg={setMsg} />
            </div>

            {/* contact + secondary meta */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 28px', marginTop: 18, paddingTop: 16, borderTop: `1px solid ${HAIRLINE}` }}>
              <MetaField label="Phone"><Masked entityType="owner_phone" entityId={o.id} masked={o.phoneMasked} hasValue={o.hasPhone} size={13} /></MetaField>
              <MetaField label="Email"><Masked entityType="owner_email" entityId={o.id} masked={o.emailMasked} hasValue={o.hasEmail} size={13} /></MetaField>
              {o.location && <MetaField label="Location"><span style={metaVal}>{o.location}</span></MetaField>}
              {o.phoneVariants?.length > 1 && <MetaField label="Also known via"><span style={metaVal}>{o.phoneVariants.length} numbers</span></MetaField>}
              <MetaField label="Owner since"><span style={metaVal}>{fmtDate(o.since) || '—'}</span></MetaField>
              <MetaField label="Last contact"><span style={metaVal}>{daysAgo(o.lastContactAt) || '—'}</span></MetaField>
              <MetaField label="Last reply"><span style={metaVal}>{daysAgo(o.lastReplyAt) || '—'}</span></MetaField>
              {d.automation?.nextAutomationAt && <MetaField label="Next automation"><span style={metaVal}>{inDays(d.automation.nextAutomationAt)}</span></MetaField>}
              {d.accountLabels?.length > 0 && (
                <MetaField label="Connected accounts">
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {d.accountLabels.map((a: any) => <span key={a.account_session} style={{ ...metaVal, background: DBORDER, borderRadius: 6, padding: '2px 7px', fontSize: 10.5, fontFamily: FM }}>{a.account_session}</span>)}
                  </div>
                </MetaField>
              )}
            </div>
            {msg && <div style={{ marginTop: 10, fontSize: 11, color: '#4ADE80', fontWeight: 600 }}>{msg}</div>}
          </div>
        </div>
        ) })()}

        {/* ══ NEXT ACTION ══════════════════════════════════════════════════ */}
        {(() => {
          const na = nextAction(d, o, props)
          const tone = {
            warn: { bg: 'rgba(217,119,6,0.12)', bd: 'rgba(217,119,6,0.35)', text: '#F0B14E', icon: '⚡' },
            info: { bg: AD, bd: AB, text: A, icon: '→' },
            muted: { bg: DCARD, bd: HAIRLINE, text: DTEXT_DIM, icon: '✓' },
          }[na.tone]
          return (
            <div style={{ marginTop: 14, background: tone.bg, border: `1px solid ${tone.bd}`, borderRadius: 12, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: tone.text, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{tone.icon} Next action</span>
              <span style={{ fontSize: 12.5, color: tone.text, fontWeight: 600 }}>{na.text}</span>
            </div>
          )
        })()}

        {/* ══ OVERVIEW CARDS ═══════════════════════════════════════════════ */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginTop: 16 }}>
          <StatCard label="Active listings" value={activeCount} onClick={() => setTab('properties')} />
          <StatCard label="Upcoming" value={upcomingCount} onClick={() => setTab('properties')} />
          <StatCard label="Total properties" value={props.length} sub={d.incompleteCount ? `+${d.incompleteCount} pending completion` : undefined} onClick={() => setTab('properties')} />
          <StatCard label="Last contact" value={daysAgo(o.lastContactAt) || '—'} small onClick={() => setTab('insights')} />
          <StatCard label="Next automation" value={d.automation?.nextAutomationAt ? inDays(d.automation.nextAutomationAt) : (automationOn ? 'armed' : 'off')} small onClick={() => setTab('flows')} />
          <StatCard label="Documents" value={d.documents?.length || 0} onClick={() => setTab('documents')} />
        </div>

        {/* ══ TABS ═════════════════════════════════════════════════════════ */}
        <div style={{ display: 'flex', gap: 4, marginTop: 22, borderBottom: `1px solid ${HAIRLINE}`, overflowX: 'auto' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px', fontFamily: F,
              fontSize: 12.5, fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? INK : MUTED,
              borderBottom: tab === t.key ? `2px solid ${A}` : '2px solid transparent', whiteSpace: 'nowrap', flexShrink: 0,
            }}>{t.label}</button>
          ))}
        </div>

        <div style={{ marginTop: 18 }}>
          {tab === 'overview' && <OverviewPanel d={d} onGoto={setTab} />}
          {tab === 'properties' && <PropertiesPanel props={props} incompleteCount={d.incompleteCount} owner={o} router={router} />}
          {tab === 'insights' && <InsightsPanel d={d} owner={o} onSaved={load} setMsg={setMsg} />}
          {tab === 'flows' && <FlowsPanel d={d} ownerId={id} onSaved={load} setMsg={setMsg} onGoto={setTab} />}
          {tab === 'documents' && <DocumentsPanel ownerId={id} documents={d.documents || []} properties={props} onSaved={load} me={me} />}
          {tab === 'history' && <HistoryPanel history={d.history || []} />}
        </div>
      </div>
    </CrmShell>
  )
}

// ── shared small pieces ──────────────────────────────────────────────────────
const metaVal: React.CSSProperties = { fontSize: 12.5, color: INK, fontWeight: 600 }
function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: DTEXT_FAINT, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}
// Kev, 2026-09-11: each tile gets its own glow (glowFor(label), deterministic
// so "Active listings" is always the same colour) — the mockup's row of
// differently-tinted stat cards, not six identical grey boxes.
function StatCard({ label, value, sub, small, onClick }: { label: string; value: any; sub?: string; small?: boolean; onClick?: () => void }) {
  const g = glowFor(label)
  return (
    <div onClick={onClick} style={{
      ...CARD, padding: '14px 16px', cursor: onClick ? 'pointer' : 'default', transition: 'box-shadow .15s',
      boxShadow: `0 0 0 1px rgba(255,255,255,0.02), 0 14px 32px -20px ${g.glow}`,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: DTEXT_FAINT, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: small ? 16 : 24, fontWeight: 800, color: INK, marginTop: 4, fontFamily: small ? F : FM }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: g.a, marginTop: 2, fontWeight: 600 }}>{sub}</div>}
    </div>
  )
}
const backBtn: React.CSSProperties = { background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 8, padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: F, color: DTEXT_DIM, fontWeight: 600 }

// ── HEADER ACTIONS ───────────────────────────────────────────────────────────
// Click-to-upload avatar/cover — hover shows a camera icon over whatever is
// already rendered inside (initials fallback or the gradient cover), no
// separate "edit photo" mode to enter first.
function PhotoUpload({ ownerId, kind, imageUrl, onSaved, style, children }:
  { ownerId: number; kind: 'avatar' | 'cover'; imageUrl?: string | null; onSaved: () => void; style: React.CSSProperties; children?: React.ReactNode }) {
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      const res = await fetch(`/api/crm/owners/${ownerId}/photo`, { method: 'POST', credentials: 'same-origin', body: fd })
      if (!res.ok) throw new Error('Upload failed')
      onSaved()
    } catch { alert('Photo upload failed') }
    finally { setBusy(false) }
  }

  return (
    <div
      style={{ ...style, cursor: 'pointer', position: 'relative', overflow: style.borderRadius ? 'hidden' : style.overflow }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => input.current?.click()}
    >
      {children}
      <input ref={input} type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
      {(hover || busy) && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF', fontSize: kind === 'avatar' ? 16 : 13, fontWeight: 700 }}>
          {busy ? '…' : '📷'}
        </div>
      )}
    </div>
  )
}

function HeaderActions({ o, onSaved, setMsg }: { o: any; onSaved: () => void; setMsg: (s: string) => void }) {
  const { doReveal } = useCrm()
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ name: o.name || '', location: o.location || '', property_type: o.propertyType || '' })
  const [busy, setBusy] = useState(false)

  async function openChat() {
    if (!o.hasPhone) return
    try {
      const v = await doReveal('owner_phone', o.id)
      window.open(`https://wa.me/${v.replace(/\D/g, '')}`, '_blank')
    } catch (e: any) { setMsg(e?.message || 'Reveal failed') }
  }
  async function call() {
    if (!o.hasPhone) return
    try {
      const v = await doReveal('owner_phone', o.id)
      window.location.href = `tel:${v}`
    } catch (e: any) { setMsg(e?.message || 'Reveal failed') }
  }
  async function save() {
    setBusy(true)
    try {
      await crmJson(`owners/${o.id}`, 'PATCH', form)
      setMsg('Contact updated')
      setEditing(false)
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Update failed') }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 4 }}>
      {editing ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Name" style={editInp} />
          <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="Location" style={{ ...editInp, width: 100 }} />
          <button onClick={save} disabled={busy} style={actBtnDark}>{busy ? '…' : 'Save'}</button>
          <button onClick={() => setEditing(false)} style={actBtnLight}>Cancel</button>
        </div>
      ) : (
        <>
          <button onClick={() => setEditing(true)} style={actBtnLight}>✎ Edit contact</button>
          <button onClick={openChat} disabled={!o.hasPhone} style={{ ...actBtnLight, opacity: o.hasPhone ? 1 : 0.4 }}>💬 Chat</button>
          <button onClick={call} disabled={!o.hasPhone} style={{ ...actBtnLight, opacity: o.hasPhone ? 1 : 0.4 }}>📞 Call</button>
          <button onClick={() => router.push('/crm/property/new')} style={actBtnDark}>+ Add property</button>
        </>
      )}
    </div>
  )
}
const editInp: React.CSSProperties = { background: '#0E1420', border: `1px solid ${DBORDER}`, borderRadius: 8, padding: '7px 10px', fontSize: 12, fontFamily: F, width: 130, outline: 'none', color: DTEXT }
const actBtnLight: React.CSSProperties = { background: DBORDER, border: `1px solid ${DCARD_BORDER}`, borderRadius: 9, padding: '8px 13px', fontSize: 11.5, fontWeight: 700, fontFamily: F, cursor: 'pointer', color: DTEXT_DIM }
const actBtnDark: React.CSSProperties = { background: A, color: '#151C2C', border: 'none', borderRadius: 9, padding: '8px 13px', fontSize: 11.5, fontWeight: 700, fontFamily: F, cursor: 'pointer' }

// ══════════════════════════════════════════════════════════════════════════
// OVERVIEW — the landing tab: recent activity + a properties-at-a-glance
// strip + preference/relationship highlights, so the 5-second questions in
// the brief's success criteria are answerable without leaving this tab.
// ══════════════════════════════════════════════════════════════════════════
function OverviewPanel({ d, onGoto }: { d: any; onGoto: (t: TabKey) => void }) {
  const props: any[] = d.properties || []
  const recentHistory = (d.history || []).slice(0, 6)
  const generalPrefs = (d.preferences?.general || []).filter((p: any) => !p.contextOnly)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={CARD}>
          <div style={{ ...HEAD, display: 'flex', justifyContent: 'space-between' }}>
            <span>Properties at a glance</span>
            <span onClick={() => onGoto('properties')} style={{ color: 'var(--crm-accent)', cursor: 'pointer', textTransform: 'none', fontWeight: 700 }}>View all →</span>
          </div>
          {!props.length && <EmptyRow text="No real, listable properties yet." />}
          {props.slice(0, 4).map(p => <PropertyRow key={p.id} p={p} compact />)}
        </div>
        <div style={CARD}>
          <div style={HEAD}>Recent activity</div>
          {!recentHistory.length && <EmptyRow text="Nothing logged yet." />}
          {recentHistory.map((h: any, i: number) => <HistoryRow key={i} h={h} />)}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {d.owner.conversationSummary && (
          <div style={CARD}>
            <div style={HEAD}>Conversation summary</div>
            <div style={{ fontSize: 12.5, color: DTEXT_DIM, lineHeight: 1.5 }}>{d.owner.conversationSummary}</div>
          </div>
        )}
        {d.owner.lastReplyQuote && (
          <div style={CARD}>
            <div style={HEAD}>Last thing they said</div>
            <div style={{ fontSize: 12.5, color: DTEXT_DIM, fontStyle: 'italic', lineHeight: 1.5 }}>&ldquo;{d.owner.lastReplyQuote}&rdquo;</div>
          </div>
        )}
        <div style={CARD}>
          <div style={{ ...HEAD, display: 'flex', justifyContent: 'space-between' }}>
            <span>What this owner usually allows</span>
            <span onClick={() => onGoto('insights')} style={{ color: 'var(--crm-accent)', cursor: 'pointer', textTransform: 'none', fontWeight: 700 }}>All →</span>
          </div>
          {!generalPrefs.length && <EmptyRow text="No general preferences captured yet." />}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {generalPrefs.slice(0, 8).map((p: any) => <PreferencePill key={p.id} p={p} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
function EmptyRow({ text }: { text: string }) { return <div style={{ fontSize: 12, color: DTEXT_FAINT, padding: '6px 0' }}>{text}</div> }

// ══════════════════════════════════════════════════════════════════════════
// PROPERTIES — the "understand all 20 at a glance" grid.
// ══════════════════════════════════════════════════════════════════════════
function PropertiesPanel({ props, incompleteCount, owner, router }: { props: any[]; incompleteCount: number; owner: any; router: any }) {
  const [filter, setFilter] = useState<typeof PROPERTY_FILTERS[number]['key']>('all')
  const filtered = props.filter(p => {
    const st = propertyStatus(p).key
    if (filter === 'all') return true
    if (filter === 'rent') return p.prices.longlet != null
    if (filter === 'sale') return p.prices.sale != null
    if (filter === 'active') return st === 'available'
    if (filter === 'upcoming') return st === 'upcoming'
    if (filter === 'off_market') return st === 'off_market'
    if (filter === 'historic') return st === 'off_market' || st === 'rented'
    return true
  })
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {PROPERTY_FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={{
            background: filter === f.key ? A : DCARD, color: filter === f.key ? '#151C2C' : DTEXT_DIM,
            border: `1px solid ${filter === f.key ? A : DCARD_BORDER}`, borderRadius: 99, padding: '6px 13px',
            fontSize: 11.5, fontWeight: 700, fontFamily: F, cursor: 'pointer',
          }}>{f.label}</button>
        ))}
      </div>
      {incompleteCount > 0 && (
        <div style={{ background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.35)', borderRadius: 10, padding: '10px 14px', fontSize: 11.5, color: '#F0B14E', marginBottom: 14 }}>
          ⏳ {incompleteCount} more record{incompleteCount === 1 ? '' : 's'} for this owner {incompleteCount === 1 ? 'is' : 'are'} still incomplete (missing ref/locality/price/type) — not shown as listings, pending completion in the review queue.
        </div>
      )}
      {!filtered.length && <div style={{ ...CARD, textAlign: 'center', color: DTEXT_FAINT, padding: 40 }}>No properties match this filter.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 14 }}>
        {filtered.map(p => <PropertyCard key={p.id} p={p} router={router} />)}
      </div>
    </div>
  )
}

function PropertyCard({ p, router }: { p: any; router: any }) {
  const { doReveal } = useCrm()
  const [busy, setBusy] = useState<string | null>(null)

  async function checkAvailability() {
    setBusy('check')
    try { await crmJson(`schedule-board/listings/${p.ref}/request-availability`, 'POST', {}) }
    catch {} finally { setBusy(null) }
  }
  async function pauseChecks() {
    setBusy('pause')
    try { await crmJson(`schedule-board/listings/${p.ref}/auto-av`, 'POST', { rhythm: 'off' }) }
    catch {} finally { setBusy(null) }
  }
  async function chat() {
    if (!p.owner.hasPhone) return
    try { const v = await doReveal('owner_phone', p.owner.id, p.id); window.open(`https://wa.me/${v.replace(/\D/g, '')}`, '_blank') }
    catch {}
  }

  return (
    <div style={{ ...CARD, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', height: 140, background: '#1B2333' }}>
        {p.images?.[0] ? (
          <img src={p.images[0].thumbnail || p.images[0].url || p.images[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', filter: p.exclusive ? 'blur(3px) brightness(0.6)' : 'none' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: DTEXT_FAINT, fontSize: 12 }}>No image</div>
        )}
        <div style={{ position: 'absolute', top: 8, left: 8 }}><StatusPill p={p} /></div>
        {p.exclusive && <div style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.55)', color: '#FFF', fontSize: 9, fontWeight: 700, borderRadius: 5, padding: '3px 7px' }}>🔒 EXCLUSIVE</div>}
      </div>
      <div style={{ padding: '13px 15px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--crm-accent)', fontFamily: FM }}>{p.ref}</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: INK }}>{p.prices.longlet ? `${fmtMoney(p.prices.longlet)}/mo` : (p.prices.sale ? fmtMoney(p.prices.sale) : '—')}</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginTop: 2 }}>{p.location.town} · {p.type}</div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{p.beds != null ? `${p.beds} bed` : ''}{p.baths != null ? ` · ${p.baths} bath` : ''}</div>

        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${HAIRLINE}`, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {p.availableDate && <MiniFact label="Available from" value={fmtDate(p.availableDate) || '—'} />}
          {p.lastConfirmedAvailableAt && <MiniFact label="Last confirmed" value={daysAgo(p.lastConfirmedAvailableAt) || '—'} />}
          {p.pendingCheckSentAt && <MiniFact label="Next check" value="awaiting owner reply" warn />}
          {!p.pendingCheckSentAt && p.avAutoRhythm !== 'off' && <MiniFact label="Auto-checks" value={p.avAutoRhythm.replace('_', ' ')} />}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 12 }}>
          <MiniBtn onClick={() => router.push(`/crm/property/${p.id}`)}>Open</MiniBtn>
          <MiniBtn onClick={chat} disabled={!p.owner.hasPhone}>Chat</MiniBtn>
          <MiniBtn onClick={checkAvailability} busy={busy === 'check'}>Check availability</MiniBtn>
          <MiniBtn onClick={() => router.push(`/crm/property/${p.id}`)}>Edit</MiniBtn>
          <MiniBtn onClick={pauseChecks} busy={busy === 'pause'} tone="muted">Pause checks</MiniBtn>
        </div>
      </div>
    </div>
  )
}
function MiniFact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
      <span style={{ color: DTEXT_FAINT }}>{label}</span>
      <span style={{ color: warn ? '#F0B14E' : DTEXT_DIM, fontWeight: 600 }}>{value}</span>
    </div>
  )
}
function MiniBtn({ children, onClick, disabled, busy, tone }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; tone?: 'muted' }) {
  return (
    <button onClick={onClick} disabled={disabled || busy} style={{
      background: tone === 'muted' ? DBORDER : AD, color: tone === 'muted' ? DTEXT_FAINT : A,
      border: `1px solid ${tone === 'muted' ? DCARD_BORDER : AB}`, borderRadius: 7, padding: '5px 9px',
      fontSize: 10.5, fontWeight: 700, fontFamily: F, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
    }}>{busy ? '…' : children}</button>
  )
}
function PropertyRow({ p, compact }: { p: any; compact?: boolean }) {
  const router = useRouter()
  return (
    <div onClick={() => router.push(`/crm/property/${p.id}`)} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${HAIRLINE}`, cursor: 'pointer' }}>
      <Thumbs images={p.images} count={p.imageCount} exclusive={p.exclusive} w={54} h={38} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--crm-accent)', fontFamily: FM }}>{p.ref}</div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{p.location.town} · {p.type}</div>
      </div>
      <StatusPill p={p} small />
      <div style={{ fontWeight: 800, fontSize: 13, color: INK, whiteSpace: 'nowrap' }}>{p.prices.longlet ? `${fmtMoney(p.prices.longlet)}/mo` : (p.prices.sale ? fmtMoney(p.prices.sale) : '—')}</div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// CONTACT & INSIGHTS
// ══════════════════════════════════════════════════════════════════════════
function InsightsPanel({ d, owner, onSaved, setMsg }: { d: any; owner: any; onSaved: () => void; setMsg: (s: string) => void }) {
  const general = d.preferences?.general || []
  const byProperty = d.preferences?.byProperty || []
  const operational = general.filter((p: any) => !p.contextOnly)
  const contextOnly = general.filter((p: any) => p.contextOnly)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={CARD}>
          <div style={HEAD}>WhatsApp identities</div>
          {!d.accountLabels?.length && <EmptyRow text="No account has logged a conversation with this owner yet." />}
          {d.accountLabels?.map((a: any) => (
            <div key={a.account_session} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${HAIRLINE}` }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, fontFamily: FM }}>{a.account_session}</div>
                <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>{a.total_msgs_in} in · {a.total_msgs_out} out{a.last_reply_at ? ` · replied ${daysAgo(a.last_reply_at)}` : ''}</div>
              </div>
              <RelationshipPill label={a.label} />
            </div>
          ))}
          {owner.phoneVariants?.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${HAIRLINE}` }}>
              <div style={{ fontSize: 10, color: DTEXT_FAINT, marginBottom: 6 }}>Known phone numbers ({owner.phoneVariants.length}) — same identity, resolved across every account</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {owner.phoneVariants.map((v: any, i: number) => <span key={i} style={{ fontSize: 10.5, fontFamily: FM, background: DBORDER, borderRadius: 6, padding: '3px 8px', color: DTEXT_DIM }}>{v.phoneMasked}{v.primary ? ' ★' : ''}</span>)}
              </div>
            </div>
          )}
        </div>

        <div style={CARD}>
          <div style={HEAD}>Relationship notes</div>
          <DncControl owner={owner} onSaved={onSaved} setMsg={setMsg} />
          {owner.outreachCount > 0 && <MiniFact label="Outreach attempts" value={String(owner.outreachCount)} />}
          {owner.replyCount > 0 && <MiniFact label="Replies received" value={String(owner.replyCount)} />}
          {owner.nextReachAt && <MiniFact label="Next scheduled reachout" value={fmtDate(owner.nextReachAt) || '—'} />}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={CARD}>
          <div style={HEAD}>Property & business preferences</div>
          {!operational.length && <EmptyRow text="Nothing extracted yet — pets, sharing, deposit and similar preferences appear here once the owner mentions them." />}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {operational.map((p: any) => <PreferencePill key={p.id} p={p} />)}
          </div>
          {byProperty.map((grp: any) => (
            <div key={grp.propertyId} style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${HAIRLINE}` }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--crm-accent)', fontFamily: FM, marginBottom: 6 }}>Specific to #{grp.propertyRef}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {grp.preferences.filter((p: any) => !p.contextOnly).map((p: any) => <PreferencePill key={p.id} p={p} />)}
              </div>
            </div>
          ))}
        </div>

        {contextOnly.length > 0 && (
          <div style={{ ...CARD, background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.28)' }}>
            <div style={{ ...HEAD, color: '#F0B14E' }}>In the owner's own words — context only</div>
            <div style={{ fontSize: 10.5, color: '#E3A458', marginBottom: 10, lineHeight: 1.5 }}>
              Never used for matching or filtering. Shown only so you understand what was actually said.
            </div>
            {contextOnly.map((p: any) => (
              <div key={p.id} style={{ fontSize: 12, color: '#D9B382', fontStyle: 'italic', padding: '6px 0', borderBottom: '1px solid rgba(217,119,6,0.22)' }}>
                &ldquo;{p.source_note || p.value}&rdquo;
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
function RelationshipPill({ label }: { label: string }) {
  const map: Record<string, any> = {
    hot: { bg: '#FEE2E2', text: '#B91C1C', l: '🔥 Hot' }, warm: { bg: '#FEF9C3', text: '#A16207', l: '☀ Warm' },
    cold: { bg: '#F3F4F6', text: '#6B7280', l: '❄ Cold' }, neutral: { bg: '#F3F4F6', text: '#6B7280', l: 'Neutral' },
  }
  const s = map[label] || { bg: '#F3F4F6', text: '#6B7280', l: label }
  return <span style={{ fontSize: 10, fontWeight: 700, color: s.text, background: s.bg, borderRadius: 99, padding: '3px 9px' }}>{s.l}</span>
}
function PreferencePill({ p }: { p: any }) {
  return (
    <span title={p.is_explicit ? 'Stated explicitly' : `Inferred (${Math.round((p.confidence || 0) * 100)}% confidence, ${p.sample_count}x)`}
      style={{ fontSize: 11, fontWeight: 600, color: p.is_explicit ? '#15803D' : '#92400E', background: p.is_explicit ? '#DCFCE7' : '#FEF9C3', borderRadius: 99, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {p.field.replace(/_/g, ' ')}: {p.value}{!p.is_explicit && <span style={{ fontSize: 8.5, opacity: 0.7 }}>~</span>}
    </span>
  )
}
function DncControl({ owner, onSaved, setMsg }: { owner: any; onSaved: () => void; setMsg: (s: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function toggle() {
    setBusy(true)
    try {
      const reason = owner.doNotContact ? null : (prompt('Reason (optional):') || 'agent request')
      await crmJson(`owners/${owner.id}`, 'PATCH', { do_not_contact: !owner.doNotContact, do_not_contact_reason: reason })
      setMsg(owner.doNotContact ? 'Contact re-enabled' : 'Marked do-not-contact')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Update failed') }
    finally { setBusy(false) }
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
      <div>
        <span style={{ fontSize: 12, color: DTEXT_DIM }}>Do not contact</span>
        {owner.doNotContactReason && <div style={{ fontSize: 10, color: '#B91C1C', marginTop: 2 }}>{owner.doNotContactReason}</div>}
      </div>
      <button onClick={toggle} disabled={busy} style={{ ...actBtnLight, color: owner.doNotContact ? '#EF4444' : DTEXT_FAINT, padding: '5px 11px', fontSize: 10.5 }}>
        {busy ? '…' : owner.doNotContact ? 'Re-enable contact' : 'Mark DNC'}
      </button>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// FLOWS — automation status
// ══════════════════════════════════════════════════════════════════════════
// ── Teil B, §8: 6 named flow types, described once as a reference legend
// (not raw DB states). "current" is computed per state row from the same
// signals the backend itself acts on — never a separate guess.
const FLOW_TYPES = [
  { key: 'available', icon: '🏠', title: 'Available Flow', desc: 'Active listing — checks in every 4-6 days, updates the exact property from the reply, reschedules automatically.' },
  { key: 'upcoming', icon: '👋', title: 'Upcoming Inventory Check', desc: 'No active listing — a warm relationship check-in every 21-28 days ("anything coming available?").' },
  { key: 'future', icon: '📅', title: 'Future Availability', desc: 'Owner named a date — next contact is planned around it instead of the generic rhythm.' },
  { key: 'human', icon: '🧑‍💬', title: 'Human Conversation Active', desc: 'A person is talking to this owner directly — automation stands down and resumes on its own afterwards.' },
  { key: 'blocked', icon: '🚫', title: 'Do Not Contact', desc: 'No automated outreach of any kind. Reactivation must be explicit.' },
  { key: 'priceflex', icon: '💬', title: 'Price Flexibility Follow-up', desc: 'A one-time, context-aware question about price flexibility — not a recurring flow.' },
]
function currentFlowKey(s: any, owner: any, hasActiveListing: boolean) {
  if (owner.doNotContact) return 'blocked'
  if (s.status === 'HUMAN_ACTIVE') return 'human'
  if (owner.nextReachAt && new Date(owner.nextReachAt).getTime() > Date.now()) return 'future'
  if (!s.enabled) return null
  return hasActiveListing ? 'available' : 'upcoming'
}
function humanStatus(s: any, owner: any) {
  if (owner.doNotContact) return { text: 'Blocked — do not contact', tone: '#B91C1C', bg: '#FEE2E2' }
  if (!s.enabled) return { text: 'Off', tone: '#6B7280', bg: '#F3F4F6' }
  if (s.status === 'HUMAN_ACTIVE') return { text: 'Human conversation active — automation will resume afterwards', tone: '#92400E', bg: '#FFFBEB' }
  if (s.status === 'PAUSED') return { text: 'Paused (viewing reminder armed)', tone: '#92400E', bg: '#FFFBEB' }
  return { text: 'Active', tone: '#15803D', bg: '#DCFCE7' }
}

function FlowsPanel({ d, ownerId, onSaved, setMsg, onGoto }: { d: any; ownerId: number; onSaved: () => void; setMsg: (s: string) => void; onGoto: (t: TabKey) => void }) {
  const states = d.automation?.states || []
  const campaigns = d.automation?.campaigns || []
  const hasActiveListing = (d.properties || []).some((p: any) => propertyStatus(p).key === 'available')
  const [starting, setStarting] = useState(false)
  const primaryState = states[0] || null
  const humanActiveState = states.find((s: any) => s.status === 'HUMAN_ACTIVE') || null

  async function startAutomation() {
    setStarting(true)
    try {
      const r = await crmJson(`owners/${ownerId}/automation/start`, 'POST', {})
      if (r.ok === false) { setMsg(r.error || 'Could not start automation'); return }
      setMsg('Automation started')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Could not start automation') }
    finally { setStarting(false) }
  }
  async function toggleDnc() {
    try {
      const reason = d.owner.doNotContact ? null : (prompt('Reason (optional):') || 'agent request')
      await crmJson(`owners/${ownerId}`, 'PATCH', { do_not_contact: !d.owner.doNotContact, do_not_contact_reason: reason })
      setMsg(d.owner.doNotContact ? 'Contact re-enabled' : 'Marked do-not-contact')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Update failed') }
  }
  async function resumeNow() {
    if (!humanActiveState) return
    try {
      await crmJson(`ownergroups/${humanActiveState.id}/resume`, 'POST', {})
      setMsg('Resumed')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Resume failed') }
  }
  async function setFutureContact() {
    const current = d.owner.nextReachAt ? String(d.owner.nextReachAt).slice(0, 10) : ''
    const input = prompt('Next planned contact date (YYYY-MM-DD), blank to clear:', current)
    if (input === null) return
    try {
      await crmJson(`owners/${ownerId}`, 'PATCH', { next_reach_at: input.trim() || null })
      setMsg(input.trim() ? 'Future contact date set' : 'Future contact cleared')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Update failed') }
  }
  async function askPriceFlex() {
    if (!primaryState) { setMsg('Start automation first'); return }
    try {
      await crmJson(`ownergroups/${primaryState.id}/price-flex-followup`, 'POST', {})
      setMsg('Price-flex follow-up sent')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Send failed') }
  }
  function onCardClick(key: string) {
    if (key === 'blocked') return toggleDnc()
    if (key === 'human') return humanActiveState ? resumeNow() : undefined
    if (key === 'future') return setFutureContact()
    if (key === 'priceflex') return askPriceFlex()
    if (key === 'available' || key === 'upcoming') return onGoto('properties')
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 8, marginBottom: 18 }}>
        {FLOW_TYPES.map(f => {
          const active = states.some((s: any) => currentFlowKey(s, d.owner, hasActiveListing) === f.key)
          const clickHint = { blocked: d.owner.doNotContact ? 'Click to re-enable contact' : 'Click to mark do-not-contact',
            human: humanActiveState ? 'Click to resume now' : null, future: 'Click to set/clear a date',
            priceflex: primaryState ? 'Click to send now' : null, available: 'Click to view properties', upcoming: 'Click to view properties' }[f.key]
          return (
            <div key={f.key} onClick={() => onCardClick(f.key)}
              style={{ background: active ? AD : DCARD, border: `1px solid ${active ? AB : HAIRLINE}`, borderRadius: 12, padding: '11px 13px', cursor: 'pointer', transition: 'box-shadow .15s' }}>
              <div style={{ fontSize: 16 }}>{f.icon}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: active ? A : INK, marginTop: 4 }}>{f.title}</div>
              <div style={{ fontSize: 9.5, color: MUTED, marginTop: 3, lineHeight: 1.4 }}>{f.desc}</div>
              {active && <div style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--crm-accent)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>● Active now</div>}
              {clickHint && <div style={{ fontSize: 8.5, color: 'var(--crm-accent)', marginTop: 5, fontWeight: 600 }}>→ {clickHint}</div>}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        <div style={CARD}>
          <div style={HEAD}>`!o` automation state{states.length !== 1 ? 's' : ''}</div>
          {!states.length && (
            <>
              <EmptyRow text="This owner has never been armed with !o — no automated check-in loop is running." />
              <button onClick={startAutomation} disabled={starting} style={{ ...actBtnDark, marginTop: 8 }}>{starting ? 'Starting…' : '▶ Start automation'}</button>
            </>
          )}
          {states.map((s: any) => <FlowStateRow key={s.id} s={s} owner={d.owner} onSaved={onSaved} setMsg={setMsg} />)}
        </div>
        <div style={CARD}>
          <div style={HEAD}>Scheduled outreach campaigns</div>
          {!campaigns.length && <EmptyRow text="Nothing scheduled." />}
          {campaigns.map((c: any) => (
            <div key={c.id} style={{ padding: '9px 0', borderBottom: `1px solid ${HAIRLINE}`, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 700, color: INK }}>{c.kind || c.type || 'campaign'}</span>
                <span style={{ color: MUTED, fontSize: 10.5 }}>{c.status}</span>
              </div>
              {c.scheduled_for && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>{fmtDate(c.scheduled_for)}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// One state row: humanized status line (never a raw enum), rhythm editor,
// and every action routes/crmOwnergroups.js already exposes — enable/
// disable/resume/price-flex-followup — called by state id, the exact same
// mutation the `!o` WhatsApp command and the CRM share (Teil B §10).
function FlowStateRow({ s, owner, onSaved, setMsg }: { s: any; owner: any; onSaved: () => void; setMsg: (s: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [minD, setMinD] = useState(s.checkin_min_days ?? '')
  const [maxD, setMaxD] = useState(s.checkin_max_days ?? '')
  const status = humanStatus(s, owner)

  async function act(action: string, path: string, body: any = {}) {
    setBusy(action)
    try {
      const r = await crmJson(`ownergroups/${s.id}/${path}`, 'POST', body)
      if (r && r.ok === false) { setMsg(r.error || `${action} failed`); return }
      setMsg(`${action} done`)
      onSaved()
    } catch (e: any) { setMsg(e?.message || `${action} failed`) }
    finally { setBusy(null) }
  }
  async function saveRhythm() {
    setBusy('rhythm')
    try {
      await crmJson(`ownergroups/${s.id}/rhythm`, 'POST', { minDays: minD === '' ? null : Number(minD), maxDays: maxD === '' ? null : Number(maxD) })
      setMsg('Rhythm updated')
      onSaved()
    } catch (e: any) { setMsg(e?.message || 'Rhythm update failed') }
    finally { setBusy(null) }
  }

  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${HAIRLINE}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: INK, fontFamily: FM }}>{s.session}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: status.tone, background: status.bg, borderRadius: 99, padding: '3px 9px' }}>{status.text}</span>
      </div>
      {s.last_action && <MiniFact label="Last action" value={`${s.last_action}${s.last_action_at ? ` · ${daysAgo(s.last_action_at)}` : ''}`} />}
      {owner.nextReachAt && <MiniFact label="Next contact planned" value={fmtDate(owner.nextReachAt) || '—'} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9 }}>
        <span style={{ fontSize: 10, color: MUTED }}>Rhythm (days)</span>
        <input value={minD} onChange={e => setMinD(e.target.value)} placeholder="min" type="number" style={{ ...editInp, width: 52, padding: '5px 7px' }} />
        <span style={{ fontSize: 10, color: MUTED }}>–</span>
        <input value={maxD} onChange={e => setMaxD(e.target.value)} placeholder="max" type="number" style={{ ...editInp, width: 52, padding: '5px 7px' }} />
        <MiniBtn onClick={saveRhythm} busy={busy === 'rhythm'}>Save</MiniBtn>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 }}>
        {s.enabled
          ? <MiniBtn onClick={() => act('Stop', 'disable')} busy={busy === 'Stop'} tone="muted">■ Stop</MiniBtn>
          : <MiniBtn onClick={() => act('Start', 'enable')} busy={busy === 'Start'}>▶ Start</MiniBtn>}
        {s.status === 'HUMAN_ACTIVE' && <MiniBtn onClick={() => act('Resume', 'resume')} busy={busy === 'Resume'}>⏭ Resume now</MiniBtn>}
        <MiniBtn onClick={() => act('Price-flex follow-up', 'price-flex-followup')} busy={busy === 'Price-flex follow-up'} tone="muted">💬 Ask about price flexibility</MiniBtn>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// DOCUMENTS — the real vault
// ══════════════════════════════════════════════════════════════════════════
const DOC_CATEGORIES = [
  { key: 'invoice', label: 'Invoices' }, { key: 'contract', label: 'Contracts' },
  { key: 'owner_document', label: 'Owner Documents' }, { key: 'property_document', label: 'Property Documents' },
  { key: 'agreement', label: 'Agreements' }, { key: 'other', label: 'Other' },
]
function DocumentsPanel({ ownerId, documents, properties, onSaved, me }: { ownerId: number; documents: any[]; properties: any[]; onSaved: () => void; me: any }) {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [category, setCategory] = useState('other')
  const [propertyId, setPropertyId] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function doUpload(files: FileList | null) {
    if (!files || !files.length) return
    setUploading(true)
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('files', f))
      fd.append('category', category)
      if (propertyId) fd.append('property_id', propertyId)
      const res = await fetch(`/api/crm/owners/${ownerId}/documents`, { method: 'POST', credentials: 'same-origin', body: fd })
      if (!res.ok) throw new Error('Upload failed')
      onSaved()
    } catch (e) { alert('Upload failed') }
    finally { setUploading(false) }
  }
  async function del(docId: number) {
    if (!confirm('Delete this document?')) return
    await crmFetch(`owners/${ownerId}/documents/${docId}`, { method: 'DELETE' }).catch(() => {})
    onSaved()
  }
  async function getLink() {
    const r = await crmFetch(`owners/${ownerId}/upload-link`).catch(() => null)
    setLink(r?.path ? `${window.location.origin}${r.path}` : null)
  }

  const grouped: Record<string, any[]> = {}
  for (const cat of DOC_CATEGORIES) grouped[cat.key] = []
  for (const doc of documents) grouped[doc.category || 'other']?.push(doc) || (grouped.other = [...(grouped.other || []), doc])

  return (
    <div>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); doUpload(e.dataTransfer.files) }}
        style={{ ...CARD, border: `2px dashed ${dragging ? A : DCARD_BORDER}`, background: dragging ? AD : DCARD, textAlign: 'center', padding: 28, marginBottom: 18, cursor: 'pointer' }}
        onClick={() => fileInput.current?.click()}
      >
        <input ref={fileInput} type="file" multiple hidden onChange={e => doUpload(e.target.files)} />
        <div style={{ fontSize: 26 }}>📁</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginTop: 6 }}>{uploading ? 'Uploading…' : 'Drag & drop files, or click to browse'}</div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>PDF, images, any file · up to 20MB each</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
          <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...editInp, width: 160 }}>
            {DOC_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <select value={propertyId} onChange={e => setPropertyId(e.target.value)} style={{ ...editInp, width: 150 }}>
            <option value="">No specific property</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.ref}</option>)}
          </select>
          <button onClick={getLink} style={actBtnLight}>🔗 Owner self-upload link</button>
        </div>
        {link && (
          <div onClick={e => e.stopPropagation()} style={{ marginTop: 10, fontSize: 11, fontFamily: FM, color: 'var(--crm-accent)', background: AD, borderRadius: 8, padding: '8px 12px', wordBreak: 'break-all' }}>{link}</div>
        )}
      </div>

      {DOC_CATEGORIES.map(cat => grouped[cat.key]?.length ? (
        <div key={cat.key} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: DTEXT_FAINT, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{cat.label} ({grouped[cat.key].length})</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 10 }}>
            {grouped[cat.key].map((doc: any) => (
              <div key={doc.id} style={{ ...CARD, padding: '12px 14px' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {doc.filename}</div>
                <div style={{ fontSize: 10.5, color: MUTED, marginTop: 3 }}>
                  {doc.uploaded_by === 'owner-self' ? 'Uploaded by owner' : `by ${doc.uploaded_by}`} · {fmtDate(doc.created_at)}
                  {doc.property_ref && ` · #${doc.property_ref}`}
                </div>
                {doc.notes && <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginTop: 4, fontStyle: 'italic' }}>{doc.notes}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                  <a href={doc.url} target="_blank" rel="noreferrer" style={{ ...linkBtn }}>View</a>
                  <a href={doc.url} download style={{ ...linkBtn }}>Download</a>
                  <span onClick={() => del(doc.id)} style={{ ...linkBtn, color: '#B91C1C' }}>Delete</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null)}
      {!documents.length && <div style={{ ...CARD, textAlign: 'center', color: DTEXT_FAINT, padding: 30 }}>No documents yet — the vault is ready for the first one.</div>}
    </div>
  )
}
const linkBtn: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--crm-accent)', cursor: 'pointer', textDecoration: 'none' }

// ══════════════════════════════════════════════════════════════════════════
// HISTORY — merged timeline
// ══════════════════════════════════════════════════════════════════════════
function HistoryPanel({ history }: { history: any[] }) {
  return (
    <div style={CARD}>
      <div style={HEAD}>Timeline ({history.length})</div>
      {!history.length && <EmptyRow text="No activity logged yet." />}
      {history.map((h, i) => <HistoryRow key={i} h={h} />)}
    </div>
  )
}
function HistoryRow({ h }: { h: any }) {
  const router = useRouter()
  const label = h.kind === 'automation'
    ? String(h.label || '').replace(/_/g, ' ')
    : describe({ type: h.label, details: h.detail, when: h.at, who: h.agent, significant: h.significant })
  const tag = h.kind === 'automation' ? '⚙' : (h.propertyRef || 'owner')
  const linkable = h.kind === 'property' && !!h.propertyId
  return (
    <div style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: `1px solid ${HAIRLINE}`, fontSize: 11.5, alignItems: 'flex-start' }}>
      <span style={{ fontFamily: FM, fontSize: 9.5, color: DTEXT_FAINT, minWidth: 92, flexShrink: 0 }}>{fmtDate(h.at)}</span>
      <span
        onClick={linkable ? () => router.push(`/crm/property/${h.propertyId}`) : undefined}
        title={linkable ? `Open #${h.propertyRef}` : undefined}
        style={{
          background: h.kind === 'automation' ? 'rgba(27,42,74,0.08)' : AD, border: `1px solid ${h.kind === 'automation' ? 'rgba(27,42,74,0.18)' : AB}`,
          color: h.kind === 'automation' ? NAVY : A, borderRadius: 4, padding: '1px 6px', fontSize: 9.5, fontWeight: 700, flexShrink: 0,
          cursor: linkable ? 'pointer' : 'default', textDecoration: linkable ? 'underline' : 'none',
        }}
      >
        {tag}
      </span>
      <span style={{ color: DTEXT_DIM }}>{label}</span>
    </div>
  )
}
