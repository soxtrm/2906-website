import type { MetadataRoute } from 'next'
import { isPubliclyPlausibleProperty } from '@/lib/public-property-safety'

const base = 'https://www.2906.estate'
const locales = ['en', 'de', 'fr', 'it', 'es', 'ar', 'ko', 'uk', 'zh']
const routes = ['', '/letting', '/sales', '/commercial', '/aesthetics', '/all-properties', '/about', '/contact', '/privacy', '/terms']

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()
  const website = locales.flatMap(locale => routes.map(route => ({
    url: `${base}/${locale}${route}`,
    lastModified: now,
    changeFrequency: route === '' || route === '/letting' ? 'daily' as const : 'weekly' as const,
    priority: route === '' ? 1 : route === '/letting' ? 0.9 : 0.7,
  })))
  let properties: MetadataRoute.Sitemap = []
  try {
    const response = await fetch('http://178.104.162.193:3001/api/properties?status=available', { next: { revalidate: 3600 } })
    const inventory = response.ok ? await response.json() : []
    properties = Array.isArray(inventory) ? inventory.filter(isPubliclyPlausibleProperty).filter(property => property.slug).flatMap(property => locales.map(locale => ({
      url: `${base}/${locale}/property/${encodeURIComponent(property.slug)}`,
      lastModified: property.updatedAt ? new Date(property.updatedAt) : now,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    }))) : []
  } catch {}
  return [
    ...website,
    ...properties,
    { url: `${base}/Link`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/link-marketplace/index.html`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
  ]
}
