'use client'
// ============================================================================
// rental-modes.tsx — LONG LET / WINTER LET / SHORT LET in the CRM (2026-09-21).
//
// A property may hold SEVERAL modes at once (a Nov–Apr flat can be a winter let
// and a short let). Modes are separate from availability/status and from property
// type. The backend (services/rentalModes.js) derives them from the legacy single
// lease_type until someone sets them, so every existing listing already has a
// valid value here — nothing to migrate on this side either.
//
// One place for the four things every surface needs:
//   RentalModeBadges  the WINTER / SHORT tag next to the locality on a card or row
//   UntilLine         "until April", right under the Available date
//   RentalModePicker  multi-select for the edit / new-property forms
//   RENTAL_TABS       the filter tabs (Long / Winter / Short)
// ============================================================================
import React from 'react'

export type RentalMode = 'long_let' | 'winter_let' | 'short_let'
export const RENTAL_MODES: { key: RentalMode; label: string; icon: string }[] = [
  { key: 'long_let', label: 'Long let', icon: '' },
  { key: 'winter_let', label: 'Winter let', icon: '❄️' },
  { key: 'short_let', label: 'Short let', icon: '🕒' },
]
export const RENTAL_LABEL: Record<RentalMode, string> = { long_let: 'Long let', winter_let: 'Winter let', short_let: 'Short let' }

// "April" — month only, a season fact for whoever is scanning (same as the ad text).
export function untilMonth(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = new Date(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso)
  if (!Number.isFinite(t.getTime())) return null
  return t.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
}

const TAG: React.CSSProperties = {
  fontSize: 9, fontWeight: 800, color: '#fff', padding: '2px 6px', borderRadius: 5,
  letterSpacing: '0.03em', flexShrink: 0, whiteSpace: 'nowrap',
}

// WINTER shows for a winter-let mode OR any dated end ("Bis") — that is the rule that
// was already on the board (a limited term must never read as year-round). SHORT shows
// for a short-let mode. A plain long let shows nothing, exactly as before.
export function RentalModeBadges({ modes, availableUntil }: { modes?: string[] | null; availableUntil?: string | null }) {
  const m = Array.isArray(modes) ? modes : []
  const winter = m.includes('winter_let') || !!availableUntil
  const short = m.includes('short_let')
  if (!winter && !short) return null
  const month = untilMonth(availableUntil)
  return (
    <>
      {winter && (
        <span data-testid="badge-winter" title={`Winter let${month ? `, available until ${month}` : ''}`}
          style={{ ...TAG, background: '#2E6FA8' }}>❄️ WINTER</span>
      )}
      {short && (
        <span data-testid="badge-short" title="Short let" style={{ ...TAG, background: '#7A5AA6' }}>🕒 SHORT</span>
      )}
    </>
  )
}

export function UntilLine({ availableUntil, style }: { availableUntil?: string | null; style?: React.CSSProperties }) {
  const month = untilMonth(availableUntil)
  if (!month) return null
  return <div data-testid="until-line" style={{ fontSize: 10, color: '#5FA3D8', fontWeight: 500, marginTop: 1, ...style }}>until {month}</div>
}

// Multi-select for forms. `value` is the modes the user has ticked; an empty selection
// is a real state ("not set — derive from the listing"), never silently filled in.
export function RentalModePicker({ value, onChange, disabled, style }: {
  value: string[]; onChange: (next: RentalMode[]) => void; disabled?: boolean; style?: React.CSSProperties
}) {
  const on = new Set(value)
  return (
    <div data-testid="rental-mode-picker" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...style }}>
      {RENTAL_MODES.map(m => {
        const active = on.has(m.key)
        return (
          <label key={m.key} data-testid={`mode-${m.key}`} style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7, fontSize: 12,
            cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
            border: `1px solid ${active ? '#2E6FA8' : '#D1D5DB'}`, background: active ? '#E8F1FA' : '#fff', color: active ? '#1D4E7C' : '#4B5563',
            fontWeight: active ? 600 : 500,
          }}>
            <input type="checkbox" checked={active} disabled={disabled} style={{ accentColor: '#2E6FA8' }}
              onChange={e => {
                const next = new Set(on)
                e.target.checked ? next.add(m.key) : next.delete(m.key)
                onChange(RENTAL_MODES.map(x => x.key).filter(k => next.has(k)))
              }} />
            {m.icon ? `${m.icon} ` : ''}{m.label}
          </label>
        )
      })}
    </div>
  )
}

// Filter tabs for lists. '' = all.
export const RENTAL_TABS: { key: '' | RentalMode; label: string }[] = [
  { key: '', label: 'All' }, { key: 'long_let', label: 'Long let' }, { key: 'winter_let', label: 'Winter let' }, { key: 'short_let', label: 'Short let' },
]
export function RentalTabs({ value, onChange, dark }: { value: '' | RentalMode; onChange: (v: '' | RentalMode) => void; dark?: boolean }) {
  return (
    <div data-testid="rental-tabs" style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
      {RENTAL_TABS.map(t => {
        const active = value === t.key
        return (
          <button key={t.key || 'all'} type="button" data-testid={`rental-tab-${t.key || 'all'}`} onClick={() => onChange(t.key)}
            style={{
              padding: '4px 9px', borderRadius: 7, fontSize: 11, cursor: 'pointer', border: 'none',
              background: active ? (dark ? '#2E6FA8' : '#1D4E7C') : (dark ? 'rgba(255,255,255,0.06)' : '#F3F4F6'),
              color: active ? '#fff' : (dark ? '#A9B0BC' : '#4B5563'), fontWeight: active ? 700 : 500,
            }}>{t.label}</button>
        )
      })}
    </div>
  )
}
