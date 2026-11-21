import type { Metadata } from 'next'
import '../../marketplace.css'
import '@/components/rooms/rooms.css'
import { RoomHome } from './room-home'

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }): Promise<Metadata> {
  const { ref } = await params
  return { title: `Rooms in ${decodeURIComponent(ref)} · NEXUS Marketplace`, alternates: { canonical: `/marketplace/rooms/${ref}` } }
}
export default async function RoomHomePage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ demo?: string }> }) {
  const { ref } = await params
  const { demo } = await searchParams
  return <RoomHome refId={decodeURIComponent(ref)} demo={demo === '1'} />
}
