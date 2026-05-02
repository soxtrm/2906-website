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

  useEffect(() => {
    setLoading(true)

    const urlMinPrice = searchParams.get('minPrice')
    const urlMaxPrice = searchParams.get('maxPrice')
    const urlLocation = searchParams.get('location')
    const urlBeds     = searchParams.get('beds')
    const urlBaths    = searchParams.get('baths')
    const urlSqm      = searchParams.get('sqm')

    fetchProperties({
      ...(category !== null && { category }),
      minPrice:  urlMinPrice ? Number(urlMinPrice) : minPrice,
      maxPrice:  urlMaxPrice ? Number(urlMaxPrice) : undefined,
      location:  urlLocation || undefined,
      bedrooms:  urlBeds     || undefined,
      bathrooms: urlBaths    || undefined,
      area:      urlSqm      || undefined,
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

      {/* Aesthetics Banner */}
      {showAestheticsBanner && (
        <section className="bg-gradient-to-r from-accent-aesthetics/10 via-gold/5 to-accent-aesthetics/10 border-y border-[#C9A961]/50 shadow-[0_1px_12px_rgba(201,169,97,0.12)]">
          <div className="container mx-auto px-4 lg:px-8">
            <Link href="/aesthetics">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="py-4 flex items-center justify-between gap-4 group cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#C9A961]/15 flex items-center justify-center shrink-0 ring-1 ring-[#C9A961]/40">
                    <Sparkles className="w-5 h-5 text-[#C9A961]" />
                  </div>
                  <div>
                    <p className="font-serif text-navy text-sm md:text-base">
                      Looking for <span className="text-[#9a7935] font-semibold">Premium Luxury</span>?
                    </p>
                    <p className="text-navy/60 text-xs md:text-sm">
                      Explore our Aesthetics collection — exclusive properties starting from €2,500/month
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[#9a7935] text-sm font-medium shrink-0">
                  <span className="hidden sm:inline">View Aesthetics</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </div>
              </motion.div>
            </Link>
          </div>
        </section>
      )}

      {/* Filters */}
      <PropertyFilters accentColor={accentColor} category={category} />

      {/* Property Grid */}
      <section className="py-10 md:py-12">
        <div className="container mx-auto px-4 lg:px-8">
          {loading ? (
            <div className="flex items-center justify-center py-24 gap-3 text-navy/50">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading properties…</span>
            </div>
          ) : allProperties.length > 0 ? (
            <>
              <p className="text-navy/60 text-sm mb-6">
                {allProperties.length} {allProperties.length === 1 ? 'property' : 'properties'}
              </p>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-8">
                {allProperties.map((property, index) => (
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
          )}
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
