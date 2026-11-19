// ARGUS Owner Workspace — the owner-facing view of the canonical ARGUS model.
//
// One physical property keeps one id (properties.id / ref). What changes over
// time is how it is offered (operating mode + offers), which rooms are rentable,
// where it is distributed and when it can be viewed. None of these create a
// second property. Field names mirror the backend tables they map to (see
// docs/owner-workspace/ARCHITECTURE.md), so the preview fixtures can be swapped
// for the API without reshaping the UI.

export type OperatingMode =
  | 'long_let' | 'rooms' | 'shortlet' | 'winter_let' | 'summer_let' | 'sale' | 'commercial' | 'commercial_sale'

export const MODE_LABEL: Record<OperatingMode, string> = {
  long_let: 'Long let',
  rooms: 'Room rentals',
  shortlet: 'Short let',
  winter_let: 'Winter let',
  summer_let: 'Summer let',
  sale: 'For sale',
  commercial: 'Commercial rent',
  commercial_sale: 'Commercial sale',
}
/** how the price of each offer type is quoted */
export const MODE_PERIOD: Record<OperatingMode, 'month' | 'night' | 'total'> = {
  long_let: 'month', rooms: 'month', shortlet: 'night', winter_let: 'month', summer_let: 'month',
  sale: 'total', commercial: 'month', commercial_sale: 'total',
}

export type ListingState = 'live' | 'paused' | 'private' | 'draft'

export interface Offer {
  id: string
  mode: OperatingMode
  price: number
  period: 'month' | 'night' | 'total'
  active: boolean
  /** audiences that see "price on request" instead of the figure */
  hidePriceFor: Audience[]
  /** optional conditions the owner sets per offer; nothing here is required */
  terms?: OfferTerms
}

export interface OfferTerms {
  minMonths?: number
  maxMonths?: number
  minNights?: number
  billsIncluded?: boolean
  negotiable?: boolean
  furnitureIncluded?: boolean
  soldWithTenant?: boolean
}

/** "6–24 months", "min. 3 nights", "negotiable · with furniture" */
export function termsLine(mode: OperatingMode, t?: OfferTerms): string {
  if (!t) return ''
  const out: string[] = []
  if (MODE_PERIOD[mode] === 'month') {
    if (t.minMonths && t.maxMonths) out.push(t.minMonths === t.maxMonths ? `${t.minMonths} months` : `${t.minMonths}–${t.maxMonths} months`)
    else if (t.minMonths) out.push(`${t.minMonths}+ months`)
    else if (t.maxMonths) out.push(`up to ${t.maxMonths} months`)
    if (t.billsIncluded) out.push('bills included')
  }
  if (MODE_PERIOD[mode] === 'night' && t.minNights) out.push(`min. ${t.minNights} night${t.minNights > 1 ? 's' : ''}`)
  if (MODE_PERIOD[mode] === 'total') {
    if (t.negotiable) out.push('negotiable')
    if (t.furnitureIncluded) out.push('with furniture')
    if (t.soldWithTenant) out.push('sold with tenant')
  }
  return out.join(' · ')
}

export type Audience = 'public' | 'agencies' | 'nexus'

export type RoomStatus = 'available' | 'occupied' | 'reserved' | 'inactive'

export interface Room {
  id: string            // stable room id, e.g. "29793-R2" (property id + room number)
  label: string
  photo: string
  /** all photos of the room; `photo` is the first (cover) */
  photos?: string[]
  price: number
  status: RoomStatus
  sizeSqm?: number
  ensuite?: boolean
  availableFrom?: string // YYYY-MM-DD
  occupiedUntil?: string // YYYY-MM-DD
  /** zone in the floor plan, plan units (1 unit ≈ 1 m) */
  zone?: { x: number; y: number; w: number; h: number }
}

export interface FloorPlan {
  width: number
  depth: number
  /** shared areas drawn but not rentable */
  shared: { label: string; x: number; y: number; w: number; h: number }[]
  doors: { x: number; y: number; side: 'n' | 's' | 'e' | 'w' }[]
  windows: { x: number; y: number; side: 'n' | 's' | 'e' | 'w'; len: number }[]
}

export interface ExclusiveDeal {
  agencyId: string
  until: string // YYYY-MM-DD
  /** what happens when it ends */
  thenRelease: 'all_approved' | 'selected' | 'private'
}

export interface Distribution {
  nexusDirect: boolean
  argusB2B: boolean
  allApprovedAgencies: boolean
  agencyIds: string[]
  agentIds: string[]
  exclusive: ExclusiveDeal | null
  private: boolean
}

export interface PropertyDistribution {
  /** true = follow the owner's profile defaults */
  inherit: boolean
  override: Distribution
}

export type SyncState = 'live' | 'pending' | 'delisting' | 'removed'

export interface ChannelStatus {
  channel: string        // 'NEXUS Direct', agency name, ...
  agencyId?: string
  state: SyncState
  since: string          // ISO
}

