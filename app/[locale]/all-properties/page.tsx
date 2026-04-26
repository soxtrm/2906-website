import { ListingsPage } from '@/components/listings-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'All Properties | 2906 Real Estate Malta',
  description: 'Browse all available properties in Malta — rentals, sales, commercial spaces and luxury listings.',
}

export default function AllPropertiesPage() {
  return (
    <ListingsPage
      category={null}
      title="All Properties"
      description="Browse our full portfolio of properties across Malta and Gozo"
      accentColor="bg-gold"
    />
  )
}
