import { ListingsPage } from '@/components/listings-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Aesthetics | 2906 Real Estate Malta',
  description: 'Luxury rental properties in Malta starting from €2,500/month. Experience premium living with exceptional design and finishes.',
}

export default function AestheticsPage() {
  return (
    <ListingsPage
      category="aesthetics"
      title="Aesthetics"
      description="Luxury rentals from €2,500/month — exceptional design, premium finishes, uncompromising quality"
      accentColor="bg-gold"
      minPrice={2500}
    />
  )
}
