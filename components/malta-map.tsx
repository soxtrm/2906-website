'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MapPin, Check, X, Home, Euro } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { regions } from '@/lib/data'
import type { Region, RegionInfo } from '@/lib/types'

const REGION_IDS: Region[] = ['Gozo', 'Comino', 'North', 'Central', 'Southeast', 'South']

const OVERLAY_SRC: Record<Region, string> = {
  Gozo:      '/regions/gozo.png',
  Comino:    '/regions/comino.png',
  North:     '/regions/north.png',
  Central:   '/regions/central.png',
  Southeast: '/regions/southeast.png',
  South:     '/regions/south.png',
}

function RegionPanel({ region, onClose, t }: { region: RegionInfo; onClose: () => void; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-serif text-xl text-navy mb-1">{region.name}</h3>
          <p className="text-xs text-navy/50">{region.areas.slice(0, 4).join(' · ')}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-off-white rounded transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4 text-navy/30" />
        </button>
      </div>

      <p className="text-navy/60 text-sm mb-4 leading-relaxed">
        {region.description}
      </p>

      <div className="mb-4">
        <h4 className="text-xs font-medium text-navy mb-2 flex items-center gap-1.5">
          <MapPin className="w-3 h-3 text-navy/40" />
          Key Villages
        </h4>
        <p className="text-xs text-navy/60">{region.areas.join(', ')}</p>
      </div>

      <div className="flex items-center gap-2 mb-4 p-3 bg-gold/5 rounded border border-gold/10">
        <Euro className="w-4 h-4 text-gold" />
        <div>
          <p className="text-[10px] text-navy/40 uppercase tracking-wide">{t('property.priceRange')}</p>
          <p className="text-navy text-sm font-medium">{region.priceRange}</p>
        </div>
      </div>

      <div className="mb-4">
        <h4 className="text-xs font-medium text-navy mb-2 flex items-center gap-1.5">
          <Check className="w-3 h-3 text-status-available" />
          {t('property.advantages')}
        </h4>
        <ul className="space-y-1">
          {region.advantages.slice(0, 4).map((adv, i) => (
            <li key={i} className="text-xs text-navy/60 flex items-start gap-1.5">
              <span className="w-1 h-1 rounded-full bg-gold mt-1.5 shrink-0" />
              {adv}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="text-xs font-medium text-navy mb-2 flex items-center gap-1.5">
          <Home className="w-3 h-3 text-navy/40" />
          {t('property.typicalProperties')}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {region.typicalProperties.map((prop, i) => (
            <span
              key={i}
              className="px-2 py-1 bg-off-white rounded text-xs text-navy/60"
            >
              {prop}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function MaltaMap() {
  const [selectedRegion, setSelectedRegion] = useState<RegionInfo | null>(null)
  const [hoveredRegion, setHoveredRegion] = useState<Region | null>(null)
  const t = useTranslations()

  const active: Region | null = hoveredRegion || selectedRegion?.id || null

  const handleRegionClick = (regionId: Region) => {
    const region = regions.find(r => r.id === regionId)
    setSelectedRegion(prev => (prev?.id === regionId ? null : region || null))
  }

  return (
    <section className="py-16 lg:py-24 bg-off-white">
      <div className="container mx-auto px-4 lg:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <p className="text-gold text-xs tracking-[0.2em] uppercase mb-2">{t('sections.discover')}</p>
          <h2 className="font-serif text-2xl md:text-3xl lg:text-4xl text-navy mb-3">
            {t('sections.exploreRegions')}
          </h2>
          <p className="text-navy/50 text-sm max-w-lg mx-auto">
            {t('sections.clickRegion')}
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-5 gap-8 items-start">
          {/* Image-based interactive map */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="lg:col-span-3"
          >
            <div className="bg-white rounded-lg shadow-sm p-4 lg:p-6">
              <div className="relative w-full aspect-square">
                {/* Base outline */}
                <img
                  src="/regions/malta-base.png"
                  alt="Malta map outline"
                  className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
                  draggable={false}
                />

                {/* Region overlays — clickable, fade in on hover/select */}
                {REGION_IDS.map(id => {
                  const isActive = active === id
                  return (
                    <img
                      key={id}
                      src={OVERLAY_SRC[id]}
                      alt={`${id} region`}
                      onMouseEnter={() => setHoveredRegion(id)}
                      onMouseLeave={() => setHoveredRegion(null)}
                      onClick={() => handleRegionClick(id)}
                      draggable={false}
                      className={`
                        absolute inset-0 w-full h-full object-contain
                        cursor-pointer transition-opacity duration-300
                        ${isActive ? 'opacity-100' : 'opacity-0 hover:opacity-100'}
                      `}
                    />
                  )
                })}
              </div>
            </div>
          </motion.div>

          {/* Region list / details */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="lg:col-span-2 flex flex-col gap-4"
          >
            <div className="bg-white rounded-lg shadow-sm p-4">
              <h3 className="font-serif text-base text-navy mb-3">{t('sections.selectRegion')}</h3>
              <div className="flex flex-col gap-2">
                {regions.map(r => {
                  const isSelected = selectedRegion?.id === r.id
                  const isHovered = hoveredRegion === r.id
                  return (
                    <button
                      key={r.id}
                      onMouseEnter={() => setHoveredRegion(r.id)}
                      onMouseLeave={() => setHoveredRegion(null)}
                      onClick={() => handleRegionClick(r.id)}
                      className={`
                        text-left px-3 py-2 rounded border text-sm transition-all
                        ${isSelected
                          ? 'bg-navy text-white border-navy'
                          : isHovered
                            ? 'bg-gold/10 text-navy border-gold/40'
                            : 'bg-white text-navy/80 border-navy/10 hover:border-navy/30'}
                      `}
                    >
                      {r.name}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="hidden lg:block">
              <AnimatePresence mode="wait">
                {selectedRegion ? (
                  <motion.div
                    key={selectedRegion.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <RegionPanel region={selectedRegion} onClose={() => setSelectedRegion(null)} t={t} />
                  </motion.div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="bg-white rounded-lg shadow-sm p-5 text-center"
                  >
                    <div className="w-12 h-12 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-3">
                      <MapPin className="w-5 h-5 text-gold" />
                    </div>
                    <p className="text-navy/50 text-xs">
                      {t('sections.clickMap')}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Mobile modal overlay */}
      <AnimatePresence>
        {selectedRegion && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="lg:hidden fixed inset-0 z-50 bg-navy/50 flex items-end"
            onClick={() => setSelectedRegion(null)}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-h-[80vh] overflow-y-auto rounded-t-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <RegionPanel region={selectedRegion} onClose={() => setSelectedRegion(null)} t={t} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
