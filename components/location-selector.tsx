'use client'

import { useState, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { fetchAreas, fetchVillages, type Area, type Village } from '@/lib/locations'

export interface LocationSelectorValue {
  selectedAreas: string[]
  preferredVillages: string[]
  topPriorityVillages: string[]
}

interface LocationSelectorProps {
  value: LocationSelectorValue
  onChange: (val: LocationSelectorValue) => void
  showPriority?: boolean
}

// Village state: unset → blue (preferred) → gold (top priority) → unset
type VillageState = 'none' | 'preferred' | 'top'

function getVillageState(code: string, value: LocationSelectorValue): VillageState {
  if (value.topPriorityVillages.includes(code)) return 'top'
  if (value.preferredVillages.includes(code)) return 'preferred'
  return 'none'
}

function villageButtonClass(state: VillageState): string {
  switch (state) {
    case 'top':       return 'bg-gold text-navy border-gold font-semibold'
    case 'preferred': return 'bg-blue-500 text-white border-blue-500'
    default:          return 'bg-white text-navy/70 border-gray-200 hover:border-gray-400'
  }
}

export function LocationSelector({ value, onChange, showPriority = true }: LocationSelectorProps) {
  const t = useTranslations('locations')

  const [keyAreas, setKeyAreas]       = useState<Area[]>([])
  const [specialAreas, setSpecialAreas] = useState<Area[]>([])
  const [villagesByArea, setVillagesByArea] = useState<Record<string, Village[]>>({})
  const [loading, setLoading]         = useState(true)
  const [loadingVillages, setLoadingVillages] = useState(false)

  // Timers for double-tap detection — useRef to avoid stale closures
  const tapTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Load areas once
  useEffect(() => {
    fetchAreas()
      .then(res => {
        setKeyAreas(res.key_areas)
        setSpecialAreas(res.special_areas)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Reload villages when selected areas change
  useEffect(() => {
    if (value.selectedAreas.length === 0) {
      setVillagesByArea({})
      return
    }
    setLoadingVillages(true)
    fetchVillages(value.selectedAreas)
      .then(res => setVillagesByArea(res.by_area))
      .catch(() => {})
      .finally(() => setLoadingVillages(false))
  }, [value.selectedAreas.join(',')])  // eslint-disable-line

  // ── Quick buttons ──────────────────────────────────────────────────────────

  const allAreaCodes   = [...keyAreas, ...specialAreas].map(a => a.code)
  const maltaAreaCodes = keyAreas.filter(a => a.code !== 'gozo').map(a => a.code)

  const isAnyActive      = allAreaCodes.length > 0 && allAreaCodes.every(c => value.selectedAreas.includes(c))
  const isAnyMaltaActive = maltaAreaCodes.length > 0 &&
    maltaAreaCodes.every(c => value.selectedAreas.includes(c)) &&
    !value.selectedAreas.includes('gozo')

  const handleAny = () =>
    onChange({ ...value, selectedAreas: allAreaCodes })

  const handleAnyMalta = () =>
    onChange({ ...value, selectedAreas: maltaAreaCodes })

  // ── Area toggle ────────────────────────────────────────────────────────────

  const toggleArea = (code: string) => {
    let newAreas = value.selectedAreas.includes(code)
      ? value.selectedAreas.filter(c => c !== code)
      : [...value.selectedAreas, code]
    // When deselecting central, also remove all its sub-areas
    if (code === 'central' && value.selectedAreas.includes('central')) {
      const specialCodes = new Set(specialAreas.map(a => a.code))
      newAreas = newAreas.filter(c => !specialCodes.has(c))
    }
    onChange({ ...value, selectedAreas: newAreas })
  }

  // ── Village tap (single = blue, double = gold) ─────────────────────────────

  const handleVillageTap = (code: string) => {
    if (tapTimers.current.has(code)) {
      // Second tap within window → double-tap = gold
      clearTimeout(tapTimers.current.get(code)!)
      tapTimers.current.delete(code)
      applyDoubleTap(code)
    } else {
      // First tap — wait 280ms
      const timer = setTimeout(() => {
        tapTimers.current.delete(code)
        applySingleTap(code)
      }, 280)
      tapTimers.current.set(code, timer)
    }
  }

  const applySingleTap = (code: string) => {
    const state = getVillageState(code, value)
    if (state === 'top') {
      // gold → blue (demote)
      onChange({
        ...value,
        topPriorityVillages: value.topPriorityVillages.filter(v => v !== code),
        preferredVillages: value.preferredVillages.includes(code)
          ? value.preferredVillages
          : [...value.preferredVillages, code],
      })
    } else if (state === 'preferred') {
      // blue → none (deselect)
      onChange({ ...value, preferredVillages: value.preferredVillages.filter(v => v !== code) })
    } else {
      // none → blue
      onChange({ ...value, preferredVillages: [...value.preferredVillages, code] })
    }
  }

  const applyDoubleTap = (code: string) => {
    const state = getVillageState(code, value)
    if (state === 'top') {
      // gold → none (remove entirely)
      onChange({
        ...value,
        topPriorityVillages: value.topPriorityVillages.filter(v => v !== code),
        preferredVillages: value.preferredVillages.filter(v => v !== code),
      })
    } else {
      // none/blue → gold
      onChange({
        ...value,
        topPriorityVillages: value.topPriorityVillages.includes(code)
          ? value.topPriorityVillages
          : [...value.topPriorityVillages, code],
        preferredVillages: value.preferredVillages.includes(code)
          ? value.preferredVillages
          : [...value.preferredVillages, code],
      })
    }
  }

  // ── "Any in [Area]" — selects all villages in that area as preferred ───────

  const handleAnyInArea = (areaCode: string) => {
    const villageCodes = (villagesByArea[areaCode] || []).map(v => v.code)
    const newPreferred = Array.from(new Set([...value.preferredVillages, ...villageCodes]))
    onChange({ ...value, preferredVillages: newPreferred })
  }

  // ── Clear all villages for an area ────────────────────────────────────────

  const handleClearArea = (areaCode: string) => {
    const villageCodes = new Set((villagesByArea[areaCode] || []).map(v => v.code))
    onChange({
      ...value,
      preferredVillages:    value.preferredVillages.filter(v => !villageCodes.has(v)),
      topPriorityVillages:  value.topPriorityVillages.filter(v => !villageCodes.has(v)),
    })
  }

  if (loading) {
    return <div className="text-sm text-navy/50 py-2">{t('loading')}</div>
  }

  const allAreas = [...keyAreas, ...specialAreas]

  return (
    <div className="location-selector space-y-4">

      {/* Priority hint */}
      {showPriority && (
        <p className="text-[11px] text-navy/40 italic leading-tight">
          {t('priorityHint')}
        </p>
      )}

      {/* Quick buttons */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleAny}
          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
            isAnyActive
              ? 'bg-navy text-white border-navy'
              : 'bg-off-white text-navy/70 border-gray-200 hover:border-navy/40'
          }`}
        >
          {t('any')}
        </button>
        <button
          type="button"
          onClick={handleAnyMalta}
          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
            isAnyMaltaActive
              ? 'bg-navy text-white border-navy'
              : 'bg-off-white text-navy/70 border-gray-200 hover:border-navy/40'
          }`}
        >
          {t('anyInMalta')}
        </button>
      </div>

      {/* Key areas */}
      <div>
        <p className="text-xs font-medium text-navy/60 mb-2 tracking-wide uppercase">{t('keyAreas')}</p>
        <div className="flex flex-wrap gap-2">
          {keyAreas.map(area => (
            <button
              key={area.code}
              type="button"
              onClick={() => toggleArea(area.code)}
              className={`px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${
                value.selectedAreas.includes(area.code)
                  ? 'bg-navy text-white border-navy'
                  : 'bg-white text-navy/70 border-gray-200 hover:border-navy/40'
              }`}
            >
              {area.display_name}
            </button>
          ))}
        </div>
      </div>

      {/* Special areas — only shown when Central is selected */}
      {value.selectedAreas.includes('central') && (
      <div>
        <p className="text-[11px] text-navy/40 mb-1.5">{t('narrowerSearch')}</p>
        <div className="flex flex-wrap gap-1.5">
          {specialAreas.map(area => (
            <button
              key={area.code}
              type="button"
              onClick={() => toggleArea(area.code)}
              className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
                value.selectedAreas.includes(area.code)
                  ? 'bg-navy/80 text-white border-navy/80'
                  : 'bg-off-white text-navy/60 border-gray-100 hover:border-gray-300'
              }`}
            >
              {area.display_name}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Village sections — one per selected area */}
      {loadingVillages && (
        <p className="text-xs text-navy/40 animate-pulse">{t('loadingVillages')}</p>
      )}

      {!loadingVillages && value.selectedAreas.map(areaCode => {
        const villages = villagesByArea[areaCode] || []
        const area = allAreas.find(a => a.code === areaCode)
        if (!area || villages.length === 0) return null

        const selectedInArea = villages.filter(v =>
          value.preferredVillages.includes(v.code) || value.topPriorityVillages.includes(v.code)
        ).length

        return (
          <div key={areaCode} className="border-t border-gray-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-navy uppercase tracking-wide">
                {area.display_name}
                {selectedInArea > 0 && (
                  <span className="ml-1.5 text-gold font-normal normal-case tracking-normal">
                    ({selectedInArea} selected)
                  </span>
                )}
              </p>
              {selectedInArea > 0 && (
                <button
                  type="button"
                  onClick={() => handleClearArea(areaCode)}
                  className="text-[10px] text-navy/30 hover:text-navy/60 transition-colors"
                >
                  clear
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {/* "Any in [Area]" shortcut */}
              <button
                type="button"
                onClick={() => handleAnyInArea(areaCode)}
                className="px-2.5 py-1 rounded-full border text-xs font-medium bg-off-white text-navy/60 border-gray-200 hover:bg-gray-100 transition-colors italic"
              >
                {t('anyIn', { area: area.display_name })}
              </button>

              {/* Village pills sorted alphabetically */}
              {[...villages]
                .sort((a, b) => a.display_name.localeCompare(b.display_name))
                .map(v => {
                  const state = getVillageState(v.code, value)
                  return (
                    <button
                      key={v.code}
                      type="button"
                      onClick={() => handleVillageTap(v.code)}
                      title={showPriority ? 'Tap: preferred · Double-tap: top priority' : undefined}
                      className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${villageButtonClass(state)}`}
                    >
                      {state === 'top' && <span className="mr-0.5">⭐</span>}
                      {v.display_name}
                    </button>
                  )
                })}
            </div>
          </div>
        )
      })}

      {/* Selection summary */}
      {(value.topPriorityVillages.length > 0 || value.preferredVillages.length > 0) && (
        <div className="border-t border-gray-100 pt-3 flex items-center gap-3 text-xs">
          {value.topPriorityVillages.length > 0 && (
            <span className="text-gold font-semibold">
              ⭐ {value.topPriorityVillages.length} {t('topPriority')}
            </span>
          )}
          {value.preferredVillages.length > 0 && (
            <span className="text-blue-500">
              ● {value.preferredVillages.length} {t('preferred')}
            </span>
          )}
          <button
            type="button"
            onClick={() => onChange({ ...value, preferredVillages: [], topPriorityVillages: [] })}
            className="ml-auto text-navy/30 hover:text-navy/60 transition-colors"
          >
            {t('clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}
