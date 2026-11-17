import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { NextRequest, NextResponse } from 'next/server'

const BACKEND = ARGUS_ORIGIN

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // Forward to backend WA notification; backend handles delivery
    await fetch(`${BACKEND}/api/contact/general`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
  }
}
