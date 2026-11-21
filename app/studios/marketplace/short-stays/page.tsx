import type { Metadata } from 'next'
import '../marketplace.css'
import '../instant.css'
import { Marketplace } from '../marketplace'

export const metadata: Metadata = { title: 'Short Stays · NEXUS Marketplace', description: 'Shortlets and short-stay rooms in Malta, booked through NEXUS Booking.', alternates: { canonical: '/marketplace/short-stays' } }

export default function Page() { return <Marketplace section="stays" /> }
