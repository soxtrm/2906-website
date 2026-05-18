import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

export interface RelatedSearchLink {
  label: string
  href: string
}

interface RelatedSearchesProps {
  heading?: string
  items: RelatedSearchLink[]
}

export function RelatedSearches({ heading = 'Related searches', items }: RelatedSearchesProps) {
  if (!items?.length) return null
  return (
    <section>
      <h2 className="font-serif text-xl md:text-2xl text-navy mb-4">{heading}</h2>
      <ul className="flex flex-wrap gap-2">
        {items.map(it => (
          <li key={it.href}>
            <Link
              href={it.href}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-navy/10 text-navy/80 text-sm hover:border-navy/30 hover:text-navy transition-colors"
            >
              {it.label}
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
