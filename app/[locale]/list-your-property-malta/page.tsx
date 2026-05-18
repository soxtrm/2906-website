import Link from 'next/link'
import type { Metadata } from 'next'
import { MessageCircle, ArrowRight, Check } from 'lucide-react'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { BreadcrumbNav } from '@/components/seo/BreadcrumbNav'
import { JsonLd } from '@/components/seo/JsonLd'
import { FAQBlock } from '@/components/seo/FAQBlock'
import { buildPageMetadata } from '@/lib/seo/metadata'
import { breadcrumbSchema, realEstateAgentSchema } from '@/lib/seo/schema'

const PATH = '/list-your-property-malta'

export const metadata: Metadata = buildPageMetadata({
  title: 'List Your Property for Rent in Malta | 2906 Estate',
  description:
    'List your Malta rental property with 2906 Estate. Active tenant pipeline, viewings handled, transparent lease process. Get in touch on WhatsApp.',
  path: PATH,
  index: true,
})

const BENEFITS = [
  'Active tenant pipeline across Sliema, St Julian’s, Gzira, central and northern Malta',
  'Listings shared across the 2906 agent collective for faster placement',
  'Viewings coordinated for you — minimal back-and-forth',
  'Lease drafting and key handover handled end to end',
  'Transparent commission — no surprise fees',
]

const FAQ = [
  {
    q: 'What does it cost to list with 2906 Estate?',
    a: 'Standard Malta market practice is one month of rent plus VAT as agency commission, paid by the tenant on contract signature. No upfront cost to the landlord.',
  },
  {
    q: 'How fast can a property get rented?',
    a: 'Well-priced properties in central locations typically rent within 1–3 weeks. Higher-end residences may take longer.',
  },
  {
    q: 'Do you photograph the property?',
    a: 'Yes. We arrange a viewing visit with the team to capture photos and the listing details together.',
  },
]

export default function ListYourPropertyPage() {
  const wa = `https://wa.me/35679010070?text=${encodeURIComponent("Hi 2906, I would like to list my Malta property for rent.")}`
  const breadcrumbs = [
    { name: 'Home', href: '/' },
    { name: 'List your property' },
  ]
  return (
    <main className="min-h-screen bg-off-white overflow-x-hidden">
      <Header />

      <section className="pt-28 pb-10 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 space-y-5">
          <BreadcrumbNav items={breadcrumbs} />
          <div className="max-w-3xl">
            <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-3">
              List your property for rent in Malta
            </h1>
            <p className="text-white/70 text-sm md:text-base leading-relaxed">
              List your Malta rental with 2906 Estate. We are a Malta-based agents collective with an active tenant
              pipeline and a streamlined process from viewing to lease signing.
            </p>
          </div>
        </div>
      </section>

      <section className="py-10 md:py-12">
        <div className="container mx-auto px-4 lg:px-8 space-y-10 max-w-4xl">
          <div className="bg-white rounded-lg p-6 md:p-8 border border-navy/10">
            <h2 className="font-serif text-xl md:text-2xl text-navy mb-5">Why owners choose 2906</h2>
            <ul className="space-y-3">
              {BENEFITS.map(b => (
                <li key={b} className="flex items-start gap-3">
                  <Check className="w-4 h-4 text-gold mt-1 shrink-0" />
                  <span className="text-navy/80 text-sm md:text-base">{b}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white rounded-lg p-6 md:p-8 border border-navy/10">
            <h2 className="font-serif text-xl md:text-2xl text-navy mb-3">Ready to list?</h2>
            <p className="text-navy/70 text-sm md:text-base mb-5">
              Send us the property details on WhatsApp — address area, bedrooms, asking rent and a few photos if you
              have them. We will reply within working hours and arrange next steps.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <a
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded bg-[#25D366] text-white font-medium text-sm hover:bg-[#20BD5A] transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                WhatsApp 2906
              </a>
              <Link
                href="/add-property"
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded bg-navy text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Submit online
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          <FAQBlock items={FAQ} />

          <div className="bg-white rounded-lg p-6 md:p-8 border border-navy/10">
            <h2 className="font-serif text-xl md:text-2xl text-navy mb-4">Browse current rentals</h2>
            <ul className="grid sm:grid-cols-2 gap-2.5">
              <li><Link href="/letting" className="text-navy/80 hover:text-gold text-sm">All rentals →</Link></li>
              <li><Link href="/rent/sliema" className="text-navy/80 hover:text-gold text-sm">Apartments for rent in Sliema →</Link></li>
              <li><Link href="/rent/st-julians" className="text-navy/80 hover:text-gold text-sm">Apartments for rent in St Julian’s →</Link></li>
              <li><Link href="/rent/2-bedroom-apartments-malta" className="text-navy/80 hover:text-gold text-sm">2 bedroom apartments in Malta →</Link></li>
              <li><Link href="/rent/luxury-apartments-malta" className="text-navy/80 hover:text-gold text-sm">Luxury apartments in Malta →</Link></li>
              <li><Link href="/letting-agent-malta" className="text-navy/80 hover:text-gold text-sm">About 2906 letting service →</Link></li>
            </ul>
          </div>
        </div>
      </section>

      <JsonLd data={breadcrumbSchema(breadcrumbs.map(b => ({ name: b.name, path: b.href ?? PATH })))} />
      <JsonLd data={realEstateAgentSchema()} />

      <Footer />
    </main>
  )
}
