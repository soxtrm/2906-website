const BASE = '/api/admin'

function token() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('admin_token')
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const t = token()
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...extra,
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as T
}

export const adminApi = {
  login: (email: string, password: string) =>
    req<{ token: string; role: string; email: string }>('POST', 'login', { email, password }),

  me: () => req<{ id: string; email: string; role: string }>('GET', 'me'),

  stats: () => req<Record<string, number>>('GET', 'crm/stats'),

  // Properties
  getProperties: (params = '') => req<{ properties: AdminProperty[]; total: number }>('GET', `properties${params}`),
  createProperty: (data: Partial<AdminProperty>) => req<AdminProperty>('POST', 'properties', data),
  updateProperty: (id: string, data: Partial<AdminProperty>) => req<AdminProperty>('PATCH', `properties/${id}`, data),
  deleteProperty: (id: string) => req<{ ok: boolean }>('DELETE', `properties/${id}`),
  uploadImages: async (id: string, files: FileList) => {
    const t = token()
    const form = new FormData()
    Array.from(files).forEach(f => form.append('images', f))
    const res = await fetch(`${BASE}/properties/${id}/images`, {
      method: 'POST',
      headers: t ? { Authorization: `Bearer ${t}` } : {},
      body: form,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Upload failed')
    return data as { images: string[] }
  },

  // CRM
  getOwners: (params = '') => req<{ owners: Owner[]; total: number }>('GET', `crm/owners${params}`),
  getOwner: (phone: string) => req<OwnerDetail>('GET', `crm/owners/${phone}`),
  updateOwner: (phone: string, data: { status?: string; notes?: string }) =>
    req<{ ok: boolean }>('PATCH', `crm/owners/${phone}`, data),

  getClients: (params = '') => req<{ clients: Client[]; total: number }>('GET', `crm/clients${params}`),
  updateClient: (phone: string, data: { status?: string; notes?: string }) =>
    req<{ ok: boolean }>('PATCH', `crm/clients/${phone}`, data),

  getWarm: (params = '') => req<{ contacts: WarmContact[]; total: number }>('GET', `crm/warm${params}`),

  // Users (admin only)
  getUsers: () => req<AdminUser[]>('GET', 'users'),
  createUser: (email: string, password: string, role: string) =>
    req<AdminUser>('POST', 'users', { email, password, role }),
  updateUser: (id: string, data: { role?: string; is_active?: boolean; password?: string }) =>
    req<{ ok: boolean }>('PATCH', `users/${id}`, data),
  deleteUser: (id: string) => req<{ ok: boolean }>('DELETE', `users/${id}`),

  // Site content (admin only)
  getContent: () => req<SiteContentItem[]>('GET', 'content'),
  updateContent: (key: string, value: string) =>
    req<{ ok: boolean }>('PATCH', `content/${key}`, { value }),
}

// Types
export interface AdminProperty {
  id: string
  title: string
  slug: string
  listing_type: 'To Rent' | 'For Sale'
  price: number
  price_after: 'per month' | 'total'
  price_type: 'month' | 'total'
  bedrooms: number | null
  bathrooms: number
  area: number | null
  size: number | null
  property_type: string
  category: 'letting' | 'aesthetics' | 'commercial' | 'sales'
  region: string
  location: string
  status: 'available' | 'viewings' | 'rented'
  images: string[]
  summary: string
  description: string
  full_description: string
  features: string[]
  available_from: string
  property_reference: string
  featured: boolean
  is_published: boolean
  created_by_email: string
  created_at: string
}

export interface SiteContentItem {
  key: string
  label: string
  value: string
  updated_at: string
}

export interface Owner {
  id: string
  phone: string
  name: string
  notes: string
  first_seen_at: string
  last_seen_at: string
  active_props: number
  total_outreach: number
  last_outreach: string
  cycle_status: string
}

export interface OwnerDetail extends Owner {
  properties: unknown[]
  cycles: unknown[]
  recent_outreach: unknown[]
}

export interface Client {
  id: string
  phone: string
  name: string
  budget_min: number
  budget_max: number
  bedrooms_wanted: number[]
  locations: string[]
  status: string
  notes: string
  assigned_agent: string
  created_at: string
}

export interface WarmContact {
  phone: string
  session: string
  is_warm: boolean
  has_property: boolean
  is_upcoming: boolean
  last_interaction: string
  owner_name: string
}

export interface AdminUser {
  id: string
  email: string
  role: 'admin' | 'moderator'
  is_active: boolean
  last_login: string
  created_at: string
  created_by_email: string
}
