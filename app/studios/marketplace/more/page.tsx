import type { Metadata } from 'next'
import '../marketplace.css'
import '../instant.css'
import { MorePageClient } from './more-client'

export const metadata: Metadata = { title: 'More Marketplaces · NEXUS', description: 'Beyond listings: industry-specific marketplaces built around the entire process.', alternates: { canonical: '/marketplace/more' } }

export default function Page() { return <MorePageClient /> }
