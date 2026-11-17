import { NextRequest } from 'next/server'
import { argusSessionFetch } from '@/lib/argus-session-proxy'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  return argusSessionFetch(req, `/api/calendar/${encodeURIComponent(id)}`, { method: 'PATCH', body: await req.text() })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  return argusSessionFetch(req, `/api/calendar/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
