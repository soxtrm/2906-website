'use client'
// ============================================================================
// board-filters.tsx — the Schedule Board's search + filter row.
//
// Deliberately NOT a new design. Every class here is lifted from
// components/property-filters.tsx, which is what the public site uses:
//   input      bg-off-white rounded, focus:ring-1 focus:ring-gold/50
//   trigger    bg-off-white rounded px-3 py-2, ChevronDown that rotates
//   panel      bg-white rounded shadow-lg border border-gray-100, fade + y
//   chip       selected bg-navy text-white / idle bg-off-white text-navy/60
//   mobile     one SlidersHorizontal toggle, count badge bg-gold text-navy
// The board previously had none of this — three bare <select>s and two number
// inputs in inline styles — which is what made it read as bolted on.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import { Bath, BedDouble, Building2, CalendarDays, Cat, ChevronDown, Euro, List, Map as MapIcon, MapPin, RotateCcw, Search, SlidersHorizontal, Snowflake, Star, UserRound, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { RENTAL_MODES, RENTAL_LABEL } from '@/components/crm/rental-modes'

export type BoardFilterValue = {
  q: string
  towns: string[]
  // Kev, 2026-09-11: "Mehrfach auswahl werkzeuge, ich will nicht nur eine
  // Sache suchen können" — beds/baths went from a single picked value to a
  // set of picked values (OR'd together server-side), same shape towns
  // already used on this board. '' (empty array) still means "don't care".
  beds: string[]
  baths: string[]
  min: string
  max: string
  type: string
  // ── the three tenancy rules ───────────────────────────────────────────────
  // The card has shown a paw and a people icon for a while, but there was no way
  // to filter on either — you could see which listings allowed pets only by
  // reading every card. These three close that.
  //
  // 'pets' / 'sharing': '' = don't care · 'yes' = the listing says yes ·
  // 'no' = it says no. Deliberately NOT a boolean: the backend answers three
  // states (yes / no / nobody wrote it down) and a two-state filter would fold
  // "no pets" together with "unknown", which is the one mistake that gets a
  // client taken to a flat that will turn them away.
  pets: '' | 'yes' | 'no'
  sharing: '' | 'yes' | 'no'
  // Subletting gets no card icon by design — a checkbox in the search only.
  // Checked = show only listings that actually say subletting is allowed.
  sublet: boolean
  // '' = Any. Otherwise a key into UPDATED_MAX_MS below. createdAt is what
  // this reads (routes/crmScheduleBoard.js:shapeCard) — !upload sets it on
  // arrival AND !price bumps it back to NOW() on a deliberate repost (Kev,
  // 2026-08-28: "so that's what actually moves the card to the top"), so it
  // already doubles as "last touched", not just "first uploaded". Kev's ask
  // (2026-08-28): a recency filter reads as a cheap proxy for "still
  // available" — nobody has bumped a rented listing in weeks.
  updated: '' | '24h' | '48h' | '5d' | '10d' | '3w'
  // Rental mode tab (2026-09-21): '' = all. A listing with several modes shows
  // under each of them; filtered client-side on the card's rentalModes.
  rental: '' | 'long_let' | 'winter_let' | 'short_let'
}

export const UPDATED_OPTIONS: [BoardFilterValue['updated'], string][] = [
  ['24h', '24h'], ['48h', '48h'], ['5d', '5 Days'], ['10d', '10 Days'], ['3w', '3 Weeks'],
]
export const UPDATED_MAX_MS: Record<Exclude<BoardFilterValue['updated'], ''>, number> = {
  '24h': 24 * 3600_000, '48h': 48 * 3600_000,
  '5d': 5 * 86_400_000, '10d': 10 * 86_400_000, '3w': 21 * 86_400_000,
}

const TYPES: [string, string][] = [
  ['apartment', 'Apartment'], ['penthouse', 'Penthouse'], ['house', 'House'],
  ['maisonette', 'Maisonette'], ['townhouse', 'Townhouse'], ['villa', 'Villa'],
]
// '4+' is the open-ended top tier — everything below it means "exactly this
// many", not "this many or more" (Kev, 2026-08-20). The '+' rides in the
// value itself so the label and the filter semantics can never drift apart;
// the backend (routes/crmScheduleBoard.js) reads the trailing '+' the same way.
const BEDS = ['1', '2', '3', '4+']
const BATHS = ['1', '2', '3']

// ── shared shells, so every control lines up on the same baseline ───────────
// Kev's redesign brief (2026-08-22): the row read flat — every control the
// same off-white block with no lift. A soft shadow gives each trigger the
// same "raised pill" feel the card buttons already have; the gold tint on
// an active filter (was ring-only) makes "something is set here" readable
// at a glance instead of requiring a close look at the ring.
const TRIGGER =
  'flex items-center gap-2 px-3 py-2 bg-white shadow-sm shadow-navy/5 rounded text-sm text-navy/70 ' +
  'hover:text-navy hover:shadow-navy/10 transition-all whitespace-nowrap'
const TRIGGER_ON = 'text-navy font-medium bg-gold/10 ring-1 ring-gold/50 shadow-gold/10'
const PANEL =
  'absolute top-full left-0 mt-1 bg-white rounded shadow-lg z-30 p-2 ' +
  'border border-gray-100 min-w-[200px]'
