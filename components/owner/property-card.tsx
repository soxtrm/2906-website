'use client'
import Link from 'next/link'
import { termsLine, type Property } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { activeOffer, ago, modeLabel, niceDate, priceLine } from './format'

const LISTING: Record<Property['listing'], { label: string; tone: string }> = {
  live: { label: 'Live', tone: '' }, paused: { label: 'Paused', tone: 'honey' }, private: { label: 'Private', tone: 'plain' }, draft: { label: 'Being checked', tone: 'honey' },
}

export function availabilityLine(p: Property, today: string) {
  if (p.mode === 'rooms') {
    const free = p.rooms.filter(r => r.status === 'available')
    return free.length ? `${free.length} of ${p.rooms.length} rooms free` : 'All rooms taken'
  }
  if (p.tenancyUntil && p.tenancyUntil > today) return `Let until ${niceDate(p.tenancyUntil, false)}`
  if (p.availableFrom && p.availableFrom > today) return `Free from ${niceDate(p.availableFrom, false)}`
  return 'Free now'
}

export function PropertyCard({ p }: { p: Property }) {
  const { requests, today } = useOwner()
  const waiting = requests.filter(r => r.propertyId === p.id && r.status === 'awaiting_owner').length
  const agencies = p.channels.filter(c => c.agencyId && c.state === 'live').length
  return (
    <Link href={`/owner/properties/${p.id}`} className="ow-prop">
      <div className="ow-prop-photo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={p.photos[0]} alt="" />
        <span className="ow-chip">{modeLabel(p)}</span>
      </div>
      <div className="ow-prop-body">
        <div className="ow-prop-title">
          <h3>{p.name}</h3>
          <span className={`ow-chip ${LISTING[p.listing].tone}`}>{LISTING[p.listing].label}</span>
        </div>
        <p className="ow-muted">{p.address}</p>
        <p className="ow-price">{priceLine(activeOffer(p))}{p.mode === 'rooms' && <small> per room from</small>}</p>
        {activeOffer(p)?.terms && termsLine(activeOffer(p)!.mode, activeOffer(p)!.terms) && <p className="ow-faint">{termsLine(activeOffer(p)!.mode, activeOffer(p)!.terms)}</p>}
        <div className="ow-facts"><span>{availabilityLine(p, today)}</span><span>Updated {ago(p.updatedAt, today)}</span></div>
        <div className="ow-row-chips">
          {waiting > 0 && <span className="ow-chip honey">{waiting} request{waiting > 1 ? 's' : ''} waiting</span>}
          <span className="ow-chip plain">{agencies ? `${agencies} agenc${agencies > 1 ? 'ies' : 'y'}` : 'No agencies'}</span>
          {p.channels.some(c => c.channel === 'NEXUS Direct' && c.state === 'live') && <span className="ow-chip plain">NEXUS Direct</span>}
        </div>
      </div>
    </Link>
  )
}
