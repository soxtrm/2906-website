'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, BusFront, CircleAlert, HeartPulse, MapPinned, ShoppingBasket, Sparkles, Waves } from 'lucide-react'
import type { PropertyLifeOverview as Overview } from '@/lib/nexus-property-context'
import styles from './property-life-overview.module.css'

const icons = {
  groceries: ShoppingBasket,
  coast: Waves,
  health: HeartPulse,
  movement: BusFront,
}

function distance(value: number) {
  return value < 1 ? `${Math.max(50, Math.round(value * 1000 / 50) * 50)} m` : `${value.toFixed(1)} km`
}

export function PropertyLifeOverview({ overview }: { overview: Overview }) {
  const [active, setActive] = useState<Overview['categories'][number]['key']>('groceries')
  const category = overview.categories.find(item => item.key === active) || overview.categories[0]
  const Icon = icons[category.key]

  return (
    <section className={styles.frame} aria-labelledby="life-overview-title">
      <header className={styles.heading}>
        <div>
          <span>2906 AREA PERSPECTIVE</span>
          <h2 id="life-overview-title">The practical picture, before a viewing.</h2>
          <p>Useful mapped context around {overview.area}. No invented score and no claim about the exact front door.</p>
        </div>
        <div className={styles.powered}><Sparkles aria-hidden="true" /><span>Powered by<br /><b>Nexus Link</b></span></div>
      </header>

      <div className={styles.verdictGrid}>
        <article className={styles.advantages}>
          <span>WHAT WORKS HERE</span>
          <ul>{overview.advantages.map(item => <li key={item}><i>+</i><span>{item}</span></li>)}</ul>
        </article>
        <article className={styles.considerations}>
          <span>WORTH CHECKING</span>
          <ul>{overview.considerations.map(item => <li key={item}><CircleAlert aria-hidden="true" /><span>{item}</span></li>)}</ul>
        </article>
      </div>

      <div className={styles.explorer}>
        <nav aria-label="Explore area facts">
          {overview.categories.map(item => {
            const ItemIcon = icons[item.key]
            return <button key={item.key} type="button" aria-pressed={active === item.key} onClick={() => setActive(item.key)}><ItemIcon aria-hidden="true" /><span>{item.label}</span></button>
          })}
        </nav>
        <div className={styles.categoryHeading}>
          <span className={styles.categoryIcon}><Icon aria-hidden="true" /></span>
          <div><h3>{category.label}</h3><p>{category.summary}</p></div>
          <span className={styles.areaPin}><MapPinned aria-hidden="true" /> area pin</span>
        </div>
        {category.places.length ? (
          <div className={styles.placeGrid}>
            {category.places.map(place => <article key={place.id} className={place.role === 'weekly-shop' ? styles.primaryPlace : undefined}>
              <span>{place.role === 'weekly-shop' ? 'WEEKLY SHOP' : place.role === 'top-up' ? 'QUICK ESSENTIALS' : place.kind.replaceAll('_', ' ').toUpperCase()}</span>
              <strong>{place.name}</strong>
              <div><b>{distance(place.distanceKm)}</b><small>straight-line from the area pin</small></div>
            </article>)}
          </div>
        ) : <p className={styles.empty}>This category is not sufficiently mapped yet. It stays unknown instead of becoming a made-up score.</p>}
      </div>

      <footer className={styles.footer}>
        <span>Privacy-safe location · mapped places · exact routes available in the full explorer</span>
        <Link href={`/link-marketplace?property=${encodeURIComponent(overview.reference)}`}>Open routes &amp; map <ArrowUpRight aria-hidden="true" /></Link>
      </footer>
    </section>
  )
}
