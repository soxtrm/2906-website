import type { Metadata } from 'next'
import '../marketplace/marketplace.css'
import '../marketplace/instant.css'
import './exchange.css'
import { Exchange } from './exchange'

export const metadata: Metadata = {
  title: 'Exchange · NEXUS STUDIOS',
  description: 'Agencies in Malta working listings together on agreed, written co-agency terms.',
  alternates: { canonical: '/exchange' },
}

export default function ExchangePage() {
  return <Exchange />
}
