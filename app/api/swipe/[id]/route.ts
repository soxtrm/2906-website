import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { NextRequest, NextResponse } from 'next/server'

const BACKEND = ARGUS_ORIGIN

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const res = await fetch(`${BACKEND}/api/swipe/${encodeURIComponent(id)}`, { cache: 'no-store' })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 503 })
  }
}
