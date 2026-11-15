import { NextRequest, NextResponse } from 'next/server'
import { contextForPriority, fetchNexusContext, resolvePropertyLifeOverview, type SmartPriority } from '@/lib/nexus-property-context'
import { getPublicProperty } from '@/lib/public-property'

const priorities = new Set<SmartPriority>(['weekly-shop', 'swimming', 'health', 'gym'])

export async function GET(request: NextRequest) {
  const priority = request.nextUrl.searchParams.get('priority') as SmartPriority | null
  const slugs = [...new Set(request.nextUrl.searchParams.getAll('slug').filter(Boolean))].slice(0, 12)
  const headers = { 'Cache-Control': 'no-store' }
  if (!priority || !priorities.has(priority) || !slugs.length) return NextResponse.json({ contexts: {} }, { headers })
  try {
    const [data, properties] = await Promise.all([
      fetchNexusContext(),
      Promise.all(slugs.map(slug => getPublicProperty(slug, { fresh: true }))),
    ])
    const contexts = Object.fromEntries(properties.flatMap(property => {
      if (!property) return []
      const overview = resolvePropertyLifeOverview(data, property.propertyReference, property.location, property.localityId)
      const context = overview && contextForPriority(overview, priority)
      return context ? [[property.slug, context]] : []
    }))
    return NextResponse.json({ contexts }, { headers })
  } catch {
    return NextResponse.json({ contexts: {} }, { headers })
  }
}
