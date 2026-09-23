import type { Property } from './types'

const API_BASE = '/api'

export interface PropertyFilters {
  category?: string
  minPrice?: number
  maxPrice?: number
  bedrooms?: string  // single number, "2,3" for multiple, "Studio", "5+"
  bathrooms?: string
  area?: string
  region?: string
  location?: string
  status?: string
  // ARGUS property intelligence (2026-09-23) — comma-separated. featureTags
  // combine with AND (must have all), localityIds and rentalModes combine
  // with OR (matches any) — same semantics the backend filter enforces.
  featureTags?: string
  localityIds?: string
  rentalModes?: string
}

export interface FeatureTagOption { key: string; label: string }
export interface LocalityOption { id: number; name: string; area: string | null }
export interface RentalModeOption { key: string; label: string }
export interface PropertyFilterOptions {
  featureTags: FeatureTagOption[]
  localities: LocalityOption[]
  rentalModes: RentalModeOption[]
}

export async function fetchFilterOptions(): Promise<PropertyFilterOptions> {
  const res = await fetch(`${API_BASE}/properties/filters`, { next: { revalidate: 3600 } })
  if (!res.ok) return { featureTags: [], localities: [], rentalModes: [] }
  return res.json()
}

export async function fetchProperties(filters?: PropertyFilters): Promise<Property[]> {
  const params = new URLSearchParams()
  if (filters) {
    Object.entries(filters).forEach(([key, val]) => {
      if (val !== undefined && val !== '') params.set(key, String(val))
    })
  }
  const qs = params.toString()
  const res = await fetch(`${API_BASE}/properties${qs ? `?${qs}` : ''}`, { next: { revalidate: 300 } })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

export async function fetchProperty(slug: string): Promise<Property> {
  const res = await fetch(`${API_BASE}/properties/${slug}`, { next: { revalidate: 300 } })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

export async function fetchFeaturedProperties(): Promise<Property[]> {
  const res = await fetch(`${API_BASE}/properties/featured`, { next: { revalidate: 300 } })
  if (!res.ok) return []
  return res.json()
}
