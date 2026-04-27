'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { useSearchParams } from 'next/navigation'
import { Header } from './header'
import { Footer } from './footer'
import { PropertyFilters } from './property-filters'
import { PropertyCard } from './property-card'
import { fetchProperties } from '@/lib/api'
import type { Property, PropertyCategory } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Sparkles, ArrowRight, Loader2 } from 'lucide-react'

interface ListingsPageProps {
  category: PropertyCategory | null
  title: string
  description: string
  subheadline?: string
  tagline?: string
  accentColor: string
  minPrice?: number
  showAestheticsBanner?: boolean
}

function ListingsContent({ category, title, description, subheadline, tagline, accentColor, minPrice, showAestheticsBanner }: ListingsPageProps) {
  const searchParams = useSearchParams()
  const [allProperties, setAllProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'all' | 'standard' | 'aesthetics'>('all')

  useEffect(() => {
    setLoading(true)

    const urlMinPrice = searchParams.get('minPrice')
    const urlMaxPrice = searchParams.get('maxPrice')
    const urlLocation = searchParams.get('location')
    const urlBeds     = searchParams.get('beds')  // e.g. "2" or "2,3" or "Studio"

    fetchProperties({
      ...(category !== null && { category }),
      minPrice:  urlMinPrice ? Number(urlMinPrice) : minPrice,
      maxPrice:  urlMaxPrice ? Number(urlMaxPrice) : undefined,
      location:  urlLocation || undefined,
      bedrooms:  urlBeds     || undefined,
    })
      .then(data => {
        let result = data
        if (category === 'letting') {
          result = data.filter((p: Property) => p.category === 'letting' || p.category === 'aesthetics')
        }
        setAllProperties(result)
      })
      .catch(() => setAllProperties([]))
      .finally(() => setLoading(false))
  }, [category, minPrice, searchParams])

  return (
    <main className="min-h-screen bg-off-white overflow-x-hidden">
      <Header />

      {/* Page Header */}
      <section className="pt-28 pb-10 bg-navy">
        <div className="container mx-auto px-4 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn('max-w-2xl mx-auto', subheadline ? 'text-left md:text-center' : 'text-center')}
          >
            <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-3">{title}</h1>
            {subheadline && (
              <p className="text-white/55 text-sm md:text-base font-light mb-3">{subheadline}</p>
            )}
            {tagline ? (
              <p className="text-gold/70 text-xs md:text-sm italic tracking-wide">{tagline}</p>
            ) : description ? (
              <p className="text-white/70 max-w-2xl mx-auto text-sm md:text-base">{description}</p>
            ) : null}
          </motion.div>
        </div>
      </section>

      {/* Category Tabs — letting page only */}
      {showAestheticsBanner && (
        <div className="bg-white border-b border-gray-100">
          <div className="container mx-auto px-4 lg:px-8">
            <div className="flex items-center gap-1 py-2 overflow-x-auto">
              {(['all', 'standard', 'aesthetics'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-medium whitespace-nowrap transition-all',
                    tab === 'aesthetics'
                      ? activeTab === 'aesthetics'
                        ? 'border border-[#C9A961] bg-[#C9A961]/10 text-[#9a7935] shadow-[0_0_8px_rgba(201,169,97,0.25)]'
                        : 'border border-[#C9A961]/60 text-[#9a7935]/80 hover:border-[#C9A961] hover:bg-[#C9A961]/5 hover:shadow-[0_0_6px_rgba(201,169,97,0.2)]'
                      : activeTab === tab
                        ? 'bg-navy text-white'
                        : 'bg-off-white text-navy/60 hover:bg-navy/8 hover:text-navy'
                  )}
                >
                  {tab === 'aesthetics' && <Sparkles className="w-3 h-3" />}
                  {tab === 'all' ? 'All' : tab === 'standard' ? 'Standard' : 'Aesthetics'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <PropertyFilters accentColor={accentColor} />

      {/* Property Grid */}
      <section className="py-10 md:py-12">
        <div className="container mx-auto px-4 lg:px-8">
          {loading ? (
            <div className="flex items-center justify-center py-24 gap-3 text-navy/50">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading properties…</span>
            </div>
          ) : (() => {
            const displayed = showAestheticsBanner
              ? activeTab === 'standard'
                ? allProperties.filter(p => p.category === 'letting')
                : activeTab === 'aesthetics'
                  ? allProperties.filter(p => p.category === 'aesthetics')
                  : allProperties
              : allProperties
            return displayed.length > 0 ? (
              <>
                <p className="text-navy/60 text-sm mb-6">
                  {displayed.length} {displayed.length === 1 ? 'property' : 'properties'}
                </p>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-8">
                  {displayed.map((property, index) => (
                    <PropertyCard key={property.id} property={property} index={index} />
                  ))}
                </div>
              </>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center py-16"
              >
                <div className="w-16 h-16 rounded-full bg-navy/5 flex items-center justify-center mx-auto mb-4">
                  <span className="text-2xl">🏠</span>
                </div>
                <h3 className="font-serif text-xl text-navy mb-2">No Properties Found</h3>
                <p className="text-navy/60 text-sm">
                  We don&apos;t have any properties matching your criteria at the moment.
                </p>
              </motion.div>
            )
          })()}
        </div>
      </section>

      <Footer />
    </main>
  )
}

export function ListingsPage(props: ListingsPageProps) {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-off-white flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-navy/40" />
      </main>
    }>
      <ListingsContent {...props} />
    </Suspense>
  )
}
