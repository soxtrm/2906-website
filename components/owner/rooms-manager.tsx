'use client'
// NEXUS Sync: the owner's rooms (2026-11-21). One home, several rooms: whole apartment or room by room, each room
// with its own price, status, photos and features, the shared spaces, an approximate layout, and the requests that
// came in through NEXUS Booking (hold / confirm / decline). Everything is saved in ARGUS; reservations in NEXUS Booking.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { BedDouble, CalendarClock, Camera, Check, ChevronDown, Clock, ExternalLink, ImagePlus, Lock, Minus, Plus, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { sync as ownerSync, type Answer } from '@/lib/owner/live'
import { LayoutEditor } from '@/components/rooms/layout-editor'
import type { IsoLayout, IsoUnit } from '@/components/rooms/isometric'

type Unit = { id?: number; kind: 'room' | 'shared'; label: string; sharedType?: string | null; status: string; priceMonth: number | null; priceNight: number | null; minStayMonths: number | null; maxOccupants: number | null; sizeSqm: number | null; privateBathroom: boolean; features: string[]; photos: string[]; description: string | null; availableFrom: string | null }
type State = { property: { id: number; ref: string; bedrooms: number | null; photos: string[] }; mode: { mode: 'whole' | 'rooms'; markets: string[] }; rooms: Unit[]; shared: Unit[]; layout: (IsoLayout & { status: string; version: number }) | null }
type Stay = { id: string; unitKey: string; unitLabel: string | null; kind: string; checkIn: string; checkOut: string; status: string; holdExpiresAt: string | null; guest: { name: string | null; email: string | null; phone: string | null }; partySize: number | null; note: string | null; createdAt: string }

const STATUS = [['on_market', 'On market'], ['hold', 'Hold'], ['off_market', 'Off market'], ['occupied', 'Occupied']] as const
const FEATURES = [['double_bed', 'Double bed'], ['single_bed', 'Single bed'], ['two_beds', 'Two beds'], ['wardrobe', 'Wardrobe'], ['desk', 'Desk'], ['window', 'Window'], ['balcony', 'Balcony'], ['air_conditioning', 'Air conditioning'], ['heating', 'Heating'], ['furnished', 'Furnished'], ['lock', 'Lock on the door'], ['tv', 'TV'], ['sea_view', 'Sea view']] as const
const SHARED = [['kitchen', 'Kitchen'], ['living', 'Living room'], ['bathroom', 'Bathroom'], ['balcony', 'Balcony'], ['terrace', 'Terrace'], ['laundry', 'Laundry'], ['garden', 'Garden']] as const
const blank = (n: number): Unit => ({ kind: 'room', label: `Room ${n}`, status: 'off_market', priceMonth: null, priceNight: null, minStayMonths: null, maxOccupants: 1, sizeSqm: null, privateBathroom: false, features: ['double_bed', 'wardrobe'], photos: [], description: null, availableFrom: null })
const eur = (n: number) => `€${n.toLocaleString('en-GB')}`
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

// photos are resized in the browser before upload (max 1800 px, JPEG): fast on mobile data and within limits
async function resized(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url })
    const k = Math.min(1, 1800 / Math.max(img.width, img.height))
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.85).split(',')[1]
  } finally { URL.revokeObjectURL(url) }
}

