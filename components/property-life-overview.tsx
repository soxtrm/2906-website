'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, BusFront, CarFront, Check, CircleAlert, Footprints, HeartPulse, MapPinned, Route, ShoppingBasket, Sparkles, Star, Waves } from 'lucide-react'
import type { PropertyLifeOverview as Overview } from '@/lib/nexus-property-context'
import styles from './property-life-overview.module.css'

const icons = { groceries: ShoppingBasket, coast: Waves, health: HeartPulse, movement: BusFront }
type RouteEvidence = { id: string; routeVerified?: boolean; walkingSeconds?: number | null; drivingSeconds?: number | null }
const distance = (value: number) => value < 1 ? `${Math.max(50, Math.round(value * 1000 / 50) * 50)} m` : `${value.toFixed(1)} km`
const minutes = (value?: number | null) => Number.isFinite(value) ? `${Math.max(1, Math.round(Number(value) / 60))} min` : null

export function PropertyLifeOverview({ overview }: { overview: Overview }) {
  const [active, setActive] = useState<Overview['categories'][number]['key']>('groceries')
  const [routes, setRoutes] = useState<Record<string, RouteEvidence>>({})
  const category = overview.categories.find(item => item.key === active) || overview.categories[0]
  const Icon = icons[category.key]

  useEffect(() => {
    let alive = true
    fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}`)
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (!alive || !payload?.places) return
        setRoutes(Object.fromEntries(payload.places.map((item: RouteEvidence) => [item.id, item])))
      }).catch(() => {})
    return () => { alive = false }
  }, [overview.reference])

  const nearest = useMemo(() => ({
    groceries: overview.categories.find(item => item.key === 'groceries')?.places.find(place => place.role === 'weekly-shop'),
    coast: overview.categories.find(item => item.key === 'coast')?.places[0],
    health: overview.categories.find(item => item.key === 'health')?.places[0],
  }), [overview.categories])
  const summaryStats = [
    { key: 'groceries' as const, label: 'Weekly shop', value: nearest.groceries ? distance(nearest.groceries.distanceKm) : 'Mapping', detail: nearest.groceries?.name || 'Large store pending', Icon: ShoppingBasket },
    { key: 'coast' as const, label: 'Coast', value: nearest.coast ? distance(nearest.coast.distanceKm) : 'Mapping', detail: nearest.coast?.name || 'Coastal option pending', Icon: Waves },
    { key: 'health' as const, label: 'Health', value: nearest.health ? distance(nearest.health.distanceKm) : 'Mapping', detail: nearest.health?.name || 'Health option pending', Icon: HeartPulse },
    { key: 'movement' as const, label: 'Area signals', value: String(overview.mappedCount), detail: 'mapped within 3 km', Icon: MapPinned },
  ]

  return <section className={styles.frame} aria-labelledby="life-overview-title">
    <header className={styles.heading}>
      <div className={styles.headingCopy}>
        <span>2906 SMART AREA BRIEF · {overview.area.toUpperCase()}</span>
        <h2 id="life-overview-title">See how this home fits real life.</h2>
        <p>Shopping, coast, health and movement in one clear view. Routes appear only where a mapped connection is available.</p>
      </div>
      <div className={styles.powered}><Sparkles aria-hidden="true" /><span>Intelligence by<br /><b>Nexus Link</b></span></div>
    </header>

    <div className={styles.statRail} aria-label="Property area highlights">
      {summaryStats.map(item => <button key={item.key} type="button" onClick={() => setActive(item.key)} aria-pressed={active === item.key}>
        <span className={styles.statIcon}><item.Icon aria-hidden="true" /></span>
        <span><small>{item.label}</small><b>{item.value}</b><em>{item.detail}</em></span>
        <ArrowUpRight aria-hidden="true" />
      </button>)}
    </div>

    <div className={styles.verdictGrid}>
      <article className={styles.advantages}><span>AT A GLANCE · ADVANTAGES</span><ul>{overview.advantages.map(item => <li key={item}><i><Check aria-hidden="true" /></i><span>{item}</span></li>)}</ul></article>
      <article className={styles.considerations}><span>CHECK BEFORE YOU DECIDE</span><ul>{overview.considerations.map(item => <li key={item}><CircleAlert aria-hidden="true" /><span>{item}</span></li>)}</ul></article>
    </div>

    <div className={styles.explorer}>
      <div className={styles.explorerTop}>
        <div><span>EXPLORE THE AREA</span><h3>Useful places, ordered by proximity.</h3></div>
        <nav aria-label="Explore area facts">{overview.categories.map(item => { const ItemIcon = icons[item.key]; return <button key={item.key} type="button" aria-pressed={active === item.key} onClick={() => setActive(item.key)}><ItemIcon aria-hidden="true" /><span>{item.label}</span></button> })}</nav>
      </div>
      <div className={styles.categoryHeading}>
        <span className={styles.categoryIcon}><Icon aria-hidden="true" /></span>
        <div><h3>{category.label}</h3><p>{category.summary}</p></div>
        <span className={styles.areaPin}><Route aria-hidden="true" /> {overview.sourceBasis === 'property' ? 'property area' : 'locality model'}</span>
      </div>
      {category.places.length ? <div className={styles.placeGrid}>{category.places.map((place, index) => {
        const route = routes[place.id]
        const walk = route?.routeVerified ? minutes(route.walkingSeconds) : null
        const drive = route?.routeVerified ? minutes(route.drivingSeconds) : null
        return <article key={place.id} className={place.role === 'weekly-shop' ? styles.primaryPlace : undefined}>
          <div className={styles.placeTop}><span>{place.role === 'weekly-shop' ? 'WEEKLY SHOP' : place.role === 'top-up' ? 'QUICK ESSENTIALS' : place.kind.replaceAll('_', ' ').toUpperCase()}</span><i>0{index + 1}</i></div>
          <strong>{place.name}</strong>
          {place.rating ? <span className={styles.rating}><Star aria-hidden="true" /> {place.rating.toFixed(1)}{place.reviews ? ` · ${place.reviews.toLocaleString()} reviews` : ''}</span> : null}
          <div className={styles.routeStrip}>
            <span><MapPinned aria-hidden="true" /><small>Area distance</small><b>{distance(place.distanceKm)}</b></span>
            <span><Footprints aria-hidden="true" /><small>Walk</small><b>{walk || 'Route check'}</b></span>
            <span><CarFront aria-hidden="true" /><small>Car</small><b>{drive || 'Route check'}</b></span>
          </div>
          <small className={styles.evidence}>{route?.routeVerified ? 'MODELLED ROUTE · no live traffic' : 'STRAIGHT-LINE · privacy-safe area pin'}</small>
        </article>
      })}</div> : <p className={styles.empty}>This category is not sufficiently mapped yet. It stays unknown instead of becoming a made-up score.</p>}
    </div>

    <footer className={styles.footer}>
      <span>{overview.sourceBasis === 'property' ? 'Privacy-safe property area' : `${overview.area} locality model`} · mapped places · route evidence labelled separately</span>
      <Link href={`/link-matrix#/property/${encodeURIComponent(overview.reference)}`}>Open Nexus Match Engine <ArrowUpRight aria-hidden="true" /></Link>
    </footer>
  </section>
}
