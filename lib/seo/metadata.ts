// Metadata builders — return Next.js Metadata objects.

import type { Metadata } from 'next'

export const SITE_URL = 'https://www.2906.estate'
export const SITE_NAME = '2906 Estate'

export function buildCanonical(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${SITE_URL}${path}`
}

export function robotsFor(index: boolean): Metadata['robots'] {
  return index
    ? { index: true, follow: true, googleBot: { index: true, follow: true } }
    : { index: false, follow: true, googleBot: { index: false, follow: true } }
}

export interface PageMetaInput {
  title: string
  description: string
  path: string
  index: boolean
  image?: string
  type?: 'website' | 'article'
}

export function buildPageMetadata({
  title,
  description,
  path,
  index,
  image,
  type = 'website',
}: PageMetaInput): Metadata {
  const canonical = buildCanonical(path)
  const ogImage = image || `${SITE_URL}/icon.png`
  return {
    title,
    description,
    alternates: { canonical },
    robots: robotsFor(index),
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: SITE_NAME,
      type,
      locale: 'en_MT',
      images: [{ url: ogImage }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  }
}
