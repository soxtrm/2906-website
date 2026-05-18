import type { MetadataRoute } from 'next'
import { fetchAllPropertiesServer } from '@/lib/seo/fetch'
import {
  applyCategoryFilter,
  isActive,
  isRental,
  uniqueActiveLocations,
} from '@/lib/seo/filters'
import { CATEGORY_DESCRIPTORS } from '@/lib/seo/content'
import { SITE_URL } from '@/lib/seo/metadata'

const NOW = () => new Date()

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const properties = await fetchAllPropertiesServer()
  const activeRentals = properties.filter(p => isActive(p) && isRental(p))
  const now = NOW()

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${SITE_URL}/letting`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE_URL}/sales`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE_URL}/commercial`, lastModified: now, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${SITE_URL}/aesthetics`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE_URL}/all-properties`, lastModified: now, changeFrequency: 'daily', priority: 0.7 },
    { url: `${SITE_URL}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${SITE_URL}/contact`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${SITE_URL}/list-your-property-malta`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE_URL}/letting-agent-malta`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
  ]

  // Location pages — only those with 3+ active rentals (index, follow)
  const locationEntries: MetadataRoute.Sitemap = uniqueActiveLocations(properties)
    .filter(loc => loc.count >= 3)
    .map(loc => ({
      url: `${SITE_URL}/rent/${loc.slug}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    }))

  // Category pages — only those with 3+ matching active rentals
  const categoryEntries: MetadataRoute.Sitemap = CATEGORY_DESCRIPTORS
    .filter(d => {
      const matches = applyCategoryFilter(properties, d).filter(p => isActive(p) && isRental(p))
      return matches.length >= 3
    })
    .map(d => ({
      url: `${SITE_URL}/rent/${d.slug}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    }))

  // Active listing detail pages
  const listingEntries: MetadataRoute.Sitemap = activeRentals
    .filter(p => p.slug)
    .map(p => ({
      url: `${SITE_URL}/property/${p.slug}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }))

  return [...staticRoutes, ...locationEntries, ...categoryEntries, ...listingEntries]
}
