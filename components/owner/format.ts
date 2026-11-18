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
