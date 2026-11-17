import { NextRequest } from 'next/server'
import { argusSessionFetch } from '@/lib/argus-session-proxy'

// Client list and manual "+ Add client" for the internal calendar. CRM staff only (the backend refuses
// Board accounts). The public add-client form uses its own submission route, not this one.
export async function GET(req: NextRequest) {
  const qs = new URL(req.url).searchParams.toString()
  return argusSessionFetch(req, `/api/clients${qs ? `?${qs}` : ''}`)
}

export async function POST(req: NextRequest) {
  return argusSessionFetch(req, '/api/clients/quick', { method: 'POST', body: await req.text() })
}
