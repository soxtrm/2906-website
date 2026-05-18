import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { PropertyCard } from '@/components/property-card'
import { BreadcrumbNav } from '@/components/seo/BreadcrumbNav'
import { SeoIntro } from '@/components/seo/SeoIntro'
import { CtaBlock } from '@/components/seo/CtaBlock'
import { FAQBlock } from '@/components/seo/FAQBlock'
import { RelatedSearches } from '@/components/seo/RelatedSearches'
import { JsonLd } from '@/components/seo/JsonLd'

import { fetchAllPropertiesServer } from '@/lib/seo/fetch'
import {
  applyCategoryFilter,
  activeRentalsInLocation,
  uniqueActiveLocations,
  resolveSlug,
  indexabilityFor,
  isActive,
  isRental,
} from '@/lib/seo/filters'
import {
  CATEGORY_DESCRIPTORS,
  defaultFaq,
  locationDescription,
  locationFallbackIntro,
  locationH1,
  locationTitle,
} from '@/lib/seo/content'
import { buildPageMetadata, SITE_URL } from '@/lib/seo/metadata'
import {
  breadcrumbSchema,
  collectionPageSchema,
  realEstateAgentSchema,
} from '@/lib/seo/schema'
import type { Property, PropertyCategory, PropertyStatus, PropertyType, Region } from '@/lib/types'
import type { SeoProperty } from '@/lib/seo/filters'

const PAGE_PATH = (slug: string) => `/rent/${slug}`

async function resolve(slug: string) {
  const all = await fetchAllPropertiesServer()
  const decoded = decodeURIComponent(slug).toLowerCase()
  const match = resolveSlug(decoded, all)

  if (match.kind === 'category') {
    const matches = applyCategoryFilter(all, match.descriptor).filter(p => isActive(p) && isRental(p))
    return { kind: 'category' as const, slug: decoded, descriptor: match.descriptor, matches, all }
  }
  if (match.kind === 'location') {
    const matches = activeRentalsInLocation(all, match.locationName)
    return { kind: 'location' as const, slug: decoded, name: match.locationName, matches, all }
  }
  return { kind: 'none' as const, slug: decoded, all }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const r = await resolve(slug)
  if (r.kind === 'none' || r.matches.length === 0) {
    return buildPageMetadata({
      title: 'Page not found | 2906 Estate',
      description: 'The page you are looking for is not available.',
      path: PAGE_PATH(slug),
      index: false,
    })
  }
  const { index } = indexabilityFor(r.matches.length)
  if (r.kind === 'category') {
    return buildPageMetadata({
      title: r.descriptor.title,
      description: r.descriptor.description,
      path: PAGE_PATH(slug),
      index,
    })
  }
  return buildPageMetadata({
    title: locationTitle(r.name),
    description: locationDescription(r.name),
    path: PAGE_PATH(slug),
    index,
  })
}

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
    propertyType: (p.propertyType ?? 'Apartment') as PropertyType,
    category: (p.category ?? 'letting') as PropertyCategory,
    region: (p.region ?? 'Central') as Region,
    location: p.location ?? '',
    status: ((p.status ?? 'available') as PropertyStatus),
    images: p.images ?? [],
    description: p.description ?? '',
    features: p.features ?? [],
    availableFrom: p.availableFrom ?? undefined,
    featured: !!p.featured,
  }
}

export default async function RentSlugPage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>
}) {
  const { slug } = await params
  const r = await resolve(slug)
  if (r.kind === 'none' || r.matches.length === 0) {
    notFound()
  }

  const h1 = r.kind === 'category' ? r.descriptor.h1 : locationH1(r.name)
  const intro = r.kind === 'category' ? r.descriptor.intro : locationFallbackIntro(r.name)
  const label = r.kind === 'category' ? r.descriptor.label : `Apartments in ${r.name}`
  const canonicalPath = PAGE_PATH(r.slug)
  const breadcrumbs = [
    { name: 'Home', href: '/' },
    { name: 'Rent in Malta', href: '/letting' },
    { name: r.kind === 'category' ? r.descriptor.label : r.name },
  ]

  const matches = r.matches
  const faq = defaultFaq(label)

  // Related searches: 6 picks of other category descriptors + a few top locations
  const otherCategoryLinks = CATEGORY_DESCRIPTORS
    .filter(d => r.kind !== 'category' || d.slug !== r.descriptor.slug)
    .slice(0, 6)
    .map(d => ({ label: d.label, href: `/rent/${d.slug}` }))

  const topLocations = uniqueActiveLocations(r.all)
    .filter(loc => r.kind !== 'location' || loc.name !== r.name)
    .slice(0, 6)
    .map(loc => ({ label: `Rentals in ${loc.name}`, href: `/rent/${loc.slug}` }))

  const related = [...otherCategoryLinks, ...topLocations].slice(0, 10)

  const breadcrumbLd = breadcrumbSchema(breadcrumbs.map(b => ({
    name: b.name,
    path: b.href ?? canonicalPath,
  })))

  const collectionLd = collectionPageSchema({
    name: h1,
    description: intro,
    url: canonicalPath,
    itemCount: matches.length,
  })

  return (
    <main className="min-h-screen bg-off-white overflow-x-hidden">
      <Header />

      <section className="pt-28 pb-10 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 space-y-5">
          <BreadcrumbNav
            items={breadcrumbs.map(b => ({ name: b.name, href: b.href }))}
          />
          <SeoIntro heading={h1} body={intro} resultCount={matches.length} />
        </div>
      </section>

      <section className="py-10 md:py-12">
        <div className="container mx-auto px-4 lg:px-8 space-y-10">
          <div>
            <p className="text-navy/60 text-sm mb-6">
              {matches.length} {matches.length === 1 ? 'property' : 'properties'}
            </p>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-8">
              {matches.map((p, i) => (
                <PropertyCard key={p.id} property={toPropertyShape(p)} index={i} />
              ))}
            </div>
          </div>

          <CtaBlock />

          {related.length > 0 && <RelatedSearches items={related} />}

          <FAQBlock items={faq} />
        </div>
      </section>

      <JsonLd data={breadcrumbLd} />
      <JsonLd data={collectionLd} />
      <JsonLd data={realEstateAgentSchema()} />

      <Footer />
    </main>
  )
}
