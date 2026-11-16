export type Schedule = {
  weekly: { day: number; start: string; end: string }[]
  breaks: { day: number | null; start: string; end: string }[]
  exceptions: { date: string; kind: 'available' | 'unavailable'; start?: string; end?: string }[]
  blocked: { from: string; to: string; label?: string | null }[]
  durationMin: number; bufferMin: number; noticeHours: number; horizonDays: number; approval: 'manual' | 'auto'
}
export type Me = {
  owner: { name: string }; delegate: { name: string; role: string; scopes: string[] } | null; role: 'owner' | 'property_manager'; scopes: string[]
  propertiesConfirmedAt: string | null; notifyMode: string; urgentSeparately: boolean
  properties: { id: number; ref: string; town: string | null; property_type: string | null; bedrooms: number | null; available_status: string | null; longlet_price: string | null; sale_price: string | null; cover: string | null; openRequests: number }[]
}
export type Request = {
  id: number; propertyId: number; state: string; label: string; durationMin: number; preferred: { start: string; end: string }[]
  proposedStart: string | null; proposedEnd: string | null; expiresAt: string | null; createdAt: string; updatedAt: string
  agent: { name: string; agency: string | null; kind: string }
  client: { people?: number; groupType?: string; moveIn?: string; pets?: string; budgetNote?: string; notes?: string; clientRef?: string }
  note: string | null
}
export type Slot = { date: string; start: string; end: string; state: 'free' | 'busy' | 'too_soon' }
export type Desk = {
  timezone: string; from: string; days: number; requests: Request[]
  external: { viewingId: number; propertyId: number; startsAt: string; durationMin: number; status: string; managedBy: string }[]
  calendars: { propertyId: number; ref: string; town: string | null; rules: Schedule | null; windows: { date: string; start: string; end: string }[]; slots: Slot[] }[]
}
export type Detail = {
  property: Record<string, any> & { id: number; ref: string }
  proposals: { id: number; fields: Record<string, any>; review_state: string; created_at: string; reviewed_at: string | null }[]
  media: { id: number; kind: 'photo' | 'document'; filename: string; content_type: string; position: number; visibility: string; review_state: string; created_at: string }[]
  rules: { schedule: Schedule; version: number; updatedAt: string } | null
  distribution: { destination: string; allowed: boolean; state: string; available: boolean }[]
}
