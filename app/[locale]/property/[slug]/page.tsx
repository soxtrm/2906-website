import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Bed, Bath, Ruler, MapPin, Check, MessageCircle, Mail, Waves, Car, DoorOpen } from 'lucide-react'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { cn } from '@/lib/utils'
import { PropertyGallery } from './gallery'

const VPS = 'http://178.104.162.193:3001'
const COMMERCIAL_TYPES = ['Office', 'Retail', 'Warehouse']

interface Property {
  id: string
  title: string
  slug: string
  listingType: string
  price: number
  priceAfter: string
  priceType: string
  bedrooms: number | null
  bathrooms: number
  area: number | null
  size: number | null
  propertyType: string
  category: string
  region: string
  location: string
  status: 'available' | 'viewings' | 'rented'
  images: string[]
  summary: string
  description: string
  fullDescription: string
  features: string[]
  availableFrom: string
  propertyReference: string
  featured: boolean
}

async function getProperty(slug: string): Promise<Property | null> {
  try {
    const res = await fetch(`${VPS}/api/properties/${slug}`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export default async function PropertyPage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>
}) {
  const { slug } = await params
  const property = await getProperty(slug)

  if (!property) notFound()

  const isCommercial =
    property.category === 'commercial' ||
    COMMERCIAL_TYPES.includes(property.propertyType)

  const statusConfig = {
    available: { dot: 'bg-status-available', label: 'Available Now' },
    viewings:  { dot: 'bg-status-viewings',  label: 'Viewings Scheduled' },
    rented:    { dot: 'bg-status-rented',    label: 'Currently Rented' },
  }
  const statusInfo = statusConfig[property.status] ?? statusConfig.available

  const displaySize = property.size || property.area

  const formatPrice = (price: number, priceAfter: string) => {
    const formatted = `€${price.toLocaleString()}`
    if (!priceAfter || priceAfter === 'total') return formatted
    return `${formatted}/${priceAfter.replace('per ', '')}`
  }

  const description = property.fullDescription || property.description || ''

  const hasPool   = property.features?.some(f => /pool|piscin/i.test(f))
  const hasGarage = property.features?.some(f => /garage|parking/i.test(f))

  const viewingsConfig = {
    available: { label: 'Viewings Possible', color: 'text-green-600' },
    viewings:  { label: 'Viewings Soon',     color: 'text-amber-600' },
    rented:    null,
  }
  const viewingsInfo = viewingsConfig[property.status] ?? null

  return (
    <main className="min-h-screen bg-off-white overflow-x-hidden">
      <Header />

      <div className="pt-24 bg-white border-b border-navy/10">
        <div className="container mx-auto px-4 lg:px-8 py-4">
          <Link
            href={`/${property.category === 'aesthetics' ? 'aesthetics' : property.category === 'sales' ? 'sales' : property.category === 'commercial' ? 'commercial' : 'letting'}`}
            className="inline-flex items-center gap-2 text-navy/60 hover:text-navy transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to listings
          </Link>
        </div>
      </div>

      <section className="py-6 md:py-8">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="grid lg:grid-cols-3 gap-6 md:gap-8">
            <div className="lg:col-span-2 space-y-5 min-w-0">
              {/* Gallery */}
              <div className="relative">
                <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
                  <span className={cn('w-3 h-3 rounded-full', statusInfo.dot)} />
                  <span className="text-sm font-medium text-white bg-navy/80 backdrop-blur-sm px-3 py-1 rounded">
                    {statusInfo.label}
                  </span>
                </div>
                <PropertyGallery images={property.images} vpsBase={VPS} />
              </div>

              {/* Details card */}
              <div className="bg-white rounded-lg p-5 md:p-8">
                {/* Title block — stacks on mobile */}
                <div className="mb-5">
                  <h1 className="font-serif text-xl md:text-3xl text-navy mb-2 leading-snug break-words">
                    {property.title}
                  </h1>
                  <div className="flex items-center gap-1.5 text-navy/60 mb-3">
                    <MapPin className="w-4 h-4 shrink-0" />
                    <span className="text-sm">
                      {property.location}{property.region && property.region !== property.location ? `, ${property.region}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="font-serif text-2xl md:text-3xl text-gold">
                      {formatPrice(property.price, property.priceAfter || property.priceType)}
                    </p>
                    <span className={cn(
                      'text-xs font-medium uppercase tracking-wide px-2 py-1 rounded',
                      property.listingType === 'For Sale' ? 'bg-amber-500/10 text-amber-700' : 'bg-blue-500/10 text-blue-700'
                    )}>
                      {property.listingType || 'To Rent'}
                    </span>
                    {property.propertyReference && (
                      <span className="text-xs text-navy/30 font-mono">{property.propertyReference}</span>
                    )}
                  </div>
                </div>

                {/* Compact stats row — icon + number only */}
                <div className="flex flex-wrap items-center gap-5 py-4 border-y border-navy/10">
                  {!isCommercial && property.bedrooms != null && property.bedrooms > 0 && (
                    <div className="flex items-center gap-1.5">
                      <Bed className="w-4 h-4 text-navy/40" />
                      <span className="font-medium text-navy text-sm">{property.bedrooms}</span>
                    </div>
                  )}
                  {property.bathrooms > 0 && (
                    <div className="flex items-center gap-1.5">
                      <Bath className="w-4 h-4 text-navy/40" />
                      <span className="font-medium text-navy text-sm">{property.bathrooms}</span>
                    </div>
                  )}
                  {displaySize && (
                    <div className="flex items-center gap-1.5">
                      <Ruler className="w-4 h-4 text-navy/40" />
                      <span className="font-medium text-navy text-sm">{displaySize}m²</span>
                    </div>
                  )}
                  {hasPool && (
                    <div className="flex items-center gap-1.5">
                      <Waves className="w-4 h-4 text-navy/40" />
                      <span className="text-navy text-sm">Pool</span>
                    </div>
                  )}
                  {hasGarage && (
                    <div className="flex items-center gap-1.5">
                      <Car className="w-4 h-4 text-navy/40" />
                      <span className="text-navy text-sm">Garage</span>
                    </div>
                  )}
                  {viewingsInfo && (
                    <div className="flex items-center gap-1.5">
                      <DoorOpen className={cn('w-4 h-4', viewingsInfo.color)} />
                      <span className={cn('text-sm', viewingsInfo.color)}>{viewingsInfo.label}</span>
                    </div>
                  )}
                  {property.availableFrom && (
                    <span className="text-navy/50 text-xs ml-auto">
                      From {new Date(property.availableFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>

                {property.summary && (
                  <div className="py-5 border-b border-navy/10">
                    <p className="text-navy/70 leading-relaxed italic text-sm md:text-base">{property.summary}</p>
                  </div>
                )}

                {description && (
                  <div className="py-5">
                    <h2 className="font-serif text-lg md:text-xl text-navy mb-4">About This Property</h2>
                    <div className="text-navy/70 leading-relaxed space-y-3 text-sm md:text-base">
                      {description.split('\n\n').filter(Boolean).map((para, i) => (
                        <p key={i}>{para.trim()}</p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Features */}
                {property.features?.length > 0 && (
                  <div className="py-5 border-t border-navy/10">
                    <h2 className="font-serif text-lg md:text-xl text-navy mb-4">Features &amp; Amenities</h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                      {property.features.map((feature) => (
                        <div key={feature} className="flex items-center gap-2">
                          <Check className="w-3.5 h-3.5 text-gold shrink-0" />
                          <span className="text-navy/70 text-sm">{feature}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-lg p-5 md:p-6 lg:sticky lg:top-24">
                <h2 className="font-serif text-lg md:text-xl text-navy mb-5">Contact 2906</h2>
                <div className="flex items-center gap-4 mb-5 p-4 bg-off-white rounded-lg">
                  <div className="w-12 h-12 rounded-full overflow-hidden bg-gradient-to-br from-navy/10 to-gold/10 flex items-center justify-center shrink-0">
                    <span className="font-serif text-sm text-navy/40">2906</span>
                  </div>
                  <div>
                    <p className="font-semibold text-navy text-sm">2906 Real Estate</p>
                    <p className="text-xs text-navy/60">Agents Collective · Malta</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <a
                    href={`https://wa.me/35699990001?text=Hi, I'm interested in ${property.title}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full px-6 py-3 rounded bg-[#25D366] text-white font-medium hover:bg-[#20BD5A] transition-colors text-sm"
                  >
                    <MessageCircle className="w-4 h-4" />
                    WhatsApp
                  </a>
                  <a
                    href={`mailto:info@2906realestate.mt?subject=Inquiry about ${property.title}`}
                    className="flex items-center justify-center gap-2 w-full px-6 py-3 rounded bg-navy text-white font-medium hover:opacity-90 transition-opacity text-sm"
                  >
                    <Mail className="w-4 h-4" />
                    Send Email
                  </a>
                </div>
                {property.propertyReference && (
                  <p className="text-center text-xs text-navy/30 mt-5 font-mono">Ref: {property.propertyReference}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
