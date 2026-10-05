import { NextResponse } from 'next/server'
import { isPubliclyPlausibleProperty } from '@/lib/public-property-safety'

const VPS = 'http://178.104.162.193:3001'

export async function GET() {
  const res = await fetch(`${VPS}/api/properties/featured`, { next: { revalidate: 60 } })
  const data = await res.json()
  return NextResponse.json(Array.isArray(data) ? data.filter(isPubliclyPlausibleProperty) : data, { status: res.status })
}
