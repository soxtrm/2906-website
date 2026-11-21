import type { Metadata } from 'next'
import './marketplace.css'
import { Marketplace } from './marketplace'

export const metadata: Metadata = {
  title: 'Marketplace · NEXUS STUDIOS',
  description: 'Homes to rent in Malta from verified agencies, with live availability and what is nearby.',
  alternates: { canonical: '/marketplace' },
}

export default function MarketplacePage() {
  return <Marketplace />
}
