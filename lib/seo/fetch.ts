// Server-only fetch helpers for SEO pages. Calls the VPS proxy URL directly
// (same pattern used by app/[locale]/property/[slug]/page.tsx).
// IMPORTANT: never use these from client components.

import type { SeoProperty } from './filters'

const VPS = process.env.NEXT_PUBLIC_VPS_BASE || 'http://178.104.162.193:3001'

export async function fetchAllPropertiesServer(): Promise<SeoProperty[]> {
  try {
    const res = await fetch(`${VPS}/api/properties`, { next: { revalidate: 300 } })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data as SeoProperty[] : []
  } catch {
    return []
  }
}

export async function fetchActiveRentalsServer(): Promise<SeoProperty[]> {
  const all = await fetchAllPropertiesServer()
  return all.filter(p => {
    const cat = (p.category || '').toLowerCase()
    const status = (p.status || '').toLowerCase()
    return (cat === 'letting' || cat === 'aesthetics') && (status === 'available' || status === 'viewings')
  })
}

export async function fetchPropertyServer(slug: string): Promise<SeoProperty | null> {
  try {
    const res = await fetch(`${VPS}/api/properties/${slug}`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    return (await res.json()) as SeoProperty
  } catch {
    return null
  }
}
