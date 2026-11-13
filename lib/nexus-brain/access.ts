import 'server-only'
import { cookies } from 'next/headers'

// Reuses the canonical CRM identity endpoint. No parallel identity store.
export async function brainAccess(): Promise<'allowed' | 'signin' | 'denied' | 'unavailable'> {
  const token = (await cookies()).get('crm_session')?.value
  if (!token) return 'signin'
  try {
    const origin = process.env.NEXUS_BRAIN_AUTH_ORIGIN || 'http://178.104.162.193:3001'
    const response = await fetch(`${origin}/api/crm/me`, {
      headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      signal: AbortSignal.timeout(8000), redirect: 'error',
    })
    if (response.status === 401) return 'signin'
    if (response.status === 403) return 'denied'
    if (!response.ok) return 'unavailable'
    const data = await response.json()
    return data?.agent?.role === 'admin' ? 'allowed' : 'denied'
  } catch { return 'unavailable' }
}