export interface Property {
  id: number
  ref: string
  name: string
  address: string
  town: string
  photos: string[]
  mode: OperatingMode
  modeHistory: { mode: OperatingMode; from: string; to?: string }[]
  bedrooms: number
  bathrooms: number
  sizeSqm?: number
  listing: ListingState
  offers: Offer[]
  rooms: Room[]
  plan?: FloorPlan
  availableFrom?: string
  lastConfirmedAt: string
  updatedAt: string
  distribution: PropertyDistribution
  channels: ChannelStatus[]
  /** an active tenancy blocks switching mode / whole-property bookings */
  tenancyUntil?: string
  propertyType?: string
  description?: string
  features?: string[]
  furnished?: 'Furnished' | 'Part' | 'Unfurnished'
  /** optional: which room a whole-property photo shows (photo url → room id) */
  photoRooms?: Record<string, string>
}

export interface Agency {
  id: string
  name: string
  approved: boolean
  agents: { id: string; name: string }[]
}

// ── viewing calendar ─────────────────────────────────────────────────────────
export interface AvailabilityRule {
  id: string
  propertyId: number
  roomId?: string
  weekday: number        // 0 = Sunday … 6 = Saturday (Malta local time)
  start: string          // 'HH:MM'
  end: string
  slotMinutes: number
}

export interface AvailabilityException {
  id: string
  propertyId: number
  date: string           // YYYY-MM-DD
  kind: 'blocked' | 'extra'
  start?: string
  end?: string
  note?: string
}

export type RequestStatus =
  | 'awaiting_owner'
  | 'confirmed'
  | 'declined'
  | 'new_time_proposed'
  | 'question'
  | 'cancelled'
  | 'completed'

export type RequestSource =
  | 'argus_crm' | 'agency_board' | 'nexus_housing' | 'direct_listing'
  | 'booking_link' | 'facebook_link' | 'whatsapp'

export const SOURCE_LABEL: Record<RequestSource, string> = {
  argus_crm: 'ARGUS agent',
  agency_board: 'Agency board',
  nexus_housing: 'NEXUS Housing',
  direct_listing: 'Your direct listing',
  booking_link: 'Booking link',
  facebook_link: 'Facebook link',
  whatsapp: 'WhatsApp',
}

export interface RequestEvent {
  at: string
  actor: 'owner' | 'agent' | 'tenant' | 'argus'
  action: string
  note?: string
}

export interface ViewingRequest {
  id: string
  propertyId: number
  roomId?: string
  start: string          // ISO (Malta wall clock serialised with offset)
  minutes: number
  status: RequestStatus
  source: RequestSource
  requester: { kind: 'agent' | 'tenant'; agencyId?: string; agentName?: string; clientRef: string }
  /** objective tenancy facts only — no nationality, no protected traits */
  applicant: { adults: number; children: number; moveIn: string; months: number; pets?: string; working?: string }
  proposedStart?: string
  question?: string
  history: RequestEvent[]
}

/** Who is really behind a message that ARGUS Main relays. ARGUS knows which
 *  account wrote, so the owner sees "Tim · Benestates" instead of a faceless bot. */
export interface Sender {
  kind: 'system' | 'agent' | 'client' | 'argus'
  name?: string
  agency?: string
}

export interface Message {
  id: string
  from: 'owner' | 'argus' | 'agent'
  sender?: Sender
  /** the property this message is about, when known */
  propertyId?: number
  /** a document sent in the chat (from Documents or uploaded right there) */
  attachment?: { docId: string; title: string; kind: DocumentItem['kind'] }
  text: string
  at: string
  /** structured actions rendered as buttons instead of more chat */
  actions?: { label: string; requestId: string; action: 'accept' | 'decline' | 'propose' }[]
}

export interface Thread {
  id: string
  title: string
  propertyId?: number
  requestId?: string
  with: 'ARGUS Main' | string
  unread: number
  messages: Message[]
}

export interface DocumentItem {
  id: string
  propertyId: number
  roomId?: string
  title: string
  kind: 'contract' | 'inventory' | 'certificate' | 'id' | 'other'
  addedAt: string
  sharedWith: string[]
  /** preview only: the file itself, so it can be opened */
  dataUrl?: string
  fileName?: string
}

export interface OwnerProfile {
  id: string
  name: string
  defaults: Distribution
  hidePriceFor: Audience[]
  notify: { whatsapp: boolean; email: boolean; quietFrom: string; quietTo: string; channel?: Channel }
  /** people linked to this owner account (partner, family, property manager). They
   *  share one conversation with ARGUS, so nobody is contacted twice. */
  delegates: Person[]
  photo?: string
  phone?: string
  email?: string
  languages?: string[]
  /** who ARGUS writes to for this account: 'me' or a delegate's name */
  mainContact?: string
}

/** how ARGUS Main reaches the owner; the chat in SYNC works the same on every channel */
export type Channel = 'whatsapp' | 'sms' | 'email' | 'app'
export const CHANNEL_LABEL: Record<Channel, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', app: 'Only here in SYNC' }

export interface Person {
  name: string
  role: 'manager' | 'viewer'
  properties: number[] | 'all'
  relation?: 'partner' | 'family' | 'property_manager' | 'helper'
  phone?: string
  email?: string
  photo?: string
}
