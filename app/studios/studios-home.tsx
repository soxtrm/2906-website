'use client'
// ============================================================================
// NEXUS STUDIOS entry (2026-11-20). Only what works today has a button:
//   Marketplace   -> /marketplace on this domain (the existing NEXUS Marketplace, same data)
//   Venues        -> the existing SmartBooking studio on nexusbooking.one
// Everything else is shown as what it is: in development or planned, without buttons that pretend.
// The live number of homes comes from the same inventory the Marketplace shows; nothing is invented.
// ============================================================================
import { useEffect, useState } from 'react'
import { NexusStar } from '@/components/brand/logo'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowUpRight, Building2, CalendarClock, Handshake, Home, Users, Wrench } from 'lucide-react'

type Item = { listable?: boolean; status?: string; images?: unknown[] }
const LIVE = new Set(['available', 'available_confirmed'])

const SOON = [
  { icon: Handshake, title: 'Agent Exchange', text: 'Work listings with other agencies on co-agency terms agreed in writing. Anonymous client briefs follow.', state: 'Early access', href: '/exchange' },
  { icon: Building2, title: 'Agency profiles', text: 'One verified profile per agency and agent, linked to the homes you are authorised to offer. Agency and agent are already named on every listing.', state: 'In development' },
  { icon: Users, title: 'Workers and services', text: 'Profiles and requests for trades and services, as a category of its own.', state: 'Planned' },
]

export function StudiosHome() {
  const reduce = useReducedMotion()
  const [homes, setHomes] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/nexus/inventory', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive || !d) return
        const list: Item[] = Array.isArray(d) ? d : (d.properties || d.items || [])
        const n = list.filter(p => p && p.listable === true && LIVE.has(String(p.status)) && Array.isArray(p.images) && p.images.length > 0).length
        if (n > 0) setHomes(n)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const rise = (i: number) => (reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.45, delay: 0.06 * i, ease: [0.22, 1, 0.36, 1] as const } })

  return (
    <div className="st">
      <header className="st-top">
        <a className="st-brand" href="/" aria-label="NEXUS STUDIOS home"><NexusStar size={18} className="st-star" />NEXUS <b>STUDIOS</b></a>
        <nav aria-label="NEXUS products">
          <a href="/marketplace">Marketplace</a>
          <a href="https://nexusbooking.one/studio">Venues</a>
          <a href="https://nexusapp.one" className="st-quiet">NEXUS App</a>
        </nav>
      </header>

      <main>
        <motion.section className="st-hero" {...rise(0)}>
          <p className="st-kicker">The business side of NEXUS</p>
          <h1>Tools for the people who make places work.</h1>
          <p className="st-lead">For agents, agencies, venues and service providers. One account across NEXUS, with only what your role allows.</p>
        </motion.section>

        <section className="st-live" aria-label="Open now">
          <motion.a className="st-card st-card-main" href="/marketplace" {...rise(1)}>
            <span className="st-icon"><Home size={20} aria-hidden /></span>
            <span className="st-state is-live">Open</span>
            <h2>Marketplace</h2>
            <p>Homes across Malta, with photos, areas, routes and everyday places nearby.</p>
            <span className="st-meta">{homes != null ? <><strong>{homes}</strong> homes available now</> : 'Live inventory'}</span>
            <span className="st-go">Browse the Marketplace <ArrowUpRight size={16} aria-hidden /></span>
          </motion.a>
          <motion.a className="st-card" href="https://nexusbooking.one/studio" {...rise(2)}>
            <span className="st-icon"><CalendarClock size={20} aria-hidden /></span>
            <span className="st-state is-live">Open</span>
            <h2>Venues and bookings</h2>
            <p>Reservations, calendars, rooms and menus for your venue, on NEXUS Booking.</p>
            <span className="st-go">Open the venue studio <ArrowUpRight size={16} aria-hidden /></span>
          </motion.a>
        </section>

        <section className="st-next" aria-labelledby="st-next-title">
          <h2 id="st-next-title">Coming to STUDIOS</h2>
          <ul>
            {SOON.map((s, i) => (
              <motion.li key={s.title} className="st-row" {...rise(3 + i)}>
                <span className="st-icon is-quiet"><s.icon size={18} aria-hidden /></span>
                <div><h3>{s.href ? <a href={s.href}>{s.title} <ArrowUpRight size={14} aria-hidden /></a> : s.title}</h3><p>{s.text}</p></div>
                <span className={`st-state${s.href ? ' is-live' : ''}`}>{s.state}</span>
              </motion.li>
            ))}
          </ul>
        </section>

        <section className="st-owners" aria-label="For property owners">
          <Wrench size={18} aria-hidden />
          <p>Own a property? Owners manage their homes and agency permissions in <a href="https://nexussync.one">NEXUS Sync</a>. STUDIOS is for professionals.</p>
        </section>
      </main>

      <footer className="st-foot">
        <span>NEXUS STUDIOS</span>
        <nav aria-label="Other NEXUS products">
          <a href="https://nexusapp.one">NEXUS App</a>
          <a href="https://nexusbooking.one">NEXUS Booking</a>
          <a href="https://nexussync.one">NEXUS Sync for owners</a>
        </nav>
      </footer>
    </div>
  )
}
