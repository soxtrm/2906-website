import { ListingsPage } from '@/components/listings-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Commercial | 2906 Real Estate Malta',
  description: 'Commercial properties across Malta — office spaces, retail units, and more.',
}

export default function CommercialPage() {
  return (
    <ListingsPage
      category="commercial"
      title="Commercial Properties"
      description="Premium commercial spaces across Malta's key business districts"
      accentColor="bg-accent-commercial"
    />
  )
}
