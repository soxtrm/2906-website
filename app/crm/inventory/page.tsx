'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch } from '@/lib/crm/api'
import {
  CrmProvider, CrmShell, OwnerPanel, Masked, Pill, Thumbs, Bar, Heart,
  AVAIL, VIEW, A, AD, AB, F, FM, fmtMoney, fmtDate, useIsMobile, useCrm, describe,
} from '@/lib/crm/ui'

export default function InventoryPage() {
  return <CrmProvider><Inventory /></CrmProvider>
}

const sel: React.CSSProperties = { background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 7, padding: '5px 9px', fontSize: 11, color: '#888', fontFamily: F, cursor: 'pointer', flexShrink: 0 }

function Inventory() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { me } = useCrm()
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [agents, setAgents] = useState<any[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [ownerPanel, setOwnerPanel] = useState<number | null>(null)
  const [f, setF] = useState<any>({ town: '', beds: '', status: '', viewing: '', agent: '', price: '', only_mine: false, exclusive: false, only_favourites: false })

  useEffect(() => { crmFetch('agents').then(d => setAgents(d.agents || [])).catch(() => {}); crmFetch('locations').then(d => setLocations(d.locations || [])).catch(() => {}) }, [])

  const load = useCallback(() => {
    const q = new URLSearchParams()
    if (f.town) q.set('town', f.town)
    if (f.beds) q.set('beds', f.beds)
    if (f.status) q.set('status', f.status)
    if (f.viewing) q.set('viewing', f.viewing)
    if (f.agent) q.set('agent', f.agent)
    if (f.only_mine) q.set('only_mine', '1')
    if (f.exclusive) q.set('exclusive', '1')
    if (f.only_favourites) q.set('only_favourites', '1')
    if (f.price) {
      const [mn, mx] = f.price.split('-')
      if (mn) q.set('price_min', mn); if (mx) q.set('price_max', mx)
    }
    crmFetch(`properties?${q.toString()}`).then(d => { setRows(d.properties || []); setTotal(d.total || 0) }).catch(() => {})
  }, [f])
  useEffect(() => { load() }, [load])

  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }))

  const filterBar = (
    <>
      <select style={sel} value={f.town} onChange={e => set('town', e.target.value)}><option value="">Location</option>{locations.map(l => <option key={l} value={l}>{l}</option>)}</select>
      <select style={sel} value={f.beds} onChange={e => set('beds', e.target.value)}><option value="">Bedrooms</option>{[1, 2, 3, 4, 5].map(b => <option key={b} value={b}>{b} bed</option>)}</select>
      <select style={sel} value={f.price} onChange={e => set('price', e.target.value)}><option value="">Price</option><option value="-1000">≤ €1,000</option><option value="1000-2000">€1k–2k</option><option value="2000-3500">€2k–3.5k</option><option value="3500-">€3.5k+</option></select>
      <select style={sel} value={f.status} onChange={e => set('status', e.target.value)}><option value="">Status</option><option value="available">Available</option><option value="soon_available">Soon</option><option value="rented">Rented</option><option value="reserved">Reserved</option></select>
      {!isMobile && <select style={sel} value={f.viewing} onChange={e => set('viewing', e.target.value)}><option value="">Viewing</option><option value="none">None</option><option value="requested">Requested</option><option value="scheduled">Scheduled</option><option value="done">Done</option></select>}
      {!isMobile && <select style={sel} value={f.agent} onChange={e => set('agent', e.target.value)}><option value="">Agent</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name || a.username}</option>)}</select>}
      {!isMobile && (
        <>
          <label style={chk}><input type="checkbox" checked={f.only_mine} onChange={e => set('only_mine', e.target.checked)} style={{ accentColor: A }} /> Only mine</label>
          <label style={chk}><input type="checkbox" checked={f.exclusive} onChange={e => set('exclusive', e.target.checked)} style={{ accentColor: A }} /> Exclusive</label>
          <label style={chk}><input type="checkbox" checked={f.only_favourites} onChange={e => set('only_favourites', e.target.checked)} style={{ accentColor: A }} /> ♥ Only favourites</label>
        </>
      )}
      {isMobile && <label style={chk}><input type="checkbox" checked={f.only_favourites} onChange={e => set('only_favourites', e.target.checked)} style={{ accentColor: A }} /> ♥</label>}
    </>
  )

  return (
    <CrmShell title="Property Inventory" subtitle={`${rows.length} shown · ${total} total`} onAdd={() => router.push('/property/new')} filterBar={filterBar}>
      {ownerPanel != null && <OwnerPanel ownerId={ownerPanel} onClose={() => setOwnerPanel(null)} />}
      {isMobile
        ? <div style={{ padding: '12px 14px' }}>{rows.map(p => <MobileCard key={p.id} p={p} onOwner={setOwnerPanel} onOpen={() => router.push(`/property/${p.id}`)} />)}{!rows.length && <Empty />}</div>
        : <DesktopTable rows={rows} onOwner={setOwnerPanel} onOpen={(id) => router.push(`/property/${id}`)} />}
    </CrmShell>
  )
}

