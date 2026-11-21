import type { Metadata } from 'next'
import '../../marketplace.css'
import { ListingView } from './listing'
import { fetchNexusContext, type NexusPlace } from '@/lib/nexus-property-context'
import { toCard } from '@/lib/marketplace/model'
import { publicShareImage } from '@/lib/public-property-title'

// Server-rendered title, description and share image for a Marketplace home (Kev 21 Nov 2026):
// "2-Bedroom Penthouse in Swieqi – €2,027/month", the real description, the first photo as a 1200×630 card.
const QUARANTINED = new Set(['2906-9398'])
async function cardFor(id: string) {
  try {
    const ctx = await fetchNexusContext()
    const p = (ctx.properties as unknown as Record<string, any>[]).find(x => String(x.id) === id && x.listable !== false && !QUARANTINED.has(String(x.id)) && !(x.market !== 'sales' && Number(x.rent) < 100))
    return p ? toCard(p, ctx.places as NexusPlace[]) : null
  } catch { return null }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id: raw } = await params
  const id = decodeURIComponent(raw)
  const url = `/marketplace/home/${encodeURIComponent(id)}`
  const c = await cardFor(id)
  if (!c) return { title: 'Home not found · NEXUS Marketplace', robots: { index: false }, alternates: { canonical: url } }
  const price = c.price ? `€${c.price.toLocaleString('en-GB')}${c.pricePeriod ? `/${c.pricePeriod}` : ''}` : null
  const head = `${c.title}${price ? ` – ${price}` : ''}`
  const description = (c.teaser || `${head}. Listed by ${c.provider.kind === 'agency' ? c.provider.agency.name : 'a provider being confirmed'} on the NEXUS Marketplace.`).slice(0, 158)
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
  return <ListingView id={decodeURIComponent(id)} />
}
