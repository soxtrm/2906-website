'use client'
// ============================================================================
// /crm/agent-profile — ARGUS AGENT LAYER, "First Deliverable" (Kev,
// 2026-09-16 spec section 26). One operating identity page: Agent = CRM
// user + profile + WhatsApp identity + Notification Group + Outreach
// Workspace + Property Feeds, per the spec's own core concept.
//
// Backend already live: /api/crm/agent-profile/:id (aggregate GET/PATCH),
// /:id/invoices, /:id/contracts, and /api/crm/notification-engine/*. This
// page is real data end to end -- no fake parallel store, per spec.
//
// Scope note (spec section 27, "second delivery"): WA self-serve QR
// connect, CREATE NEW GROUP via waha.createGroup(), the full outreach
// workspace (drafts/arm/schedule), and scheduled-message pre-send recheck
// are NOT wired here yet -- this is the profile shell + real-data widgets
// the spec's own "First Deliverable" asks for first.
// ============================================================================
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { CrmProvider, CrmShell, useCrm, DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, A, AD, F } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'
// Dynamically imported inside buildInvoicePdf() instead of a static top-level
// import: jspdf pulls in fflate's Node build (a dynamic Worker() require)
// which Turbopack cannot resolve while SSR-ing this 'use client' page's
// initial HTML — even though jsPDF itself only ever runs in the browser,
// inside an onClick handler. A dynamic import() is only evaluated at call
// time, so it never enters the SSR bundle at all.

const DPAGE = '#0B0F17'
const DCARD2 = '#0F1521'

// Kev, 2026-09-17 ("das watermark oben links von 2906 also das logo, clean
// und edel"): client-facing documents (invoice/contract) carry the 2906
// brand mark, not the internal ARGUS wordmark — same split already applied
// between crm.2906.estate (ARGUS) and 2906.estate (2906 logo). Fetched once
// and cached as a data URI so jsPDF's addImage() can embed it directly.
let logoDataUriPromise: Promise<{ uri: string; ratio: number }> | null = null
function loadLogoDataUri(): Promise<{ uri: string; ratio: number }> {
  if (!logoDataUriPromise) {
    logoDataUriPromise = (async () => {
      const buf = await fetch('/logo-transparent.png').then(r => r.arrayBuffer())
      let binary = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const uri = `data:image/png;base64,${btoa(binary)}`
      const ratio = await new Promise<number>(resolve => {
        const img = new Image()
        img.onload = () => resolve(img.naturalWidth / img.naturalHeight)
        img.onerror = () => resolve(3)
        img.src = uri
      })
      return { uri, ratio }
    })()
  }
  return logoDataUriPromise
}

type Agent = {
  id: number; username: string; name: string; display_name: string | null; surname: string | null
  email: string | null; whatsapp_phone: string | null; public_phone: string | null; address: string | null
  vat_number: string | null; company_number: string | null; bank_iban: string | null; bank_account_name: string | null
  profile_image_url: string | null; bio: string | null; languages: string[]; specialties: string[]
  role: string; active: boolean; whatsapp_session: string | null
  feature_entitlements: Record<string, string>; invoice_settings: any; contract_settings: any
}
type SavedSearch = {
  id: number; name: string; filters: any; enabled: boolean
  delivery_intensity: string; match_quality: string; matches_today: string
}
type Invoice = { id: number; invoice_number: string | null; client_or_owner_name: string | null; property_ref: string | null; deal_ref: string | null; invoice_date: string; status: string; line_items: { description: string; price: number }[]; vat_enabled: boolean; vat_rate: number }
type ContractRow = { id: number; property_ref: string | null; owner_name: string | null; tenant_name: string | null; start_date: string | null; end_date: string | null; status: string }
type Bundle = {
  agent: Agent
  whatsapp: { status: string; session: string | null; phone?: string | null; qr?: string }
  notificationEngine: { searches: SavedSearch[]; channel: any }
  propertyFeeds: { my_active_listings: string; my_total_listings: string }
  outreach: { status: string; n: string }[]
  activity: { action_type: string; target_ref: string | null; details: any; created_at: string }[]
  invoices: Invoice[]
  contracts: ContractRow[]
}

const FEATURES: { key: string; label: string; desc: string }[] = [
  { key: 'outreach_engine', label: 'Outreach Engine', desc: 'Personal WhatsApp outreach, scheduling, dedup.' },
  { key: 'upload_engine', label: 'Owner / Property Upload', desc: 'Turn a WhatsApp message into a canonical listing.' },
  { key: 'distribution', label: 'Property Sharing / Distribution', desc: 'Swipe links, group posting.' },
  { key: 'notification_engine', label: 'Notification Engine', desc: 'Saved searches, automatic WhatsApp feed.' },
  { key: 'match_engine', label: 'Match Engine', desc: 'ARGUS decides who a property is actually for.' },
  { key: 'agent_dashboard', label: 'Agent Dashboard', desc: 'Owner conversations, tasks, calendar.' },
  { key: 'property_feeds', label: 'Property Feeds', desc: 'My Listings / My Matches, always current.' },
  { key: 'scheduled_messages', label: 'Scheduled Messages', desc: 'Prepare tonight, ARGUS sends tomorrow.' },
]
function featureStatus(entitlements: Record<string, string> | undefined, key: string): string {
  return (entitlements && entitlements[key]) || 'coming_soon'
}
const FEATURE_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  active: { bg: 'rgba(62,207,142,0.14)', fg: '#3ECF8E', label: 'ACTIVE' },
  available: { bg: 'rgba(79,123,242,0.14)', fg: '#7EA0FF', label: 'AVAILABLE' },
  coming_soon: { bg: 'rgba(255,255,255,0.06)', fg: DTEXT_FAINT, label: 'COMING SOON' },
  admin_required: { bg: 'rgba(242,165,61,0.14)', fg: '#F2A53D', label: 'ADMIN REQUIRED' },
}
const WA_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  CONNECTED: { bg: 'rgba(62,207,142,0.14)', fg: '#3ECF8E', label: 'Connected' },
  CONNECTING: { bg: 'rgba(242,165,61,0.14)', fg: '#F2A53D', label: 'Connecting' },
  QR_REQUIRED: { bg: 'rgba(242,165,61,0.14)', fg: '#F2A53D', label: 'QR required' },
  OFFLINE: { bg: 'rgba(255,255,255,0.06)', fg: DTEXT_FAINT, label: 'Offline' },
  ERROR: { bg: 'rgba(242,89,122,0.14)', fg: '#F2597A', label: 'Error' },
}

function Badge({ bg, fg, label }: { bg: string; fg: string; label: string }) {
  return <span style={{ background: bg, color: fg, fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, letterSpacing: '0.02em' }}>{label}</span>
}

function SectionCard({ id, title, icon, children, right }: { id?: string; title: string; icon?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div id={id} style={{
      background: `linear-gradient(180deg, ${DCARD} 0%, #10182A 100%)`, border: `1px solid ${DCARD_BORDER}`,
      borderRadius: 14, padding: '18px 20px', marginBottom: 16, position: 'relative', overflow: 'hidden',
      boxShadow: '0 12px 32px -18px rgba(0,0,0,0.55)',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 20, right: 20, height: 1, background: 'linear-gradient(90deg, transparent, rgba(184,149,63,0.35), transparent)' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 700, color: DTEXT }}>
          {icon && <span style={{
            width: 26, height: 26, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, background: AD, boxShadow: '0 0 14px -4px rgba(184,149,63,0.5)',
          }}>{icon}</span>}{title}
        </div>
        {right}
      </div>
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  )
}

