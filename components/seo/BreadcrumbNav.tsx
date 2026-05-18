import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

export interface BreadcrumbCrumb {
  name: string
  href?: string
}

export function BreadcrumbNav({ items }: { items: BreadcrumbCrumb[] }) {
  if (!items?.length) return null
  return (
    <nav aria-label="Breadcrumb" className="text-xs md:text-sm">
      <ol className="flex flex-wrap items-center gap-1.5 text-navy/60">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={`${item.name}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="w-3 h-3 text-navy/30" aria-hidden="true" />}
              {item.href && !isLast ? (
                <Link href={item.href} className="hover:text-navy transition-colors">
                  {item.name}
                </Link>
              ) : (
                <span className={isLast ? 'text-navy font-medium' : ''}>{item.name}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
