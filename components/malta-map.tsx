'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MapPin, Check, X, Home, Euro } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { regions } from '@/lib/data'
import type { Region, RegionInfo } from '@/lib/types'

// Actual Malta island shape (simplified but recognizable)
const maltaPath = "M245,85 L265,78 L285,82 L310,95 L335,115 L355,140 L365,170 L370,200 L365,235 L355,265 L340,290 L315,310 L285,325 L255,332 L225,330 L195,320 L170,305 L150,285 L138,260 L130,230 L128,200 L135,170 L148,145 L165,120 L185,100 L210,88 L245,85 Z"
const gozoPath = "M85,45 L120,35 L155,42 L175,58 L180,80 L172,100 L155,115 L125,122 L95,118 L70,105 L55,85 L52,65 L62,50 L85,45 Z"
const cominoPath = "M170,95 L185,92 L195,100 L192,112 L180,118 L168,112 L165,102 L170,95 Z"

// Region polygon paths for colored areas
const regionPaths: Record<string, { path: string; label: { x: number; y: number } }> = {
  'North': {
    path: "M165,120 L185,100 L210,88 L245,85 L265,78 L285,82 L310,95 L300,130 L265,145 L225,150 L185,145 L165,120 Z",
    label: { x: 235, y: 115 }
  },
  'Central East': {
    path: "M300,130 L335,115 L355,140 L365,170 L370,200 L355,205 L330,195 L310,175 L300,150 L300,130 Z",
    label: { x: 340, y: 165 }
  },
  'Central West': {
    path: "M185,145 L225,150 L265,145 L300,150 L310,175 L300,195 L265,205 L225,200 L195,190 L175,175 L170,155 L185,145 Z",
    label: { x: 230, y: 175 }
  },
  'Central Surroundings': {
    path: "M175,175 L195,190 L225,200 L265,205 L300,195 L330,195 L355,205 L365,235 L355,265 L330,250 L295,245 L255,240 L215,245 L175,235 L155,210 L148,185 L175,175 Z",
    label: { x: 255, y: 220 }
  },
  'South': {
    path: "M155,210 L175,235 L215,245 L255,240 L240,275 L210,295 L175,290 L150,270 L138,240 L155,210 Z",
    label: { x: 190, y: 260 }
  },
  'South East': {
    path: "M255,240 L295,245 L330,250 L355,265 L340,290 L315,310 L285,325 L255,332 L225,330 L210,310 L210,295 L240,275 L255,240 Z",
    label: { x: 285, y: 290 }
  },
}

// Region colors - distinct illustrated palette
const regionColors: Record<string, { fill: string; hover: string; text: string }> = {
  'North': { fill: '#A8D5BA', hover: '#8DC4A8', text: '#1B3A2D' },
  'Central East': { fill: '#B8953F', hover: '#A6863A', text: '#fff' },
  'Central West': { fill: '#E8A87C', hover: '#D6966A', text: '#3D1F0A' },
  'Central Surroundings': { fill: '#7BAFD4', hover: '#6A9EC3', text: '#0D2A3D' },
  'South': { fill: '#C8A96E', hover: '#B8995E', text: '#2D1A00' },
  'South East': { fill: '#8FA6C8', hover: '#7E95B7', text: '#0D1F3D' },
  'Gozo': { fill: '#88C5A0', hover: '#75B48F', text: '#0D2A1A' },
}

