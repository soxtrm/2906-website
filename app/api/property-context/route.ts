import { NextRequest, NextResponse } from 'next/server'
import { contextForPriority, fetchNexusContext, type SmartPriority } from '@/lib/nexus-property-context'

const priorities = new Set<SmartPriority>(['weekly-shop', 'swimming', 'health', 'gym'])

export async function GET(request: NextRequest) {
  const priority = request.nextUrl.searchParams.get('priority') as SmartPriority | null
  const refs = (request.nextUrl.searchParams.get('refs') || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 12)
  if (!priority || !priorities.has(priority) || !refs.length) return NextResponse.json({ contexts: {} })
  try {
    const data = await fetchNexusContext()
    const contexts = Object.fromEntries(data.properties.filter(property => refs.includes(property.id)).flatMap(property => {
      const context = contextForPriority(property, data.places, priority)
      return context ? [[property.id, context]] : []
    }))
    return NextResponse.json({ contexts }, { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' } })
  } catch {
    return NextResponse.json({ contexts: {} }, { status: 200 })
  }
}
