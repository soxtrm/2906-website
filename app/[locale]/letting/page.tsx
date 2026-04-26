import { ListingsPage } from '@/components/listings-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Letting | 2906 Real Estate Malta',
  description: 'Discover rental properties across Malta. From cozy apartments to luxury villas, find your perfect home with 2906 Real Estate.',
}

export default function LettingPage() {
  return (
    <ListingsPage
      category="letting"
      title="Rental Properties"
      description="Quality rental properties across Malta for every budget"
      accentColor="bg-accent-letting"
      showAestheticsBanner
    />
  )
}