function inputStyle(): React.CSSProperties {
  return { background: DPAGE, border: `1px solid ${DBORDER}`, borderRadius: 8, padding: '9px 11px', fontSize: 12.5, color: DTEXT, fontFamily: F, outline: 'none', width: '100%' }
}
function btnPrimary(): React.CSSProperties {
  return { background: A, color: '#151C2C', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 12, fontWeight: 700, fontFamily: F, cursor: 'pointer' }
}
function btnGhost(): React.CSSProperties {
  return { background: 'transparent', border: `1px solid ${DBORDER}`, color: DTEXT_DIM, borderRadius: 8, padding: '7px 13px', fontSize: 11.5, fontWeight: 700, fontFamily: F, cursor: 'pointer' }
}

function AgentProfilePage() {
  const { me } = useCrm()
  const params = useSearchParams()
  const overrideId = params.get('agent_id')
  const agentId = overrideId ? Number(overrideId) : me?.id
  const isSelf = !overrideId || Number(overrideId) === me?.id

  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [ibanRevealed, setIbanRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState<Partial<Agent>>({})
  const [saveBusy, setSaveBusy] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)

  const load = useCallback(async () => {
    if (!agentId) return
    try {
      const d = await crmFetch(`agent-profile/${agentId}`)
      setBundle(d); setErr(null)
    } catch (e: any) { setErr(e?.message || 'Could not load this profile') }
    finally { setLoading(false) }
  }, [agentId])

  useEffect(() => { load() }, [load])

  async function saveProfile() {
    if (!agentId) return
    setSaveBusy(true)
    try {
      await crmJson(`agent-profile/${agentId}`, 'PATCH', editDraft)
      setEditing(false); setEditDraft({})
      await load()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not save') }
    finally { setSaveBusy(false) }
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !agentId) return
    setPhotoBusy(true)
    try {
      const fd = new FormData()
      fd.append('photo', file)
      await crmFetch(`agent-profile/${agentId}/photo`, { method: 'POST', body: fd })
      await load()
    } catch (err: any) { alert(err?.data?.error || err?.message || 'Could not upload photo') }
    finally { setPhotoBusy(false) }
  }

  const canSeeFull = me?.role === 'admin' || isSelf
  const a = bundle?.agent

  const maskedIban = useMemo(() => {
    if (!a?.bank_iban) return null
    if (ibanRevealed) return a.bank_iban
    return a.bank_iban.replace(/^(.{4}).+(.{4})$/, '$1 **** **** **** $2')
  }, [a?.bank_iban, ibanRevealed])

  if (loading) return <div style={{ padding: 40, color: DTEXT_DIM }}>Loading profile…</div>
  if (err || !bundle || !a) return <div style={{ padding: 40, color: '#F2597A' }}>{err || 'Profile not found'}</div>

  return (
    <div style={{ background: DPAGE, minHeight: '100%', padding: '20px 18px 60px', color: DTEXT, fontFamily: F }}>
      <style>{`
        .agent-tool-card > div:hover {
          transform: translateY(-2px);
          border-color: rgba(184,149,63,0.5) !important;
          box-shadow: 0 16px 34px -16px rgba(184,149,63,0.25) !important;
        }
      `}</style>
      {/* ── Identity card ─────────────────────────────────────────────── */}
      <div style={{
        background: `linear-gradient(160deg, #172038 0%, ${DCARD2} 65%, #0A0D14 100%)`,
        border: `1px solid ${DCARD_BORDER}`, borderTop: `1px solid rgba(184,149,63,0.45)`,
        borderRadius: 16, padding: '24px 22px 22px', marginBottom: 18, position: 'relative', overflow: 'hidden',
        boxShadow: '0 20px 60px -20px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)',
      }}>
        {/* Dual-tone brand glow — gold (identity/warmth) top-right, electric
            blue (system/tech) bottom-left, per "das soll super modern
            aussehen" — echoes the mockup's own gold radial without being flat. */}
        <div style={{ position: 'absolute', top: -80, right: -80, width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(184,149,63,0.22), transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: -100, left: -60, width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(79,123,242,0.16), transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'linear-gradient(90deg, transparent, rgba(184,149,63,0.6), transparent)' }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', position: 'relative' }}>
          <label style={{
            width: 78, height: 78, borderRadius: '50%', flexShrink: 0, position: 'relative', cursor: canSeeFull ? 'pointer' : 'default',
            background: a.profile_image_url ? `url(${a.profile_image_url}) center/cover` : 'linear-gradient(135deg, rgba(184,149,63,0.4), rgba(79,123,242,0.4))',
            border: `2px solid ${A}`, boxShadow: '0 0 0 4px rgba(184,149,63,0.10), 0 8px 24px -6px rgba(184,149,63,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 700,
          }}>
            {!a.profile_image_url && (a.name || a.username || '?').charAt(0).toUpperCase()}
            {canSeeFull && (
              <>
                <div style={{
                  position: 'absolute', bottom: -2, right: -2, width: 24, height: 24, borderRadius: '50%',
                  background: A, color: '#151C2C', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, border: `2px solid ${DCARD}`,
                }} title="Change photo">{photoBusy ? '…' : '✎'}</div>
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickPhoto} />
              </>
            )}
          </label>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 19, fontWeight: 800 }}>{a.name}{a.surname ? ` ${a.surname}` : ''}</div>
              <Badge bg={a.active ? 'rgba(62,207,142,0.14)' : 'rgba(242,89,122,0.14)'} fg={a.active ? '#3ECF8E' : '#F2597A'} label={a.active ? 'Active' : 'Suspended'} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: DTEXT_FAINT, letterSpacing: '0.04em' }}>{a.role.toUpperCase()}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '6px 20px', marginTop: 12, fontSize: 12 }}>
              {a.email && <div style={{ color: DTEXT_DIM }}>✉ {a.email}</div>}
              {(a.whatsapp_phone || a.public_phone) && <div style={{ color: DTEXT_DIM }}>☏ {a.whatsapp_phone || a.public_phone}</div>}
              {a.address && <div style={{ color: DTEXT_DIM }}>⌂ {a.address}</div>}
              {a.vat_number && <div style={{ color: DTEXT_DIM }}>VAT {a.vat_number}</div>}
              {a.company_number && <div style={{ color: DTEXT_DIM }}>Co. Nr {a.company_number}</div>}
              {a.bank_iban && (
                <div style={{ color: DTEXT_DIM, display: 'flex', alignItems: 'center', gap: 6 }}>
                  🏦 {maskedIban}
                  <span onClick={() => setIbanRevealed(v => !v)} style={{ cursor: 'pointer', color: A, fontSize: 11 }}>{ibanRevealed ? 'hide' : 'reveal'}</span>
                  <span onClick={() => navigator.clipboard?.writeText(a.bank_iban || '')} style={{ cursor: 'pointer', color: DTEXT_FAINT, fontSize: 11 }}>copy</span>
                </div>
              )}
            </div>
          </div>
          <button onClick={() => { setEditing(true); setEditDraft({}) }} style={btnGhost()}>✎ Edit Profile</button>
        </div>
      </div>

      {editing && (
        <SectionCard title="Edit Profile" icon="✎">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
            <input placeholder="First name" defaultValue={a.name || ''} onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} style={inputStyle()} />
            <input placeholder="Surname" defaultValue={a.surname || ''} onChange={e => setEditDraft(d => ({ ...d, surname: e.target.value }))} style={inputStyle()} />
            <input placeholder="Email" defaultValue={a.email || ''} onChange={e => setEditDraft(d => ({ ...d, email: e.target.value }))} style={inputStyle()} />
            <input placeholder="Phone" defaultValue={a.whatsapp_phone || ''} onChange={e => setEditDraft(d => ({ ...d, whatsapp_phone: e.target.value }))} style={inputStyle()} />
            <input placeholder="Address" defaultValue={a.address || ''} onChange={e => setEditDraft(d => ({ ...d, address: e.target.value }))} style={{ ...inputStyle(), gridColumn: 'span 2' }} />
            {me?.role === 'admin' && <>
              <input placeholder="VAT number" defaultValue={a.vat_number || ''} onChange={e => setEditDraft(d => ({ ...d, vat_number: e.target.value }))} style={inputStyle()} />
              <input placeholder="Company number" defaultValue={a.company_number || ''} onChange={e => setEditDraft(d => ({ ...d, company_number: e.target.value }))} style={inputStyle()} />
              <input placeholder="IBAN" defaultValue={a.bank_iban || ''} onChange={e => setEditDraft(d => ({ ...d, bank_iban: e.target.value }))} style={inputStyle()} />
              <input placeholder="Bank account name" defaultValue={a.bank_account_name || ''} onChange={e => setEditDraft(d => ({ ...d, bank_account_name: e.target.value }))} style={inputStyle()} />
            </>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button onClick={saveProfile} disabled={saveBusy} style={btnPrimary()}>{saveBusy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} style={btnGhost()}>Cancel</button>
          </div>
        </SectionCard>
      )}

      {/* ── Quick tool cards ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 18 }}>
        {[
          { href: '#invoice', icon: '🧾', label: 'Invoice Creator', desc: 'Create professional invoices in seconds.' },
          { href: '#contract', icon: '📄', label: 'Contract Creator', desc: 'Generate rental contracts quickly.' },
          { href: '#features', icon: '⬡', label: 'Be Part of ARGUS', desc: 'Explore all tools available to you.' },
          { href: '/schedule-board', icon: '📊', label: 'Agent Dashboard', desc: 'Open your personal dashboard.', external: true },
        ].map(c => (
          <a key={c.label} href={c.href} className="agent-tool-card" style={{ textDecoration: 'none' }}>
            <div style={{
              background: `linear-gradient(155deg, ${DCARD} 0%, #0F1521 100%)`, border: `1px solid ${DCARD_BORDER}`,
              borderRadius: 12, padding: '16px 16px', cursor: 'pointer', height: '100%', position: 'relative', overflow: 'hidden',
              boxShadow: '0 10px 26px -16px rgba(0,0,0,0.6)', transition: 'transform .15s, box-shadow .15s, border-color .15s',
            }}>
              <div style={{ position: 'absolute', top: -30, right: -30, width: 100, height: 100, borderRadius: '50%', background: 'radial-gradient(circle, rgba(184,149,63,0.16), transparent 70%)', pointerEvents: 'none' }} />
              <div style={{
                width: 36, height: 36, borderRadius: 9, background: `linear-gradient(135deg, ${AD}, rgba(79,123,242,0.12))`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, marginBottom: 10,
                boxShadow: '0 0 16px -4px rgba(184,149,63,0.45)', position: 'relative',
              }}>{c.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: DTEXT, position: 'relative' }}>{c.label}</div>
              <div style={{ fontSize: 11, color: DTEXT_FAINT, marginTop: 3, position: 'relative' }}>{c.desc}</div>
            </div>
          </a>
        ))}
      </div>

      {/* ── WhatsApp connection ──────────────────────────────────────────── */}
      <WhatsAppConnectionPanel agentId={agentId!} whatsapp={bundle.whatsapp} canSeeFull={canSeeFull} onChange={load} />

      {/* ── Notification Engine ──────────────────────────────────────────── */}
      <NotificationEnginePanel agentId={agentId!} bundle={bundle} onChange={load} />

      {/* ── My Property Feeds ────────────────────────────────────────────── */}
      <SectionCard title="My Property Feeds" icon="🏠">
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Stat label="Active Listings" value={bundle.propertyFeeds.my_active_listings} />
          <Stat label="Total Listings" value={bundle.propertyFeeds.my_total_listings} />
        </div>
      </SectionCard>

      {/* ── Personal Outreach ────────────────────────────────────────────── */}
      <SectionCard title="Personal Outreach" icon="🛰">
        {bundle.outreach.length === 0
          ? <div style={{ fontSize: 12, color: DTEXT_FAINT }}>No outreach campaigns yet.</div>
          : <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {bundle.outreach.map(o => <Stat key={o.status} label={o.status} value={o.n} />)}
            </div>}
        <div style={{ marginTop: 10, fontSize: 11, color: DTEXT_FAINT }}>Full outreach workspace (draft / arm / schedule) is coming in the next pass.</div>
      </SectionCard>

      {/* ── Scheduled Messages ───────────────────────────────────────────── */}
      <ScheduledMessagesPanel agentId={agentId!} />

      {/* ── Invoice Creator ──────────────────────────────────────────────── */}
      <InvoiceCreator agentId={agentId!} agent={a} invoices={bundle.invoices} onCreated={load} />

      {/* ── Contract Creator ─────────────────────────────────────────────── */}
      <ContractCreator agentId={agentId!} agent={a} contracts={bundle.contracts} onCreated={load} />

      {/* ── Be Part of ARGUS ──────────────────────────────────────────────── */}
      <SectionCard id="features" title="Be Part of ARGUS" icon="⬡">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
          {FEATURES.map(f => {
            const status = featureStatus(a.feature_entitlements, f.key)
            const badge = FEATURE_BADGE[status] || FEATURE_BADGE.coming_soon
            return (
              <div key={f.key} style={{ background: DCARD2, border: `1px solid ${DBORDER}`, borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{f.label}</div>
                  <Badge {...badge} />
                </div>
                <div style={{ fontSize: 11, color: DTEXT_FAINT, marginTop: 4 }}>{f.desc}</div>
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* ── Recent Activity ──────────────────────────────────────────────── */}
      <SectionCard title="Recent Activity" icon="🕓">
        {bundle.activity.length === 0
          ? <div style={{ fontSize: 12, color: DTEXT_FAINT }}>No activity recorded yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bundle.activity.map((row, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: DTEXT_DIM, borderBottom: i < bundle.activity.length - 1 ? `1px solid ${DBORDER}` : 'none', paddingBottom: 7 }}>
                  <span>{row.action_type.replace(/_/g, ' ')}{row.target_ref ? ` · #${row.target_ref}` : ''}</span>
                  <span style={{ color: DTEXT_FAINT }}>{new Date(row.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>}
      </SectionCard>
    </div>
  )
}

// ARGUS Agent Layer, Second Delivery §1-5: self-serve QR connect. Polls the
// SAME status endpoint the aggregate profile load uses, refreshing the QR
// image each tick since WAHA's QR rotates/expires. RBAC is enforced
// server-side (assertScope in crmAgentProfile.js) -- `canSeeFull` here is
// only a display convenience, not the actual security boundary.
function WhatsAppConnectionPanel({ agentId, whatsapp, canSeeFull, onChange }: { agentId: number; whatsapp: Bundle['whatsapp']; canSeeFull: boolean; onChange: () => void }) {
  const [live, setLive] = useState(whatsapp)
  const [busy, setBusy] = useState(false)
  const [polling, setPolling] = useState(false)

  useEffect(() => { setLive(whatsapp) }, [whatsapp])

  useEffect(() => {
    if (!polling) return
    const t = setInterval(async () => {
      try {
        const d = await crmFetch(`agent-profile/${agentId}/whatsapp/status`)
        setLive(d)
        if (d.status === 'CONNECTED') { setPolling(false); onChange() }
      } catch { /* keep polling, transient network error */ }
    }, 3000)
    return () => clearInterval(t)
  }, [polling, agentId, onChange])

  async function connect() {
    setBusy(true)
    try {
      const d = await crmFetch(`agent-profile/${agentId}/whatsapp/connect`, { method: 'POST' })
      setLive(d)
      if (d.status !== 'CONNECTED') setPolling(true)
      else onChange()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not start WhatsApp connection') }
    finally { setBusy(false) }
  }

  async function disconnect() {
    if (!confirm('Disconnect this WhatsApp session?')) return
    setBusy(true)
    try {
      await crmJson(`agent-profile/${agentId}/whatsapp/disconnect`, 'POST', {})
      setPolling(false)
      onChange()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not disconnect') }
    finally { setBusy(false) }
  }

  return (
    <SectionCard title="WhatsApp Connection" icon="💬" right={<Badge {...(WA_BADGE[live.status] || WA_BADGE.OFFLINE)} />}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, color: DTEXT_DIM, marginBottom: 10 }}>
        <div>Session: <span style={{ color: DTEXT }}>{live.session || 'not assigned'}</span></div>
        {live.phone && <div>Number: <span style={{ color: DTEXT }}>{live.phone}</span></div>}
      </div>

      {canSeeFull && live.status !== 'CONNECTED' && !live.qr && (
        <button onClick={connect} disabled={busy} style={btnPrimary()}>{busy ? 'Starting…' : 'Connect WhatsApp'}</button>
      )}

      {live.qr && live.status !== 'CONNECTED' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 4 }}>
          <div style={{ fontSize: 11.5, color: DTEXT_DIM }}>Scan this QR with WhatsApp (Linked Devices → Link a Device):</div>
          <img src={live.qr} alt="WhatsApp QR" style={{ width: 180, height: 180, borderRadius: 10, border: `1px solid ${DBORDER}`, background: '#fff', padding: 6 }} />
          <button onClick={connect} disabled={busy} style={btnGhost()}>↻ Refresh QR</button>
        </div>
      )}

      {canSeeFull && live.status === 'CONNECTED' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={connect} disabled={busy} style={btnGhost()}>Reconnect</button>
          <button onClick={disconnect} disabled={busy} style={{ ...btnGhost(), color: '#F2597A' }}>Disconnect</button>
        </div>
      )}

      {!canSeeFull && (
        <div style={{ fontSize: 11, color: DTEXT_FAINT }}>Only this Agent (or an admin) can manage this connection.</div>
      )}
    </SectionCard>
  )
}

type ScheduledMsg = {
  id: number; recipient_phone: string; recipient_name: string | null; message_payload: string
  property_ref: string | null; scheduled_at: string; status: string; skip_reason: string | null
}
const SM_STATUS_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  SCHEDULED: { bg: 'rgba(79,123,242,0.14)', fg: '#7EA0FF', label: 'SCHEDULED' },
  SENT: { bg: 'rgba(62,207,142,0.14)', fg: '#3ECF8E', label: 'SENT' },
  SKIPPED: { bg: 'rgba(242,165,61,0.14)', fg: '#F2A53D', label: 'SKIPPED' },
  FAILED: { bg: 'rgba(242,89,122,0.14)', fg: '#F2597A', label: 'FAILED' },
  CANCELLED: { bg: 'rgba(255,255,255,0.06)', fg: DTEXT_FAINT, label: 'CANCELLED' },
}

