'use client'
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { crmFetch, crmJson, type Me, type Reveals } from './api'

// ── design tokens (verbatim from the approved mockup) ────────────────────────
export const A = 'rgba(212,137,26,1)', AD = 'rgba(212,137,26,0.10)', AB = 'rgba(212,137,26,0.28)'
export const F = "var(--font-bricolage), 'Bricolage Grotesque', Arial, sans-serif"
export const FM = "var(--font-jetbrains), 'JetBrains Mono', 'Courier New', monospace"

export const AVAIL: Record<string, any> = {
  available:      { bg: '#DCFCE7', text: '#15803D', dot: '#22C55E', label: 'Available' },
  soon_available: { bg: '#FEF9C3', text: '#A16207', dot: '#EAB308', label: 'Soon' },
  soon:           { bg: '#FEF9C3', text: '#A16207', dot: '#EAB308', label: 'Soon' },
  rented:         { bg: '#FEE2E2', text: '#B91C1C', dot: '#EF4444', label: 'Rented' },
  reserved:       { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: 'Reserved' },
}
export const VIEW: Record<string, any> = {
  none:      { bg: '#F3F4F6', text: '#9CA3AF', dot: '#D1D5DB', label: 'None' },
  requested: { bg: '#FEF9C3', text: '#A16207', dot: '#EAB308', label: 'Requested' },
  scheduled: { bg: '#DCFCE7', text: '#15803D', dot: '#22C55E', label: 'Scheduled' },
  done:      { bg: '#D1FAE5', text: '#065F46', dot: '#10B981', label: '✓ Done' },
}

