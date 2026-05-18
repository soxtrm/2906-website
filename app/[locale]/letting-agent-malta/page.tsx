import Link from 'next/link'
import type { Metadata } from 'next'
import { MessageCircle, ArrowRight } from 'lucide-react'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { BreadcrumbNav } from '@/components/seo/BreadcrumbNav'
import { JsonLd } from '@/components/seo/JsonLd'
import { FAQBlock } from '@/components/seo/FAQBlock'
import { buildPageMetadata } from '@/lib/seo/metadata'
import { breadcrumbSchema, realEstateAgentSchema } from '@/lib/seo/schema'

const PATH = '/letting-agent-malta'

export const metadata: Metadata = buildPageMetadata({
  title: 'Letting Agent in Malta — 2906 Estate',
  description:
    '2906 Estate is a Malta-based letting agent collective covering rentals across Sliema, St Julian’s, Gzira, central and northern Malta. Independent agents, shared listings, fast placements.',
  path: PATH,
  index: true,
})

const FAQ = [
  {
    q: 'What is 2906 Estate?',
    a: '2906 Estate is a Malta-based real estate collective of independent letting agents who share inventory and tenants across the island. The shared pool means faster placements for landlords and broader choice for tenants.',
  },
  {
    q: 'Which areas do you cover?',
    a: 'Primarily Sliema, St Julian’s, Gzira, Msida, San Gwann, Swieqi, Mellieha, Bugibba/Qawra and central Malta. We also handle selected properties in Gozo and the south.',
  },
  {
    q: 'How do I contact a letting agent?',
    a: 'Send a WhatsApp to +356 7901 0070 with the area and budget you are looking for, or open any current listing and tap WhatsApp.',
  },
]

export default function LettingAgentPage() {
  const wa = `https://wa.me/35679010070?text=${encodeURIComponent("Hi 2906, I'm looking for a letting agent in Malta.")}`
  const breadcrumbs = [
    { name: 'Home', href: '/' },
    { name: 'Letting agent Malta' },
  ]
  return (
    <main className="min-h-screen bg-off-white overflow-x-hidden">
      <Header />

      <section className="pt-28 pb-10 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 space-y-5">
          <BreadcrumbNav items={breadcrumbs} />
          <div className="max-w-3xl">
            <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-3">
              Letting agent in Malta
            </h1>
            <p className="text-white/70 text-sm md:text-base leading-relaxed">
              2906 Estate is a Malta-based letting agent collective. Independent agents share listings and tenant
              demand, so properties get placed quickly and renters get more relevant options across Malta.
            </p>
          </div>
        </div>
      </section>

      <section className="py-10 md:py-12">
        <div className="container mx-auto px-4 lg:px-8 space-y-10 max-w-4xl">
          <div className="bg-white rounded-lg p-6 md:p-8 border border-navy/10 space-y-4">
            <h2 className="font-serif text-xl md:text-2xl text-navy">How 2906 works</h2>
            <p className="text-navy/70 text-sm md:text-base leading-relaxed">
              When a landlord lists with 2906, the property is visible to the whole agent collective. Whichever agent
              has the matching tenant in their pipeline handles the viewing and lease. That means a single listing
              reaches several active tenant lists simultaneously.
            </p>
            <p className="text-navy/70 text-sm md:text-base leading-relaxed">
              Tenants get a curated set of rentals matching their brief, with a single point of contact rather than
              chasing multiple agencies. Lease drafting, key handover and deposit handling are coordinated by 2906.
            </p>
          </div>

          <div className="bg-white rounded-lg p-6 md:p-8 border border-navy/10">
            <h2 className="font-serif text-xl md:text-2xl text-navy mb-3">Talk to a letting agent</h2>
            <p className="text-navy/70 text-sm md:text-base mb-5">
              WhatsApp is the fastest way to reach us. Tell us the area, budget and move-in date and we will reply
              with current options.
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
                href="/letting"
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded bg-navy text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Browse rentals
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          <FAQBlock items={FAQ} />

          <div className="bg-white rounded-lg p-6 md:p-8 border border-navy/10">
            <h2 className="font-serif text-xl md:text-2xl text-navy mb-4">Popular rental searches</h2>
            <ul className="grid sm:grid-cols-2 gap-2.5">
              <li><Link href="/rent/1-bedroom-apartments-malta" className="text-navy/80 hover:text-gold text-sm">1 bedroom apartments in Malta →</Link></li>
              <li><Link href="/rent/2-bedroom-apartments-malta" className="text-navy/80 hover:text-gold text-sm">2 bedroom apartments in Malta →</Link></li>
              <li><Link href="/rent/3-bedroom-apartments-malta" className="text-navy/80 hover:text-gold text-sm">3 bedroom apartments in Malta →</Link></li>
              <li><Link href="/rent/penthouses-malta" className="text-navy/80 hover:text-gold text-sm">Penthouses in Malta →</Link></li>
              <li><Link href="/rent/seafront-apartments-malta" className="text-navy/80 hover:text-gold text-sm">Seafront apartments in Malta →</Link></li>
              <li><Link href="/rent/apartments-under-2000-malta" className="text-navy/80 hover:text-gold text-sm">Apartments under €2,000 in Malta →</Link></li>
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
