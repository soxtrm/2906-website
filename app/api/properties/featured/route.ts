import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { NextResponse } from 'next/server'
import { isPubliclyPlausibleProperty } from '@/lib/public-property-safety'

const VPS = ARGUS_ORIGIN

export async function GET() {
  const res = await fetch(`${VPS}/api/properties/featured`, { next: { revalidate: 60 } })
  const data = await res.json()
  return NextResponse.json(Array.isArray(data) ? data.filter(isPubliclyPlausibleProperty) : data, { status: res.status })
}
