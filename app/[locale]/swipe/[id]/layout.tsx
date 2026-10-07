import type { Metadata } from 'next'

const BACKEND = 'http://178.104.162.193:3001'

type PreviewProperty = {
  ref?: string
  town?: string | null
  propertyType?: string | null
  description?: string | null
  fullDescription?: string | null
  images?: string[]
}

function plain(value: string | null | undefined, fallback: string) {
  const text = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text || fallback
}

function headline(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

export async function generateMetadata({ params }: {
  params: Promise<{ locale: string; id: string }>
}): Promise<Metadata> {
  const { locale, id } = await params
  const canonical = `/${locale}/swipe/${encodeURIComponent(id)}`

  try {
    const response = await fetch(`${BACKEND}/api/swipe/${encodeURIComponent(id)}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('preview unavailable')
    const data = await response.json()
    const properties: PreviewProperty[] = Array.isArray(data.properties) ? data.properties : []
    const property = properties[0]
    if (!property) throw new Error('empty preview')

    const kind = headline(plain(property.propertyType, 'Property'))
    const town = plain(property.town, 'Malta')
    const ref = plain(property.ref, '')
    const propertyTitle = `${kind} in ${town}${ref ? ` - #${ref}` : ''}`
    const title = data.kind === 'property'
      ? propertyTitle
      : plain(data.title, `${properties.length} properties selected for you`)
    const description = plain(
      property.fullDescription || property.description,
      data.kind === 'property'
        ? `View this ${kind.toLowerCase()} in ${town}, shared by 2906 Real Estate.`
        : `Browse ${properties.length} properties selected for you by 2906 Real Estate.`
    ).slice(0, 190)
    const image = property.images?.find(Boolean)

    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        type: 'website',
        url: canonical,
        title,
        description,
        images: image ? [{ url: image, alt: propertyTitle }] : undefined,
      },
      twitter: {
        card: image ? 'summary_large_image' : 'summary',
        title,
        description,
        images: image ? [image] : undefined,
      },
    }
  } catch {
    return {
      title: 'Property selection | 2906 Real Estate',
      description: 'View a property selection shared by 2906 Real Estate Malta.',
      alternates: { canonical },
    }
  }
}

export default function SwipeLayout({ children }: { children: React.ReactNode }) {
  return children
}
