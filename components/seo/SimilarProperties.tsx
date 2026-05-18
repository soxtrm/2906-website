import { PropertyCard } from '@/components/property-card'
import type { Property } from '@/lib/types'
import type { SeoProperty } from '@/lib/seo/filters'

interface SimilarPropertiesProps {
  items: SeoProperty[]
  heading?: string
}

// Maps a SeoProperty (server fetch shape) to the Property shape PropertyCard expects.
function toPropertyShape(p: SeoProperty): Property {
  return {
    id: p.id,
    title: p.title || '',
    slug: p.slug,
    price: typeof p.price === 'number' ? p.price : parseFloat(String(p.price ?? 0)) || 0,
    priceType: ((p.priceType || p.priceAfter || 'month').toLowerCase().includes('month')
      ? 'month'
      : 'total') as 'month' | 'total',
    bedrooms: p.bedrooms ?? 0,
    bathrooms: p.bathrooms ?? 0,
    area: p.area ?? p.size ?? 0,
    propertyType: (p.propertyType ?? 'Apartment') as Property['propertyType'],
    category: (p.category ?? 'letting') as Property['category'],
    region: (p.region ?? 'Central') as Property['region'],
    location: p.location ?? '',
    status: ((p.status ?? 'available') as Property['status']),
    images: p.images ?? [],
    description: p.description ?? '',
    features: p.features ?? [],
    availableFrom: p.availableFrom ?? undefined,
    featured: !!p.featured,
  }
}

export function SimilarProperties({ items, heading = 'Similar properties' }: SimilarPropertiesProps) {
  if (!items?.length) return null
  return (
    <section>
      <h2 className="font-serif text-xl md:text-2xl text-navy mb-5">{heading}</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
        {items.map((p, i) => (
          <PropertyCard key={p.id} property={toPropertyShape(p)} index={i} compact />
        ))}
      </div>
    </section>
  )
}
