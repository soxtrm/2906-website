// Client-side fetch wrapper for the CRM. Talks to same-origin /api/crm/* which
// proxies to the backend with the HTTP-only session cookie.
export async function crmFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`/api/crm/${path}`, { credentials: 'same-origin', ...opts })
  let data: any = null
  try { data = await res.json() } catch { /* non-json */ }
  if (!res.ok) {
    const err: any = new Error((data && data.error) || `Request failed (${res.status})`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export async function crmGet(path: string) { return crmFetch(path) }
export async function crmJson(path: string, method: string, body: any) {
  return crmFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type Reveals = { used: number; limit: number }
export type Me = {
  id: number; username: string; email: string; name: string;
  role: 'admin' | 'agent' | 'viewer'; daily_reveal_limit: number
}
