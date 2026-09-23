import { NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001'

// Feature-tag / locality / rental-mode vocabulary the multi-select filters
// render from (ARGUS property intelligence, 2026-09-23). Revalidates hourly
// — this list changes only when new inventory/localities appear, never per
// request.
export async function GET() {
  const res = await fetch(`${VPS}/api/properties/filters`, { next: { revalidate: 3600 } })
  const data = await res.json()
  return NextResponse.json(data)
}
