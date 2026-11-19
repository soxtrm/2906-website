// SYNC server side (nexussync.one route handlers only, never imported by client code).
// Calls the ARGUS SYNC account service with the shared HMAC signature
// (same scheme as services/nexusLinkCrypto.js on ARGUS) and keeps the owner's
// session in an httpOnly cookie on this domain.
import { createHash, createHmac } from 'crypto'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'

export const SESSION_COOKIE = 'sync_session'
const PREFIX = '/api/sync-account/v1'

function secret() {
  const s = (process.env.NEXUS_SYNC_LINK_SECRET || '').replace(/[^\x21-\x7E]/g, '')
  if (s.length < 32) throw new Error('SYNC_NOT_CONFIGURED')
  return s
}

// Deterministic JSON, keys sorted recursively; must match canonicalJson() on ARGUS.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}
export function sign(key: string, { timestamp, method, path, body }: { timestamp: number; method: string; path: string; body: unknown }) {
  const hash = createHash('sha256').update(canonicalJson(body ?? null)).digest('hex')
  return `v1=${createHmac('sha256', key).update(`${timestamp}.${method.toUpperCase()}.${path}.${hash}`).digest('hex')}`
}

export type ArgusAnswer = { status: number; body: Record<string, unknown> & { ok?: boolean; error?: string; message?: string } }

export async function argus(path: string, body: Record<string, unknown>, clientIp?: string | null): Promise<ArgusAnswer> {
  let key: string
  try { key = secret() } catch { return { status: 503, body: { ok: false, error: 'SYNC_NOT_CONFIGURED', message: 'Sign-in is not available right now.' } } }
  const clean = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
  const timestamp = Math.floor(Date.now() / 1000)
  try {
    const res = await fetch(`${ARGUS_ORIGIN}${PREFIX}${path}`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        'X-Nexus-Link-Key': process.env.NEXUS_SYNC_LINK_KEY_ID || 'nexus-sync',
        'X-Nexus-Link-Timestamp': String(timestamp),
        'X-Nexus-Link-Signature': sign(key, { timestamp, method: 'POST', path, body: clean }),
        ...(clientIp ? { 'X-Sync-Client-IP': clientIp.slice(0, 64) } : {}),
      },
      body: JSON.stringify(clean),
    })
    const data = await res.json().catch(() => ({ ok: false, error: 'BAD_ANSWER', message: 'ARGUS did not answer properly.' }))
    return { status: res.status, body: data }
  } catch {
    return { status: 502, body: { ok: false, error: 'NO_CONNECTION', message: 'No connection to ARGUS. Please try again.' } }
  }
}

export function clientIp(headers: Headers) {
  return (headers.get('x-forwarded-for') || '').split(',')[0].trim() || headers.get('x-real-ip') || null
}

// Requests that change something must come from SYNC itself.
const ORIGINS = ['https://nexussync.one', 'https://www.nexussync.one']
export function sameOrigin(headers: Headers) {
  const o = headers.get('origin')
  if (!o) return true // same-origin GET/fetch without Origin (older browsers); cookie is SameSite=Lax anyway
  const host = headers.get('host') || ''
  return ORIGINS.includes(o) || o === `https://${host}` || (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(o))
}

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge,
})
