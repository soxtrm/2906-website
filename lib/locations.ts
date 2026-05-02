// Always use the Next.js proxy — avoids mixed-content blocks on HTTPS deployments
const API_BASE = '/api'

export interface Area {
  id: number
  code: string
  display_name: string
  is_key_area?: boolean
}

export interface AreasResponse {
  key_areas: Area[]
  special_areas: Area[]
}

export interface Village {
  code: string
  display_name: string
  areas?: string[]
}

export interface VillagesResponse {
  by_area: Record<string, Village[]>
  all_unique: Village[]
}

export async function fetchAreas(): Promise<AreasResponse> {
  const res = await fetch(`${API_BASE}/api/locations/areas`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetchAreas: ${res.status}`)
  return res.json()
}

export async function fetchVillages(areaCodes: string[]): Promise<VillagesResponse> {
  if (areaCodes.length === 0) return { by_area: {}, all_unique: [] }
  const params = new URLSearchParams({ area_codes: areaCodes.join(',') })
  const res = await fetch(`${API_BASE}/api/locations/villages?${params}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetchVillages: ${res.status}`)
  return res.json()
}

export async function fetchVillage(code: string): Promise<Village & { primary_area: string; areas: string[] }> {
  const res = await fetch(`${API_BASE}/api/locations/village/${code}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetchVillage: ${res.status}`)
  return res.json()
}
