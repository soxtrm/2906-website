'use client'
// NEXUS Marketplace: one home let room by room (2026-11-21). The interactive 2.5D apartment, the rooms with live
// state from NEXUS Booking, and a real request for the chosen room (booking or viewing) saved in NEXUS Booking.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, Bath, BedDouble, CalendarClock, Check, ChevronLeft, ChevronRight, Lock, MapPin, Ruler, UsersRound } from 'lucide-react'
import { MarketplaceNav } from '@/components/marketplace/nav'
import { useMpPath } from '@/components/rooms/path'
import { IsometricApartment, schematicLayout, type IsoLayout, type IsoUnit } from '@/components/rooms/isometric'

type Room = { id: number; label: string; status: string; state: 'available' | 'reserved' | 'occupied'; priceMonth: number | null; priceNight: number | null; minStayMonths: number | null; maxOccupants: number | null; sizeSqm: number | null; sizeVerified: boolean; privateBathroom: boolean; features: string[]; photos: string[]; description: string | null; availableFrom: string | null; span: [number, number] }
type Shared = { id: number; label: string; sharedType: string | null }
type Home = { ref: string; town: string; type: string | null; bedrooms: number | null; bathrooms: number | null; photos: string[]; markets: string[]; rooms: Room[]; shared: Shared[]; layout: IsoLayout | null; demo: boolean }
type Block = { unitKey: string; span: [number, number]; checkIn: string; checkOut: string; status: string }
const eur = (n: number) => `€${n.toLocaleString('en-GB')}`
const tc = (s: string) => s.replace(/_/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase())
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const iso = (d: Date) => d.toISOString().slice(0, 10)
const STATE = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied' } as const

