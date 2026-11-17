import { NextRequest } from 'next/server'
import { argusSessionFetch } from '@/lib/argus-session-proxy'

// Internal calendar. Signed-in CRM or Board users only; the backend decides what each role may see.
export async function GET(req: NextRequest) {
  const qs = new URL(req.url).searchParams.toString()
  return argusSessionFetch(req, `/api/calendar${qs ? `?${qs}` : ''}`)
}

export async function POST(req: NextRequest) {
  return argusSessionFetch(req, '/api/calendar', { method: 'POST', body: await req.text() })
}
