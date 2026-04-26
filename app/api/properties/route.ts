import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001'

export async function GET(req: NextRequest) {
  const search = req.nextUrl.search
  const res = await fetch(`${VPS}/api/properties${search}`, { next: { revalidate: 60 } })
  const data = await res.json()
  return NextResponse.json(data)
}