// ARGUS Agent Layer, Second Delivery §14-20: a simple personal scheduling
// queue, NOT mass outreach. Every send (whether the cron tick fires it or
// the agent hits SEND NOW here) goes through services/scheduledMessages.js's
// mandatory pre-send recheck — this panel only ever displays the result.
function ScheduledMessagesPanel({ agentId }: { agentId: number }) {
  const [items, setItems] = useState<ScheduledMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(false)
  const [phone, setPhone] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [propertyRef, setPropertyRef] = useState('')
  const [message, setMessage] = useState('')
  const [when, setWhen] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setItems(await crmFetch(`scheduled-messages?agent_id=${agentId}`)) }
    catch { /* non-fatal for the profile page */ }
    finally { setLoading(false) }
  }, [agentId])

  useEffect(() => { load() }, [load])

  async function create() {
    if (!phone.trim() || !message.trim() || !when) return
    setBusy(true)
    try {
      await crmJson(`scheduled-messages?agent_id=${agentId}`, 'POST', {
        recipient_phone: phone.trim(), recipient_name: recipientName || null,
        property_ref: propertyRef || null, message_payload: message.trim(),
        scheduled_at: new Date(when).toISOString(),
      })
      setForm(false); setPhone(''); setRecipientName(''); setPropertyRef(''); setMessage(''); setWhen('')
      load()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not schedule message') }
    finally { setBusy(false) }
  }

  async function sendNow(id: number) {
    try {
      const r = await crmJson(`scheduled-messages/${id}/send-now?agent_id=${agentId}`, 'POST', {})
      if (r.skipped) alert(`Not sent — ${r.detail}`)
      load()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Send failed') }
  }
  async function cancel(id: number) {
    if (!confirm('Cancel this scheduled message?')) return
    await crmJson(`scheduled-messages/${id}?agent_id=${agentId}`, 'DELETE', {})
    load()
  }

  const pending = items.filter(i => ['SCHEDULED', 'DRAFT'].includes(i.status))
  const resolved = items.filter(i => !['SCHEDULED', 'DRAFT'].includes(i.status)).slice(0, 8)

  return (
    <SectionCard title="Scheduled Messages" icon="⏰" right={<button onClick={() => setForm(v => !v)} style={btnGhost()}>{form ? 'Cancel' : '+ Schedule Message'}</button>}>
      {form && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, marginBottom: 14, padding: 12, background: DCARD2, borderRadius: 10 }}>
          <input placeholder="Recipient phone" value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle()} />
          <input placeholder="Recipient name (optional)" value={recipientName} onChange={e => setRecipientName(e.target.value)} style={inputStyle()} />
          <input placeholder="Property REF (optional)" value={propertyRef} onChange={e => setPropertyRef(e.target.value)} style={inputStyle()} />
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={inputStyle()} />
          <textarea placeholder="Message" value={message} onChange={e => setMessage(e.target.value)} style={{ ...inputStyle(), gridColumn: 'span 2', minHeight: 50 }} />
          <button onClick={create} disabled={busy} style={btnPrimary()}>{busy ? 'Scheduling…' : 'Schedule'}</button>
        </div>
      )}
      {loading ? <div style={{ fontSize: 12, color: DTEXT_FAINT }}>Loading…</div> : (
        <>
          {pending.length === 0
            ? <div style={{ fontSize: 12, color: DTEXT_FAINT }}>Nothing scheduled.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: resolved.length ? 14 : 0 }}>
                {pending.map(m => (
                  <div key={m.id} style={{ background: DCARD2, border: `1px solid ${DBORDER}`, borderRadius: 10, padding: '10px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{m.recipient_name || m.recipient_phone}{m.property_ref ? ` · #${m.property_ref}` : ''}</div>
                        <div style={{ fontSize: 11, color: DTEXT_DIM, marginTop: 3 }}>{m.message_payload}</div>
                        <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginTop: 3 }}>{new Date(m.scheduled_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button onClick={() => sendNow(m.id)} style={btnGhost()}>Send Now</button>
                        <button onClick={() => cancel(m.id)} style={{ ...btnGhost(), color: '#F2597A' }}>Cancel</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>}
          {resolved.length > 0 && (
            <div style={{ borderTop: `1px solid ${DBORDER}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: DTEXT_FAINT, marginBottom: 8 }}>RECENT</div>
              {resolved.map(m => (
                <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5, color: DTEXT_DIM, padding: '5px 0' }}>
                  <span>{m.recipient_name || m.recipient_phone}{m.property_ref ? ` · #${m.property_ref}` : ''}{m.skip_reason ? ` — ${m.skip_reason}` : ''}</span>
                  <Badge {...(SM_STATUS_BADGE[m.status] || SM_STATUS_BADGE.CANCELLED)} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionCard>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color: DTEXT }}>{value}</div>
      <div style={{ fontSize: 10.5, color: DTEXT_FAINT, textTransform: 'capitalize' }}>{label.replace(/_/g, ' ')}</div>
    </div>
  )
}

function NotificationEnginePanel({ agentId, bundle, onChange }: { agentId: number; bundle: Bundle; onChange: () => void }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [island, setIsland] = useState('')
  const [villages, setVillages] = useState('')
  const [budgetMax, setBudgetMax] = useState('')
  const [bedrooms, setBedrooms] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const filters: any = {}
      if (island) filters.island_preference = island
      if (villages.trim()) filters.preferred_villages = villages.split(',').map(s => s.trim()).filter(Boolean)
      if (budgetMax) { filters.budget_max = Number(budgetMax); filters.budget_intent = 'max' }
      if (bedrooms) filters.bedrooms_wanted = Number(bedrooms)
      await crmJson(`notification-engine/searches?agent_id=${agentId}`, 'POST', { name: name.trim(), filters })
      setCreating(false); setName(''); setIsland(''); setVillages(''); setBudgetMax(''); setBedrooms('')
      onChange()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not create search') }
    finally { setBusy(false) }
  }

  async function toggle(s: SavedSearch) {
    await crmJson(`notification-engine/searches/${s.id}?agent_id=${agentId}`, 'PATCH', { enabled: !s.enabled })
    onChange()
  }
  async function remove(s: SavedSearch) {
    if (!confirm(`Delete "${s.name}"?`)) return
    await crmJson(`notification-engine/searches/${s.id}?agent_id=${agentId}`, 'DELETE', {})
    onChange()
  }

  const [groupForm, setGroupForm] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupParticipants, setGroupParticipants] = useState('')
  const [groupBusy, setGroupBusy] = useState(false)

  async function createGroup() {
    setGroupBusy(true)
    try {
      const participants = groupParticipants.split(',').map(s => s.trim()).filter(Boolean)
      await crmJson(`notification-engine/channel/create?agent_id=${agentId}`, 'POST', { name: groupName || undefined, participants })
      setGroupForm(false); setGroupName(''); setGroupParticipants('')
      onChange()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not create the WhatsApp group') }
    finally { setGroupBusy(false) }
  }
  async function disconnectGroup() {
    if (!confirm('Disconnect the notification group?')) return
    await crmJson(`notification-engine/channel?agent_id=${agentId}`, 'DELETE', {})
    onChange()
  }

  return (
    <SectionCard title="Notification Engine" icon="🔔" right={<button onClick={() => setCreating(v => !v)} style={btnGhost()}>{creating ? 'Cancel' : '+ Create Search'}</button>}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: DCARD2, border: `1px solid ${DBORDER}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, color: DTEXT_DIM }}>
          Delivery group: {bundle.notificationEngine.channel
            ? <span style={{ color: DTEXT }}>{bundle.notificationEngine.channel.whatsapp_group_id}</span>
            : <span style={{ color: DTEXT_FAINT }}>none connected</span>}
        </div>
        {bundle.notificationEngine.channel
          ? <button onClick={disconnectGroup} style={{ ...btnGhost(), color: '#F2597A' }}>Disconnect</button>
          : <button onClick={() => setGroupForm(v => !v)} style={btnGhost()}>{groupForm ? 'Cancel' : '+ Create Group'}</button>}
      </div>
      {groupForm && !bundle.notificationEngine.channel && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8, marginBottom: 14, padding: 12, background: DCARD2, borderRadius: 10 }}>
          <input placeholder={`Group name (default: ARGUS — ${bundle.agent.name} Notifications)`} value={groupName} onChange={e => setGroupName(e.target.value)} style={{ ...inputStyle(), gridColumn: 'span 2' }} />
          <input placeholder="Participant phone numbers, comma-separated" value={groupParticipants} onChange={e => setGroupParticipants(e.target.value)} style={{ ...inputStyle(), gridColumn: 'span 2' }} />
          <div style={{ fontSize: 10.5, color: DTEXT_FAINT, gridColumn: 'span 2' }}>
            Requires your WhatsApp to be connected. At least one participant besides you is required by WhatsApp itself.
          </div>
          <button onClick={createGroup} disabled={groupBusy} style={btnPrimary()}>{groupBusy ? 'Creating…' : 'Create Group'}</button>
        </div>
      )}
      {creating && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, marginBottom: 14, padding: 12, background: DCARD2, borderRadius: 10 }}>
          <input placeholder="Search name" value={name} onChange={e => setName(e.target.value)} style={inputStyle()} />
          <select value={island} onChange={e => setIsland(e.target.value)} style={inputStyle()}>
            <option value="">Any island</option>
            <option value="MALTA">Malta</option>
            <option value="GOZO">Gozo</option>
          </select>
          <input placeholder="Localities, comma-separated" value={villages} onChange={e => setVillages(e.target.value)} style={inputStyle()} />
          <input placeholder="Budget max (€)" type="number" value={budgetMax} onChange={e => setBudgetMax(e.target.value)} style={inputStyle()} />
          <input placeholder="Min bedrooms" type="number" value={bedrooms} onChange={e => setBedrooms(e.target.value)} style={inputStyle()} />
          <button onClick={create} disabled={busy} style={btnPrimary()}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      )}
      {bundle.notificationEngine.searches.length === 0
        ? <div style={{ fontSize: 12, color: DTEXT_FAINT }}>No saved searches yet — ARGUS isn't watching anything for you.</div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bundle.notificationEngine.searches.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: DCARD2, border: `1px solid ${DBORDER}`, borderRadius: 10, padding: '10px 14px' }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{s.name}</div>
                  <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginTop: 2 }}>
                    {s.delivery_intensity.toUpperCase()} · {s.match_quality === 'direct_only' ? 'Direct only' : 'Direct + Similar'} · {s.matches_today} match{s.matches_today === '1' ? '' : 'es'} today
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Badge {...(s.enabled ? FEATURE_BADGE.active : FEATURE_BADGE.coming_soon)} label={s.enabled ? 'ACTIVE' : 'PAUSED'} />
                  <button onClick={() => toggle(s)} style={btnGhost()}>{s.enabled ? 'Pause' : 'Resume'}</button>
                  <button onClick={() => remove(s)} style={{ ...btnGhost(), color: '#F2597A' }}>Delete</button>
                </div>
              </div>
            ))}
          </div>}
    </SectionCard>
  )
}

// Structured, legible, ARGUS-branded PDF — deliberately not the final
// designed invoice template (Kev: that comes later, supplied separately).
// This is the generator SHELL producing a real, downloadable document now.
async function buildInvoicePdf(data: {
  agent: Agent; clientName: string; billingCompanyNumber: string; billingVatNumber: string; billingAddress: string
  propertyRef: string; dealRef: string; invoiceNumber?: string | null
  lines: { description: string; price: string }[]; vatEnabled: boolean; vatRate: string; notes: string
}) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const GOLD: [number, number, number] = [184, 149, 63]
  const NAVY: [number, number, number] = [27, 42, 74]
  const INK: [number, number, number] = [30, 34, 44]
  const MUTED: [number, number, number] = [110, 118, 138]
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 48

  doc.setFillColor(...NAVY)
  doc.rect(0, 0, pageW, 86, 'F')
  doc.setFillColor(...GOLD)
  doc.rect(0, 86, pageW, 3, 'F')
  const logo = await loadLogoDataUri()
  const logoW = 70
  const logoH = logoW / logo.ratio
  doc.addImage(logo.uri, 'PNG', margin, (86 - logoH) / 2, logoW, logoH)

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('INVOICE', pageW - margin, 42, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(210, 216, 230)
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  doc.text(`Date: ${today}`, pageW - margin, 60, { align: 'right' })
  if (data.invoiceNumber) doc.text(`Invoice #${data.invoiceNumber}`, pageW - margin, 72, { align: 'right' })

  let y = 120
  doc.setTextColor(...MUTED)
  doc.setFontSize(9)
  doc.text('FROM', margin, y)
  doc.text('BILL TO', pageW / 2, y)
  y += 14
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(`${data.agent.name || ''}${data.agent.surname ? ' ' + data.agent.surname : ''}`, margin, y)
  doc.text(data.clientName || '—', pageW / 2, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(...MUTED)
  let yl = y + 14, yr = y + 14
  if (data.agent.vat_number) { doc.text(`VAT ${data.agent.vat_number}`, margin, yl); yl += 12 }
  if (data.agent.company_number) { doc.text(`Co. Nr ${data.agent.company_number}`, margin, yl); yl += 12 }
  if (data.agent.email) { doc.text(data.agent.email, margin, yl); yl += 12 }
  if (data.billingVatNumber) { doc.text(`VAT ${data.billingVatNumber}`, pageW / 2, yr); yr += 12 }
  if (data.billingCompanyNumber) { doc.text(`Co. Nr ${data.billingCompanyNumber}`, pageW / 2, yr); yr += 12 }
  if (data.billingAddress) { doc.text(doc.splitTextToSize(data.billingAddress, pageW / 2 - margin), pageW / 2, yr); yr += 12 }

  y = Math.max(yl, yr) + 16
  if (data.propertyRef || data.dealRef) {
    doc.setFontSize(9)
    doc.text([data.propertyRef ? `Property REF: ${data.propertyRef}` : '', data.dealRef ? `Deal REF: ${data.dealRef}` : ''].filter(Boolean).join('   ·   '), margin, y)
    y += 20
  }

  doc.setDrawColor(...GOLD)
  doc.setLineWidth(1)
  doc.line(margin, y, pageW - margin, y)
  y += 20

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text('DESCRIPTION', margin, y)
  doc.text('AMOUNT', pageW - margin, y, { align: 'right' })
  y += 10
  doc.setDrawColor(220, 220, 220)
  doc.line(margin, y, pageW - margin, y)
  y += 16

  const validLines = data.lines.filter(l => l.description || l.price)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10.5)
  doc.setTextColor(...INK)
  let subtotal = 0
  for (const l of validLines) {
    const price = Number(l.price) || 0
    subtotal += price
    doc.text(l.description || '—', margin, y)
    doc.text(`€${price.toFixed(2)}`, pageW - margin, y, { align: 'right' })
    y += 18
  }

  const vat = data.vatEnabled ? subtotal * (Number(data.vatRate) || 0) / 100 : 0
  const total = subtotal + vat
  y += 8
  doc.line(pageW - margin - 160, y, pageW - margin, y)
  y += 16
  doc.setFontSize(10)
  doc.setTextColor(...MUTED)
  doc.text('Subtotal', pageW - margin - 160, y)
  doc.setTextColor(...INK)
  doc.text(`€${subtotal.toFixed(2)}`, pageW - margin, y, { align: 'right' })
  if (data.vatEnabled) {
    y += 16
    doc.setTextColor(...MUTED)
    doc.text(`VAT (${data.vatRate}%)`, pageW - margin - 160, y)
    doc.setTextColor(...INK)
    doc.text(`€${vat.toFixed(2)}`, pageW - margin, y, { align: 'right' })
  }
  y += 20
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(...GOLD)
  doc.text('TOTAL', pageW - margin - 160, y)
  doc.text(`€${total.toFixed(2)}`, pageW - margin, y, { align: 'right' })

  if (data.notes) {
    y += 36
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9.5)
    doc.setTextColor(...MUTED)
    doc.text('NOTES', margin, y)
    y += 14
    doc.setTextColor(...INK)
    doc.text(doc.splitTextToSize(data.notes, pageW - margin * 2), margin, y)
  }

  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('Generated by ARGUS · 2906 Estate', margin, doc.internal.pageSize.getHeight() - 30)

  return doc
}

function InvoiceCreator({ agentId, agent, invoices, onCreated }: { agentId: number; agent: Agent; invoices: Invoice[]; onCreated: () => void }) {
  const [clientName, setClientName] = useState('')
  const [billingCompanyNumber, setBillingCompanyNumber] = useState('')
  const [billingVatNumber, setBillingVatNumber] = useState('')
  const [billingAddress, setBillingAddress] = useState('')
  const [propertyRef, setPropertyRef] = useState('')
  const [dealRef, setDealRef] = useState('')
  const [lines, setLines] = useState<{ description: string; price: string }[]>([{ description: '', price: '' }])
  const [vatEnabled, setVatEnabled] = useState(false)
  const [vatRate, setVatRate] = useState('18')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const subtotal = lines.reduce((sum, l) => sum + (Number(l.price) || 0), 0)
  const vat = vatEnabled ? subtotal * (Number(vatRate) || 0) / 100 : 0
  const total = subtotal + vat

  function setLine(i: number, field: 'description' | 'price', v: string) {
    setLines(ls => ls.map((l, idx) => idx === i ? { ...l, [field]: v } : l))
  }

  function reset() {
    setClientName(''); setBillingCompanyNumber(''); setBillingVatNumber(''); setBillingAddress('')
    setPropertyRef(''); setDealRef(''); setLines([{ description: '', price: '' }]); setNotes('')
  }

  // Kev, 2026-09-16: "anstatt Save Draft ... PDF download" — this now saves
  // the draft (so it still shows in Recent Drafts / the activity log / the
  // audit trail) AND immediately generates a real downloadable PDF from the
  // same data, in one action.
  async function saveAndDownload() {
    setBusy(true)
    try {
      const created = await crmJson(`agent-profile/${agentId}/invoices`, 'POST', {
        client_or_owner_name: clientName || null, property_ref: propertyRef || null, deal_ref: dealRef || null,
        billing_company_number: billingCompanyNumber || null, billing_vat_number: billingVatNumber || null,
        billing_address: billingAddress || null,
        line_items: lines.filter(l => l.description || l.price).map(l => ({ description: l.description, price: Number(l.price) || 0 })),
        vat_enabled: vatEnabled, vat_rate: Number(vatRate) || 0, notes: notes || null,
      })
      const doc = await buildInvoicePdf({ agent, clientName, billingCompanyNumber, billingVatNumber, billingAddress, propertyRef, dealRef, invoiceNumber: created?.invoice_number, lines, vatEnabled, vatRate, notes })
      doc.save(`invoice${propertyRef ? '-' + propertyRef : ''}-${new Date().toISOString().slice(0, 10)}.pdf`)
      reset()
      onCreated()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not save invoice') }
    finally { setBusy(false) }
  }

  return (
    <SectionCard id="invoice" title="Invoice Creator" icon="🧾">
      <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginBottom: 12 }}>
        From: {agent.name}{agent.surname ? ` ${agent.surname}` : ''}{agent.vat_number ? ` · VAT ${agent.vat_number}` : ''}{agent.company_number ? ` · Co. Nr ${agent.company_number}` : ''}
        {' '}— structured document now, final branded template comes later.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8, marginBottom: 8 }}>
        <input placeholder="Client / Owner name / Company" value={clientName} onChange={e => setClientName(e.target.value)} style={inputStyle()} />
        <input placeholder="Company Nr (optional)" value={billingCompanyNumber} onChange={e => setBillingCompanyNumber(e.target.value)} style={inputStyle()} />
        <input placeholder="VAT Number (optional)" value={billingVatNumber} onChange={e => setBillingVatNumber(e.target.value)} style={inputStyle()} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8, marginBottom: 10 }}>
        <input placeholder="Billing address (optional)" value={billingAddress} onChange={e => setBillingAddress(e.target.value)} style={inputStyle()} />
        <input placeholder="Property REF (e.g. 2906-1234)" value={propertyRef} onChange={e => setPropertyRef(e.target.value)} style={inputStyle()} />
        <input placeholder="Deal REF" value={dealRef} onChange={e => setDealRef(e.target.value)} style={inputStyle()} />
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input placeholder="Description (e.g. Agency Fee)" value={l.description} onChange={e => setLine(i, 'description', e.target.value)} style={{ ...inputStyle(), flex: 1 }} />
          <input placeholder="€" type="number" value={l.price} onChange={e => setLine(i, 'price', e.target.value)} style={{ ...inputStyle(), width: 110 }} />
          {lines.length > 1 && <button onClick={() => setLines(ls => ls.filter((_, idx) => idx !== i))} style={btnGhost()}>✕</button>}
        </div>
      ))}
      <button onClick={() => setLines(ls => [...ls, { description: '', price: '' }])} style={{ ...btnGhost(), marginBottom: 12 }}>+ Add Line</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: DTEXT_DIM }}>
          <input type="checkbox" checked={vatEnabled} onChange={e => setVatEnabled(e.target.checked)} /> Apply VAT
        </label>
        {vatEnabled && <input type="number" value={vatRate} onChange={e => setVatRate(e.target.value)} style={{ ...inputStyle(), width: 70 }} />}
        {vatEnabled && <span style={{ fontSize: 11, color: DTEXT_FAINT }}>%</span>}
      </div>
      <textarea placeholder="Notes" value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inputStyle(), minHeight: 50, marginBottom: 12 }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, fontSize: 12.5, color: DTEXT_DIM, marginBottom: 12 }}>
        <div>Subtotal: <b style={{ color: DTEXT }}>€{subtotal.toFixed(2)}</b></div>
        {vatEnabled && <div>VAT: <b style={{ color: DTEXT }}>€{vat.toFixed(2)}</b></div>}
        <div>Total: <b style={{ color: A }}>€{total.toFixed(2)}</b></div>
      </div>
      <button onClick={saveAndDownload} disabled={busy} style={btnPrimary()}>{busy ? 'Generating…' : '⬇ Download PDF'}</button>

      {invoices.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${DBORDER}`, paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: DTEXT_FAINT, marginBottom: 8 }}>RECENT INVOICES</div>
          {invoices.map(inv => {
            const sub = (inv.line_items || []).reduce((s, l) => s + (Number(l.price) || 0), 0)
            return (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: DTEXT_DIM, padding: '5px 0' }}>
                <span>{inv.client_or_owner_name || '(no client)'} {inv.property_ref ? `· #${inv.property_ref}` : ''}</span>
                <span>€{sub.toFixed(2)} · {new Date(inv.invoice_date).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
              </div>
            )
          })}
        </div>
      )}
    </SectionCard>
  )
}

