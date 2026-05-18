// JSON-LD schema builders. All return plain objects ready to JSON.stringify.

import { SITE_URL, SITE_NAME } from './metadata'
import type { SeoProperty } from './filters'
import { toNumber } from './filters'

export interface BreadcrumbItem {
  name: string
  path: string
}

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.path.startsWith('http') ? item.path : `${SITE_URL}${item.path}`,
    })),
  }
}

export function collectionPageSchema(opts: {
  name: string
  description: string
  url: string
  itemCount: number
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: opts.name,
    description: opts.description,
    url: opts.url.startsWith('http') ? opts.url : `${SITE_URL}${opts.url}`,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: opts.itemCount,
    },
  }
}

export function itemListSchema(opts: {
  url: string
  items: { name: string; url: string }[]
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    url: opts.url.startsWith('http') ? opts.url : `${SITE_URL}${opts.url}`,
    numberOfItems: opts.items.length,
    itemListElement: opts.items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      url: it.url.startsWith('http') ? it.url : `${SITE_URL}${it.url}`,
    })),
  }
}

export function faqSchema(items: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(it => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  }
}

export function listingSchema(p: SeoProperty, path: string) {
  const url = `${SITE_URL}${path}`
  const price = toNumber(p.price)
  const isMonthly = (p.priceAfter || p.priceType || '').toLowerCase().includes('month')
  const propType = (p.propertyType || '').toLowerCase()

  let typeName: string = 'Apartment'
  if (propType === 'penthouse') typeName = 'Apartment'
  else if (propType.includes('villa') || propType.includes('house') || propType.includes('townhouse') || propType.includes('farmhouse')) {
    typeName = 'House'
  } else if (propType === 'maisonette') typeName = 'Apartment'

  const schema: Record<string, any> = {
    '@context': 'https://schema.org',
    '@type': typeName,
    name: p.title || `Property in ${p.location || 'Malta'}`,
    description: p.summary || p.description || '',
    url,
    image: (p.images && p.images.length > 0) ? p.images.slice(0, 8) : undefined,
    address: {
      '@type': 'PostalAddress',
      addressLocality: p.location || undefined,
      addressRegion: p.region || 'Malta',
      addressCountry: 'MT',
    },
    numberOfRooms: p.bedrooms ?? undefined,
    numberOfBathroomsTotal: p.bathrooms ?? undefined,
    floorSize: (p.size || p.area)
      ? { '@type': 'QuantitativeValue', value: p.size || p.area, unitCode: 'MTK' }
      : undefined,
  }

  if (price > 0) {
    schema.offers = {
      '@type': 'Offer',
      priceCurrency: 'EUR',
      price: price,
      url,
      availability:
        (p.status || '').toLowerCase() === 'rented'
          ? 'https://schema.org/SoldOut'
          : 'https://schema.org/InStock',
      ...(isMonthly && {
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price,
          priceCurrency: 'EUR',
          unitCode: 'MON',
          unitText: 'MONTH',
        },
      }),
    }
  }

  // Strip undefined fields
  Object.keys(schema).forEach(k => schema[k] === undefined && delete schema[k])
  return schema
}

export function realEstateAgentSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateAgent',
    name: SITE_NAME,
    url: SITE_URL,
    areaServed: { '@type': 'Country', name: 'Malta' },
    sameAs: [],
  }
}
