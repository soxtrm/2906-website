// Client side of the real SYNC backend (nexussync.one /api/sync/*). The session
// lives in an httpOnly cookie; this file never sees it.
export interface LiveAccount {
  id: string; email: string | null; emailVerified: boolean; name: string
  phone: { e164: string; verified: boolean; via: string | null } | null
  notifyChannel: 'whatsapp' | 'sms' | 'email' | 'app'
}
export interface LiveListing {
  externalId: string; sourcePropertyId: number; ref: string; claimState: string
  facts: { locality: string; type: string; bedrooms: number | null; bathrooms: number | null; rent: number | null; sale: number | null; availableFrom: string | null; amenities: string[]; photos: string[] }
}
export interface LiveLink {
  linkId: string; agencyKey: string; state: 'verified' | 'claim_pending' | 'invited' | 'not_invited' | 'disputed' | 'revoked'
  properties?: LiveListing[]
  proposed?: { externalId: string; ref: string; town: string; propertyType: string; bedrooms: number | null; claimState: string }[]
}
export interface LiveOwner { agencyKey: string; links: LiveLink[] }
export interface LiveMessage { id: number; at: string; from: 'owner' | 'argus'; sender: { kind: 'owner' | 'agent' | 'system'; name: string | null; org: string | null }; text: string; propertyId: number | null }

export type Answer<T> = ({ ok: true } & T) | { ok: false; error: string; message: string; status: number }

export async function sync<T = Record<string, unknown>>(op: string, body: Record<string, unknown> = {}): Promise<Answer<T>> {
  try {
    const r = await fetch(`/api/sync/${op}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || d.ok === false) return { ok: false, error: d.error || 'FAILED', message: d.message || 'Something went wrong. Please try again.', status: r.status }
    return { ok: true, ...d } as Answer<T>
  } catch {
    return { ok: false, error: 'NO_CONNECTION', message: 'No connection. Please check your internet and try again.', status: 0 }
  }
}

export const liveProperties = (o: LiveOwner | null) => (o?.links || []).flatMap(l => l.properties || [])
export const pendingClaims = (o: LiveOwner | null) => (o?.links || []).filter(l => l.state === 'claim_pending')