export const fmtPhone = (p: string) => {
  const d = String(p || '').replace(/\D/g, '')
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`.trim()
}
export const fmtMoney = (n: any) => (n == null ? null : `€${Number(n).toLocaleString()}`)

// Human-readable activity description from a property_activities row.
export function describe(h: any) {
  const t = (h.type || '').replace(/_/g, ' ')
  const d = h.details || {}
  if (d.field && (d.old != null || d.new != null)) return `${t}: ${d.field} ${d.old ?? '∅'} → ${d.new ?? '∅'}`
  return t
}
export const fmtDate = (d: any) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(+dt)) return String(d)
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export const WAIcon = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="#25D366" aria-hidden>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
)

export function Pill({ status, map, small }: { status: string; map: Record<string, any>; small?: boolean }) {
  const s = map[status] || map[Object.keys(map)[0]]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: small ? '2px 7px' : '3px 9px', borderRadius: 99, background: s.bg, color: s.text, fontSize: small ? 9 : 10, fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: '0.03em' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />{s.label}
    </span>
  )
}

export function Thumbs({ images = [], count, exclusive, w = 68, h = 44 }: { images?: any[]; count?: number; exclusive?: boolean; w?: number; h?: number }) {
  const n = count ?? images.length
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, width: w, height: h, flexShrink: 0, borderRadius: 7, overflow: 'hidden' }}>
      {[0, 1, 2, 3].map(i => {
        const img = images[i]
        const url = img && (img.thumbnail || img.url || img)
        return (
          <div key={i} style={{ background: i < n && url ? `center/cover no-repeat url(${url})` : (i < n ? 'linear-gradient(135deg,#2A4A38,#162E24)' : '#F0EEEA'), display: 'flex', alignItems: 'center', justifyContent: 'center', filter: exclusive ? 'blur(3px) brightness(0.55)' : 'none', fontSize: 9, color: '#CCC' }}>
            {i >= n && '·'}{exclusive && i < n && <span style={{ fontSize: 10 }}>{'🔒'}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function Bar({ pct }: { pct: number }) {
  const c = pct === 100 ? '#22C55E' : pct < 50 ? '#EF4444' : '#EAB308'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div style={{ flex: 1, height: 3, background: '#EDEBE5', borderRadius: 2 }}><div style={{ width: `${pct}%`, height: '100%', background: c, borderRadius: 2 }} /></div>
      <span style={{ fontSize: 10, color: c, fontWeight: 700, minWidth: 26, textAlign: 'right', fontFamily: FM }}>{pct}%</span>
    </div>
  )
}

// ── auth + reveal context ────────────────────────────────────────────────────
type CrmCtx = {
  me: Me | null
  reveals: Reveals
  doReveal: (entityType: string, entityId: number, propertyId?: number) => Promise<string>
  logout: () => Promise<void>
}
const Ctx = createContext<CrmCtx | null>(null)
export const useCrm = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error('useCrm outside provider')
  return c
}

export function CrmProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [reveals, setReveals] = useState<Reveals>({ used: 0, limit: 50 })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    crmFetch('me')
      .then(d => { if (!alive) return; setMe(d.agent); setReveals(d.reveals); setReady(true) })
      .catch(() => { router.replace('/login') })
    return () => { alive = false }
  }, [router])

  const doReveal = useCallback(async (entityType: string, entityId: number, propertyId?: number) => {
    const d = await crmJson('reveal', 'POST', { entity_type: entityType, entity_id: entityId, property_id: propertyId })
    setReveals({ used: d.used, limit: d.limit })
    return d.value as string
  }, [])

  const logout = useCallback(async () => {
    await crmFetch('logout', { method: 'POST' }).catch(() => {})
    router.replace('/login')
  }, [router])

  if (!ready) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F6F4EF', color: A, fontFamily: F, fontWeight: 800, fontSize: 22 }}>2906</div>
    )
  }
  return <Ctx.Provider value={{ me, reveals, doReveal, logout }}>{children}</Ctx.Provider>
}

// ── responsive hook ──────────────────────────────────────────────────────────
export function useIsMobile() {
  const [m, setM] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const on = () => setM(mq.matches)
    on(); mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}

// ── masked PII value with 60s reveal ─────────────────────────────────────────
export function Masked({ entityType, entityId, masked, hasValue, propertyId, size = 11 }:
  { entityType: 'owner_phone' | 'owner_email'; entityId: number; masked: string | null; hasValue: boolean; propertyId?: number; size?: number }) {
  const { doReveal, reveals } = useCrm()
  const [val, setVal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<any>(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  if (!hasValue) return <span style={{ color: '#CCC', fontSize: size }}>{'—'}</span>
  const atLimit = reveals.used >= reveals.limit && !val

  async function onReveal() {
    if (val || busy) return
    setBusy(true)
    try {
      const v = await doReveal(entityType, entityId, propertyId)
      setVal(v)
      timer.current = setTimeout(() => setVal(null), 60000)
    } catch (e: any) {
      alert(e?.message || 'Reveal failed')
    } finally { setBusy(false) }
  }
  const display = val ? (entityType === 'owner_phone' ? fmtPhone(val) : val) : masked
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: size, fontFamily: FM, color: val ? A : '#999', letterSpacing: '0.02em' }}>{display}</span>
      <button onClick={onReveal} disabled={atLimit} title={atLimit ? 'Daily reveal limit reached' : 'Reveal'} style={{ background: 'none', border: 'none', cursor: atLimit ? 'not-allowed' : 'pointer', color: val ? A : (atLimit ? '#E5E1D8' : '#CCC'), fontSize: size + 1, padding: 0, lineHeight: 1 }}>{'👁'}</button>
      {val && entityType === 'owner_phone' && (
        <a href={`https://wa.me/${val.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" style={{ lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}><WAIcon size={size + 3} /></a>
      )}
    </div>
  )
}

// ── app shell (sidebar / header / mobile bottom nav) ─────────────────────────
const NAV = [
  { icon: '▦', label: 'Dashboard', href: '/' },
  { icon: '≡', label: 'Inventory', href: '/inventory' },
  { icon: '◎', label: 'Owners', href: '/owners' },
  { icon: '€', label: 'Earnings', href: '/earnings', disabled: true },
  { icon: '⚙', label: 'Admin', href: '/admin', disabled: true },
]

