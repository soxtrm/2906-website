'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import {
  ArrowUpRight,
  Bath,
  BedDouble,
  Building2,
  Check,
  Compass,
  MapPin,
  Ruler,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Header } from '@/components/header'
import { Hero } from '@/components/hero'
import { PropertySearch } from '@/components/property-search'
import { MaltaMap } from '@/components/malta-map'
import { MaltaLifestyle } from '@/components/malta-lifestyle'
import { Footer } from '@/components/footer'
import { fetchFeaturedProperties, fetchProperties } from '@/lib/api'
import type { Property } from '@/lib/types'
import styles from './estate-modern-home.module.css'

type Collection = 'aesthetic' | 'all'

const FALLBACK_FEATURES = ['Property facts', 'Local context', 'Human guidance']

function humanize(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function displayTitle(property: Property) {
  const location = property.location?.trim().toLowerCase()
  const usefulParts = String(property.title || '')
    .split('|')
    .map(part => part.trim())
    .filter(part => {
      const normalized = part.toLowerCase()
      return normalized &&
        normalized !== location &&
        !/€|\bbed(room)?s?\b|\bbath(room)?s?\b|^\d[\d,.]*$/.test(normalized)
    })
  return usefulParts.join(' · ') || humanize(String(property.propertyType || 'Residence'))
}

function formatPrice(property: Property) {
  const price = `€${Number(property.price || 0).toLocaleString('en-GB')}`
  return property.priceType === 'month' ? `${price}/mo` : price
}

function propertySignals(property: Property) {
  const raw = [...(property.featureTags || []), ...(property.features || [])]
    .map(value => String(value).trim())
    .filter(Boolean)
  return Array.from(new Set(raw.map(humanize))).slice(0, 4)
}

function ModernPropertyCard({ property, index }: { property: Property; index: number }) {
  const t = useTranslations('modernHome')
  const reduceMotion = useReducedMotion()
  const signals = propertySignals(property)
  const photo = property.images?.[0] || '/placeholder.jpg'
  const nexusHref = `/Link#/property/${encodeURIComponent(property.id)}`
  const title = displayTitle(property)

  return (
    <motion.article
      className={styles.propertyCard}
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.55, delay: Math.min(index * 0.07, 0.28), ease: [0.22, 1, 0.36, 1] }}
    >
      <Link href={`/property/${property.slug}`} className={styles.imageLink} aria-label={`${t('viewProperty')} ${title}`}>
        <img src={photo} alt={title} className={styles.propertyImage} loading={index > 1 ? 'lazy' : 'eager'} />
        <span className={styles.imageVeil} />
        <div className={styles.cardTopline}>
          <span className={styles.statusMark}><span />{t(`status.${property.status}`)}</span>
          <span className={styles.price}>{formatPrice(property)}</span>
        </div>
        <div className={styles.imageCopy}>
          <span>{property.propertyType}</span>
          <h3>{title}</h3>
          <p><MapPin aria-hidden="true" /> {property.location}</p>
        </div>
      </Link>

      <div className={styles.factRail} aria-label={t('propertyFacts')}>
        <span><BedDouble aria-hidden="true" /> <b>{property.bedrooms || '–'}</b> {t('beds')}</span>
        <span><Bath aria-hidden="true" /> <b>{property.bathrooms || '–'}</b> {t('baths')}</span>
        <span><Ruler aria-hidden="true" /> <b>{property.area || '–'}</b> m²</span>
      </div>

      <div className={styles.nexusPanel}>
        <div className={styles.nexusHeading}>
          <div>
            <span className={styles.nexusEyebrow}>{t('nexusEyebrow')}</span>
            <strong>{t('nexusTitle')}</strong>
          </div>
          <Sparkles aria-hidden="true" />
        </div>
        <div className={styles.signalTags}>
          {(signals.length ? signals : FALLBACK_FEATURES).map(signal => (
            <span key={signal}><Check aria-hidden="true" />{signal}</span>
          ))}
        </div>
        <div className={styles.nexusFooter}>
          <span>{t('poweredBy')}</span>
          <Link href={nexusHref} aria-label={`${t('openNexus')} ${title}`}>
            {t('openNexus')} <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </div>
    </motion.article>
  )
}

