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
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export type BoardFilterValue = {
  q: string
  beds: string
  baths: string
  min: string
  max: string
  type: string
}

const TYPES: [string, string][] = [
  ['apartment', 'Apartment'], ['penthouse', 'Penthouse'], ['house', 'House'],
  ['maisonette', 'Maisonette'], ['townhouse', 'Townhouse'], ['villa', 'Villa'],
]
const BEDS = ['1', '2', '3', '4']
const BATHS = ['1', '2', '3']

// ── shared shells, so every control lines up on the same baseline ───────────
const TRIGGER =
  'flex items-center gap-2 px-3 py-2 bg-off-white rounded text-sm text-navy/70 ' +
  'hover:text-navy transition-colors whitespace-nowrap'
const TRIGGER_ON = 'text-navy font-medium ring-1 ring-gold/40'
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

export function BoardFilters({ value, onChange, onReset, count, mineCount, loading, extra }: {
  value: BoardFilterValue
  onChange: (patch: Partial<BoardFilterValue>) => void
  onReset: () => void
  count: number
  mineCount: number
  loading: boolean
  /** Rendered at the end of the row — the board puts its "drawn area" pill here. */
  extra?: React.ReactNode
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const activeCount =
    (value.q ? 1 : 0) + (value.beds ? 1 : 0) + (value.baths ? 1 : 0) +
    (value.type ? 1 : 0) + (value.min || value.max ? 1 : 0)

  const typeLabel = value.type
    ? (TYPES.find(t => t[0] === value.type)?.[1] || value.type)
    : 'Property Type'
  const budgetLabel = value.min || value.max
    ? `€${value.min || '0'} – ${value.max ? `€${value.max}` : '∞'}`
    : 'Budget'

  return (
    <div ref={ref} className="w-full">
      {/* Mobile: one toggle, exactly like the public listings page. */}
      {/* min-h-[38px]: below ~30px this is a miss on a phone, and this is the
          one control that gates every other filter. */}
      <button
        type="button"
        onClick={() => setMobileOpen(o => !o)}
        className="lg:hidden flex items-center gap-2 text-navy text-sm font-medium w-full min-h-[38px] py-1"
      >
        <SlidersHorizontal className="w-4 h-4" />
        Filters
        {activeCount > 0 && (
          <span className="bg-gold text-navy text-[10px] px-1.5 py-0.5 rounded-full font-semibold">
            {activeCount}
          </span>
        )}
        <span className="ml-auto text-navy/40 text-xs font-normal tabular-nums">
          {loading ? '…' : `${count} listing${count === 1 ? '' : 's'}`}
        </span>
      </button>

      <div className={cn('flex-col lg:flex-row lg:items-center gap-2 lg:gap-3 w-full',
        mobileOpen ? 'flex mt-3' : 'hidden lg:flex')}>

        {/* Search — ref, town or area. The board's own listings are local, so
            this filters instantly rather than round-tripping. */}
        <div className="relative flex-1 lg:max-w-[260px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-navy/30 pointer-events-none" />
          <input
            type="text"
            value={value.q}
            onChange={e => onChange({ q: e.target.value })}
            placeholder="Search ref, town or area…"
            className="w-full pl-8 pr-7 py-2 bg-off-white border-0 rounded text-sm text-navy
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

        <Dropdown id="beds" label={value.beds ? `${value.beds}+ beds` : 'Beds'} active={!!value.beds}
          open={open === 'beds'} onToggle={setOpen}>
          <div className="flex flex-wrap gap-1">
            {BEDS.map(b => (
              <button key={b} type="button"
                onClick={() => { onChange({ beds: value.beds === b ? '' : b }); setOpen(null) }}
                className={cn(CHIP, 'min-w-[38px]', value.beds === b ? CHIP_ON : CHIP_OFF)}>
                {b}+
              </button>
            ))}
          </div>
        </Dropdown>

        <Dropdown id="baths" label={value.baths ? `${value.baths}+ baths` : 'Baths'} active={!!value.baths}
          open={open === 'baths'} onToggle={setOpen}>
          <div className="flex flex-wrap gap-1">
            {BATHS.map(b => (
              <button key={b} type="button"
                onClick={() => { onChange({ baths: value.baths === b ? '' : b }); setOpen(null) }}
                className={cn(CHIP, 'min-w-[38px]', value.baths === b ? CHIP_ON : CHIP_OFF)}>
                {b}+
              </button>
            ))}
          </div>
        </Dropdown>

        <Dropdown id="budget" label={budgetLabel} active={!!(value.min || value.max)}
          open={open === 'budget'} onToggle={setOpen}>
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