export function CrmShell({ title, subtitle, onAdd, filterBar, children }:
  { title: string; subtitle?: string; onAdd?: () => void; filterBar?: React.ReactNode; children: React.ReactNode }) {
  const isMobile = useIsMobile()
  const pathname = usePathname() || '/'
  const router = useRouter()
  const { me, reveals, logout } = useCrm()
  const active = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href)
  const warn = reveals.used >= 40 && reveals.used < reveals.limit
  const pct = Math.min(100, Math.round((reveals.used / Math.max(1, reveals.limit)) * 100))

  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', height: '100vh', background: '#F6F4EF', fontFamily: F, color: '#1A1A1A', overflow: 'hidden', fontSize: 13 }}>
      {!isMobile && (
        <aside style={{ width: 190, background: '#131313', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '26px 22px 20px', borderBottom: '1px solid #222' }}>
            <div style={{ fontFamily: F, fontSize: 34, fontWeight: 800, color: A, letterSpacing: '-0.03em', lineHeight: 1 }}>2906</div>
            <div style={{ fontSize: 9, color: '#444', marginTop: 5, letterSpacing: '0.18em', textTransform: 'uppercase' }}>ESTATE · CRM</div>
          </div>
          <nav style={{ padding: '12px 0', flex: 1 }}>
            {NAV.map(item => {
              const on = active(item.href)
              return (
                <div key={item.label} onClick={() => !item.disabled && router.push(item.href)}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 22px', cursor: item.disabled ? 'default' : 'pointer', background: on ? 'rgba(212,137,26,0.1)' : 'transparent', borderLeft: on ? `2px solid ${A}` : '2px solid transparent', color: item.disabled ? '#333' : on ? A : '#555', fontSize: 12, fontWeight: on ? 700 : 400, letterSpacing: '0.05em', textTransform: 'uppercase', transition: 'all 0.12s' }}>
                  <span style={{ fontSize: 15, opacity: on ? 1 : 0.4 }}>{item.icon}</span>{item.label}
                  {item.disabled && <span style={{ fontSize: 8, marginLeft: 'auto', color: '#333' }}>soon</span>}
                </div>
              )
            })}
          </nav>
          <div style={{ padding: '16px 22px', borderTop: '1px solid #222' }}>
            <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Signed in</div>
            <div style={{ color: A, fontSize: 13, fontWeight: 700, marginTop: 3 }}>{me?.name || me?.username} · {me?.role === 'admin' ? 'Admin' : me?.role === 'agent' ? 'Agent' : 'Viewer'}</div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, height: 2, background: '#222', borderRadius: 1 }}><div style={{ width: `${pct}%`, height: '100%', background: warn ? '#EF4444' : A, borderRadius: 1 }} /></div>
              <span style={{ fontSize: 10, color: '#555', fontFamily: FM }}>{reveals.used}/{reveals.limit}</span>
            </div>
            <div style={{ fontSize: 9, color: '#3a3a3a', marginTop: 2 }}>reveals today</div>
            <div onClick={logout} style={{ marginTop: 12, fontSize: 10, color: '#555', cursor: 'pointer', letterSpacing: '0.05em', textTransform: 'uppercase' }}>↩ Sign out</div>
          </div>
        </aside>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header style={{ background: '#FFF', borderBottom: '1px solid #EDEBE5', padding: isMobile ? '12px 16px' : '16px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <h1 style={{ fontFamily: F, fontSize: isMobile ? 18 : 22, fontWeight: 800, margin: 0, letterSpacing: '-0.025em', color: '#0F0F0F' }}>{title}</h1>
            {subtitle && <div style={{ fontSize: 11, color: '#AAA', marginTop: 2 }}>{subtitle}</div>}
          </div>
          {onAdd && <button onClick={onAdd} style={{ background: '#0F0F0F', color: '#FFF', border: 'none', borderRadius: 9, padding: isMobile ? '9px 14px' : '10px 18px', fontSize: isMobile ? 11 : 12, cursor: 'pointer', fontFamily: F, fontWeight: 700, letterSpacing: '0.03em' }}>+ Add</button>}
        </header>

        {warn && (
          <div style={{ background: '#FEF3C7', color: '#92400E', fontSize: 11, padding: '6px 26px', fontFamily: F, fontWeight: 600 }}>
            ⚠ You have used {reveals.used} of {reveals.limit} reveals today. Approaching daily limit.
          </div>
        )}
        {reveals.used >= reveals.limit && (
          <div style={{ background: '#FEE2E2', color: '#B91C1C', fontSize: 11, padding: '6px 26px', fontFamily: F, fontWeight: 700 }}>
            Reveal limit reached. Contact admin to raise your limit.
          </div>
        )}

        {filterBar !== undefined && (
          <div style={{ background: '#FFF', borderBottom: '1px solid #EDEBE5', padding: isMobile ? '8px 14px' : '10px 26px', display: 'flex', gap: 7, flexShrink: 0, flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', alignItems: 'center' }}>
            {filterBar}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', background: '#FAFAF7', paddingBottom: isMobile ? 76 : 0 }}>
          {children}
        </div>
      </div>

      {isMobile && (
        <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#FFF', borderTop: '1px solid #EDEBE5', display: 'flex', zIndex: 100, paddingBottom: 'env(safe-area-inset-bottom,0px)', boxShadow: '0 -4px 20px rgba(0,0,0,0.07)' }}>
          {NAV.map(item => {
            const on = active(item.href)
            return (
              <button key={item.label} onClick={() => !item.disabled && router.push(item.href)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '10px 0 8px', border: 'none', cursor: 'pointer', background: 'transparent', color: item.disabled ? '#DDD' : on ? A : '#BBB' }}>
                <span style={{ fontSize: 19, lineHeight: 1 }}>{item.icon}</span>
                <span style={{ fontSize: 9, marginTop: 4, fontFamily: F, fontWeight: on ? 700 : 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{item.label}</span>
                {on && <div style={{ width: 4, height: 4, borderRadius: '50%', background: A, marginTop: 3 }} />}
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}

export const useMobile = useIsMobile

// ── favourite heart (per-agent, toggles via API) ─────────────────────────────
export function Heart({ propertyId, fav: initial, size = 14, onChange }:
  { propertyId: number; fav?: boolean; size?: number; onChange?: (fav: boolean) => void }) {
  const [fav, setFav] = useState(!!initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setFav(!!initial) }, [initial])
  async function toggle(e?: any) {
    e?.stopPropagation?.()
    if (busy) return
    setBusy(true)
    const next = !fav
    try {
      if (next) await crmJson('favourites', 'POST', { property_id: propertyId })
      else await crmFetch(`favourites/${propertyId}`, { method: 'DELETE' })
      setFav(next); onChange?.(next)
    } catch { /* keep prior state */ } finally { setBusy(false) }
  }
  return (
    <button onClick={toggle} title={fav ? 'Remove favourite' : 'Add to favourites'}
      style={{ background: 'none', border: 'none', cursor: busy ? 'wait' : 'pointer', color: fav ? A : '#CCC', fontSize: size, padding: 0, lineHeight: 1 }}>
      {fav ? '♥' : '♡'}
    </button>
  )
}

// ── location select (dropdown from locations table; no free text; admin can add) ──
const REGION_ORDER = ['Central', 'North', 'South-East', 'South', 'Gozo']
export function LocationSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { me } = useCrm()
  const [items, setItems] = useState<any[]>([])
  const reload = useCallback(() => crmFetch('locations').then(d => setItems(d.items || [])).catch(() => {}), [])
  useEffect(() => { reload() }, [reload])
  async function addNew() {
    const name = window.prompt('New location name (canonical, e.g. "St Paul\'s Bay"):')
    if (!name || !name.trim()) return
    try { const d = await crmJson('locations', 'POST', { name: name.trim() }); await reload(); onChange(d.location?.name || name.trim()) }
    catch (e: any) { alert(e?.message || 'Failed to add location') }
  }
  const sel: React.CSSProperties = { flex: 1, background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#1A1A1A', fontFamily: F, outline: 'none' }
  const groups: Record<string, any[]> = {}
  for (const it of items) { const g = it.region || 'Other'; (groups[g] ||= []).push(it) }
  const regionKeys = [...REGION_ORDER.filter(r => groups[r]), ...Object.keys(groups).filter(r => !REGION_ORDER.includes(r))]
  const known = items.some(i => i.name === value)
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <select style={sel} value={value || ''} onChange={e => onChange(e.target.value)}>
        <option value="">Select location…</option>
        {value && !known && <option value={value}>{value} (current)</option>}
        {regionKeys.map(rk => (
          <optgroup key={rk} label={rk}>
            {groups[rk].map((it: any) => <option key={it.id || it.name} value={it.name}>{it.name}</option>)}
          </optgroup>
        ))}
      </select>
      {me?.role === 'admin' && (
        <button onClick={addNew} title="Add new location" style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 8, padding: '0 12px', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>+</button>
      )}
    </div>
  )
}

// ── owner slide-over panel (desktop right drawer / mobile bottom sheet) ───────
export function OwnerPanel({ ownerId, onClose }: { ownerId: number; onClose: () => void }) {
  const isMobile = useIsMobile()
  const router = useRouter()
  const [d, setD] = useState<any>(null)
  useEffect(() => { crmFetch(`owners/${ownerId}`).then(setD).catch(() => {}) }, [ownerId])

  const ps: React.CSSProperties = isMobile
    ? { position: 'fixed', bottom: 0, left: 0, right: 0, background: '#FFF', borderRadius: '18px 18px 0 0', boxShadow: '0 -8px 40px rgba(0,0,0,0.14)', maxHeight: '80vh', overflowY: 'auto', zIndex: 200, paddingBottom: 32 }
    : { position: 'fixed', top: 0, right: 0, bottom: 0, width: 380, background: '#FFF', boxShadow: '-6px 0 40px rgba(0,0,0,0.10)', overflowY: 'auto', zIndex: 200 }
  const owner = d?.owner
  const props = d?.properties || []

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 199, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(3px)' }} />
      <div style={ps}>
        {isMobile && <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 0' }}><div style={{ width: 36, height: 4, background: '#E0DDD6', borderRadius: 2 }} /></div>}
        <div style={{ padding: '22px 26px 18px', borderBottom: '1px solid #F4F2EC' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 9, color: '#BBB', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: F, marginBottom: 5 }}>Owner Profile</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#0F0F0F', letterSpacing: '-0.02em', fontFamily: F }}>{owner?.name || (d ? 'Unnamed owner' : 'Loading…')}</div>
              {owner && <div style={{ fontSize: 10, color: '#BBB', marginTop: 4, fontFamily: FM }}>ON-{String(owner.id).padStart(3, '0')} · since {fmtDate(owner.since)}</div>}
            </div>
            <button onClick={onClose} style={{ background: '#F4F2EC', border: 'none', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 18, color: '#999', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
        </div>

        {owner && (
          <>
            <div style={{ padding: '16px 26px', borderBottom: '1px solid #F4F2EC' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: F, marginBottom: 10 }}>Contact</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: '#AAA', minWidth: 36, fontFamily: F }}>Phone</span>
                <Masked entityType="owner_phone" entityId={owner.id} masked={owner.phoneMasked} hasValue={owner.hasPhone} size={12} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 10, color: '#AAA', minWidth: 36, fontFamily: F }}>Email</span>
                <Masked entityType="owner_email" entityId={owner.id} masked={owner.emailMasked} hasValue={owner.hasEmail} size={12} />
              </div>
            </div>
            <div style={{ padding: '16px 26px', borderBottom: '1px solid #F4F2EC' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: F, marginBottom: 10 }}>Commission</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#FAFAF6', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 9, color: '#AAA', marginBottom: 2, fontFamily: F }}>🔑 Owner Creator</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1A1A1A', fontFamily: F }}>{owner.createdBy || '—'}</div>
                </div>
                <div style={{ background: '#FAFAF6', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 9, color: '#AAA', marginBottom: 2, fontFamily: F }}>📋 Listing</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1A1A1A', fontFamily: F }}>Per listing</div>
                </div>
              </div>
            </div>
            <div style={{ padding: '16px 26px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: F, marginBottom: 12 }}>Properties ({props.length})</div>
              {props.map((l: any) => (
                <div key={l.id} onClick={() => router.push(`/property/${l.id}`)} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #F4F2EC', cursor: 'pointer' }}>
                  <Thumbs images={l.images} count={l.imageCount} exclusive={l.exclusive} w={60} h={40} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: A, fontFamily: FM }}>{l.ref}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1A1A1A', marginTop: 1, fontFamily: F }}>{l.location.town} · {l.type}</div>
                    <div style={{ marginTop: 4 }}><Pill status={l.availableStatus} map={AVAIL} small /></div>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: '#0F0F0F', fontFamily: F, whiteSpace: 'nowrap' }}>{l.prices.longlet ? fmtMoney(l.prices.longlet) : (l.prices.sale ? fmtMoney(l.prices.sale) : '—')}</div>
                </div>
              ))}
              {!props.length && <div style={{ fontSize: 12, color: '#BBB' }}>No visible properties.</div>}
            </div>
          </>
        )}
      </div>
    </>
  )
}