const CHIP = 'px-2 py-1 rounded text-[11px] transition-colors'
const CHIP_ON = 'bg-navy text-white'
const CHIP_OFF = 'bg-off-white text-navy/60 hover:bg-navy/10'

function Dropdown({ id, label, active, open, onToggle, children }: {
  id: string; label: string; active: boolean
  open: boolean; onToggle: (id: string | null) => void
  children: React.ReactNode
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onToggle(open ? null : id)}
        className={cn(TRIGGER, active && TRIGGER_ON)}
      >
        <span>{label}</span>
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.12 }}
            className={PANEL}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function RoomScrubber({ label, values, selected, onChange }: {
  label: string
  values: readonly string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const selectedOrdered = values.filter(value => selected.includes(value))
  const current = selectedOrdered.length
    ? Math.max(...selectedOrdered.map(value => values.indexOf(value))) + 1
    : 0
  const fill = `${(current / values.length) * 100}%`
  return <div className="rounded-2xl border border-[var(--crm-border)] bg-[var(--crm-raised)] p-3">
    <div className="mb-1 flex items-center justify-between gap-3">
      <strong className="text-[12px] text-[var(--crm-text)]">{label}</strong>
      <span className="rounded-full bg-[var(--crm-surface)] px-2 py-1 text-[10px] font-bold text-[var(--crm-accent)]">
        {selectedOrdered.length ? selectedOrdered.join(' · ') : 'Any'}
      </span>
    </div>
    <input
      type="range"
      min={0}
      max={values.length}
      step={1}
      value={current}
      onChange={event => {
        const index = Number(event.target.value)
        onChange(index === 0 ? [] : [values[index - 1]])
      }}
      aria-label={`${label} quick selector`}
      className="crm-mobile-range w-full"
      style={{ '--range-fill': fill } as React.CSSProperties}
    />
    <div className="mt-1 flex justify-between px-1 text-[9px] font-semibold text-[var(--crm-faint)]">
      <span>Any</span>{values.map(value => <span key={value}>{value}</span>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--crm-border)] pt-3">
      <button type="button" aria-pressed={selected.length === 0} onClick={() => onChange([])} className="crm-filter-choice">Any</button>
      {values.map(value => <button
        key={value}
        aria-pressed={selected.includes(value)}
        type="button"
        onClick={() => onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value])}
        className="crm-filter-choice"
      >{value}</button>)}
    </div>
  </div>
}

