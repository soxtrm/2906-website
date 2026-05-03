'use client'

import { useState, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { fetchAreas, fetchVillages, type Area, type Village } from '@/lib/locations'

interface SingleVillageSelectorProps {
  value: string | null
  onChange: (code: string | null, displayName?: string) => void
  placeholder?: string
}

export function SingleVillageSelector({ value, onChange, placeholder = 'Search village…' }: SingleVillageSelectorProps) {
  const [keyAreas, setKeyAreas]       = useState<Area[]>([])
  const [specialAreas, setSpecialAreas] = useState<Area[]>([])
  const [allVillages, setAllVillages] = useState<Village[]>([])
  const [activeArea, setActiveArea]   = useState<string | null>(null)
  const [search, setSearch]           = useState('')
  const [loading, setLoading]         = useState(true)

  useEffect(() => {
    fetchAreas().then(res => {
      setKeyAreas(res.key_areas)
      setSpecialAreas(res.special_areas)
      const allCodes = [...res.key_areas, ...res.special_areas].map(a => a.code)
      return fetchVillages(allCodes)
    })
      .then(res => setAllVillages(res.all_unique))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const specialAreaCodes = new Set(specialAreas.map(a => a.code))

  const handleAreaClick = (code: string | null) => {
    if (code === activeArea) {
      setActiveArea(null)
    } else {
      // If deselecting central, clear any central sub-area filter
      if (code === null && activeArea && specialAreaCodes.has(activeArea)) {
        setActiveArea(null)
      } else {
        setActiveArea(code)
      }
    }
    // If switching away from central, clear special area filter
    if (code !== 'central' && activeArea && specialAreaCodes.has(activeArea)) {
      setActiveArea(code)
    } else {
      setActiveArea(prev => prev === code ? null : code)
    }
  }

  const visibleVillages = allVillages.filter(v => {
    const matchesSearch = search.length === 0 ||
      v.display_name.toLowerCase().includes(search.toLowerCase())
    const matchesArea = !activeArea ||
      (v.areas || []).includes(activeArea)
    return matchesSearch && matchesArea
  })

  const selectedVillage = allVillages.find(v => v.code === value)

  if (loading) {
    return <div className="text-sm text-navy/40 py-2">Loading villages…</div>
  }

  const showSpecialAreas = activeArea === 'central' || (activeArea !== null && specialAreaCodes.has(activeArea))

  return (
    <div className="single-village-selector space-y-2">

      {/* Selected display */}
      {value && selectedVillage && (
        <div className="flex items-center gap-2 px-3 py-2 bg-gold/10 rounded border border-gold/30 text-sm text-navy">
          <span className="font-medium">{selectedVillage.display_name}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="ml-auto text-navy/40 hover:text-navy transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-navy/30" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-8 pr-8 py-2 bg-off-white border border-gray-200 rounded text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-navy/30 hover:text-navy"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Key area filter pills */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setActiveArea(null)}
          className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
            !activeArea
              ? 'bg-navy text-white border-navy'
              : 'bg-off-white text-navy/60 border-gray-200 hover:border-gray-300'
          }`}
        >
          All
        </button>
        {keyAreas.map(area => (
          <button
            key={area.code}
            type="button"
            onClick={() => {
              if (activeArea === area.code) {
                setActiveArea(null)
              } else {
                // Clear special area filter when switching key areas
                setActiveArea(area.code)
              }
            }}
            className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
              activeArea === area.code || (specialAreaCodes.has(activeArea ?? '') && area.code === 'central')
                ? 'bg-navy text-white border-navy'
                : 'bg-off-white text-navy/60 border-gray-200 hover:border-gray-300'
            }`}
          >
            {area.display_name}
          </button>
        ))}
      </div>

      {/* Special areas — only visible when Central is selected */}
      {showSpecialAreas && specialAreas.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-1 border-l-2 border-navy/10">
          {specialAreas.map(area => (
            <button
              key={area.code}
              type="button"
              onClick={() => setActiveArea(prev => prev === area.code ? 'central' : area.code)}
              className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
                activeArea === area.code
                  ? 'bg-navy/80 text-white border-navy/80'
                  : 'bg-off-white text-navy/50 border-gray-100 hover:border-gray-300'
              }`}
            >
              {area.display_name}
            </button>
          ))}
        </div>
      )}

      {/* Village list */}
      <div className="max-h-48 overflow-y-auto border border-gray-100 rounded bg-white">
        {visibleVillages.length === 0 ? (
          <p className="px-3 py-2 text-xs text-navy/40">No villages found</p>
        ) : (
          visibleVillages.map(v => (
            <button
              key={v.code}
              type="button"
              onClick={() => onChange(v.code, v.display_name)}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                value === v.code
                  ? 'bg-gold/10 text-navy font-medium'
                  : 'text-navy/70 hover:bg-off-white'
              }`}
            >
              {v.display_name}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
