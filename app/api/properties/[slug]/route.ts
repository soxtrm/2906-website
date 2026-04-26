import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params
  const res = await fetch(`${VPS}/api/properties/${slug}`, { next: { revalidate: 60 } })
  if (!res.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const data = await res.json()
  return NextResponse.json(data)
}
