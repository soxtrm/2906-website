import 'server-only'
import { isPubliclyPlausibleProperty } from './public-property-safety'
import type { Property } from './types'

type PublicPropertyDetail = Property & {
  listingType?: string
  size?: number | null
  priceAfter?: string
  summary?: string
  fullDescription?: string
  documents?: Array<{ filename: string; url: string }>
}

export async function getPublicProperty(slug: string, { fresh = false } = {}): Promise<PublicPropertyDetail | null> {
  if (!slug || slug.length > 240 || /[\\/]/.test(slug) || slug === '.' || slug === '..') return null

  try {
    const response = await fetch(
      `http://178.104.162.193:3001/api/properties/${encodeURIComponent(slug)}`,
      fresh ? { cache: 'no-store', signal: AbortSignal.timeout(5000) } : { next: { revalidate: 60 } },
    )
    if (!response.ok) return null
    const property = await response.json()
    return property?.slug === slug && isPubliclyPlausibleProperty(property) ? property : null
  } catch {
    return null
  }
}
