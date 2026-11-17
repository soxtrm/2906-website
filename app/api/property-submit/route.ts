import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { NextRequest, NextResponse } from 'next/server'

const BACKEND = ARGUS_ORIGIN

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const res = await fetch(`${BACKEND}/api/property-submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
  }
}
