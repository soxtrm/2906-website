'use client'
// NEXUS Marketplace section pages (Kev, 21 Nov 2026): Commercial, Workers, Jobs, More Marketplaces.
// Honest by design: what works links to the working product; what is being built says so.
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Building2, CalendarDays, Check, Compass, FileSignature, Gavel, Hammer, HardHat, Home, KeyRound, MessageCircle, Plug, Ruler, ScanSearch, Search, Sparkles, SprayCan, Truck, Users, Wrench } from 'lucide-react'
import { MarketplaceNav, MarketplaceSubnav } from '@/components/marketplace/nav'
import { useMpPath } from '@/components/rooms/path'

const rise = { h: { opacity: 0, y: 16 }, v: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 260, damping: 30 } } }
function Hero({ kicker, title, children }: { kicker: string; title: React.ReactNode; children?: React.ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.section className="mx-hero" initial={reduce ? false : 'h'} animate="v" variants={{ v: { transition: { staggerChildren: 0.06 } } }}>
      <motion.span className="mx-kicker" variants={rise}>{kicker}</motion.span>
      <motion.h1 variants={rise}>{title}</motion.h1>
      {children && <motion.div className="mx-lead" variants={rise}>{children}</motion.div>}
    </motion.section>
  )
}

export function CommercialPage() {
  return (
    <main className="mp mx">
      <MarketplaceNav active="commercial" />
      <MarketplaceSubnav label="Commercial" items={[{ key: 'rent', label: 'Commercial Rental', count: 0, active: true, onClick: () => {} }, { key: 'sale', label: 'Commercial Sales', count: 0, onClick: () => {} }, { key: 'land', label: 'Land', count: 0, onClick: () => {} }]} />
      <Hero kicker="NEXUS Marketplace · Commercial" title={<>Offices, retail and land.<br /><span className="mx-muted">Listed the same way as homes.</span></>}>
        <p>No commercial property is listed on NEXUS yet. When an agency publishes offices, shops, warehouses or land, they appear here with the same live availability, location intelligence and direct conversation as residential homes.</p>
      </Hero>
      <div className="mx-empty"><Building2 size={22} aria-hidden="true" /><span><b>0 commercial listings</b>Agencies publish commercial stock from their ARGUS workspace or through NEXUS Exchange.</span></div>
    </main>
  )
}

const WORKERS = [
  { key: 'notary', label: 'Notaries', Icon: FileSignature, note: 'Property sales: chosen by the buyer' },
  { key: 'lawyer', label: 'Lawyers', Icon: Gavel, note: 'Contracts and disputes' },
  { key: 'architect', label: 'Architects & Surveyors', Icon: Ruler, note: 'Plans, permits, surveys' },
  { key: 'inspection', label: 'Property Inspection', Icon: ScanSearch, note: 'Condition and handover reports' },
  { key: 'electrician', label: 'Electricians', Icon: Plug, note: 'Installations and repairs' },
  { key: 'plumber', label: 'Plumbers', Icon: Wrench, note: 'Water, heating, drainage' },
  { key: 'cleaning', label: 'Cleaning', Icon: SprayCan, note: 'Move-in, move-out, regular' },
  { key: 'moving', label: 'Moving', Icon: Truck, note: 'Removals and storage' },
  { key: 'maintenance', label: 'Maintenance & Trades', Icon: Hammer, note: 'Handymen, painters, carpenters' },
]
export function WorkersPage() {
  const reduce = useReducedMotion()
  return (
    <main className="mp mx">
      <MarketplaceNav active="workers" />
      <Hero kicker="NEXUS Marketplace · Workers" title={<>The professionals around a property.<br /><span className="mx-muted">Requested from where the deal happens.</span></>}>
        <p>Request a notary, a mover or an inspection from your Property Workspace: the property, the locality and the documents you choose are filled in for you, and the professional replies inside NEXUS. Nobody sees private addresses or contracts unless you share them.</p>
      </Hero>
      <motion.div className="mx-grid" initial={reduce ? false : 'h'} whileInView="v" viewport={{ once: true }} variants={{ v: { transition: { staggerChildren: 0.04 } } }}>
        {WORKERS.map(w => <motion.div key={w.key} className="mx-tile" variants={rise}><w.Icon size={20} aria-hidden="true" /><b>{w.label}</b><small>{w.note}</small><span className="mx-state">Onboarding</span></motion.div>)}
      </motion.div>
      <section className="mx-note"><b>Where the pilot stands</b>
        <p>Professionals are being onboarded and verified. No profiles are listed yet, so nothing here can be booked today. Three different statuses will be shown on every profile: <i>unverified</i>, <i>credential verified</i> (checked against the professional register) and <i>approved NEXUS provider</i>.</p></section>
    </main>
  )
}