function Counter({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return <span className="rm-counter" role="group" aria-label={label}>
    <button type="button" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={14} /></button>
    <b>{value}</b>
    <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={14} /></button>
  </span>
}

// The owner uses NEXUS Sync; agents use the same screen from the CRM for owners who do not use Sync.
export type RoomsApi = <T = Record<string, unknown>>(op: string, body: Record<string, unknown>) => Promise<Answer<T>>
export function RoomsManager({ propertyId, readOnly, api, marketHref }: { propertyId: number; readOnly: boolean; api?: RoomsApi; marketHref?: (ref: string) => string }) {
  const sync: RoomsApi = api || ownerSync
  const reduce = useReducedMotion()
  const [st, setSt] = useState<State | null>(null)
  const [rooms, setRooms] = useState<Unit[]>([])
  const [shared, setShared] = useState<string[]>([])
  const [open, setOpen] = useState<number | null>(0)
  const [count, setCount] = useState(3)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [stays, setStays] = useState<Stay[] | null>(null)
  const [staysErr, setStaysErr] = useState('')
  const [picker, setPicker] = useState<number | null>(null)
  const say = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(m => (m && m.text === text ? null : m)), 4500) }

  const take = useCallback((s: State) => {
    setSt(s); setRooms(s.rooms.length ? s.rooms : []); setShared(s.shared.map(x => x.sharedType || 'other'))
    if (s.property.bedrooms) setCount(Math.min(12, Math.max(1, s.property.bedrooms)))
  }, [])
  const load = useCallback(async () => {
    const r = await sync<State>('owner/rooms', { propertyId })
    if (r.ok) take(r as unknown as State); else say(false, r.message)
    const s = await sync<{ stays: Stay[] }>('owner/rooms/stays', { propertyId })
    if (s.ok) { setStays(s.stays); setStaysErr('') } else { setStays([]); setStaysErr(s.message) }
  }, [propertyId, take])
  useEffect(() => { load() }, [load])

  const dirty = useMemo(() => !!st && (JSON.stringify(rooms) !== JSON.stringify(st.rooms) || JSON.stringify(shared) !== JSON.stringify(st.shared.map(x => x.sharedType || 'other'))), [st, rooms, shared])
  const patch = (i: number, p: Partial<Unit>) => setRooms(rs => rs.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const save = async () => {
    if (!st) return
    setBusy(true)
    const keep = st.shared.filter(x => shared.includes(x.sharedType || 'other'))
    const add = shared.filter(t => !keep.some(x => x.sharedType === t)).map(t => ({ kind: 'shared', label: SHARED.find(x => x[0] === t)?.[1] || 'Shared space', sharedType: t }))
    const r = await sync<State>('owner/rooms/save', { propertyId, rooms, shared: [...keep, ...add] })
    setBusy(false)
    if (r.ok) { take(r as unknown as State); say(true, 'Rooms saved.') } else say(false, r.message)
  }
  const setMode = async (mode: 'whole' | 'rooms', markets?: string[]) => {
    if (!st) return
    setBusy(true)
    const r = await sync<State>('owner/rooms/mode', { propertyId, mode, markets: markets || st.mode.markets })
    setBusy(false)
    if (r.ok) { take(r as unknown as State); say(true, mode === 'rooms' ? 'Let room by room. Rooms on the market appear in NEXUS Marketplace → Rooms.' : 'Let as one apartment.') } else say(false, r.message)
  }
  const photo = async (u: Unit, body: Record<string, unknown>) => {
    if (!u.id) { say(false, 'Save the room first, then add photos.'); return }
    setBusy(true)
    const r = await sync<{ unitId: number; photos: string[] }>('owner/rooms/photo', { propertyId, unitId: u.id, ...body })
    setBusy(false)
    if (!r.ok) { say(false, r.message); return }
    setRooms(rs => rs.map(x => (x.id === r.unitId ? { ...x, photos: r.photos } : x)))
    setSt(s => s && { ...s, rooms: s.rooms.map(x => (x.id === r.unitId ? { ...x, photos: r.photos } : x)) })
  }
  const upload = async (u: Unit, files: FileList | null) => {
    for (const f of Array.from(files || []).slice(0, 6)) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { say(false, 'JPG, PNG or WebP only.'); continue }
      await photo(u, { dataBase64: await resized(f) })
    }
  }
  const decide = async (s: Stay, action: string) => {
    setBusy(true)
    const r = await sync<{ stay: Stay }>('owner/rooms/decide', { propertyId, stayId: s.id, action, holdHours: 48 })
    setBusy(false)
    if (!r.ok) { say(false, r.message); return }
    say(true, action === 'confirm' ? 'Confirmed. The guest and the agency see it now.' : action === 'hold' ? 'Reserved for 48 hours.' : action === 'decline' ? 'Declined.' : 'Done.')
    load()
  }
  const saveLayout = async (layout: IsoLayout, confirm: boolean) => {
    setBusy(true)
    const r = await sync<State>('owner/rooms/layout', { propertyId, layout, confirm })
    setBusy(false)
    if (r.ok) { take(r as unknown as State); say(true, confirm ? 'Layout confirmed: it shows on your rooms listing.' : 'Layout saved as a draft.') } else say(false, r.message)
  }

  if (!st) return <section className="lv-section rm"><p className="lv-faint">Loading rooms…</p></section>
  const isoUnits: IsoUnit[] = [...st.rooms.map(r => ({ id: r.id!, kind: 'room' as const, label: r.label, state: (r.status === 'occupied' ? 'occupied' : r.status === 'hold' ? 'reserved' : 'available') as IsoUnit['state'], price: r.priceMonth ? `${eur(r.priceMonth)}/mo` : null })), ...st.shared.map(s => ({ id: s.id!, kind: 'shared' as const, label: s.label, sharedType: s.sharedType, state: 'shared' as const }))]
  const live = st.mode.mode === 'rooms'
  const waiting = (stays || []).filter(s => ['requested', 'held'].includes(s.status))

  return (
    <section className="lv-section rm" aria-labelledby="rm-h">
      <div className="rm-head">
        <div><h2 id="rm-h">Rooms</h2><p className="lv-faint">One home, several rooms. Each room gets its own price, photos and calendar; the home stays one listing.</p></div>
        <div className="rm-mode" role="group" aria-label="How it is let">
          <button type="button" aria-pressed={!live} disabled={busy || readOnly} onClick={() => setMode('whole')}>Whole apartment</button>
          <button type="button" aria-pressed={live} disabled={busy || readOnly || !st.rooms.length} onClick={() => setMode('rooms')} title={!st.rooms.length ? 'Add the rooms first' : undefined}>Room by room</button>
        </div>
      </div>
      {live && <div className="rm-markets" role="group" aria-label="Markets">
        {([['long_let', 'Long let'], ['short_let', 'Short let']] as const).map(([k, l]) => { const on = st.mode.markets.includes(k); return <button key={k} type="button" aria-pressed={on} disabled={busy || readOnly || (on && st.mode.markets.length === 1)} onClick={() => setMode('rooms', on ? st.mode.markets.filter(x => x !== k) : [...st.mode.markets, k])}>{on && <Check size={13} />}{l}</button> })}
        <a className="rm-link" href={marketHref ? marketHref(st.property.ref) : `https://nexusstudios.one/marketplace/rooms/${encodeURIComponent(st.property.ref)}`} target="_blank" rel="noopener">See it in the Marketplace<ExternalLink size={13} /></a>
      </div>}

      {!rooms.length && !readOnly && (
        <div className="rm-start">
          <Sparkles size={20} aria-hidden="true" />
          <div><b>How many bedrooms do you let separately?</b><p className="lv-faint">You can rename, price and photograph each one next.</p></div>
          <Counter value={count} min={1} max={12} onChange={setCount} label="bedrooms" />
          <button type="button" className="rm-btn ok" onClick={() => { setRooms(Array.from({ length: count }, (_, i) => blank(i + 1))); setOpen(0); setShared(s => (s.length ? s : ['kitchen', 'living', 'bathroom'])) }}><Plus size={15} />Add {count} room{count === 1 ? '' : 's'}</button>
        </div>
      )}

      <div className="rm-rooms">
        {rooms.map((r, i) => (
          <article key={r.id || `new${i}`} className="rm-room" data-open={open === i || undefined} data-status={r.status}>
            <button type="button" className="rm-room-head" onClick={() => setOpen(o => (o === i ? null : i))} aria-expanded={open === i}>
              <span className="rm-thumb">{r.photos[0] ? <img src={r.photos[0]} alt="" /> : <BedDouble size={18} aria-hidden="true" />}</span>
              <span className="rm-room-name"><b>{r.label || `Room ${i + 1}`}</b><small>{r.priceMonth ? `${eur(r.priceMonth)}/month` : 'No price yet'}{r.maxOccupants ? ` · ${r.maxOccupants} ${r.maxOccupants === 1 ? 'person' : 'people'}` : ''}</small></span>
              <span className="rm-chip" data-status={r.status}>{STATUS.find(s => s[0] === r.status)?.[1]}</span>
              <ChevronDown size={18} aria-hidden="true" />
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div className="rm-room-body" initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  <div className="rm-grid">
                    <label className="rm-field"><span>Name or number</span><input value={r.label} maxLength={40} disabled={readOnly} onChange={e => patch(i, { label: e.target.value })} /></label>
                    <label className="rm-field"><span>Price per month (€)</span><input inputMode="numeric" value={r.priceMonth ?? ''} disabled={readOnly} onChange={e => patch(i, { priceMonth: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null })} placeholder="e.g. 700" /></label>
                    {st.mode.markets.includes('short_let') && <label className="rm-field"><span>Price per night (€)</span><input inputMode="numeric" value={r.priceNight ?? ''} disabled={readOnly} onChange={e => patch(i, { priceNight: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null })} /></label>}
                    <label className="rm-field"><span>Free from</span><input type="date" value={r.availableFrom || ''} disabled={readOnly} onChange={e => patch(i, { availableFrom: e.target.value || null })} /></label>
                  </div>
                  <div className="rm-seg" role="group" aria-label="Status">{STATUS.map(([k, l]) => <button key={k} type="button" aria-pressed={r.status === k} disabled={readOnly} onClick={() => patch(i, { status: k })}>{l}</button>)}</div>
                  <div className="rm-row">
                    <span className="rm-inline"><UsersRound size={15} aria-hidden="true" />Up to <Counter value={r.maxOccupants || 1} min={1} max={6} onChange={n => patch(i, { maxOccupants: n })} label="people" /></span>
                    <span className="rm-inline"><CalendarClock size={15} aria-hidden="true" />Min. <Counter value={r.minStayMonths || 1} min={1} max={36} onChange={n => patch(i, { minStayMonths: n })} label="months" /> months</span>
                    <label className="rm-toggle"><input type="checkbox" checked={r.privateBathroom} disabled={readOnly} onChange={e => patch(i, { privateBathroom: e.target.checked })} /><i />Private bathroom</label>
                  </div>
                  <div className="rm-chips" role="group" aria-label="In the room">{FEATURES.map(([k, l]) => { const on = r.features.includes(k); return <button key={k} type="button" aria-pressed={on} disabled={readOnly} onClick={() => patch(i, { features: on ? r.features.filter(f => f !== k) : [...r.features, k] })}>{l}</button> })}</div>
                  <details className="rm-more"><summary>Size and description (optional)</summary>
                    <label className="rm-field"><span>Approximate size (m²)</span><input inputMode="decimal" value={r.sizeSqm ?? ''} disabled={readOnly} onChange={e => patch(i, { sizeSqm: e.target.value ? Number(e.target.value.replace(',', '.')) || null : null })} /></label>
                    <p className="lv-faint">Shown as "approx." Never as a measured size.</p>
                    <label className="rm-field"><span>About this room</span><textarea rows={3} maxLength={1200} value={r.description || ''} disabled={readOnly} onChange={e => patch(i, { description: e.target.value || null })} /></label>
                  </details>
                  <div className="rm-photos">
                    {r.photos.map(p => <span key={p} className="rm-photo"><img src={p} alt="" />{!readOnly && <button type="button" aria-label="Remove photo" onClick={() => photo(r, { remove: p })}><X size={13} /></button>}</span>)}
                    {!readOnly && <>
                      <label className="rm-add"><ImagePlus size={18} /><span>Upload</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e => { upload(r, e.target.files); e.target.value = '' }} /></label>
                      {st.property.photos.length > 0 && <button type="button" className="rm-add" onClick={() => setPicker(picker === i ? null : i)}><Camera size={18} /><span>From the home</span></button>}
                    </>}
                  </div>
                  {picker === i && <div className="rm-picker">{st.property.photos.map(p => <button key={p} type="button" aria-pressed={r.photos.includes(p)} onClick={() => photo(r, r.photos.includes(p) ? { remove: p } : { url: p })}><img src={p} alt="" /></button>)}</div>}
                  {!r.id && <p className="lv-faint">Save to add photos to this room.</p>}
                  {!readOnly && <button type="button" className="rm-remove" onClick={() => { setRooms(rs => rs.filter((_, k) => k !== i)); setOpen(null) }}><Trash2 size={14} />Remove this room</button>}
                </motion.div>
              )}
            </AnimatePresence>
          </article>
        ))}
        {rooms.length > 0 && !readOnly && rooms.length < 12 && <button type="button" className="rm-btn" onClick={() => { setRooms(rs => [...rs, blank(rs.length + 1)]); setOpen(rooms.length) }}><Plus size={15} />Add a room</button>}
      </div>

      {rooms.length > 0 && <>
        <h3 className="rm-h3">Shared with everyone</h3>
        <div className="rm-chips" role="group" aria-label="Shared spaces">{SHARED.map(([k, l]) => { const on = shared.includes(k); return <button key={k} type="button" aria-pressed={on} disabled={readOnly} onClick={() => setShared(s => (on ? s.filter(x => x !== k) : [...s, k]))}>{l}</button> })}</div>
        <p className="lv-faint">Shared spaces are shown to tenants but are never booked on their own.</p>
      </>}
      {!readOnly && (dirty || !st.rooms.length) && rooms.length > 0 && <div className="rm-save"><button type="button" className="rm-btn ok" disabled={busy} onClick={save}><Check size={15} />{busy ? 'Saving…' : 'Save rooms'}</button><span className="lv-faint">Rooms on the market need a price.</span></div>}

      {st.rooms.length > 0 && !readOnly && (
        <details className="rm-layout" open={!st.layout}>
          <summary><b>Layout</b><span className="lv-faint">{st.layout ? (st.layout.status === 'owner_confirmed' ? 'Confirmed · shown on the listing' : 'Draft · not shown yet') : 'Draw where the rooms are (approximate)'}</span></summary>
          <LayoutEditor key={`${st.layout?.version || 0}-${st.rooms.length}-${st.shared.length}`} units={isoUnits} initial={st.layout} busy={busy} onSave={saveLayout} />
        </details>
      )}

      <h3 className="rm-h3">Requests for rooms {waiting.length > 0 && <span className="rm-count">{waiting.length}</span>}</h3>
      {staysErr && <p className="lv-faint">{staysErr}</p>}
      {stays && !stays.length && !staysErr && <p className="lv-faint">No requests yet. Booking and viewing requests from NEXUS Marketplace appear here.</p>}
      <div className="rm-stays">
        {(stays || []).map(s => (
          <div key={s.id} className="rm-stay" data-status={s.status}>
            <div><b>{s.unitLabel || 'Room'}</b> · {s.kind === 'viewing' ? <>viewing on {day(s.checkIn)}</> : <>{day(s.checkIn)} → {day(s.checkOut)}</>}
              <small>{s.guest.name}{s.partySize ? ` · ${s.partySize} ${s.partySize === 1 ? 'person' : 'people'}` : ''}{s.guest.email ? ` · ${s.guest.email}` : ''}{s.guest.phone ? ` · ${s.guest.phone}` : ''}</small>
              {s.note && <small className="rm-note">“{s.note}”</small>}</div>
            <span className="rm-chip" data-status={s.status}>{s.status === 'held' ? <><Lock size={12} />Reserved</> : s.status === 'requested' ? <><Clock size={12} />New</> : s.status}</span>
            {!readOnly && <div className="rm-acts">
              {s.status === 'requested' && s.kind === 'booking' && <button type="button" className="rm-btn" disabled={busy} onClick={() => decide(s, 'hold')}>Reserve 48 h</button>}
              {['requested', 'held'].includes(s.status) && <button type="button" className="rm-btn ok" disabled={busy} onClick={() => decide(s, 'confirm')}><Check size={14} />Confirm</button>}
              {['requested', 'held'].includes(s.status) && <button type="button" className="rm-btn quiet" disabled={busy} onClick={() => decide(s, 'decline')}>Decline</button>}
              {s.status === 'confirmed' && <button type="button" className="rm-btn quiet" disabled={busy} onClick={() => decide(s, 'cancel')}>Cancel</button>}
            </div>}
          </div>
        ))}
      </div>
      <AnimatePresence>{msg && <motion.p className="rm-msg" data-ok={msg.ok || undefined} role="status" initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{msg.text}</motion.p>}</AnimatePresence>
    </section>
  )
}