export function RoomHome({ refId, demo }: { refId: string; demo: boolean }) {
  const mpPath = useMpPath()
  const reduce = useReducedMotion()
  const [home, setHome] = useState<Home | null>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [online, setOnline] = useState(true)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<number | null>(null)
  const [photo, setPhoto] = useState(0)
  const q = demo ? '?demo=1' : ''
  const load = useCallback(async () => {
    const r = await fetch(`/api/marketplace/rooms/${encodeURIComponent(refId)}${q}`).catch(() => null)
    const j = r ? await r.json().catch(() => ({})) : {}
    if (!r || !r.ok) { setErr(j.message || 'This home cannot be loaded right now.'); return }
    setHome(j.home); setBlocks(j.blocks || []); setOnline(j.bookingOnline !== false)
  }, [refId, q])
  useEffect(() => { load() }, [load])
  useEffect(() => { setPhoto(0) }, [sel])
  const units: IsoUnit[] = useMemo(() => home ? [
    ...home.rooms.map(r => ({ id: r.id, kind: 'room' as const, label: r.label, state: r.state, price: r.priceMonth ? `${eur(r.priceMonth)}/mo` : r.priceNight ? `${eur(r.priceNight)}/night` : null })),
    ...home.shared.map(s => ({ id: s.id, kind: 'shared' as const, label: s.label, sharedType: s.sharedType, state: 'shared' as const })),
  ] : [], [home])
  const layout = useMemo(() => (home?.layout && home.layout.blocks.length ? home.layout : schematicLayout(units)), [home, units])
  const room = home?.rooms.find(r => r.id === sel) || null

  if (err) return <main className="mp rx"><MarketplaceNav active="residential" /><p className="rx-empty">{err}</p><Link className="rx-back" href={mpPath(`/marketplace/rooms${q}`)}><ArrowLeft size={16} />All rooms</Link></main>
  if (!home) return <main className="mp rx"><MarketplaceNav active="residential" /><p className="rx-empty">Loading the apartment…</p></main>
  const title = `${home.bedrooms ? `${home.bedrooms}-Bedroom ` : ''}${tc(home.type || 'Apartment')} in ${tc(home.town || 'Malta')}`

  return (
    <main className="mp rx rx-home">
      <MarketplaceNav active={home && home.markets.length === 1 && home.markets[0] === 'short_let' ? 'stays' : 'residential'} />
      <Link className="rx-back" href={mpPath(`/marketplace/rooms${q}`)}><ArrowLeft size={16} />All rooms</Link>
      <div className="rx-head">
        <div><span className="rx-kicker">Rooms · Ref {home.ref}{home.demo && ' · Demonstration'}</span><h1>{title}</h1>
          <p className="rx-place"><MapPin size={15} aria-hidden="true" />{tc(home.town || 'Malta')} · {home.rooms.length} room{home.rooms.length === 1 ? '' : 's'} to let{home.markets.includes('short_let') ? ' · long and short stays' : ' · long let'}</p></div>
      </div>
      {home.demo && <p className="rx-demo">Demonstration home with synthetic data. Requests use the real booking engine but reach no real owner.</p>}
      {!online && <p className="rx-demo">Live availability is not reachable right now; the states shown are the owner's.</p>}
      <div className="rx-layout">
        <section className="rx-scene" aria-label="Apartment">
          <IsometricApartment layout={layout} units={units} selected={sel} onSelect={setSel} height={520} />
          {!home.layout && <p className="rx-note">The owner has not drawn this apartment yet: rooms are shown side by side, not where they really are.</p>}
          <div className="rx-roomlist" role="list">
            {home.rooms.map(r => <button key={r.id} type="button" role="listitem" className="rx-roombtn" data-state={r.state} aria-pressed={sel === r.id} onClick={() => setSel(r.id)}>
              <b>{r.label}</b><span>{r.priceMonth ? `${eur(r.priceMonth)}/mo` : r.priceNight ? `${eur(r.priceNight)}/night` : '—'}</span><i>{STATE[r.state]}</i></button>)}
          </div>
          {home.shared.length > 0 && <p className="rx-shared"><b>Shared:</b> {home.shared.map(s => s.label).join(' · ')}</p>}
        </section>
        <aside className="rx-panel" aria-live="polite">
          <AnimatePresence mode="wait">
            {!room ? (
              <motion.div key="pick" className="rx-pick" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <BedDouble size={26} aria-hidden="true" /><b>Choose a room</b><p>Tap a room in the apartment or in the list to see its photos, price and dates.</p>
              </motion.div>
            ) : (
              <motion.div key={room.id} className="rx-room" initial={reduce ? false : { opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.22 }}>
                <div className="rx-gallery">
                  {room.photos.length ? <img src={room.photos[photo % room.photos.length]} alt={`${room.label}`} /> : <span className="rx-nophoto"><BedDouble size={40} /></span>}
                  {room.photos.length > 1 && <><button type="button" className="l" aria-label="Previous photo" onClick={() => setPhoto(p => (p - 1 + room.photos.length) % room.photos.length)}><ChevronLeft size={18} /></button><button type="button" className="r" aria-label="Next photo" onClick={() => setPhoto(p => (p + 1) % room.photos.length)}><ChevronRight size={18} /></button></>}
                </div>
                <div className="rx-room-head"><h2>{room.label}</h2><span className="rx-state" data-state={room.state}>{room.state === 'reserved' ? <Lock size={12} /> : room.state === 'available' ? <Check size={12} /> : null}{STATE[room.state]}</span></div>
                <p className="rx-price">{room.priceMonth ? <>{eur(room.priceMonth)}<small>/month</small></> : null}{room.priceNight ? <span>{room.priceMonth ? ' · ' : ''}{eur(room.priceNight)}<small>/night</small></span> : null}</p>
                <ul className="rx-facts">
                  {room.maxOccupants && <li><UsersRound size={14} />Up to {room.maxOccupants} {room.maxOccupants === 1 ? 'person' : 'people'}</li>}
                  {room.minStayMonths && <li><CalendarClock size={14} />From {room.minStayMonths} month{room.minStayMonths === 1 ? '' : 's'}</li>}
                  {room.privateBathroom && <li><Bath size={14} />Private bathroom</li>}
                  {room.sizeSqm && <li><Ruler size={14} />{room.sizeVerified ? '' : 'approx. '}{room.sizeSqm} m²</li>}
                </ul>
                {room.features.length > 0 && <p className="rx-chips">{room.features.map(f => <i key={f}>{tc(f)}</i>)}</p>}
                {room.description && <p className="rx-desc">{room.description}</p>}
                <Busy room={room} blocks={blocks} />
                <RequestForm key={room.id} home={home} room={room} demo={demo} onDone={load} />
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>
    </main>
  )
}

function Busy({ room, blocks }: { room: Room; blocks: Block[] }) {
  const mine = blocks.filter(b => b.span[0] < room.span[1] && room.span[0] < b.span[1]).slice(0, 4)
  if (!mine.length) return <p className="rx-busy ok">No bookings yet: free{room.availableFrom ? ` from ${day(room.availableFrom)}` : ' now'}.</p>
  return <div className="rx-busy"><b>Already taken</b>{mine.map((b, i) => <span key={i}>{b.unitKey === 'whole' ? 'Whole apartment' : 'This room'}: {day(b.checkIn)} → {day(b.checkOut)} ({b.status === 'confirmed' ? 'booked' : 'reserved'})</span>)}</div>
}

function RequestForm({ home, room, demo, onDone }: { home: Home; room: Room; demo: boolean; onDone: () => void }) {
  const short = home.markets.includes('short_let')
  const [kind, setKind] = useState<'booking' | 'viewing'>('booking')
  const [market, setMarket] = useState<'long_let' | 'short_let'>(home.markets.includes('long_let') ? 'long_let' : 'short_let')
  const min = iso(new Date(Date.now() + 86400e3))
  const [checkIn, setCheckIn] = useState(room.availableFrom && room.availableFrom > min ? room.availableFrom : min)
  const [checkOut, setCheckOut] = useState(iso(new Date(Date.now() + 8 * 86400e3)))
  const [months, setMonths] = useState(Math.max(room.minStayMonths || 1, 6))
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState(''); const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState<null | { status: string; kind: string; checkIn: string; checkOut: string }>(null)
  const [key] = useState(() => `rq_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`)
  if (room.state === 'occupied') return <p className="rx-busy">This room is occupied now. Ask the owner about later dates through a viewing request.</p>
  if (done) return (
    <div className="rx-done" role="status"><Check size={18} /><div><b>{done.kind === 'viewing' ? 'Viewing request sent' : 'Booking request sent'}</b>
      <p>{done.kind === 'viewing' ? `For ${day(done.checkIn)}.` : `${day(done.checkIn)} → ${day(done.checkOut)}.`} It is saved in NEXUS Booking and waits for the owner. Nothing is booked until they confirm.</p></div></div>
  )
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('')
    const r = await fetch(`/api/marketplace/rooms/${encodeURIComponent(home.ref)}/request${demo ? '?demo=1' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitId: room.id, kind, market, checkIn, checkOut, months, name, email, phone, note, key }) }).catch(() => null)
    const j = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (!r || !r.ok) { setErr(j.message || 'The request could not be sent. Try again.'); return }
    setDone(j.stay); onDone()
  }
  return (
    <form className="rx-form" onSubmit={submit}>
      <div className="rx-seg" role="group" aria-label="Request">{([['booking', 'Book this room'], ['viewing', 'Ask for a viewing']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
      {kind === 'booking' && short && home.markets.length > 1 && <div className="rx-seg small" role="group" aria-label="Stay">{([['long_let', 'Months'], ['short_let', 'Nights']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={market === k} onClick={() => setMarket(k)}>{l}</button>)}</div>}
      <div className="rx-dates">
        <label><span>{kind === 'viewing' ? 'Viewing on' : 'Move in'}</span><input type="date" min={min} value={checkIn} onChange={e => setCheckIn(e.target.value)} required /></label>
        {kind === 'booking' && (market === 'short_let'
          ? <label><span>Move out</span><input type="date" min={checkIn} value={checkOut} onChange={e => setCheckOut(e.target.value)} required /></label>
          : <label><span>For</span><select value={months} onChange={e => setMonths(Number(e.target.value))}>{[1, 2, 3, 6, 9, 12, 18, 24].filter(n => n >= (room.minStayMonths || 1)).map(n => <option key={n} value={n}>{n} month{n === 1 ? '' : 's'}</option>)}</select></label>)}
      </div>
      <label><span>Your name</span><input value={name} onChange={e => setName(e.target.value)} required maxLength={120} autoComplete="name" /></label>
      <div className="rx-dates">
        <label><span>E-mail</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
        <label><span>or phone</span><input type="tel" value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" /></label>
      </div>
      <label><span>Message (optional)</span><textarea rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="A little about you and your plans" /></label>
      {err && <p className="rx-err" role="alert">{err}</p>}
      <button type="submit" className="rx-send" disabled={busy || !name.trim() || (!email.trim() && phone.replace(/\D/g, '').length < 7)}>{busy ? 'Sending…' : kind === 'viewing' ? 'Send viewing request' : `Request ${room.label}`}</button>
      <p className="rx-fine">Your request goes to the owner through NEXUS Booking. It is not a booking until the owner confirms it; nothing is paid now.</p>
    </form>
  )
}