// Same principle as buildInvoicePdf: structured, ARGUS-branded, real
// downloadable PDF now; final legal template comes later. jsPDF is imported
// dynamically inside here for the same SSR/Turbopack reason.
async function buildContractPdf(data: {
  agent: Agent
  propertyRef: string; ownerName: string; ownerCompanyNumber: string; ownerVatNumber: string
  tenantName: string; tenantCompanyNumber: string; tenantVatNumber: string
  startDate: string; endDate: string; rent: string; deposit: string; occupants: string
  petsAllowed: boolean; specialClauses: string
}) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const GOLD: [number, number, number] = [184, 149, 63]
  const NAVY: [number, number, number] = [27, 42, 74]
  const INK: [number, number, number] = [30, 34, 44]
  const MUTED: [number, number, number] = [110, 118, 138]
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 48

  doc.setFillColor(...NAVY)
  doc.rect(0, 0, pageW, 86, 'F')
  doc.setFillColor(...GOLD)
  doc.rect(0, 86, pageW, 3, 'F')
  const logo = await loadLogoDataUri()
  const logoW = 70
  const logoH = logoW / logo.ratio
  doc.addImage(logo.uri, 'PNG', margin, (86 - logoH) / 2, logoW, logoH)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(255, 255, 255)
  doc.text('RENTAL AGREEMENT', pageW - margin, 42, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(210, 216, 230)
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  doc.text(`Drawn up: ${today}`, pageW - margin, 60, { align: 'right' })

  let y = 120
  doc.setTextColor(...MUTED)
  doc.setFontSize(9)
  doc.text('LESSOR / OWNER', margin, y)
  doc.text('LESSEE / TENANT', pageW / 2, y)
  y += 14
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(data.ownerName || '—', margin, y)
  doc.text(data.tenantName || '—', pageW / 2, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(...MUTED)
  let yl = y + 14, yr = y + 14
  if (data.ownerCompanyNumber) { doc.text(`Co. Nr ${data.ownerCompanyNumber}`, margin, yl); yl += 12 }
  if (data.ownerVatNumber) { doc.text(`VAT ${data.ownerVatNumber}`, margin, yl); yl += 12 }
  if (data.tenantCompanyNumber) { doc.text(`Co. Nr ${data.tenantCompanyNumber}`, pageW / 2, yr); yr += 12 }
  if (data.tenantVatNumber) { doc.text(`VAT ${data.tenantVatNumber}`, pageW / 2, yr); yr += 12 }

  y = Math.max(yl, yr) + 16
  doc.setDrawColor(...GOLD)
  doc.setLineWidth(1)
  doc.line(margin, y, pageW - margin, y)
  y += 24

  const rows: [string, string][] = [
    ['Property', data.propertyRef ? `Ref #${data.propertyRef}` : '—'],
    ['Term', `${data.startDate || '—'} to ${data.endDate || '—'}`],
    ['Rent', data.rent ? `€${Number(data.rent).toLocaleString()} / month` : '—'],
    ['Deposit', data.deposit ? `€${Number(data.deposit).toLocaleString()}` : '—'],
    ['Occupants', data.occupants || '—'],
    ['Pets', data.petsAllowed ? 'Allowed' : 'Not allowed'],
  ]
  doc.setFontSize(10.5)
  for (const [label, val] of rows) {
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...MUTED)
    doc.text(label, margin, y)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...INK)
    doc.text(val, margin + 110, y)
    y += 20
  }

  if (data.specialClauses) {
    y += 12
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(...MUTED)
    doc.text('SPECIAL CLAUSES', margin, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...INK)
    doc.text(doc.splitTextToSize(data.specialClauses, pageW - margin * 2), margin, y)
  }

  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text(`Prepared by ${data.agent.name || ''}${data.agent.surname ? ' ' + data.agent.surname : ''} · Generated by ARGUS · 2906 Estate`, margin, doc.internal.pageSize.getHeight() - 30)

  return doc
}