export function JobsPage() {
  return (
    <main className="mp mx">
      <MarketplaceNav active="jobs" />
      <Hero kicker="NEXUS Marketplace · Jobs" title={<>Hiring in the industries NEXUS serves.<br /><span className="mx-muted">Employers, roles and candidates.</span></>}>
        <p>Jobs is its own marketplace: organisations publish roles, candidates keep one professional profile, apply and follow every application in one place. It is separate from Workers, which is about booking a service for a property.</p>
      </Hero>
      <div className="mx-two">
        <div className="mx-card"><Users size={20} aria-hidden="true" /><b>For employers</b><ul><li>Organisation profile</li><li>Publish a role</li><li>Review applications</li><li>Contact candidates in NEXUS</li><li>Hiring status per candidate</li></ul></div>
        <div className="mx-card"><Search size={20} aria-hidden="true" /><b>For candidates</b><ul><li>One professional profile</li><li>Browse roles</li><li>Apply with your documents</li><li>Track every application</li><li>Conversations with employers</li></ul></div>
      </div>
      <section className="mx-note"><b>Availability</b><p>Jobs is in development (NEXUS milestone 6). No roles are listed yet; this page will list real openings as soon as the first employers publish them.</p></section>
    </main>
  )
}

const STEPS = [
  { key: 'discover', label: 'Discover', Icon: Compass, text: 'A home appears in the Marketplace with live availability and honest details.', live: true, href: '/marketplace' },
  { key: 'understand', label: 'Understand', Icon: Sparkles, text: 'Structured features and Smart Intelligence: the places, routes and times around it.', live: true, href: '/marketplace' },
  { key: 'connect', label: 'Connect', Icon: MessageCircle, text: 'A private NEXUS conversation with the right agent. No phone numbers handed out.', live: true, href: '/marketplace' },
  { key: 'arrange', label: 'Arrange', Icon: CalendarDays, text: 'Viewings inside the owner\'s real hours, confirmed by the owner in NEXUS Sync.', live: true },
  { key: 'transact', label: 'Transact', Icon: FileSignature, text: 'The Deal Room: stages, documents, drafts and payment requests that never pretend money arrived.', live: true },
  { key: 'complete', label: 'Complete', Icon: KeyRound, text: 'Handover with condition evidence and a verified completion.', live: false },
  { key: 'continue', label: 'Continue', Icon: Home, text: 'The Property Workspace stays: services, maintenance and documents for as long as you need them.', live: false },
  { key: 'expand', label: 'Expand', Icon: HardHat, text: 'The same depth for Booking, Work, Services, Mobility and Hospitality, each with its own workflow.', live: false },
]
export function MorePage({ exchangeHref }: { exchangeHref: string }) {
  const reduce = useReducedMotion()
  const mp = useMpPath()
  return (
    <main className="mp mx mx-more">
      <MarketplaceNav active="more" />
      <Hero kicker="NEXUS · More Marketplaces" title={<>Beyond listings.<br /><span className="mx-muted">Built around the entire process.</span></>}>
        <p>A marketplace should understand the industry it serves. Real estate is the first one we build end to end: one property, one connected experience.</p>
      </Hero>
      <ol className="mx-steps">
        {STEPS.map((s, i) => (
          <motion.li key={s.key} initial={reduce ? false : { opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }} transition={{ type: 'spring', stiffness: 220, damping: 28, delay: reduce ? 0 : 0.04 }}>
            <span className="mx-step-n">{String(i + 1).padStart(2, '0')}</span>
            <s.Icon size={22} aria-hidden="true" />
            <span className="mx-step-body"><b>{s.label}</b><span>{s.text}</span></span>
            <span className="mx-state" data-live={s.live || undefined}>{s.live ? <><Check size={12} aria-hidden="true" />Live</> : 'Next'}</span>
            {s.href && <Link href={mp(s.href)} className="mx-step-go" aria-label={`Open: ${s.label}`}><ArrowRight size={16} /></Link>}
          </motion.li>
        ))}
      </ol>
      <section className="mx-note"><b>Industry by industry</b><p>Each marketplace gets its own workflow instead of a generic listing template. Next to Real Estate: <a href="https://nexusbooking.one">NEXUS Booking</a> for stays and appointments, Workers for property services, Jobs for hiring. Agencies working together use <a href={exchangeHref}>NEXUS Exchange</a>.</p></section>
    </main>
  )
}
