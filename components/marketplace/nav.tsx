'use client'
// NEXUS Marketplace navigation (Kev, 21 Nov 2026): Residential · Commercial · Short Stays · Workers · Jobs · More Marketplaces.
// Places is no longer a destination (its data lives on in maps, Smart Intelligence and the NEXUS App).
// Short Stays stays separate because calendar, inventory, booking and pricing work differently (NEXUS Booking).
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { MarketplaceLogo } from '@/components/brand/logo'
import { useMpPath } from '@/components/rooms/path'

export type MpSection = 'residential' | 'commercial' | 'stays' | 'workers' | 'jobs' | 'more'
export const MP_SECTIONS: { key: MpSection; label: string; href: string }[] = [
  { key: 'residential', label: 'Residential', href: '/marketplace' },
  { key: 'commercial', label: 'Commercial', href: '/marketplace/commercial' },
  { key: 'stays', label: 'Short Stays', href: '/marketplace/short-stays' },
  { key: 'workers', label: 'Workers', href: '/marketplace/workers' },
  { key: 'jobs', label: 'Jobs', href: '/marketplace/jobs' },
  { key: 'more', label: 'More Marketplaces', href: '/marketplace/more' },
]

export function MarketplaceNav({ active, right }: { active: MpSection; right?: React.ReactNode }) {
  const mp = useMpPath()
  const reduce = useReducedMotion()
  return (
    <header className="mp-top mnav">
      <Link className="mp-brand" href={mp('/marketplace')} aria-label="NEXUS Marketplace"><MarketplaceLogo height={13} /></Link>
      <nav className="mnav-tabs" aria-label="Marketplace">
        {MP_SECTIONS.map(s => (
          <Link key={s.key} href={mp(s.href)} aria-current={s.key === active ? 'page' : undefined} className={s.key === 'more' ? 'mnav-more' : undefined}>
            {s.key === active && <motion.i className="mnav-glider" layoutId="mnav-glider" transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 38 }} />}
            <span>{s.label}</span>
          </Link>
        ))}
      </nav>
      {right && <div className="mnav-right">{right}</div>}
    </header>
  )
}

export type SubItem = { key: string; label: string; href?: string; onClick?: () => void; count?: number | string; external?: boolean; active?: boolean }
export function MarketplaceSubnav({ items, label }: { items: SubItem[]; label: string }) {
  const mp = useMpPath()
  return (
    <div className="mp-seg mnav-sub" role="group" aria-label={label}>
      {items.map(i => {
        const inner = <>{i.label}{i.count !== undefined && <small>{i.count}</small>}{i.external && <small aria-hidden="true">↗</small>}</>
        if (i.onClick) return <button key={i.key} type="button" aria-pressed={!!i.active} onClick={i.onClick}>{inner}</button>
        if (i.external) return <a key={i.key} href={i.href} target="_blank" rel="noopener" className="mnav-sub-link">{inner}</a>
        return <Link key={i.key} href={mp(i.href || '/marketplace')} aria-current={i.active ? 'page' : undefined} className="mnav-sub-link">{inner}</Link>
      })}
    </div>
  )
}
