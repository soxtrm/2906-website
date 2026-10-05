import { NextRequest, NextResponse } from 'next/server'
import { isPubliclyPlausibleProperty } from '@/lib/public-property-safety'

const VPS = 'http://178.104.162.193:3001'

export async function GET(req: NextRequest) {
  const search = req.nextUrl.search
  const res = await fetch(`${VPS}/api/properties${search}`, { next: { revalidate: 60 } })
  const data = await res.json()
  if (!Array.isArray(data)) return NextResponse.json(data, { status: res.status })
  const publicProperties = data.filter(isPubliclyPlausibleProperty)
  return NextResponse.json(publicProperties, { status: res.status })
}