function ContractCreator({ agentId, agent, contracts, onCreated }: { agentId: number; agent: Agent; contracts: ContractRow[]; onCreated: () => void }) {
  const [propertyRef, setPropertyRef] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerCompanyNumber, setOwnerCompanyNumber] = useState('')
  const [ownerVatNumber, setOwnerVatNumber] = useState('')
  const [tenantName, setTenantName] = useState('')
  const [tenantCompanyNumber, setTenantCompanyNumber] = useState('')
  const [tenantVatNumber, setTenantVatNumber] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rent, setRent] = useState('')
  const [deposit, setDeposit] = useState('')
  const [occupants, setOccupants] = useState('')
  const [petsAllowed, setPetsAllowed] = useState(false)
  const [specialClauses, setSpecialClauses] = useState('')
  const [busy, setBusy] = useState(false)

  function reset() {
    setPropertyRef(''); setOwnerName(''); setOwnerCompanyNumber(''); setOwnerVatNumber('')
    setTenantName(''); setTenantCompanyNumber(''); setTenantVatNumber('')
    setStartDate(''); setEndDate(''); setRent(''); setDeposit(''); setOccupants(''); setSpecialClauses('')
  }

  async function saveAndDownload() {
    setBusy(true)
    try {
      await crmJson(`agent-profile/${agentId}/contracts`, 'POST', {
        property_ref: propertyRef || null, owner_name: ownerName || null, tenant_name: tenantName || null,
        start_date: startDate || null, end_date: endDate || null, rent: rent ? Number(rent) : null,
        deposit: deposit ? Number(deposit) : null, occupants: occupants || null, pets_allowed: petsAllowed,
        special_clauses: specialClauses || null,
        extra_fields: { ownerCompanyNumber, ownerVatNumber, tenantCompanyNumber, tenantVatNumber },
      })
      const doc = await buildContractPdf({
        agent, propertyRef, ownerName, ownerCompanyNumber, ownerVatNumber,
        tenantName, tenantCompanyNumber, tenantVatNumber, startDate, endDate, rent, deposit,
        occupants, petsAllowed, specialClauses,
      })
      doc.save(`contract${propertyRef ? '-' + propertyRef : ''}-${new Date().toISOString().slice(0, 10)}.pdf`)
      reset()
      onCreated()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not save contract') }
    finally { setBusy(false) }
  }

  return (
    <SectionCard id="contract" title="Contract Creator" icon="📄">
      <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginBottom: 12 }}>Structured document now, final legal template comes later.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, marginBottom: 8 }}>
        <input placeholder="Property REF" value={propertyRef} onChange={e => setPropertyRef(e.target.value)} style={inputStyle()} />
        <input placeholder="Owner / Lessor" value={ownerName} onChange={e => setOwnerName(e.target.value)} style={inputStyle()} />
        <input placeholder="Owner Company Nr (optional)" value={ownerCompanyNumber} onChange={e => setOwnerCompanyNumber(e.target.value)} style={inputStyle()} />
        <input placeholder="Owner VAT Number (optional)" value={ownerVatNumber} onChange={e => setOwnerVatNumber(e.target.value)} style={inputStyle()} />
        <input placeholder="Tenant / Lessee" value={tenantName} onChange={e => setTenantName(e.target.value)} style={inputStyle()} />
        <input placeholder="Tenant Company Nr (optional)" value={tenantCompanyNumber} onChange={e => setTenantCompanyNumber(e.target.value)} style={inputStyle()} />
        <input placeholder="Tenant VAT Number (optional)" value={tenantVatNumber} onChange={e => setTenantVatNumber(e.target.value)} style={inputStyle()} />
        <input placeholder="Start date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle()} />
        <input placeholder="End date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputStyle()} />
        <input placeholder="Rent (€/month)" type="number" value={rent} onChange={e => setRent(e.target.value)} style={inputStyle()} />
        <input placeholder="Deposit (€)" type="number" value={deposit} onChange={e => setDeposit(e.target.value)} style={inputStyle()} />
        <input placeholder="Occupants" value={occupants} onChange={e => setOccupants(e.target.value)} style={inputStyle()} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: DTEXT_DIM }}>
          <input type="checkbox" checked={petsAllowed} onChange={e => setPetsAllowed(e.target.checked)} /> Pets allowed
        </label>
      </div>
      <textarea placeholder="Special clauses (optional)" value={specialClauses} onChange={e => setSpecialClauses(e.target.value)} style={{ ...inputStyle(), minHeight: 50, marginBottom: 12 }} />
      <button onClick={saveAndDownload} disabled={busy} style={btnPrimary()}>{busy ? 'Generating…' : '⬇ Download PDF'}</button>

      {contracts.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${DBORDER}`, paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: DTEXT_FAINT, marginBottom: 8 }}>RECENT CONTRACTS</div>
          {contracts.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: DTEXT_DIM, padding: '5px 0' }}>
              <span>{c.owner_name || '?'} → {c.tenant_name || '?'} {c.property_ref ? `· #${c.property_ref}` : ''}</span>
              <span>{c.start_date ? new Date(c.start_date).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '?'}</span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

export default function Page() {
  return (
    <CrmProvider>
      <CrmShell title="Agent Profile" subtitle="Your operating identity" dark>
        <AgentProfilePage />
      </CrmShell>
    </CrmProvider>
  )
}
