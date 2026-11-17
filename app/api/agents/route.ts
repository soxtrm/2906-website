import { NextRequest } from 'next/server'
import { argusSessionFetch } from '@/lib/argus-session-proxy'

// Agent list for the internal calendar. Signed-in CRM or Board users only.
export async function GET(req: NextRequest) {
  return argusSessionFetch(req, '/api/agents')
}
