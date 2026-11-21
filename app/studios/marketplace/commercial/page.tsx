import type { Metadata } from 'next'
import '../marketplace.css'
import '../instant.css'
import { CommercialPage } from '../sections'

export const metadata: Metadata = { title: 'Commercial · NEXUS Marketplace', description: 'Offices, retail and land in Malta.', alternates: { canonical: '/marketplace/commercial' } }

export default function Page() { return <CommercialPage /> }
