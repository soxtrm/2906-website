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

const DPAGE = '#0B0F17'
const DCARD2 = '#0F1521'

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
  whatsapp: { status: string; session: string | null; phone?: string | null }
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
    <div id={id} style={{ background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 14, padding: '18px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 700, color: DTEXT }}>
          {icon && <span style={{ fontSize: 15 }}>{icon}</span>}{title}
        </div>
        {right}
      </div>
      {children}
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
      {/* ── Identity card ─────────────────────────────────────────────── */}
      <div style={{ background: `linear-gradient(160deg, ${DCARD} 0%, ${DCARD2} 100%)`, border: `1px solid ${DCARD_BORDER}`, borderRadius: 16, padding: '22px 22px 20px', marginBottom: 18, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: -60, right: -60, width: 200, height: 200, borderRadius: '50%', background: 'radial-gradient(circle, rgba(184,149,63,0.14), transparent 70%)' }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', position: 'relative' }}>
          <div style={{
            width: 76, height: 76, borderRadius: '50%', flexShrink: 0,
            background: a.profile_image_url ? `url(${a.profile_image_url}) center/cover` : 'linear-gradient(135deg, rgba(184,149,63,0.35), rgba(79,123,242,0.35))',
            border: `2px solid ${A}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 700,
          }}>
            {!a.profile_image_url && (a.name || a.username || '?').charAt(0).toUpperCase()}
          </div>
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
          <a key={c.label} href={c.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 12, padding: '16px 16px', cursor: 'pointer', height: '100%' }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: AD, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, marginBottom: 10 }}>{c.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: DTEXT }}>{c.label}</div>
              <div style={{ fontSize: 11, color: DTEXT_FAINT, marginTop: 3 }}>{c.desc}</div>
            </div>
          </a>
        ))}
      </div>

      {/* ── WhatsApp connection ──────────────────────────────────────────── */}
      <SectionCard title="WhatsApp Connection" icon="💬" right={<Badge {...(WA_BADGE[bundle.whatsapp.status] || WA_BADGE.OFFLINE)} />}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, color: DTEXT_DIM }}>
          <div>Session: <span style={{ color: DTEXT }}>{bundle.whatsapp.session || 'not assigned'}</span></div>
          {bundle.whatsapp.phone && <div>Number: <span style={{ color: DTEXT }}>{bundle.whatsapp.phone}</span></div>}
        </div>
        {bundle.whatsapp.status !== 'CONNECTED' && (
          <div style={{ marginTop: 10, fontSize: 11, color: DTEXT_FAINT }}>
            Self-serve QR connect is coming in the next pass — for now, ask an admin to assign/reconnect your WhatsApp session.
          </div>
        )}
      </SectionCard>

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

      {/* ── Invoice Creator ──────────────────────────────────────────────── */}
      <InvoiceCreator agentId={agentId!} agent={a} invoices={bundle.invoices} onCreated={load} />

      {/* ── Contract Creator ─────────────────────────────────────────────── */}
      <ContractCreator agentId={agentId!} contracts={bundle.contracts} onCreated={load} />

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

  return (
    <SectionCard title="Notification Engine" icon="🔔" right={<button onClick={() => setCreating(v => !v)} style={btnGhost()}>{creating ? 'Cancel' : '+ Create Search'}</button>}>
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

function InvoiceCreator({ agentId, agent, invoices, onCreated }: { agentId: number; agent: Agent; invoices: Invoice[]; onCreated: () => void }) {
  const [clientName, setClientName] = useState('')
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

  async function save() {
    setBusy(true)
    try {
      await crmJson(`agent-profile/${agentId}/invoices`, 'POST', {
        client_or_owner_name: clientName || null, property_ref: propertyRef || null, deal_ref: dealRef || null,
        line_items: lines.filter(l => l.description || l.price).map(l => ({ description: l.description, price: Number(l.price) || 0 })),
        vat_enabled: vatEnabled, vat_rate: Number(vatRate) || 0, notes: notes || null,
      })
      setClientName(''); setPropertyRef(''); setDealRef(''); setLines([{ description: '', price: '' }]); setNotes('')
      onCreated()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not save invoice') }
    finally { setBusy(false) }
  }

  return (
    <SectionCard id="invoice" title="Invoice Creator" icon="🧾">
      <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginBottom: 12 }}>
        From: {agent.name}{agent.surname ? ` ${agent.surname}` : ''}{agent.vat_number ? ` · VAT ${agent.vat_number}` : ''}{agent.company_number ? ` · Co. Nr ${agent.company_number}` : ''}
        {' '}— structured draft only, final PDF template comes later.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8, marginBottom: 10 }}>
        <input placeholder="Client / Owner name" value={clientName} onChange={e => setClientName(e.target.value)} style={inputStyle()} />
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
      <button onClick={save} disabled={busy} style={btnPrimary()}>{busy ? 'Saving…' : 'Save Draft'}</button>

      {invoices.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${DBORDER}`, paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: DTEXT_FAINT, marginBottom: 8 }}>RECENT DRAFTS</div>
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

function ContractCreator({ agentId, contracts, onCreated }: { agentId: number; contracts: ContractRow[]; onCreated: () => void }) {
  const [propertyRef, setPropertyRef] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [tenantName, setTenantName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rent, setRent] = useState('')
  const [deposit, setDeposit] = useState('')
  const [petsAllowed, setPetsAllowed] = useState(false)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await crmJson(`agent-profile/${agentId}/contracts`, 'POST', {
        property_ref: propertyRef || null, owner_name: ownerName || null, tenant_name: tenantName || null,
        start_date: startDate || null, end_date: endDate || null, rent: rent ? Number(rent) : null,
        deposit: deposit ? Number(deposit) : null, pets_allowed: petsAllowed,
      })
      setPropertyRef(''); setOwnerName(''); setTenantName(''); setStartDate(''); setEndDate(''); setRent(''); setDeposit('')
      onCreated()
    } catch (e: any) { alert(e?.data?.error || e?.message || 'Could not save contract') }
    finally { setBusy(false) }
  }

  return (
    <SectionCard id="contract" title="Contract Creator" icon="📄">
      <div style={{ fontSize: 10.5, color: DTEXT_FAINT, marginBottom: 12 }}>Structured draft only — final legal template comes later.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, marginBottom: 12 }}>
        <input placeholder="Property REF" value={propertyRef} onChange={e => setPropertyRef(e.target.value)} style={inputStyle()} />
        <input placeholder="Owner / Lessor" value={ownerName} onChange={e => setOwnerName(e.target.value)} style={inputStyle()} />
        <input placeholder="Tenant / Lessee" value={tenantName} onChange={e => setTenantName(e.target.value)} style={inputStyle()} />
        <input placeholder="Start date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle()} />
        <input placeholder="End date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputStyle()} />
        <input placeholder="Rent (€/month)" type="number" value={rent} onChange={e => setRent(e.target.value)} style={inputStyle()} />
        <input placeholder="Deposit (€)" type="number" value={deposit} onChange={e => setDeposit(e.target.value)} style={inputStyle()} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: DTEXT_DIM }}>
          <input type="checkbox" checked={petsAllowed} onChange={e => setPetsAllowed(e.target.checked)} /> Pets allowed
        </label>
      </div>
      <button onClick={save} disabled={busy} style={btnPrimary()}>{busy ? 'Saving…' : 'Save Draft'}</button>

      {contracts.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${DBORDER}`, paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: DTEXT_FAINT, marginBottom: 8 }}>RECENT DRAFTS</div>
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