export function BoardFilters({ value, onChange, onReset, count, mineCount, loading, extra, dark, smartTools, onMapToggle, onProfileOpen, onFavouritesOpen, mapActive = false, favouritesActive = false, smartBadgeCount = 0, townOptions = [] }: {
  value: BoardFilterValue
  onChange: (patch: Partial<BoardFilterValue>) => void
  onReset: () => void
  count: number
  mineCount: number
  loading: boolean
  /** Rendered at the end of the row — the board puts its "drawn area" pill here. */
  extra?: React.ReactNode
  /** The mobile toggle row sits directly on CrmShell's filterBar background —
   * on the dark shell that's near-black navy, so it needs light text instead
   * of the public site's navy-on-white default or it reads as invisible. */
  dark?: boolean
  /** Real board actions supplied by the page. Kept outside this component so
   * the island never invents navigation or duplicates business logic. */
  smartTools?: React.ReactNode
  /** Direct workspace actions. Only the burger icon opens the daily-tools sheet. */
  onMapToggle?: () => void
  onProfileOpen?: () => void
  onFavouritesOpen?: () => void
  mapActive?: boolean
  favouritesActive?: boolean
  smartBadgeCount?: number
  townOptions?: Array<{ key: string; label: string; n: number }>
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [mobilePanel, setMobilePanel] = useState<'smart' | 'filters' | null>(null)
  const [smartPickerOpen, setSmartPickerOpen] = useState(false)
  const [filterPickerOpen, setFilterPickerOpen] = useState(false)
  const [islandFocus, setIslandFocus] = useState<string | null>(null)
  const [compactMobile, setCompactMobile] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filterPanelRef = useRef<HTMLElement>(null)
  const filterScrollFrameRef = useRef(0)
  const ref = useRef<HTMLDivElement>(null)

  const mobilePlaceholders = ['Reference', 'Village', 'Owner or agent', 'Property type']

  useEffect(() => {
    if (!searchOpen || value.q) return
    const timer = window.setInterval(
      () => setPlaceholderIndex(current => (current + 1) % mobilePlaceholders.length),
      1650,
    )
    return () => window.clearInterval(timer)
  }, [searchOpen, value.q])

  useEffect(() => {
    if (!searchOpen) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [searchOpen])

  useEffect(() => {
    const scroller = ref.current?.closest('.crm-main')?.querySelector<HTMLElement>('.crm-content')
    if (!scroller) return
    let frame = 0
    let lastTop = scroller.scrollTop
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const nextTop = scroller.scrollTop
        if (nextTop < 28) setCompactMobile(false)
        else if (nextTop > lastTop + 5 && nextTop > 112) setCompactMobile(true)
        else if (nextTop < lastTop - 5) setCompactMobile(false)
        lastTop = nextTop
      })
    }
    scroller.addEventListener('scroll', update, { passive: true })
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener('scroll', update) }
  }, [])

  useEffect(() => {
    const filterbar = ref.current?.closest('.crm-filterbar')
    filterbar?.classList.toggle('crm-filterbar-collapsed', compactMobile)
    return () => filterbar?.classList.remove('crm-filterbar-collapsed')
  }, [compactMobile])

  useEffect(() => {
    const surfaceOpen = !!(open || mobilePanel || smartPickerOpen || filterPickerOpen || searchOpen)
    if (!surfaceOpen) return
    const away = (event: MouseEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) return
      // The first tap outside is reserved for putting the active cloud away.
      // This prevents a listing action or another navigation item firing under
      // a sheet the agent was still looking at.
      event.preventDefault()
      event.stopPropagation()
      setOpen(null)
      setMobilePanel(null)
      setSmartPickerOpen(false)
      setFilterPickerOpen(false)
      setIslandFocus(null)
      setSearchOpen(false)
    }
    document.addEventListener('click', away, true)
    return () => document.removeEventListener('click', away, true)
  }, [filterPickerOpen, mobilePanel, open, searchOpen, smartPickerOpen])

  const activeCount =
    (value.towns.length ? 1 : 0) + (value.beds.length ? 1 : 0) + (value.baths.length ? 1 : 0) +
    (value.type ? 1 : 0) + (value.min || value.max ? 1 : 0) +
    (value.pets ? 1 : 0) + (value.sharing ? 1 : 0) + (value.sublet ? 1 : 0) +
    (value.updated ? 1 : 0) + (value.rental ? 1 : 0)
  const hasActiveIslandSelection = activeCount > 0 || smartBadgeCount > 0 || value.q.trim().length > 0

  const typeLabel = value.type
    ? (TYPES.find(t => t[0] === value.type)?.[1] || value.type)
    : 'Property Type'
  const priceLabel = value.min || value.max
    ? `€${value.min || '0'} – ${value.max ? `€${value.max}` : '∞'}`
    : 'Price'
  const updatedLabel = value.updated
    ? `Updated: ${UPDATED_OPTIONS.find(o => o[0] === value.updated)?.[1] || value.updated}`
    : 'Updated'
  const rentalLabel = value.rental ? `Rental: ${RENTAL_LABEL[value.rental]}` : 'Rental'

  // One dropdown holds all three tenancy rules. Three separate triggers would
  // push the row past the width the map leaves it on a laptop, and these are
  // asked together on the phone anyway ("pets? can they share?").
  const rulesActive = !!(value.pets || value.sharing || value.sublet)
  const rulesLabel = (() => {
    if (!rulesActive) return 'Pets & Sharing'
    const bits: string[] = []
    if (value.pets)    bits.push(value.pets === 'yes' ? 'Pets ok' : 'No pets')
    if (value.sharing) bits.push(value.sharing === 'yes' ? 'Sharing ok' : 'No sharing')
    if (value.sublet)  bits.push('Sublet ok')
    return bits.join(' · ')
  })()

  const toggleTown = (key: string) => onChange({
    towns: value.towns.includes(key) ? value.towns.filter(item => item !== key) : [...value.towns, key],
  })

  const closeIslandSurfaces = () => {
    setOpen(null)
    setMobilePanel(null)
    setSmartPickerOpen(false)
    setFilterPickerOpen(false)
    setIslandFocus(null)
    setSearchOpen(false)
  }

  const openIslandFeature = (panel: 'smart' | 'filters', target: string) => {
    setOpen(null)
    const otherSurfaceOpen = panel === 'smart'
      ? searchOpen || mobilePanel === 'filters' || filterPickerOpen
      : searchOpen || mobilePanel === 'smart' || smartPickerOpen
    if (otherSurfaceOpen) {
      closeIslandSurfaces()
      return
    }
    setSearchOpen(false)
    if (panel === 'smart' && !smartPickerOpen && mobilePanel !== 'smart') {
      setMobilePanel(null)
      setIslandFocus(null)
      setSmartPickerOpen(true)
      return
    }
    if (panel === 'filters' && !filterPickerOpen && mobilePanel !== 'filters') {
      setMobilePanel(null)
      setIslandFocus(null)
      setFilterPickerOpen(true)
      return
    }
    setSmartPickerOpen(panel === 'smart')
    setFilterPickerOpen(panel === 'filters')
    setIslandFocus(target)
    setMobilePanel(panel)
  }

  const primeSmartIsland = () => {
    if (searchOpen || mobilePanel === 'filters' || filterPickerOpen) {
      closeIslandSurfaces()
      return
    }
    setSearchOpen(false)
    setOpen(null)
    setMobilePanel(null)
    setIslandFocus(null)
    setSmartPickerOpen(current => !current)
  }

  const openMapWorkspace = () => {
    if (searchOpen || mobilePanel === 'filters' || filterPickerOpen) {
      closeIslandSurfaces()
      return
    }
    closeIslandSurfaces()
    onMapToggle?.()
  }

  const openSmartMenu = () => {
    if (searchOpen || mobilePanel === 'filters' || filterPickerOpen) {
      closeIslandSurfaces()
      return
    }
    setOpen(null)
    setSearchOpen(false)
    setFilterPickerOpen(false)
    setIslandFocus(null)
    setSmartPickerOpen(true)
    setMobilePanel(current => current === 'smart' ? null : 'smart')
  }

  const openDirectSmartWorkspace = (action?: () => void) => {
    if (searchOpen || mobilePanel === 'filters' || filterPickerOpen) {
      closeIslandSurfaces()
      return
    }
    closeIslandSurfaces()
    action?.()
  }

  const primeFilterIsland = () => {
    if (searchOpen || mobilePanel === 'smart' || smartPickerOpen) {
      closeIslandSurfaces()
      return
    }
    setSearchOpen(false)
    setOpen(null)
    setMobilePanel(null)
    setIslandFocus(null)
    setSmartPickerOpen(false)
    setFilterPickerOpen(true)
    if (window.matchMedia('(max-width: 760px)').matches) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }))
    }
  }

  useEffect(() => {
    const closeForWorkspace = () => {
      setMobilePanel(null)
      setSmartPickerOpen(false)
      setIslandFocus(null)
    }
    window.addEventListener('crm-board-tool-picked', closeForWorkspace)
    return () => window.removeEventListener('crm-board-tool-picked', closeForWorkspace)
  }, [])

  useEffect(() => {
    if (!mobilePanel || !islandFocus) return
    const timer = window.setTimeout(() => {
      ref.current?.querySelectorAll('.is-island-focus').forEach(element => element.classList.remove('is-island-focus'))
      const target = document.getElementById(islandFocus)
      target?.classList.add('is-island-focus')
      const panel = filterPanelRef.current
      if (mobilePanel === 'filters' && panel && target) {
        cancelAnimationFrame(filterScrollFrameRef.current)
        const panelTop = panel.getBoundingClientRect().top
        const targetTop = target.getBoundingClientRect().top
        const start = panel.scrollTop
        const maximum = panel.scrollHeight - panel.clientHeight
        const destination = Math.min(maximum, Math.max(0, start + targetTop - panelTop - 68))
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          panel.scrollTop = destination
          return
        }
        const startedAt = performance.now()
        const animate = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / 380)
          const eased = 1 - Math.pow(1 - progress, 4)
          panel.scrollTop = start + (destination - start) * eased
          if (progress < 1) filterScrollFrameRef.current = requestAnimationFrame(animate)
        }
        filterScrollFrameRef.current = requestAnimationFrame(animate)
        return
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 140)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(filterScrollFrameRef.current)
    }
  }, [mobilePanel, islandFocus])

  return (
    <div ref={ref} className={cn('w-full', compactMobile && 'crm-board-filter-collapsed')}>
      <motion.div
        data-panel={searchOpen ? 'search' : mobilePanel || (smartPickerOpen ? 'smart-picker' : filterPickerOpen ? 'filter-picker' : 'default')}
        className="crm-board-islands"
      >
        <motion.div className={cn('crm-argus-orbit flex min-w-0 items-center rounded-[18px] border border-[var(--crm-border)] bg-[var(--crm-surface)] p-1.5', searchOpen && 'is-searching')}>
          <AnimatePresence mode="popLayout" initial={false}>
            {searchOpen ? (
              <motion.form key="search-field" layout initial={{ opacity: 0, scaleX: .9, scaleY: .97 }} animate={{ opacity: 1, scaleX: 1, scaleY: 1 }} exit={{ opacity: 0, scaleX: .92, scaleY: .98 }} transition={{ type: 'spring', stiffness: 360, damping: 32, mass: .62 }} className="relative flex min-w-0 flex-1 items-center" onSubmit={event => { event.preventDefault(); setSearchOpen(false); searchInputRef.current?.blur() }}>
                <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--crm-muted)]" />
                <input ref={searchInputRef} type="search" enterKeyHint="search" autoComplete="off" value={value.q} onChange={event => onChange({ q: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false) }} placeholder={mobilePlaceholders[placeholderIndex]} aria-label="Search by reference, village, owner, agent or property type" className="h-10 w-full min-w-0 rounded-[13px] border-0 bg-[var(--crm-raised)] pl-9 pr-9 text-[13px] text-[var(--crm-text)] outline-none placeholder:text-[var(--crm-faint)]" />
                <button type="button" onClick={() => value.q ? onChange({ q: '' }) : setSearchOpen(false)} aria-label={value.q ? 'Clear search' : 'Close search'} className="absolute right-1 grid h-8 w-8 place-items-center rounded-full border-0 bg-transparent text-[var(--crm-muted)]"><X className="h-4 w-4" /></button>
              </motion.form>
            ) : (
              <motion.button key="search-trigger" layout type="button" onClick={() => { if (mobilePanel || smartPickerOpen || filterPickerOpen) { closeIslandSurfaces(); return }; setOpen(null); setSearchOpen(true) }} aria-label={value.q ? 'Edit active search' : 'Open ARGUS search'} title={value.q ? `Search: ${value.q}` : 'Search inventory'} className="grid h-10 w-full place-items-center rounded-[13px] border-0 bg-transparent text-[var(--crm-text)]" initial={{ opacity: 0, scale: .92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .92 }}>
                <span className="crm-argus-logo-window"><img src="/argus-logo-kevin.png" alt="ARGUS" style={{ filter: dark ? 'invert(1) brightness(1.18)' : 'none' }} />{value.q && <i className="crm-search-active-dot" aria-hidden />}</span>
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>

        <motion.div role="group" aria-label={`Daily tools and smart filters${smartBadgeCount ? `, ${smartBadgeCount} active` : ''}`} className={cn('crm-nav-island crm-smart-island', (mobilePanel === 'smart' || smartPickerOpen) && 'is-active')} onClick={event => { if (!(event.target as Element).closest('.crm-island-feature')) primeSmartIsland() }}>
          <span className="crm-island-icons crm-smart-icons">
            <button type="button" className="crm-island-feature" aria-label={mapActive ? 'Close map workspace' : 'Open map workspace'} aria-pressed={mapActive} data-active={mapActive} onClick={openMapWorkspace}><MapIcon aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open daily tools" aria-expanded={mobilePanel === 'smart'} aria-controls="crm-mobile-smart-panel" data-active={mobilePanel === 'smart'} onClick={openSmartMenu}><List aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open profile workspace" onClick={() => openDirectSmartWorkspace(onProfileOpen)}><UserRound aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open favourites workspace" aria-pressed={favouritesActive} data-active={favouritesActive} onClick={() => openDirectSmartWorkspace(onFavouritesOpen)}><Star aria-hidden /></button>
          </span>
          <span className="crm-island-label">Smartfilters</span>
          {smartBadgeCount > 0 && <span className="crm-island-count" aria-label={`${smartBadgeCount} active smart filters`}>{smartBadgeCount}</span>}
        </motion.div>

        <motion.div
          role="group"
          aria-label={`Property filters${activeCount ? `, ${activeCount} active` : ''}`}
          className={cn('crm-nav-island crm-filter-island', (mobilePanel === 'filters' || filterPickerOpen) && 'is-active')}
          onClick={event => { if (!(event.target as Element).closest('.crm-island-feature')) primeFilterIsland() }}
        >
          <span className="crm-island-icons crm-filter-icons">
            <button type="button" className="crm-island-feature" aria-label="Open price filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={!!(value.min || value.max)} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-price'} onClick={() => openIslandFeature('filters', 'crm-filter-price')}><Euro aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open availability filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-availability'} onClick={() => openIslandFeature('filters', 'crm-filter-availability')}><CalendarDays aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open bedroom filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={value.beds.length > 0} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-bedrooms'} onClick={() => openIslandFeature('filters', 'crm-filter-bedrooms')}><BedDouble aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open bathroom filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={value.baths.length > 0} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-bathrooms'} onClick={() => openIslandFeature('filters', 'crm-filter-bathrooms')}><Bath aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open property types" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={!!value.type} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-property-type'} onClick={() => openIslandFeature('filters', 'crm-filter-property-type')}><Building2 aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open pets and tenancy filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={rulesActive} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-tenancy'} onClick={() => openIslandFeature('filters', 'crm-filter-tenancy')}><Cat aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open updated filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={!!value.updated} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-updated'} onClick={() => openIslandFeature('filters', 'crm-filter-updated')}><SlidersHorizontal aria-hidden /></button>
            <button type="button" className="crm-island-feature" aria-label="Open rental filters" aria-expanded={mobilePanel === 'filters'} aria-controls="crm-mobile-filter-panel" data-selected={!!value.rental} data-active={mobilePanel === 'filters' && islandFocus === 'crm-filter-rental'} onClick={() => openIslandFeature('filters', 'crm-filter-rental')}><Snowflake aria-hidden /></button>
          </span>
          <span className="crm-island-label">Filters</span>
        </motion.div>
      </motion.div>
      {hasActiveIslandSelection && <button type="button" className="crm-board-islands-handle" onClick={() => setCompactMobile(false)} aria-label="Expand active ARGUS tools"><span /></button>}

      <AnimatePresence initial={false} mode="popLayout">
        {mobilePanel === 'smart' && (
          <motion.section id="crm-mobile-smart-panel" key="smart-panel" initial={{ opacity: 0, y: -7, scale: .985, borderRadius: 29 }} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 24 }} exit={{ opacity: 0, y: -5, scale: .989, borderRadius: 28 }} transition={{ type: 'spring', stiffness: 235, damping: 28, mass: .92 }} className="crm-mobile-island-panel crm-mobile-smart-panel" style={{ transformOrigin: 'top 42%' }} onMouseDown={event => event.stopPropagation()}>
            <header><div><span>ACTION CLOUD</span><strong>Daily tools</strong></div><div className="crm-mobile-panel-head-actions">{smartBadgeCount > 0 && <button type="button" className="crm-filter-reset" onClick={onReset} aria-label="Reset smart filters"><RotateCcw /><em>Reset</em></button>}<button type="button" onClick={closeIslandSurfaces} aria-label="Close daily tools"><X /></button></div></header>
            <div>{smartTools}</div>
          </motion.section>
        )}

        {mobilePanel === 'filters' && (
          <motion.section ref={filterPanelRef} id="crm-mobile-filter-panel" key="filter-panel" initial={{ opacity: 0, y: -7, scale: .985, borderRadius: 29 }} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 24 }} exit={{ opacity: 0, y: -5, scale: .989, borderRadius: 28 }} transition={{ type: 'spring', stiffness: 235, damping: 28, mass: .92 }} className="crm-mobile-island-panel crm-mobile-filter-panel" style={{ transformOrigin: 'top right' }} onMouseDown={event => event.stopPropagation()}>
            <header>
              <div><span>ISLAND 02</span><strong>Property filters</strong></div>
              <div className="crm-mobile-panel-head-actions">{activeCount > 0 && <button type="button" className="crm-filter-reset" onClick={onReset} aria-label="Reset property filters"><RotateCcw /><em>Reset</em></button>}<button type="button" onClick={closeIslandSurfaces} aria-label="Close filters"><X /></button></div>
            </header>

            <div className="crm-filter-section">
              <div className="crm-filter-section-title"><MapPin /><span>Location</span></div>
              <div className="crm-location-choices">
                {townOptions.map(town => <button key={town.key} type="button" aria-pressed={value.towns.includes(town.key)} onClick={() => toggleTown(town.key)}>{town.label}<small>{town.n}</small></button>)}
                {!townOptions.length && <p>Locations appear when inventory is loaded.</p>}
              </div>
            </div>

            <div id="crm-filter-price" data-island-focus={islandFocus === 'crm-filter-price'} className="crm-filter-section">
              <div className="crm-filter-section-title"><Euro /><span>Price range</span></div>
              <div className="crm-price-fields"><label><span>Minimum</span><input type="number" inputMode="numeric" placeholder="€ 0" value={value.min} onChange={event => onChange({ min: event.target.value })} /></label><label><span>Maximum</span><input type="number" inputMode="numeric" placeholder="Any" value={value.max} onChange={event => onChange({ max: event.target.value })} /></label></div>
            </div>

            <div className="crm-filter-section crm-room-sections">
              <div id="crm-filter-bedrooms" data-island-focus={islandFocus === 'crm-filter-bedrooms'}><RoomScrubber label="Bedrooms" values={BEDS} selected={value.beds} onChange={beds => onChange({ beds })} /></div>
              <div id="crm-filter-bathrooms" data-island-focus={islandFocus === 'crm-filter-bathrooms'}><RoomScrubber label="Bathrooms" values={BATHS} selected={value.baths} onChange={baths => onChange({ baths })} /></div>
            </div>

            <div id="crm-filter-tenancy" data-island-focus={islandFocus === 'crm-filter-tenancy'} className="crm-filter-section">
              <div className="crm-filter-section-title"><Cat /><span>Pets &amp; tenancy</span></div>
              <div className="crm-tenancy-grid">
                {([['pets', 'Pets', 'Allowed', 'Not allowed'], ['sharing', 'Sharing', 'Allowed', 'Not allowed']] as const).map(([key, title, yesLabel, noLabel]) => <div key={key}><strong>{title}</strong><button type="button" aria-pressed={value[key] === 'yes'} onClick={() => onChange({ [key]: value[key] === 'yes' ? '' : 'yes' } as Partial<BoardFilterValue>)}>{yesLabel}</button><button type="button" aria-pressed={value[key] === 'no'} onClick={() => onChange({ [key]: value[key] === 'no' ? '' : 'no' } as Partial<BoardFilterValue>)}>{noLabel}</button></div>)}
                <label className="crm-sublet-choice"><input type="checkbox" checked={value.sublet} onChange={event => onChange({ sublet: event.target.checked })} /><span>Subletting allowed</span></label>
              </div>
              <p className="crm-filter-hint">Unknown rules stay unknown and are never treated as “not allowed”.</p>
            </div>

            <div id="crm-filter-property-type" data-island-focus={islandFocus === 'crm-filter-property-type'} className="crm-filter-section">
              <div className="crm-filter-section-title"><Building2 /><span>Property type</span></div>
              <div className="crm-filter-choice-row">{TYPES.map(([key, label]) => <button key={key} type="button" aria-pressed={value.type === key} onClick={() => onChange({ type: value.type === key ? '' : key })}>{label}</button>)}</div>
            </div>

            <div id="crm-filter-availability" data-island-focus={islandFocus === 'crm-filter-availability'} className="crm-filter-section">
              <div className="crm-filter-section-title"><CalendarDays /><span>Availability &amp; other</span></div>
              <div className="crm-mobile-extra">{extra}</div>
              <div id="crm-filter-updated" data-island-focus={islandFocus === 'crm-filter-updated'} className="crm-filter-choice-row crm-updated-choices"><button type="button" aria-pressed={!value.updated} onClick={() => onChange({ updated: '' })}>Any update</button>{UPDATED_OPTIONS.map(([key, label]) => <button key={key} type="button" aria-pressed={value.updated === key} onClick={() => onChange({ updated: value.updated === key ? '' : key })}>{label}</button>)}</div>
              <div id="crm-filter-rental" data-island-focus={islandFocus === 'crm-filter-rental'} className="crm-filter-choice-row"><button type="button" aria-pressed={!value.rental} onClick={() => onChange({ rental: '' })}>All rentals</button>{RENTAL_MODES.map(mode => <button key={mode.key} type="button" aria-pressed={value.rental === mode.key} onClick={() => onChange({ rental: value.rental === mode.key ? '' : mode.key })}>{mode.icon ? `${mode.icon} ` : ''}{mode.label}</button>)}</div>
            </div>

            <div className="crm-mobile-filter-scroll-end" aria-hidden="true" />

            <footer>
              <button type="button" className="crm-clear-filters" onClick={onReset} disabled={activeCount === 0}>Clear all</button>
              <button type="button" className="crm-show-results" onClick={() => setMobilePanel(null)} disabled={loading}><Search />{loading ? 'Loading…' : `Show ${count} result${count === 1 ? '' : 's'}`}</button>
            </footer>
          </motion.section>
        )}
      </AnimatePresence>

      <div className="hidden w-full gap-2">

        {/* Search — ref, town or area. The board's own listings are local, so
            this filters instantly rather than round-tripping. */}
        <div className="relative hidden flex-1 min-w-[220px] lg:block lg:max-w-[300px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-navy/30 pointer-events-none" />
          <input
            type="text"
            value={value.q}
            onChange={e => onChange({ q: e.target.value })}
            placeholder="Search ref, town or area…"
            className="w-full pl-8 pr-7 py-2 bg-white shadow-sm shadow-navy/5 border-0 rounded text-sm text-navy
                       placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50"
          />
          {value.q && (
            <button
              type="button"
              onClick={() => onChange({ q: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              aria-label="Clear search"
            >
              <X className="w-3 h-3 text-navy/30 hover:text-navy" />
            </button>
          )}
        </div>

        <Dropdown id="type" label={typeLabel} active={!!value.type} open={open === 'type'} onToggle={setOpen}>
          <div className="flex flex-wrap gap-1 max-w-[260px]">
            {TYPES.map(([v, l]) => (
              <button key={v} type="button"
                onClick={() => { onChange({ type: value.type === v ? '' : v }); setOpen(null) }}
                className={cn(CHIP, value.type === v ? CHIP_ON : CHIP_OFF)}>
                {l}
              </button>
            ))}
          </div>
          {value.type && (
            <button type="button" onClick={() => { onChange({ type: '' }); setOpen(null) }}
              className="mt-2 pt-2 border-t border-gray-100 w-full text-[10px] text-navy/40 hover:text-navy">
              Clear
            </button>
          )}
        </Dropdown>

        {/* Kev, 2026-09-11: multi-select — click toggles a chip in/out of the
            set instead of replacing a single picked value. Dropdown stays
            open (setOpen(null) removed) so picking 1+3 beds is one open,
            two clicks, not three. */}
        <Dropdown id="beds" label={value.beds.length ? `${value.beds.join(', ')} beds` : 'Beds'} active={!!value.beds.length}
          open={open === 'beds'} onToggle={setOpen}>
          <div className="flex flex-wrap gap-1">
            {BEDS.map(b => (
              <button key={b} type="button"
                onClick={() => onChange({
                  beds: value.beds.includes(b) ? value.beds.filter(x => x !== b) : [...value.beds, b],
                })}
                className={cn(CHIP, 'min-w-[38px]', value.beds.includes(b) ? CHIP_ON : CHIP_OFF)}>
                {b}
              </button>
            ))}
          </div>
          {value.beds.length > 0 && (
            <button type="button" onClick={() => onChange({ beds: [] })}
              className="mt-2 pt-2 border-t border-gray-100 w-full text-[10px] text-navy/40 hover:text-navy">
              Clear
            </button>
          )}
        </Dropdown>

        <Dropdown id="baths" label={value.baths.length ? `${value.baths.join(', ')}+ baths` : 'Baths'} active={!!value.baths.length}
          open={open === 'baths'} onToggle={setOpen}>
          <div className="flex flex-wrap gap-1">
            {BATHS.map(b => (
              <button key={b} type="button"
                onClick={() => onChange({
                  baths: value.baths.includes(b) ? value.baths.filter(x => x !== b) : [...value.baths, b],
                })}
                className={cn(CHIP, 'min-w-[38px]', value.baths.includes(b) ? CHIP_ON : CHIP_OFF)}>
                {b}+
              </button>
            ))}
          </div>
          {value.baths.length > 0 && (
            <button type="button" onClick={() => onChange({ baths: [] })}
              className="mt-2 pt-2 border-t border-gray-100 w-full text-[10px] text-navy/40 hover:text-navy">
              Clear
            </button>
          )}
        </Dropdown>

        <Dropdown id="price" label={priceLabel} active={!!(value.min || value.max)}
          open={open === 'price'} onToggle={setOpen}>
          <div className="flex items-center gap-2">
            <input type="number" inputMode="numeric" placeholder="Min €" value={value.min}
              onChange={e => onChange({ min: e.target.value })}
              className="w-24 px-2 py-1.5 bg-off-white border-0 rounded text-sm text-navy
                         placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50" />
            <span className="text-navy/30 text-xs">–</span>
            <input type="number" inputMode="numeric" placeholder="Max €" value={value.max}
              onChange={e => onChange({ max: e.target.value })}
              className="w-24 px-2 py-1.5 bg-off-white border-0 rounded text-sm text-navy
                         placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50" />
          </div>
          {(value.min || value.max) && (
            <button type="button" onClick={() => onChange({ min: '', max: '' })}
              className="mt-2 pt-2 border-t border-gray-100 w-full text-[10px] text-navy/40 hover:text-navy">
              Clear
            </button>
          )}
        </Dropdown>

        {/* ── Pets · Sharing · Subletting ──────────────────────────────────
            Yes/No chips rather than a single toggle, because the data has three
            states and "the listing says no pets" is a different, useful search
            from "the listing does not mention pets". Leaving both chips off means
            "don't care" and shows everything, including the unknowns. */}
        <Dropdown id="rules" label={rulesLabel} active={rulesActive}
          open={open === 'rules'} onToggle={setOpen}>
          <div className="min-w-[210px] space-y-2">
            {([
              ['pets', 'Pets', 'Pet-friendly', 'No pets'],
              ['sharing', 'Sharing', 'Sharing ok', 'No sharing'],
            ] as const).map(([key, title, yesLabel, noLabel]) => (
              <div key={key}>
                <div className="text-[10px] uppercase tracking-wide text-navy/40 mb-1">{title}</div>
                <div className="flex gap-1">
                  <button type="button"
                    onClick={() => onChange({ [key]: value[key] === 'yes' ? '' : 'yes' } as Partial<BoardFilterValue>)}
                    className={cn(CHIP, value[key] === 'yes' ? CHIP_ON : CHIP_OFF)}>
                    {yesLabel}
                  </button>
                  <button type="button"
                    onClick={() => onChange({ [key]: value[key] === 'no' ? '' : 'no' } as Partial<BoardFilterValue>)}
                    className={cn(CHIP, value[key] === 'no' ? CHIP_ON : CHIP_OFF)}>
                    {noLabel}
                  </button>
                </div>
              </div>
            ))}

            {/* Subletting: a checkbox, no card icon — Kev's call. It is only ever
                asked as "can they sublet at all?", so one box is the whole control. */}
            <label className="flex items-center gap-2 pt-2 border-t border-gray-100 cursor-pointer">
              <input
                type="checkbox"
                checked={value.sublet}
                onChange={e => onChange({ sublet: e.target.checked })}
                className="w-3.5 h-3.5 accent-navy"
              />
              <span className="text-[11px] text-navy/70">Subletting allowed</span>
            </label>

            {rulesActive && (
              <button type="button"
                onClick={() => onChange({ pets: '', sharing: '', sublet: false })}
                className="mt-1 pt-2 border-t border-gray-100 w-full text-[10px] text-navy/40 hover:text-navy">
                Clear
              </button>
            )}
          </div>
        </Dropdown>

        {/* "Any" clears it — nobody picks a recency window and means
            "and also everything older", so there is no separate Clear row
            here the way price/type get one. */}
        <Dropdown id="updated" label={updatedLabel} active={!!value.updated}
          open={open === 'updated'} onToggle={setOpen}>
          <div className="flex flex-wrap gap-1 max-w-[220px]">
            <button type="button"
              onClick={() => { onChange({ updated: '' }); setOpen(null) }}
              className={cn(CHIP, !value.updated ? CHIP_ON : CHIP_OFF)}>
              Any
            </button>
            {UPDATED_OPTIONS.map(([v, l]) => (
              <button key={v} type="button"
                onClick={() => { onChange({ updated: value.updated === v ? '' : v }); setOpen(null) }}
                className={cn(CHIP, value.updated === v ? CHIP_ON : CHIP_OFF)}>
                {l}
              </button>
            ))}
          </div>
        </Dropdown>

        {/* Rental mode (2026-09-21): Long let / Winter let / Short let. Tapping the
            active one again clears it, like the other chip dropdowns. */}
        <Dropdown id="rental" label={rentalLabel} active={!!value.rental}
          open={open === 'rental'} onToggle={setOpen}>
          <div data-testid="rental-filter" className="flex flex-wrap gap-1 max-w-[240px]">
            <button type="button" onClick={() => { onChange({ rental: '' }); setOpen(null) }}
              className={cn(CHIP, !value.rental ? CHIP_ON : CHIP_OFF)}>
              All
            </button>
            {RENTAL_MODES.map(m => (
              <button key={m.key} type="button" data-testid={`rental-filter-${m.key}`}
                onClick={() => { onChange({ rental: value.rental === m.key ? '' : m.key }); setOpen(null) }}
                className={cn(CHIP, value.rental === m.key ? CHIP_ON : CHIP_OFF)}>
                {m.icon ? `${m.icon} ` : ''}{m.label}
              </button>
            ))}
          </div>
        </Dropdown>

        {extra}

        {activeCount > 0 && (
          <button type="button" onClick={onReset}
            className="px-3 py-2 rounded text-sm text-navy/40 hover:text-navy transition-colors whitespace-nowrap">
            Reset
          </button>
        )}

        {/* Desktop result counter. Tabular figures so it stops jittering as
            the count changes while typing. */}
        <span className="hidden lg:flex items-center gap-1.5 ml-auto text-xs text-navy/40 tabular-nums whitespace-nowrap">
          {loading ? 'loading…' : `${count} listing${count === 1 ? '' : 's'}`}
          {mineCount > 0 && (
            <span className="text-gold font-semibold">· {mineCount} yours</span>
          )}
        </span>
      </div>
    </div>
  )
}
