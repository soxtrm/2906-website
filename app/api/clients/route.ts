import { NextRequest, NextResponse } from 'next/server'

const BACKEND = 'http://178.104.162.193:3001'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const qs = searchParams.toString()
    const res = await fetch(`${BACKEND}/api/clients${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json([], { status: 500 })
  }
}

// Manual "+ Add client" from the calendar panel — proxies to the minimal
// /api/clients/quick backend route (no WhatsApp/Sheets/email side effects,
// unlike /api/clients/submit which the public add-client form uses).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const res = await fetch(`${BACKEND}/api/clients/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