function RegionPanel({ region, onClose, t }: { region: RegionInfo; onClose: () => void; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      {/* Region Header */}
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

      {/* Description */}
      <p className="text-navy/60 text-sm mb-4 leading-relaxed">
        {region.description}
      </p>

      {/* Key Villages */}
      <div className="mb-4">
        <h4 className="text-xs font-medium text-navy mb-2 flex items-center gap-1.5">
          <MapPin className="w-3 h-3 text-navy/40" />
          Key Villages
        </h4>
        <p className="text-xs text-navy/60">{region.areas.join(', ')}</p>
      </div>

      {/* Price Range */}
      <div className="flex items-center gap-2 mb-4 p-3 bg-gold/5 rounded border border-gold/10">
        <Euro className="w-4 h-4 text-gold" />
        <div>
          <p className="text-[10px] text-navy/40 uppercase tracking-wide">{t('property.priceRange')}</p>
          <p className="text-navy text-sm font-medium">{region.priceRange}</p>
        </div>
      </div>

      {/* Advantages */}
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

      {/* Property Types */}
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
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null)
  const t = useTranslations()

  const handleRegionClick = (regionId: Region) => {
    const region = regions.find(r => r.id === regionId)
    setSelectedRegion(region || null)
  }

  return (
    <section className="py-16 lg:py-24 bg-off-white">
      <div className="container mx-auto px-4 lg:px-6">
        {/* Section Header */}
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
          {/* Interactive Vector Map */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="lg:col-span-3"
          >
            <div className="bg-white rounded-lg shadow-sm p-6 lg:p-8">
              <svg
                viewBox="0 0 420 380"
                className="w-full h-auto"
                style={{ maxHeight: '450px' }}
              >
                {/* Sea background */}
                <defs>
                  <linearGradient id="seaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#E8F4FC" />
                    <stop offset="100%" stopColor="#D5EAF7" />
                  </linearGradient>
                  <filter id="islandShadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="2" dy="3" stdDeviation="4" floodOpacity="0.15"/>
                  </filter>
                </defs>
                <rect x="0" y="0" width="420" height="380" fill="url(#seaGradient)" rx="8" />

                {/* Subtle wave pattern */}
                <g opacity="0.3">
                  {[0, 1, 2, 3, 4].map(i => (
                    <path
                      key={i}
                      d={`M0,${60 + i * 70} Q105,${45 + i * 70} 210,${60 + i * 70} T420,${60 + i * 70}`}
                      fill="none"
                      stroke="#B8D4E8"
                      strokeWidth="1"
                    />
                  ))}
                </g>

                {/* Gozo Island with region */}
                <g filter="url(#islandShadow)">
                  <path
                    d={gozoPath}
                    fill={hoveredRegion === 'Gozo' || selectedRegion?.id === 'Gozo'
                      ? regionColors['Gozo'].hover
                      : regionColors['Gozo'].fill}
                    stroke={selectedRegion?.id === 'Gozo' ? '#1B2A4A' : '#fff'}
                    strokeWidth="1.5"
                    className="cursor-pointer transition-all duration-300"
                    onMouseEnter={() => setHoveredRegion('Gozo')}
                    onMouseLeave={() => setHoveredRegion(null)}
                    onClick={() => handleRegionClick('Gozo')}
                  />
                  <text
                    x="115"
                    y="78"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={regionColors['Gozo'].text}
                    fontSize="11"
                    fontWeight="700"
                    className="pointer-events-none select-none"
                  >
                    Gozo
                  </text>
                </g>

                {/* Comino Island */}
                <g filter="url(#islandShadow)">
                  <path
                    d={cominoPath}
                    fill="#F5EFE6"
                    stroke="#1B2A4A"
                    strokeWidth="1"
                  />
                  <text
                    x="180"
                    y="106"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#1B2A4A"
                    fontSize="7"
                    fontWeight="500"
                    className="pointer-events-none select-none opacity-60"
                  >
                    Comino
                  </text>
                </g>

                {/* Malta Main Island - Base shape */}
                <g filter="url(#islandShadow)">
                  <path
                    d={maltaPath}
                    fill="#F5EFE6"
                    stroke="#1B2A4A"
                    strokeWidth="1.5"
                  />
                </g>

                {/* Colored Region Overlays */}
                {Object.entries(regionPaths).map(([regionId, { path, label }]) => {
                  const isHovered = hoveredRegion === regionId
                  const isSelected = selectedRegion?.id === regionId
                  const colors = regionColors[regionId]

                  return (
                    <g
                      key={regionId}
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredRegion(regionId)}
                      onMouseLeave={() => setHoveredRegion(null)}
                      onClick={() => handleRegionClick(regionId as Region)}
                    >
                      <path
                        d={path}
                        fill={isHovered || isSelected ? colors.hover : colors.fill}
                        stroke={isSelected ? '#1B2A4A' : '#fff'}
                        strokeWidth={isSelected ? 2 : 1.5}
                        className="transition-all duration-200"
                        style={{ opacity: isHovered || isSelected ? 1 : 0.9 }}
                      />
                      <text
                        x={label.x}
                        y={label.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={colors.text}
                        fontSize="9"
                        fontWeight="600"
                        className="pointer-events-none select-none"
                      >
                        {regionId === 'Central Surroundings' ? 'Central' : regionId}
                      </text>
                    </g>
                  )
                })}

                {/* Compass */}
                <g transform="translate(370, 40)">
                  <circle cx="0" cy="0" r="18" fill="white" stroke="#1B2A4A" strokeWidth="0.5" />
                  <text x="0" y="-5" textAnchor="middle" fontSize="8" fill="#1B2A4A" fontWeight="600">N</text>
                  <path d="M0,-10 L3,-2 L0,0 L-3,-2 Z" fill="#1B2A4A" />
                  <path d="M0,10 L3,2 L0,0 L-3,2 Z" fill="#B8953F" />
                </g>

                {/* Scale bar */}
                <g transform="translate(30, 355)">
                  <line x1="0" y1="0" x2="60" y2="0" stroke="#1B2A4A" strokeWidth="1" />
                  <line x1="0" y1="-4" x2="0" y2="4" stroke="#1B2A4A" strokeWidth="1" />
                  <line x1="60" y1="-4" x2="60" y2="4" stroke="#1B2A4A" strokeWidth="1" />
                  <text x="30" y="12" textAnchor="middle" fontSize="8" fill="#1B2A4A" opacity="0.5">10 km</text>
                </g>
              </svg>
            </div>
          </motion.div>

          {/* Region Details Panel — desktop sidebar */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="hidden lg:block lg:col-span-2"
          >
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
                  <h3 className="font-serif text-lg text-navy mb-1">{t('sections.selectRegion')}</h3>
                  <p className="text-navy/50 text-xs mb-4">
                    {t('sections.clickMap')}
                  </p>

                  {/* Quick pills */}
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {regions.slice(0, 4).map((region) => (
                      <button
                        key={region.id}
                        onClick={() => setSelectedRegion(region)}
                        className="px-3 py-1.5 rounded-full text-xs transition-colors bg-off-white text-navy/60 hover:bg-navy hover:text-white"
                      >
                        {region.name}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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