const chk: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#999', cursor: 'pointer' }
const Empty = () => <div style={{ padding: 40, textAlign: 'center', color: '#BBB', fontSize: 13, fontFamily: F }}>No properties match these filters.</div>

// ── desktop table ─────────────────────────────────────────────────────────────
function DesktopTable({ rows, onOwner, onOpen }: { rows: any[]; onOwner: (id: number) => void; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const thS: React.CSSProperties = { padding: '9px 16px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: '#AAA', letterSpacing: '0.12em', textTransform: 'uppercase', borderBottom: '1px solid #EDEBE5', background: '#FAFAF7', position: 'sticky', top: 0, zIndex: 5, whiteSpace: 'nowrap', fontFamily: F }
  const tdS: React.CSSProperties = { padding: '13px 16px', verticalAlign: 'middle', borderBottom: '1px solid #F6F4EF' }
  if (!rows.length) return <Empty />
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1050 }}>
      <thead><tr>{['Ref · Gallery', '', 'Owner', 'Location', 'Price', 'Bd/Ba', 'Available', 'Viewing', 'Profile', ''].map((h, i) => <th key={i} style={thS}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map(p => {
          const isOpen = open === p.id, incomplete = p.completeness < 60
          return (
            <RowFragment key={p.id} p={p} isOpen={isOpen} incomplete={incomplete} tdS={tdS}
              onToggle={() => setOpen(isOpen ? null : p.id)} onOwner={onOwner} onOpen={onOpen} />
          )
        })}
      </tbody>
    </table>
  )
}

