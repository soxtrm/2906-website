import type { Metadata } from 'next'
import '../../marketplace.css'
import { ListingView } from './listing'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  return { title: `Home ${decodeURIComponent(id)} · NEXUS Marketplace`, alternates: { canonical: `/marketplace/home/${id}` } }
}

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ListingView id={decodeURIComponent(id)} />
}
