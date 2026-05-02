'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, X, ChevronDown, Home, Bed, Bath } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { maltaLocations, propertyTypes, bedroomOptions, bathroomOptions } from '@/lib/data'
import { cn } from '@/lib/utils'

interface SearchFilters {
  location: string
  propertyTypes: string[]
  bedrooms: string[]
  bathrooms: string[]
  budget: string
}

export function PropertySearch() {
  const router = useRouter()
  const [filters, setFilters] = useState<SearchFilters>({
    location: '',
    propertyTypes: [],
    bedrooms: [],
    bathrooms: [],
    budget: '',
  })
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const [locationSearch, setLocationSearch] = useState('')
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setActiveDropdown(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filteredLocations = maltaLocations.filter(loc =>
    loc.toLowerCase().includes(locationSearch.toLowerCase())
  )

  const handleSearch = () => {
    const params = new URLSearchParams()
    if (filters.location) params.set('location', filters.location)
    if (filters.propertyTypes.length) params.set('types', filters.propertyTypes.join(','))
    if (filters.bedrooms.length) params.set('beds', filters.bedrooms.join(','))
    if (filters.bathrooms.length) params.set('baths', filters.bathrooms.join(','))
    if (filters.budget) params.set('maxPrice', filters.budget)
    router.push(`/letting?${params.toString()}`)
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

  return (
    <div ref={searchRef} className="w-full">
      <div className="bg-white/10 backdrop-blur-md rounded-lg border border-white/20 p-3">
        <div className="flex flex-col lg:flex-row gap-2">

          {/* Location Search with Autocomplete */}
          <div className="relative flex-1">
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/50" />
              <input
                type="text"
                placeholder="Search village or area..."
                value={locationSearch || filters.location}
                onChange={(e) => {
                  setLocationSearch(e.target.value)
                  setFilters(prev => ({ ...prev, location: '' }))
                  setActiveDropdown('location')
                }}
                onFocus={() => setActiveDropdown('location')}
                className={cn(
                  'w-full pl-9 pr-8 py-2.5 bg-transparent text-white text-sm',
                  'placeholder:text-white/50 focus:outline-none'
                )}
              />
              {(locationSearch || filters.location) && (
                <button
                  onClick={() => {
                    setLocationSearch('')
                    setFilters(prev => ({ ...prev, location: '' }))
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded"
                >
                  <X className="w-3 h-3 text-white/50" />
                </button>
              )}
            </div>

            <AnimatePresence>
              {activeDropdown === 'location' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-xl z-30 max-h-60 overflow-auto"
                >
                  {filteredLocations.length > 0 ? (
                    filteredLocations.slice(0, 20).map((loc) => (
                      <button
                        key={loc}
                        onClick={() => {
                          setFilters(prev => ({ ...prev, location: loc }))
                          setLocationSearch('')
                          setActiveDropdown(null)
                        }}
                        className="w-full px-3 py-2 text-left text-sm text-navy/80 hover:bg-off-white flex items-center gap-2"
                      >
                        <MapPin className="w-3 h-3 text-navy/30" />
                        {loc}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-3 text-sm text-navy/50">No locations found</div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Divider */}
          <div className="hidden lg:block w-px bg-white/20" />

          {/* Property Type */}
          <div className="relative">
            <button
              onClick={() => setActiveDropdown(activeDropdown === 'propertyType' ? null : 'propertyType')}
              className={cn(
                'flex items-center gap-2 px-3 py-2.5 text-sm w-full lg:w-auto',
                'text-white/70 hover:text-white transition-colors'
              )}
            >
              <Home className="w-4 h-4" />
              <span className="whitespace-nowrap">
                {filters.propertyTypes.length > 0
                  ? `${filters.propertyTypes.length} type${filters.propertyTypes.length > 1 ? 's' : ''}`
                  : 'Property Type'
                }
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform ml-auto lg:ml-1', activeDropdown === 'propertyType' && 'rotate-180')} />
            </button>

            <AnimatePresence>
              {activeDropdown === 'propertyType' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl z-30 min-w-[220px] max-h-72 overflow-auto p-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {propertyTypes.map((type) => (
                      <button
                        key={type}
                        onClick={() => togglePropertyType(type)}
                        className={cn(
                          'px-2.5 py-1.5 rounded text-xs transition-colors',
                          filters.propertyTypes.includes(type)
                            ? 'bg-navy text-white'
                            : 'bg-off-white text-navy/70 hover:bg-navy/10'
                        )}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  {filters.propertyTypes.length > 0 && (
                    <button
                      onClick={() => setFilters(prev => ({ ...prev, propertyTypes: [] }))}
                      className="mt-2 pt-2 border-t border-gray-100 w-full text-xs text-navy/50 hover:text-navy"
                    >
                      Clear selection
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Divider */}
          <div className="hidden lg:block w-px bg-white/20" />

          {/* Bedrooms */}
          <div className="relative">
            <button
              onClick={() => setActiveDropdown(activeDropdown === 'bedrooms' ? null : 'bedrooms')}
              className={cn(
                'flex items-center gap-2 px-3 py-2.5 text-sm w-full lg:w-auto',
                'text-white/70 hover:text-white transition-colors'
              )}
            >
              <Bed className="w-4 h-4" />
              <span className="whitespace-nowrap">
                {filters.bedrooms.length > 0
                  ? filters.bedrooms.join(', ')
                  : 'Bedrooms'
                }
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform ml-auto lg:ml-1', activeDropdown === 'bedrooms' && 'rotate-180')} />
            </button>

            <AnimatePresence>
              {activeDropdown === 'bedrooms' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl z-30 p-2"
                >
                  <div className="flex gap-1.5">
                    {bedroomOptions.map((bed) => (
                      <button
                        key={bed}
                        onClick={() => toggleBedroom(bed)}
                        className={cn(
                          'px-3 py-2 rounded text-xs font-medium transition-colors min-w-[40px]',
                          filters.bedrooms.includes(bed)
                            ? 'bg-navy text-white'
                            : 'bg-off-white text-navy/70 hover:bg-navy/10'
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

          {/* Divider */}
          <div className="hidden lg:block w-px bg-white/20" />

          {/* Bathrooms */}
          <div className="relative">
            <button
              onClick={() => setActiveDropdown(activeDropdown === 'bathrooms' ? null : 'bathrooms')}
              className={cn(
                'flex items-center gap-2 px-3 py-2.5 text-sm w-full lg:w-auto',
                'text-white/70 hover:text-white transition-colors'
              )}
            >
              <Bath className="w-4 h-4" />
              <span className="whitespace-nowrap">
                {filters.bathrooms.length > 0
                  ? filters.bathrooms.join(', ')
                  : 'Bathrooms'
                }
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform ml-auto lg:ml-1', activeDropdown === 'bathrooms' && 'rotate-180')} />
            </button>

            <AnimatePresence>
              {activeDropdown === 'bathrooms' && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl z-30 p-2"
                >
                  <div className="flex gap-1.5">
                    {bathroomOptions.map((bath) => (
                      <button
                        key={bath}
                        onClick={() => toggleBathroom(bath)}
                        className={cn(
                          'px-3 py-2 rounded text-xs font-medium transition-colors min-w-[40px]',
                          filters.bathrooms.includes(bath)
                            ? 'bg-navy text-white'
                            : 'bg-off-white text-navy/70 hover:bg-navy/10'
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

          {/* Divider */}
          <div className="hidden lg:block w-px bg-white/20" />

          {/* Budget € */}
          <div className="flex items-center px-2">
            <input
              type="text"
              placeholder="Budget €"
              value={filters.budget}
              onChange={(e) => setFilters(prev => ({ ...prev, budget: e.target.value.replace(/\D/g, '') }))}
              className="w-24 px-2 py-2 bg-transparent text-white text-sm placeholder:text-white/50 focus:outline-none"
            />
          </div>

          {/* Search Button */}
          <button
            onClick={handleSearch}
            className={cn(
              'flex items-center justify-center px-5 py-2.5 rounded-md',
              'bg-gold hover:bg-gold-light text-navy text-sm font-medium',
              'transition-all duration-200 hover:shadow-lg whitespace-nowrap'
            )}
          >
            Search
          </button>
        </div>
      </div>
    </div>
  )
}