function RowFragment({ p, isOpen, incomplete, tdS, onToggle, onOwner, onOpen }: any) {
  const [acts, setActs] = useState<any[] | null>(null)
  useEffect(() => { if (isOpen && !acts) crmFetch(`properties/${p.id}`).then(d => setActs(d.activities || [])).catch(() => setActs([])) }, [isOpen])
  return (
    <>
      <tr style={{ background: '#FFF', borderLeft: p.exclusive ? `3px solid ${A}` : incomplete ? '3px solid #EF4444' : '3px solid transparent' }}>
        <td style={tdS}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Thumbs images={p.images} count={p.imageCount} exclusive={p.exclusive} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: p.published ? A : '#CCC', fontFamily: FM, cursor: 'pointer' }} onClick={() => onOpen(p.id)}>{p.ref}</span>
                {p.published
                  ? <span style={{ fontSize: 9, background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 5px', fontFamily: F, fontWeight: 700 }}>LIVE ↗</span>
                  : <span style={{ fontSize: 9, background: '#F4F2EC', border: '1px solid #E0DDD6', color: '#BBB', borderRadius: 4, padding: '1px 5px', fontFamily: F, fontWeight: 700 }}>DRAFT</span>}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {p.exclusive && <span style={{ fontSize: 9, fontWeight: 700, color: A, background: AD, border: `1px solid ${AB}`, borderRadius: 4, padding: '2px 6px' }}>🔒 EXCL</span>}
                {incomplete && <span style={{ fontSize: 9, fontWeight: 700, color: '#EF4444', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 4, padding: '2px 6px' }}>INCOMPLETE</span>}
              </div>
            </div>
          </div>
        </td>
        <td style={{ ...tdS, color: '#AAA', fontSize: 11, whiteSpace: 'nowrap' }}>{p.type}</td>
        <td style={{ ...tdS, minWidth: 160 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#0F0F0F', cursor: 'pointer', borderBottom: `1px dashed ${AB}`, display: 'inline-block', marginBottom: 5 }} onClick={() => onOwner(p.owner.id)}>{p.owner.name || '—'}</div>
          <Masked entityType="owner_phone" entityId={p.owner.id} masked={p.owner.phoneMasked} hasValue={p.owner.hasPhone} propertyId={p.id} />
          <Masked entityType="owner_email" entityId={p.owner.id} masked={p.owner.emailMasked} hasValue={p.owner.hasEmail} propertyId={p.id} />
        </td>
        <td style={{ ...tdS, fontSize: 12 }}>
          <div style={{ fontWeight: 700 }}>{p.location.town}</div>
          {p.location.street && <div style={{ color: '#AAA', fontSize: 11, marginTop: 1 }}>{p.location.street}</div>}
          {p.location.apt && <div style={{ color: '#CCC', fontSize: 10, marginTop: 1 }}>{p.location.apt}</div>}
        </td>
        <td style={{ ...tdS, whiteSpace: 'nowrap' }}>
          {p.prices.longlet != null && <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.02em' }}>{fmtMoney(p.prices.longlet)}<span style={{ fontSize: 10, color: '#AAA', fontWeight: 400 }}>/mo</span></div>}
          {p.prices.shortlet && <div style={{ fontSize: 11, color: A, marginTop: 3, fontWeight: 600 }}>↗ Shortlet</div>}
          {p.prices.sale != null && <div style={{ fontSize: 11, color: '#AAA', marginTop: 3 }}>{fmtMoney(p.prices.sale)} sale</div>}
        </td>
        <td style={{ ...tdS, textAlign: 'center', fontWeight: 800, fontSize: 15 }}>{p.beds ?? '—'}<span style={{ color: '#DDD', fontWeight: 300 }}>/</span>{p.baths ?? '—'}</td>
        <td style={{ ...tdS, whiteSpace: 'nowrap' }}><Pill status={p.availableStatus} map={AVAIL} /><div style={{ fontSize: 10, color: '#BBB', marginTop: 5, fontFamily: FM }}>{fmtDate(p.availableDate)}</div></td>
        <td style={{ ...tdS, whiteSpace: 'nowrap' }}><Pill status={p.viewingStatus} map={VIEW} /></td>
        <td style={{ ...tdS, minWidth: 128 }}>
          <Bar pct={p.completeness} />
          <div style={{ marginTop: 6, fontSize: 10, color: '#AAA', lineHeight: 1.9, fontFamily: FM }}>
            <div>🔑 {p.ownerCreator || '—'}</div>
            <div>📋 {p.listingAgents.length ? p.listingAgents.join(' + ') : '—'}</div>
            {p.activityAgents.length > 0 && <div>⚡ {p.activityAgents.join(' + ')}</div>}
          </div>
        </td>
        <td style={tdS}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button onClick={() => onOpen(p.id)} style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 7, padding: '5px 11px', fontSize: 10, cursor: 'pointer', fontFamily: F, fontWeight: 700 }}>Edit</button>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 6, padding: '3px 8px', display: 'inline-flex' }}><Heart propertyId={p.id} fav={p.fav} size={13} /></span>
              {[['⏱', 'History'], ['⚑', 'Report']].map(([ico, tip]) => (
                <button key={ico} title={tip} onClick={() => ico === '⏱' ? onToggle() : null}
                  style={{ background: ico === '⏱' && isOpen ? AD : '#F6F4EF', border: `1px solid ${ico === '⏱' && isOpen ? AB : '#E8E4DA'}`, borderRadius: 6, padding: '5px 8px', fontSize: 11, cursor: 'pointer', color: ico === '⏱' && isOpen ? A : '#AAA' }}>{ico}</button>
              ))}
            </div>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr style={{ background: '#FAFAF7' }}>
          <td colSpan={10} style={{ padding: '12px 28px 14px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: F, marginBottom: 10 }}>Activity History</div>
            {acts == null && <div style={{ fontSize: 12, color: '#BBB' }}>Loading…</div>}
            {acts && acts.length === 0 && <div style={{ fontSize: 12, color: '#BBB' }}>No activity yet.</div>}
            {acts?.map((h: any) => (
              <div key={h.id} style={{ display: 'flex', gap: 18, padding: '6px 0', borderBottom: '1px solid #F0EDE8', fontSize: 12, alignItems: 'center' }}>
                <span style={{ fontFamily: FM, fontSize: 10, color: '#CCC', minWidth: 150, flexShrink: 0 }}>{fmtDate(h.when)}</span>
                <span style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700, minWidth: 46, textAlign: 'center' }}>{h.who || '—'}</span>
                <span style={{ color: '#555' }}>{describe(h)}</span>
                {h.significant && <span style={{ marginLeft: 'auto', fontSize: 9, color: A }}>●</span>}
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  )
}

// ── mobile card ───────────────────────────────────────────────────────────────
function MobileCard({ p, onOwner, onOpen }: any) {
  const [open, setOpen] = useState(false)
  const incomplete = p.completeness < 60
  return (
    <div style={{ background: '#FFF', borderRadius: 14, marginBottom: 10, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05),0 4px 12px rgba(0,0,0,0.04)', borderLeft: p.exclusive ? `4px solid ${A}` : incomplete ? '4px solid #EF4444' : '4px solid transparent' }}>
      <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <Thumbs images={p.images} count={p.imageCount} exclusive={p.exclusive} w={76} h={52} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: A, fontFamily: FM }}>{p.ref}</span>
                {p.published
                  ? <span style={{ fontSize: 9, background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 5px', fontFamily: F, fontWeight: 700 }}>LIVE</span>
                  : <span style={{ fontSize: 9, background: '#F4F2EC', border: '1px solid #E0DDD6', color: '#BBB', borderRadius: 4, padding: '1px 5px', fontFamily: F, fontWeight: 700 }}>DRAFT</span>}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F0F0F', fontFamily: F, marginTop: 2 }}>{p.location.town} · {p.type}</div>
              {p.location.street && <div style={{ fontSize: 10, color: '#AAA', fontFamily: F, marginTop: 1 }}>{p.location.street}</div>}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div onClick={e => e.stopPropagation()}><Heart propertyId={p.id} fav={p.fav} size={16} /></div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#0F0F0F', fontFamily: F }}>{fmtMoney(p.prices.longlet || p.prices.sale || 0)}</div>
                <div style={{ fontSize: 9, color: '#AAA', fontFamily: F }}>{p.prices.longlet ? '/mo' : 'sale'}</div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill status={p.availableStatus} map={AVAIL} small />
            {p.viewingStatus !== 'none' && <Pill status={p.viewingStatus} map={VIEW} small />}
            {p.exclusive && <span style={{ fontSize: 9, color: A, fontWeight: 700, background: AD, border: `1px solid ${AB}`, borderRadius: 4, padding: '2px 6px' }}>🔒 EXCL</span>}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 7, fontSize: 10, color: '#AAA', fontFamily: F, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: '#666' }}>🛏 {p.beds ?? '—'} · 🚿 {p.baths ?? '—'}</span>
            <span>{fmtDate(p.availableDate)}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#CCC' }}>{open ? '▲' : '▼'}</span>
          </div>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #F4F2EC', padding: '14px 16px', background: '#FAFAF7' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: F, marginBottom: 8 }}>Owner</div>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#0F0F0F', fontFamily: F, borderBottom: `1px dashed ${AB}`, cursor: 'pointer' }} onClick={() => onOwner(p.owner.id)}>{p.owner.name || '—'}</span>
          <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Masked entityType="owner_phone" entityId={p.owner.id} masked={p.owner.phoneMasked} hasValue={p.owner.hasPhone} propertyId={p.id} size={12} />
            <Masked entityType="owner_email" entityId={p.owner.id} masked={p.owner.emailMasked} hasValue={p.owner.hasEmail} propertyId={p.id} size={12} />
          </div>
          <div style={{ marginTop: 12, marginBottom: 14 }}><Bar pct={p.completeness} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onOpen} style={{ flex: 1, background: '#0F0F0F', color: '#FFF', border: 'none', borderRadius: 9, padding: '11px', fontSize: 12, fontWeight: 700, fontFamily: F, cursor: 'pointer' }}>Open / Edit</button>
          </div>
        </div>
      )}
    </div>
  )
}
