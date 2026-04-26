'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { PropertyCard } from './property-card'
import { fetchFeaturedProperties } from '@/lib/api'
import type { Property } from '@/lib/types'

export function FeaturedProperties() {
  const t = useTranslations()
  const [properties, setProperties] = useState<Property[]>([])

  useEffect(() => {
    fetchFeaturedProperties()
      .then(data => { if (data.length > 0) setProperties(data) })
      .catch(() => {})
  }, [])

  if (properties.length === 0) return null

  return (
    <section className="py-16 lg:py-20 bg-white">
      <div className="container mx-auto px-4 lg:px-6">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="flex items-end justify-between mb-8"
        >
          <div>
            <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">{t('sections.curatedSelection')}</p>
            <h2 className="font-serif text-2xl md:text-3xl text-navy">
              {t('sections.featuredProperties')}
            </h2>
          </div>
          <Link
            href="/letting"
            className="hidden sm:flex items-center gap-1.5 text-sm text-navy/60 hover:text-gold transition-colors group"
          >
            {t('sections.viewAll')}
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </motion.div>

        {/* Property Grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {properties.map((property, index) => (
            <PropertyCard key={property.id} property={property} index={index} />
          ))}
        </div>

        {/* Mobile view all link */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="sm:hidden text-center mt-6"
        >
          <Link
            href="/letting"
            className="inline-flex items-center gap-1.5 text-sm text-navy/60 hover:text-gold transition-colors"
          >
            {t('sections.viewAll')}
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </motion.div>
      </div>
    </section>
  )
}
