'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence, useInView } from 'framer-motion'
import { Bed, Bath, Square, MapPin } from 'lucide-react'
import type { Property } from '@/lib/types'
import { cn } from '@/lib/utils'

interface PropertyCardProps {
  property: Property
  index?: number
  compact?: boolean
}

const COMMERCIAL_TYPES = ['Office', 'Retail', 'Warehouse']

export function PropertyCard({ property, index = 0, compact = false }: PropertyCardProps) {
  const [imageError, setImageError] = useState(false)
  const [photoIndex, setPhotoIndex] = useState(0)
  const [isHovered, setIsHovered] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(cardRef, { amount: 0.5 })

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const photos = property.images || []
  const photosCount = photos.length

  useEffect(() => {
    if (photosCount <= 1) return
    const shouldAnimate = isMobile ? isInView : isHovered
    if (!shouldAnimate) {
      setPhotoIndex(0)
      return
    }
    const interval = setInterval(() => {
      setPhotoIndex(prev => (prev + 1) % photosCount)
    }, 4000)
    return () => clearInterval(interval)
  }, [isHovered, isInView, isMobile, photosCount])

  const statusConfig = {
    available: { dot: 'bg-status-available', label: 'Available', text: 'text-status-available' },
    viewings: { dot: 'bg-status-viewings', label: 'Viewing', text: 'text-status-viewings' },
    rented: { dot: 'bg-status-rented', label: 'Rented', text: 'text-status-rented' },
  }

  const isCommercial =
    property.category === 'commercial' ||
    COMMERCIAL_TYPES.includes(property.propertyType as string)

  const formatPrice = (price: number, priceType: 'month' | 'total') => {
    if (priceType === 'total') return `€${price.toLocaleString()}`
    return `€${price.toLocaleString()}/mo`
  }

  const placeholderImage = `https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80`
  const currentPhoto = (idx: number) => imageError ? placeholderImage : (photos[idx] || photos[0] || placeholderImage)

  useEffect(() => {
    if (photosCount <= 1) return
    const preload = (idx: number) => { const img = new window.Image(); img.src = currentPhoto(idx) }
    preload((photoIndex + 1) % photosCount)
  }, [photoIndex, photosCount])

  const slideVariants = {
    enter: { x: '100%' },
    center: { x: 0 },
    exit: { x: '-100%' },
  }

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 15 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.05, duration: 0.4 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Link href={`/property/${property.slug}`} className="group block">
        <article className="bg-white rounded overflow-hidden border border-gray-100 hover:border-gray-200 hover:shadow-md transition-all duration-300">
          {/* Image */}
          <div className={cn('relative overflow-hidden', compact ? 'aspect-[16/10]' : 'aspect-[4/3]')}>
            <AnimatePresence initial={false} mode="sync">
              <motion.div
                key={photoIndex}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
                className="absolute inset-0"
              >
                <img
                  src={currentPhoto(photoIndex)}
                  alt={property.title}
                  onError={() => setImageError(true)}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                />
              </motion.div>
            </AnimatePresence>

            {/* Status badge */}
            <div className="absolute top-3 left-3 z-10">
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/90 backdrop-blur-sm text-[10px] font-semibold shadow-sm">
                <span className={cn('w-1.5 h-1.5 rounded-full', statusConfig[property.status].dot)} />
                <span className={statusConfig[property.status].text}>
                  {statusConfig[property.status].label}
                </span>
              </span>
            </div>

            {/* Price */}
            <div className="absolute bottom-3 left-3 z-10">
              <span className="text-sm font-semibold text-white bg-navy/80 backdrop-blur-sm px-2.5 py-1 rounded">
                {formatPrice(property.price, property.priceType)}
              </span>
            </div>

            {/* Photo dots */}
            {photosCount > 1 && (
              <div className="absolute bottom-3 right-3 z-10 flex gap-1">
                {photos.map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      'w-1.5 h-1.5 rounded-full transition-colors duration-300',
                      i === photoIndex ? 'bg-white' : 'bg-white/40'
                    )}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Content */}
          <div className={cn('p-4', compact && 'p-3')}>
            <h3 className={cn(
              'font-serif text-navy mb-1 group-hover:text-gold transition-colors line-clamp-1',
              compact ? 'text-base' : 'text-lg'
            )}>
              {property.title}
            </h3>

            <div className="flex items-center gap-1 text-navy/50 mb-3">
              <MapPin className="w-3 h-3" />
              <span className="text-xs">{property.location}</span>
            </div>

            <div className="flex items-center gap-4 text-navy/60">
              {!isCommercial && property.bedrooms > 0 && (
                <div className="flex items-center gap-1">
                  <Bed className="w-3.5 h-3.5" />
                  <span className="text-xs">{property.bedrooms}</span>
                </div>
              )}
              <div className="flex items-center gap-1">
                <Bath className="w-3.5 h-3.5" />
                <span className="text-xs">{property.bathrooms}</span>
              </div>
              <div className="flex items-center gap-1">
                <Square className="w-3.5 h-3.5" />
                <span className="text-xs">{property.area}m²</span>
              </div>
            </div>
          </div>
        </article>
      </Link>
    </motion.div>
  )
}
