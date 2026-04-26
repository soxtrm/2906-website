import { ListingsPage } from '@/components/listings-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sales | 2906 Real Estate Malta',
  description: 'Properties for sale across Malta. Find your perfect home or investment with 2906 Real Estate.',
}

export default function SalesPage() {
  return (
    <ListingsPage
      category="sales"
      title="Properties for Sale"
      description="Exceptional properties for sale across Malta and Gozo"
      accentColor="bg-accent-sales"
    />
  )
}
