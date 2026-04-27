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
      title="Luxury Lets from €2,500/month"
      subheadline="Apartments, Houses, Palazzos, Penthouses, Villas & more"
      tagline="Exceptional design — Premium finishes — Uncompromising quality."
      description=""
      accentColor="bg-gold"
      minPrice={2500}
    />
  )
}
