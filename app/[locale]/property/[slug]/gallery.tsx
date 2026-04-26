'use client'
import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const placeholder = 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1600&q=80'

export function PropertyGallery({ images, vpsBase = '' }: { images: string[]; vpsBase?: string }) {
  const [active, setActive] = useState(0)

  const fixUrl = (url: string) =>
    url.startsWith('/') ? `${vpsBase}${url}` : url

  const all = images?.length > 0 ? images : [placeholder]
  const prev = () => setActive(a => (a === 0 ? all.length - 1 : a - 1))
  const next = () => setActive(a => (a === all.length - 1 ? 0 : a + 1))

  return (
    <div className="space-y-3">
      <div className="relative aspect-square sm:aspect-[4/3] md:aspect-[16/10] rounded-lg overflow-hidden">
        <img
          src={fixUrl(all[active])}
          alt=""
          className="w-full h-full object-cover"
          onError={e => { (e.target as HTMLImageElement).src = placeholder }}
        />
        {all.length > 1 && (
          <>
            <button onClick={prev}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center hover:bg-white transition-colors">
              <ChevronLeft className="w-5 h-5 text-navy" />
            </button>
            <button onClick={next}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center hover:bg-white transition-colors">
              <ChevronRight className="w-5 h-5 text-navy" />
            </button>
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
              {all.map((_, i) => (
                <button key={i} onClick={() => setActive(i)}
                  className={cn('w-1.5 h-1.5 rounded-full transition-colors', i === active ? 'bg-white' : 'bg-white/40')} />
              ))}
            </div>
          </>
        )}
      </div>
      {all.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory scroll-smooth">
          {all.map((img, i) => (
            <button key={i} onClick={() => setActive(i)}
              className={cn('shrink-0 w-20 h-14 md:w-24 md:h-16 rounded overflow-hidden border-2 transition-colors snap-start', i === active ? 'border-gold' : 'border-transparent')}>
              <img src={fixUrl(img)} alt="" className="w-full h-full object-cover"
                onError={e => { (e.target as HTMLImageElement).src = placeholder }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