function PropertyCollection() {
  const t = useTranslations('modernHome')
  const [collection, setCollection] = useState<Collection>('aesthetic')
  const [featured, setFeatured] = useState<Property[]>([])
  const [all, setAll] = useState<Property[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    Promise.all([fetchFeaturedProperties(), fetchProperties({ status: 'available' })])
      .then(([featuredData, allData]) => {
        if (!active) return
        setFeatured(featuredData)
        setAll(allData)
      })
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [])

  const aesthetic = useMemo(() => {
    const premium = all.filter(property => property.category === 'aesthetics' || property.featured)
    const combined = Array.from(new Map([...featured, ...premium].map(property => [property.id, property])).values())
    const curatedRank = new Map(featured.map((property, index) => [property.id, Math.max(0, 60 - index * 8)]))
    return combined
      .sort((a, b) => {
        const score = (property: Property) =>
          (property.category === 'aesthetics' ? 100 : 0) +
          Math.min(property.images?.length || 0, 12) * 2 +
          (propertySignals(property).some(tag => /sea|terrace|pool|view|design/i.test(tag)) ? 18 : 0) +
          (curatedRank.get(property.id) || 0) -
          (property.priceType === 'month' && Number(property.price) > 10000 ? 100 : 0)
        return score(b) - score(a)
      })
  }, [all, featured])

  const visible = (collection === 'aesthetic' ? aesthetic : all).slice(0, 6)

  return (
    <section className={styles.collection} id="collection">
      <div className={styles.shell}>
        <div className={styles.sectionHeading}>
          <div>
            <p>{t('collectionEyebrow')}</p>
            <h2>{t('collectionTitle')}</h2>
          </div>
          <p className={styles.sectionIntro}>{t('collectionIntro')}</p>
        </div>

        <div className={styles.collectionControls}>
          <div className={styles.tabs} role="tablist" aria-label={t('collectionTabs')}>
            <button role="tab" aria-selected={collection === 'aesthetic'} onClick={() => setCollection('aesthetic')}>
              {t('aestheticTab')}
            </button>
            <button role="tab" aria-selected={collection === 'all'} onClick={() => setCollection('all')}>
              {t('allTab')}
            </button>
          </div>
          <Link href={collection === 'aesthetic' ? '/aesthetics' : '/all-properties'} className={styles.textLink}>
            {t('viewCollection')} <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>

        {loading ? (
          <div className={styles.loadingGrid} aria-live="polite">
            <span>{t('loading')}</span>
          </div>
        ) : visible.length ? (
          <div className={styles.propertyGrid}>
            {visible.map((property, index) => <ModernPropertyCard key={property.id} property={property} index={index} />)}
          </div>
        ) : (
          <p className={styles.empty}>{t('empty')}</p>
        )}
      </div>
    </section>
  )
}

function EditorialPromise() {
  const t = useTranslations('modernHome')
  const reduceMotion = useReducedMotion()
  const points = [
    { icon: Compass, title: t('promise.localTitle'), text: t('promise.localText') },
    { icon: ShieldCheck, title: t('promise.verifiedTitle'), text: t('promise.verifiedText') },
    { icon: Building2, title: t('promise.accessTitle'), text: t('promise.accessText') },
  ]

  return (
    <section className={styles.promise}>
      <div className={styles.shell}>
        <motion.div
          className={styles.promiseIntro}
          initial={reduceMotion ? false : { opacity: 0, y: 22 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
        >
          <span>{t('promise.eyebrow')}</span>
          <h2>{t('promise.title')}</h2>
          <p>{t('promise.text')}</p>
        </motion.div>
        <div className={styles.promiseGrid}>
          {points.map(({ icon: Icon, title, text }, index) => (
            <motion.div
              key={title}
              className={styles.promiseItem}
              initial={reduceMotion ? false : { opacity: 0, y: 16 }}
              whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
            >
              <span className={styles.iconFrame}><Icon aria-hidden="true" /></span>
              <div><strong>{title}</strong><p>{text}</p></div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

function NexusInvitation() {
  const t = useTranslations('modernHome')
  const reduceMotion = useReducedMotion()
  return (
    <section className={styles.nexusInvitation}>
      <motion.div
        className={styles.nexusInvitationInner}
        initial={reduceMotion ? false : { opacity: 0, y: 24 }}
        whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.25 }}
      >
        <div className={styles.nexusStar} aria-hidden="true"><Sparkles /></div>
        <div>
          <span>{t('nexusInvite.eyebrow')}</span>
          <h2>{t('nexusInvite.title')}</h2>
          <p>{t('nexusInvite.text')}</p>
        </div>
        <Link href="/Link" className={styles.nexusButton}>
          {t('nexusInvite.cta')} <ArrowUpRight aria-hidden="true" />
        </Link>
      </motion.div>
    </section>
  )
}

export function EstateModernHome() {
  return (
    <main className={styles.page}>
      <Header heroPage />
      <div className={styles.heroWrap}>
        <Hero />
        <div className={styles.heroSearch}>
          <div className={styles.shell}><PropertySearch /></div>
        </div>
      </div>
      <EditorialPromise />
      <PropertyCollection />
      <NexusInvitation />
      <MaltaMap />
      <MaltaLifestyle />
      <Footer />
    </main>
  )
}
