'use client'
// NEXUS Marketplace → Rooms (2026-11-21): homes let room by room. A Rooms inventory of its own (not a property type),
// filterable by long / short let, price per room, people, private bathroom and shared facilities.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { BedDouble, Bath, MapPin, SlidersHorizontal, UsersRound } from 'lucide-react'
import { MarketplaceLogo } from '@/components/brand/logo'
import { useMpPath } from '@/components/rooms/path'

type Room = { id: number; label: string; status: string; priceMonth: number | null; priceNight: number | null; maxOccupants: number | null; privateBathroom: boolean; photos: string[] }
type Home = { propertyId: number; ref: string; town: string; type: string | null; bedrooms: number | null; photos: string[]; markets: string[]; rooms: Room[]; shared: { label: string; sharedType: string | null }[]; demo?: boolean }
const eur = (n: number) => `€${n.toLocaleString('en-GB')}`
const tc = (s: string) => s.replace(/\b[a-z]/g, c => c.toUpperCase())

export function RoomsMarket({ demo }: { demo: boolean }) {
  const mpPath = useMpPath()
  const reduce = useReducedMotion()
  const [homes, setHomes] = useState<Home[] | null>(null)
  const [err, setErr] = useState('')
  const [market, setMarket] = useState<'any' | 'long_let' | 'short_let'>('any')
  const [max, setMax] = useState(0)
  const [people, setPeople] = useState(1)
  const [privBath, setPrivBath] = useState(false)
  useEffect(() => {
    fetch(`/api/marketplace/rooms${demo ? '?demo=1' : ''}`).then(r => r.json()).then(j => { if (j.homes) setHomes(j.homes); else setErr(j.message || 'Rooms are not available right now.') }).catch(() => setErr('Rooms are not available right now.'))
  }, [demo])
  const shown = useMemo(() => (homes || []).map(h => ({ ...h, rooms: h.rooms.filter(r =>
    (!max || (r.priceMonth ?? Infinity) <= max) && (r.maxOccupants ?? 1) >= people && (!privBath || r.privateBathroom)) }))
    .filter(h => h.rooms.length && (market === 'any' || h.markets.includes(market))), [homes, market, max, people, privBath])
  const q = demo ? '?demo=1' : ''

  return (
    <main className="mp rx">
      <header className="mp-top"><Link href={mpPath('/marketplace')} aria-label="NEXUS Marketplace"><MarketplaceLogo /></Link><nav className="rx-tabs"><Link href={mpPath('/marketplace')}>Homes</Link><span aria-current="page">Rooms</span></nav></header>
      <section className="rx-hero">
        <span className="rx-kicker">NEXUS Rooms{demo && ' · Demonstration'}</span>
        <h1>A room of your own, <span className="rx-grad">in a real home.</span></h1>
        <p>Every room has its own price, photos and calendar. See where it is in the apartment, then ask for it directly.</p>
        {demo && <p className="rx-demo">This is a demonstration home with synthetic data. Requests go through the real booking engine but reach no real owner.</p>}
      </section>
      <div className="rx-filters" role="group" aria-label="Filters">
        <SlidersHorizontal size={16} aria-hidden="true" />
        <div className="rx-seg">{([['any', 'Any stay'], ['long_let', 'Long let'], ['short_let', 'Short let']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={market === k} onClick={() => setMarket(k)}>{l}</button>)}</div>
        <label className="rx-sel">Up to <select value={max} onChange={e => setMax(Number(e.target.value))}><option value={0}>any price</option>{[500, 600, 700, 800, 1000, 1200].map(n => <option key={n} value={n}>{eur(n)}/month</option>)}</select></label>
        <label className="rx-sel"><UsersRound size={14} aria-hidden="true" /><select value={people} onChange={e => setPeople(Number(e.target.value))}>{[1, 2, 3].map(n => <option key={n} value={n}>{n} {n === 1 ? 'person' : 'people'}</option>)}</select></label>
        <button type="button" className="rx-pill" aria-pressed={privBath} onClick={() => setPrivBath(v => !v)}><Bath size={14} />Private bathroom</button>
      </div>
      {err && <p className="rx-empty">{err}</p>}
      {homes && !shown.length && !err && <p className="rx-empty">{homes.length ? 'No room matches these filters.' : 'No homes are let room by room yet. Owners add rooms in NEXUS Sync.'}</p>}
      <div className="rx-grid">
        {shown.map((h, i) => {
          const from = Math.min(...h.rooms.map(r => r.priceMonth ?? Infinity))
          const free = h.rooms.filter(r => r.status === 'on_market').length
          return (
            <motion.div key={h.ref} initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04 }}>
              <Link href={mpPath(`/marketplace/rooms/${encodeURIComponent(h.ref)}${q}`)} className="rx-card">
                <span className="rx-photo">{h.photos[0] ? <img src={h.photos[0]} alt="" loading="lazy" /> : <BedDouble size={36} />}<span className="rx-badge">{h.rooms.length} room{h.rooms.length === 1 ? '' : 's'}</span></span>
                <span className="rx-body">
                  <b>{Number.isFinite(from) ? <>from {eur(from)}<small>/month</small></> : 'Price on request'}</b>
                  <span className="rx-place"><MapPin size={13} aria-hidden="true" />{tc(h.town || 'Malta')} · {h.bedrooms ? `${h.bedrooms}-Bedroom ` : ''}{tc(h.type || 'Apartment')}</span>
                  <span className="rx-rooms">{h.rooms.slice(0, 4).map(r => <i key={r.id} data-state={r.status}>{r.label}{r.priceMonth ? ` · ${eur(r.priceMonth)}` : ''}</i>)}</span>
                  <span className="rx-meta">{free} free now{h.markets.includes('short_let') ? ' · short stays too' : ''}{h.shared.length ? ` · shared ${h.shared.slice(0, 3).map(s => s.label.toLowerCase()).join(', ')}` : ''}</span>
                </span>
              </Link>
            </motion.div>
          )
        })}
      </div>
    </main>
  )
}
