import { JsonLd } from './JsonLd'
import { faqSchema } from '@/lib/seo/schema'

export interface FaqItem {
  q: string
  a: string
}

interface FAQBlockProps {
  items: FaqItem[]
  heading?: string
}

export function FAQBlock({ items, heading = 'Frequently asked questions' }: FAQBlockProps) {
  if (!items?.length) return null
  return (
    <section className="bg-white border border-navy/10 rounded-lg p-6 md:p-8">
      <h2 className="font-serif text-xl md:text-2xl text-navy mb-5">{heading}</h2>
      <div className="space-y-5">
        {items.map((item, i) => (
          <div key={i}>
            <h3 className="font-medium text-navy text-sm md:text-base mb-1.5">{item.q}</h3>
            <p className="text-navy/70 text-sm md:text-base leading-relaxed">{item.a}</p>
          </div>
        ))}
      </div>
      <JsonLd data={faqSchema(items)} />
    </section>
  )
}
