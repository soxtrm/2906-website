import Link from 'next/link'
import { MessageCircle, ArrowRight } from 'lucide-react'

interface CtaBlockProps {
  heading?: string
  body?: string
  whatsappText?: string
}

export function CtaBlock({
  heading = 'Looking to list your property with 2906 Estate?',
  body = 'List your Malta rental with the 2906 Estate collective. We handle viewings, vetting and lease signing across the island.',
  whatsappText = 'Hi 2906, I would like to list my property for rent.',
}: CtaBlockProps) {
  const wa = `https://wa.me/35679010070?text=${encodeURIComponent(whatsappText)}`
  return (
    <section className="bg-white border border-navy/10 rounded-lg p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5">
        <div className="max-w-xl">
          <h2 className="font-serif text-xl md:text-2xl text-navy mb-2">{heading}</h2>
          <p className="text-navy/70 text-sm md:text-base">{body}</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 shrink-0">
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
            href="/list-your-property-malta"
            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded bg-navy text-white font-medium text-sm hover:opacity-90 transition-opacity"
          >
            List your property
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}
