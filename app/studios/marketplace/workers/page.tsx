import type { Metadata } from 'next'
import '../marketplace.css'
import '../instant.css'
import { WorkersPage } from '../sections'

export const metadata: Metadata = { title: 'Workers · NEXUS Marketplace', description: 'Notaries, inspectors, movers and other property professionals, requested from your Property Workspace.', alternates: { canonical: '/marketplace/workers' } }

export default function Page() { return <WorkersPage /> }
