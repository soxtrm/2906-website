'use client'
// Incoming Properties — shared types, polling summary hook and small helpers.
// Data: /api/crm/intake/* (staff only). Counts come from the database, not
// from the browser, and are refreshed while the page is open.
import { useEffect, useState } from 'react'
import { crmFetch } from './api'

export type Missing = { field: string; label: string; critical: boolean }
export type IntakeProperty = {
  kind: 'property'; id: number; ref: string; type: string | null; town: string | null
  beds: number | null; baths: number | null; sizeSqm: number | null; rent: number | null; sale: number | null
  availableDate: string | null; marketStatus: string | null; published: boolean; usable: boolean; archived: boolean
  cover: string | null; images: string[]; imageCount: number; mediaExpected: number | null
  summary: string; description?: string
  uploader: { id: number | null; name: string | null }; uploadedAt: string; createdAt: string; updatedAt: string; source: string | null
  package: { id: number; state: string; reason: string | null; mediaImported: number | null } | null
  hasOwner: boolean
  verification: { status: 'unverified' | 'needs_correction' | 'verified'; note: string | null; at: string | null; by: string | null }
  linkedTo: { id: number; ref: string } | null
  missing: Missing[]; pending: boolean; ready: boolean
  canReview?: boolean; suggestions?: Suggestion[]
}
export type IntakePackage = {
  kind: 'package'; packageId: number; state: 'FAILED' | 'DUPLICATE'; reason: string | null; attempts: number
  summary: string; mediaExpected: number; uploader: { id: number | null; name: string | null }; uploadedAt: string; duplicateOf: string | null
}
export type IntakeItem = IntakeProperty | IntakePackage
export type Suggestion = { id: number; ref: string; town: string; beds: number | null; price: number | null; published: boolean; imageCount: number; cover: string | null; marketStatus: string | null; reason: string }
export type IntakeCounts = {
  new_today: number; needs_verification: number; needs_correction: number; missing_info: number; ready: number
  approved: number; approved_today: number; failed: number; duplicates: number; missing_price: number
}
export type IntakeSummary = { counts: IntakeCounts; uploadsToday: { agent: string; n: number }[] }
export type FeedEvent = { id: number; at: string; action: string; actor: string | null; propertyId: number | null; ref: string | null; packageId: number | null; note: string | null; media: number | null }

export const FILTERS: { key: string; label: string; count: keyof IntakeCounts | null; hint: string }[] = [
  { key: 'needs_verification', label: 'Needs verification', count: 'needs_verification', hint: 'Uploaded, nobody has confirmed the facts yet' },
  { key: 'ready', label: 'Ready to approve', count: 'ready', hint: 'Price, location, bedrooms and photos are there' },
  { key: 'missing_info', label: 'Missing information', count: 'missing_info', hint: 'Price, location, bedrooms or photos missing' },
  { key: 'new_today', label: 'New today', count: 'new_today', hint: 'Received today (Malta time)' },
  { key: 'failed', label: 'Failed uploads', count: 'failed', hint: 'Packages that could not be imported' },
  { key: 'approved', label: 'Verified', count: 'approved', hint: 'Facts confirmed by Olga or an administrator' },
  { key: 'duplicates', label: 'Duplicate / linked', count: 'duplicates', hint: 'Archived as a duplicate or linked to an existing property' },
]

// One shared poll per tab: the nav badge, the dashboard and the inbox read the same numbers.
let cache: { at: number; data: IntakeSummary | null; inflight: Promise<IntakeSummary | null> | null } = { at: 0, data: null, inflight: null }
const listeners = new Set<(s: IntakeSummary | null) => void>()
export function refreshIntakeSummary(): Promise<IntakeSummary | null> {
  if (cache.inflight) return cache.inflight
  cache.inflight = crmFetch('intake/summary')
    .then((d: IntakeSummary) => { cache = { at: Date.now(), data: d, inflight: null }; listeners.forEach(l => l(d)); return d })
    .catch(() => { cache.inflight = null; return cache.data })
  return cache.inflight
}
export function useIntakeSummary(intervalMs = 45_000, enabled = true) {
  const [s, setS] = useState<IntakeSummary | null>(cache.data)
  useEffect(() => {
    if (!enabled) return
    listeners.add(setS)
    if (Date.now() - cache.at > 10_000) refreshIntakeSummary()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') refreshIntakeSummary() }, intervalMs)
    const onFocus = () => refreshIntakeSummary()
    window.addEventListener('focus', onFocus)
    return () => { listeners.delete(setS); window.clearInterval(t); window.removeEventListener('focus', onFocus) }
  }, [intervalMs, enabled])
  return enabled ? s : null
}

// Cloudinary delivers resized copies on request; everything else is used as is.
export function thumb(url: string | null | undefined, w = 640) {
  if (!url) return ''
  return url.includes('/res.cloudinary.com/') && url.includes('/upload/') && !/\/upload\/[a-z]_/.test(url)
    ? url.replace('/upload/', `/upload/w_${w},c_limit,q_auto,f_auto/`) : url
}
export const money = (rent: number | null, sale: number | null) =>
  rent != null ? `€${rent.toLocaleString('en-GB')}/month` : sale != null ? `€${sale.toLocaleString('en-GB')} sale` : 'Price missing'
export const maltaTime = (d: string | null | undefined) => d
  ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—'
export function ago(d: string | null | undefined) {
  if (!d) return ''
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.round(h / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
export const VERIFY_LABEL: Record<string, string> = { unverified: 'Verification required', needs_correction: 'Needs correction', verified: 'Verified' }

export function feedLine(e: FeedEvent): string {
  const who = e.actor || 'ARGUS'
  const ref = e.ref ? `#${e.ref}` : e.packageId ? `upload ${e.packageId}` : 'a property'
  switch (e.action) {
    case 'verified': return `${who} verified ${ref}`
    case 'needs_correction': return `${who} asked for a correction on ${ref}${e.note ? `: ${e.note}` : ''}`
    case 'linked': return `${who} linked ${ref} to an existing property`
    case 'rejected_duplicate': return `${who} rejected ${ref} as a duplicate`
    case 'edited': return `${who} corrected ${ref}`
    case 'package_dismissed': return `${who} closed failed upload ${e.packageId ?? ''}`.trim()
    case 'upload_imported': return `${who} uploaded ${ref}${e.media != null ? ` · ${e.media} photos` : ''}`
    case 'upload_review_required': return `${who} uploaded ${ref}${e.media != null ? ` · ${e.media} photos` : ''} — verification required`
    case 'upload_failed': return `Upload ${e.packageId ?? ''} failed${e.note ? `: ${e.note}` : ''}`
    case 'upload_duplicate': return `Upload ${e.packageId ?? ''} was a duplicate${e.note ? ` (${e.note})` : ''}`
    default: return `${who}: ${e.action.replace(/_/g, ' ')} ${ref}`
  }
}
