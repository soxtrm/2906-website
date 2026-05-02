'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, X, SlidersHorizontal, MapPin, Search } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { maltaLocations, propertyTypes, bedroomOptions, bathroomOptions, commercialPropertyTypes } from '@/lib/data'
import { cn } from '@/lib/utils'

interface Filters {
  location: string
  propertyTypes: string[]
  bedrooms: string[]
  bathrooms: string[]
  budget: string
  sqm: string
}

interface PropertyFiltersProps {
  accentColor: string
  category?: string | null
}

export function PropertyFilters({ accentColor, category }: PropertyFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isCommercial = category === 'commercial'

  const [isOpen, setIsOpen] = useState(false)
  const [filters, setFilters] = useState<Filters>({
    location: searchParams.get('location') || '',
    propertyTypes: searchParams.get('types')?.split(',').filter(Boolean) || [],
    bedrooms: searchParams.get('beds')?.split(',').filter(Boolean) || [],
    bathrooms: searchParams.get('baths')?.split(',').filter(Boolean) || [],
    budget: searchParams.get('maxPrice') || '',
    sqm: searchParams.get('sqm') || '',
  })

  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const [locationSearch, setLocationSearch] = useState('')
  const filterRef = useRef<HTMLDivElement>(null)

  const filteredLocations = maltaLocations.filter(loc =>
    loc.toLowerCase().includes(locationSearch.toLowerCase())
  )

  const availablePropertyTypes = isCommercial ? commercialPropertyTypes : propertyTypes

  const applyFilters = () => {
    const params = new URLSearchParams()
    if (filters.location) params.set('location', filters.location)
    if (filters.propertyTypes.length) params.set('types', filters.propertyTypes.join(','))
    if (!isCommercial && filters.bedrooms.length) params.set('beds', filters.bedrooms.join(','))
    if (filters.bathrooms.length) params.set('baths', filters.bathrooms.join(','))
    if (filters.budget) params.set('maxPrice', filters.budget)
    if (isCommercial && filters.sqm) params.set('sqm', filters.sqm)
    router.push(`?${params.toString()}`)
  }

  const clearFilters = () => {
    setFilters({
      location: '',
      propertyTypes: [],
      bedrooms: [],
      bathrooms: [],
      budget: '',
      sqm: '',
    })
    setLocationSearch('')
    router.push(window.location.pathname)
  }

  const toggleBedroom = (bed: string) => {
    setFilters(prev => ({
      ...prev,
      bedrooms: prev.bedrooms.includes(bed)
        ? prev.bedrooms.filter(b => b !== bed)
        : [...prev.bedrooms, bed]
    }))
  }

  const toggleBathroom = (bath: string) => {
    setFilters(prev => ({
      ...prev,
      bathrooms: prev.bathrooms.includes(bath)
        ? prev.bathrooms.filter(b => b !== bath)
        : [...prev.bathrooms, bath]
    }))
  }

  const togglePropertyType = (type: string) => {
    setFilters(prev => ({
      ...prev,
      propertyTypes: prev.propertyTypes.includes(type)
        ? prev.propertyTypes.filter(t => t !== type)
        : [...prev.propertyTypes, type]
    }))
  }

  const activeFiltersCount =
    (filters.location ? 1 : 0) +
    filters.propertyTypes.length +
    filters.bedrooms.length +
    filters.bathrooms.length +
    (filters.budget ? 1 : 0) +
    (filters.sqm ? 1 : 0)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setActiveDropdown(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={filterRef} className="bg-white border-b border-gray-100">
      {/* Accent Line */}
      <div className={cn('h-[2px]', accentColor)} />

      <div className="container mx-auto px-4 lg:px-6 py-3">
        {/* Mobile Toggle */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="lg:hidden flex items-center gap-2 text-navy text-sm font-medium mb-3"
        >
          <SlidersHorizontal className="w-4 h-4" />
          Filters
          {activeFiltersCount > 0 && (
            <span className="bg-gold text-navy text-[10px] px-1.5 py-0.5 rounded-full">
              {activeFiltersCount}
            </span>
          )}
        </button>

        {/* Filters */}
        <div className={cn('flex flex-col lg:flex-row gap-3', isOpen ? 'flex' : 'hidden lg:flex')}>

          {/* Location Search */}
          <div className="relative flex-1 max-w-[220px]">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-navy/30" />
            <input
              type="text"
              placeholder="Search location..."
              value={locationSearch || filters.location}
              onChange={(e) => {
                setLocationSearch(e.target.value)
                setFilters(prev => ({ ...prev, location: '' }))
                setActiveDropdown('location')
              }}
              onFocus={() => setActiveDropdown('location')}
              className="w-full pl-8 pr-7 py-2 bg-off-white border-0 rounded text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50"
            />
            {(locationSearch || filters.location) && (
              <button
                onClick={() => {
                  setLocationSearch('')
                  setFilters(prev => ({ ...prev, location: '' }))
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              >
                <X className="w-3 h-3 text-navy/30 hover:text-navy" />
              </button>
            )}

            <AnimatePresence>
              {activeDropdown === 'location' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 right-0 mt-1 bg-white rounded shadow-lg z-30 max-h-48 overflow-auto border border-gray-100"
                >
                  {filteredLocations.length > 0 ? (
                    filteredLocations.slice(0, 15).map((loc) => (
                      <button
                        key={loc}
                        onClick={() => {
                          setFilters(prev => ({ ...prev, location: loc }))
                          setLocationSearch('')
                          setActiveDropdown(null)
                        }}
                        className="w-full px-3 py-1.5 text-left text-xs text-navy/70 hover:bg-off-white flex items-center gap-1.5"
                      >
                        <MapPin className="w-2.5 h-2.5 text-navy/20" />
                        {loc}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-xs text-navy/40">No locations found</div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Property Types */}
          <div className="relative">
            <button
              onClick={() => setActiveDropdown(activeDropdown === 'propertyType' ? null : 'propertyType')}
              className="flex items-center gap-2 px-3 py-2 bg-off-white rounded text-sm text-navy/70 hover:text-navy"
            >
              <span>
                {filters.propertyTypes.length > 0
                  ? `${filters.propertyTypes.length} type${filters.propertyTypes.length > 1 ? 's' : ''}`
                  : 'Property Type'
                }
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', activeDropdown === 'propertyType' && 'rotate-180')} />
            </button>

            <AnimatePresence>
              {activeDropdown === 'propertyType' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 mt-1 bg-white rounded shadow-lg z-30 p-2 min-w-[240px] max-h-64 overflow-auto border border-gray-100"
                >
                  <div className="flex flex-wrap gap-1">
                    {availablePropertyTypes.map((type) => (
                      <button
                        key={type}
                        onClick={() => togglePropertyType(type)}
                        className={cn(
                          'px-2 py-1 rounded text-[10px] transition-colors',
                          filters.propertyTypes.includes(type)
                            ? 'bg-navy text-white'
                            : 'bg-off-white text-navy/60 hover:bg-navy/10'
                        )}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  {filters.propertyTypes.length > 0 && (
                    <button
                      onClick={() => setFilters(prev => ({ ...prev, propertyTypes: [] }))}
                      className="mt-2 pt-2 border-t border-gray-100 w-full text-[10px] text-navy/40 hover:text-navy"
                    >
                      Clear
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Bedrooms — hidden for commercial */}
          {!isCommercial && (
            <div className="relative">
              <button
                onClick={() => setActiveDropdown(activeDropdown === 'bedrooms' ? null : 'bedrooms')}
                className="flex items-center gap-2 px-3 py-2 bg-off-white rounded text-sm text-navy/70 hover:text-navy"
              >
                <span>
                  {filters.bedrooms.length > 0
                    ? filters.bedrooms.join(', ') + ' bed'
                    : 'Bedrooms'
                  }
                </span>
                <ChevronDown className={cn('w-3 h-3 transition-transform', activeDropdown === 'bedrooms' && 'rotate-180')} />
              </button>

              <AnimatePresence>
                {activeDropdown === 'bedrooms' && (
                  <motion.div
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="absolute top-full left-0 mt-1 bg-white rounded shadow-lg z-30 p-2 border border-gray-100"
                  >
                    <div className="flex gap-1">
                      {bedroomOptions.map((bed) => (
                        <button
                          key={bed}
                          onClick={() => toggleBedroom(bed)}
                          className={cn(
                            'px-2.5 py-1.5 rounded text-xs font-medium transition-colors min-w-[36px]',
                            filters.bedrooms.includes(bed)
                              ? 'bg-navy text-white'
                              : 'bg-off-white text-navy/60 hover:bg-navy/10'
                          )}
                        >
                          {bed}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Bathrooms */}
          <div className="relative">
            <button
              onClick={() => setActiveDropdown(activeDropdown === 'bathrooms' ? null : 'bathrooms')}
              className="flex items-center gap-2 px-3 py-2 bg-off-white rounded text-sm text-navy/70 hover:text-navy"
            >
              <span>
                {filters.bathrooms.length > 0
                  ? filters.bathrooms.join(', ') + ' bath'
                  : 'Bathrooms'
                }
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', activeDropdown === 'bathrooms' && 'rotate-180')} />
            </button>

            <AnimatePresence>
              {activeDropdown === 'bathrooms' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 mt-1 bg-white rounded shadow-lg z-30 p-2 border border-gray-100"
                >
                  <div className="flex gap-1">
                    {bathroomOptions.map((bath) => (
                      <button
                        key={bath}
                        onClick={() => toggleBathroom(bath)}
                        className={cn(
                          'px-2.5 py-1.5 rounded text-xs font-medium transition-colors min-w-[36px]',
                          filters.bathrooms.includes(bath)
                            ? 'bg-navy text-white'
                            : 'bg-off-white text-navy/60 hover:bg-navy/10'
                        )}
                      >
                        {bath}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* SQM — commercial only */}
          {isCommercial && (
            <div className="flex items-center">
              <input
                type="text"
                placeholder="Min m²"
                value={filters.sqm}
                onChange={(e) => setFilters(prev => ({ ...prev, sqm: e.target.value.replace(/\D/g, '') }))}
                className="w-24 px-2 py-2 bg-off-white rounded text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50"
              />
            </div>
          )}

          {/* Budget € */}
          <div className="flex items-center">
            <input
              type="text"
              placeholder="Budget €"
              value={filters.budget}
              onChange={(e) => setFilters(prev => ({ ...prev, budget: e.target.value.replace(/\D/g, '') }))}
              className="w-24 px-2 py-2 bg-off-white rounded text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={applyFilters}
              className="flex items-center gap-1.5 px-4 py-2 rounded text-xs font-medium bg-navy text-white hover:bg-navy-light transition-colors"
            >
              <Search className="w-3 h-3" />
              Apply
            </button>
            {activeFiltersCount > 0 && (
              <button
                onClick={clearFilters}
                className="px-2 py-2 rounded text-navy/40 hover:text-navy hover:bg-off-white transition-colors"
                aria-label="Clear filters"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
