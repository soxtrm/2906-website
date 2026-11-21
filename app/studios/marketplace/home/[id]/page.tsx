import type { Metadata } from 'next'
import '../../marketplace.css'
import '../../instant.css'
import { ListingView } from './listing'
import { fetchNexusContext, type NexusPlace } from '@/lib/nexus-property-context'
import { toCard } from '@/lib/marketplace/model'
import { notFound } from 'next/navigation'
import { publicPropertyDescription, publicShareImage } from '@/lib/public-property-title'

// Server-rendered title, description and share image for a Marketplace home (Kev 21 Nov 2026):
// "2-Bedroom Penthouse in Swieqi – €2,027/month", the real description, the first photo as a 1200×630 card.
const QUARANTINED = new Set(['2906-9398'])
// undefined = ARGUS not reachable (the page still renders and loads in the browser); null = no such public home
async function cardFor(id: string) {
  try {
    const ctx = await fetchNexusContext()
    const p = (ctx.properties as unknown as Record<string, any>[]).find(x => String(x.id) === id && x.listable !== false && !QUARANTINED.has(String(x.id)) && !(x.market !== 'sales' && Number(x.rent) < 100))
    return p ? { c: toCard(p, ctx.places as NexusPlace[]), description: String(p.description || '') } : null
  } catch { return undefined }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id: raw } = await params
  const id = decodeURIComponent(raw)
  const url = `/marketplace/home/${encodeURIComponent(id)}`
  const found = await cardFor(id)
  if (!found) return { title: found === null ? 'Home not found · NEXUS Marketplace' : 'NEXUS Marketplace', robots: found === null ? { index: false } : undefined, alternates: { canonical: url } }
  const c = found.c
  const price = c.price ? `€${c.price.toLocaleString('en-GB')}${c.pricePeriod ? `/${c.pricePeriod}` : ''}` : null
  const head = `${c.title}${price ? ` – ${price}` : ''}`
  const description = found.description
    ? publicPropertyDescription({ fullDescription: found.description, location: c.area, propertyType: c.typeLabel, bedrooms: c.bedrooms, price: c.price, priceType: c.pricePeriod })
    : `${head}. Listed by ${c.provider.kind === 'agency' ? c.provider.agency.name : 'a provider being confirmed'} on the NEXUS Marketplace.`
  const image = publicShareImage({ images: c.images })
  return {
    title: `${head} · NEXUS Marketplace`,
    description,
    alternates: { canonical: url },
    openGraph: { title: head, description, url, type: 'website', siteName: 'NEXUS Marketplace', images: image ? [{ url: image, width: 1200, height: 630, alt: c.title }] : undefined },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: head, description, images: image ? [image] : undefined },
  }
}

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if ((await cardFor(decodeURIComponent(id))) === null) notFound()
  return <ListingView id={decodeURIComponent(id)} />
}
