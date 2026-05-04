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
