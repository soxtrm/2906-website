import type { Metadata } from 'next'
import '../marketplace.css'
import '@/components/rooms/rooms.css'
import { RoomsMarket } from './rooms'

export const metadata: Metadata = { title: 'Rooms · NEXUS Marketplace', description: 'Rooms to let in real homes across Malta: each with its own price, photos and calendar.', alternates: { canonical: '/marketplace/rooms' } }
export default async function RoomsPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams
  return <RoomsMarket demo={demo === '1'} />
}
