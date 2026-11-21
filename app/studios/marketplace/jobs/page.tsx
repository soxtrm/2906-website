import type { Metadata } from 'next'
import '../marketplace.css'
import '../instant.css'
import { JobsPage } from '../sections'

export const metadata: Metadata = { title: 'Jobs · NEXUS Marketplace', description: 'Hiring in the industries NEXUS serves.', alternates: { canonical: '/marketplace/jobs' } }

export default function Page() { return <JobsPage /> }
