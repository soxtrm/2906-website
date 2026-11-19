import { datePart, timePart, weekdayOf } from '@/lib/owner/engine'
import { MODE_LABEL, type Offer, type Property } from '@/lib/owner/model'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const dayName = (date: string) => DAYS[weekdayOf(date)]
export const shortDay = (date: string) => DAYS[weekdayOf(date)].slice(0, 3)
export function niceDate(date: string, withDay = true) {
  const [, m, d] = date.split('-').map(Number)
  return `${withDay ? `${dayName(date)}, ` : ''}${d} ${MONTHS[m - 1]}`
}
export function relDay(date: string, today: string) {
  const diff = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff < 7) return dayName(date)
  return niceDate(date)
}
export const when = (iso: string, today: string) => `${relDay(datePart(iso), today)}, ${timePart(iso)}`
export const monthName = (m: number) => MONTHS[m]
export const euro = (n: number) => `€${Math.round(n).toLocaleString('en-GB')}`
export function priceLine(o?: Offer) {
  if (!o) return 'No price yet'
  return `${euro(o.price)}${o.period === 'month' ? ' / month' : o.period === 'night' ? ' / night' : ''}`
}
export const activeOffer = (p: Property) => p.offers.find(o => o.active)
export const modeLabel = (p: Property) => MODE_LABEL[p.mode]
export function ago(iso: string, today: string) {
  const d = datePart(iso)
  const diff = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86400000)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  return `${diff} days ago`
}
export function occupants(a: { adults: number; children: number }) {
  const parts = [`${a.adults} adult${a.adults === 1 ? '' : 's'}`]
  if (a.children) parts.push(`${a.children} child${a.children === 1 ? '' : 'ren'}`)
  return parts.join(', ')
}

// One colour per property, used in the calendar, the chat and the wish list so
// the owner recognises a home at a glance. Modern, no orange (Kev, 19 Nov).
export const PROP_COLORS = ['#ec4899', '#14b8a6', '#6366f1', '#0ea5e9', '#a855f7', '#84cc16']
export function propColor(ids: number[], id: number | null | undefined) {
  if (id == null) return '#071449'
  const i = ids.indexOf(id)
  return PROP_COLORS[(i < 0 ? 0 : i) % PROP_COLORS.length]
}
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
