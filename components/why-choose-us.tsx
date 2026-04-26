'use client'

import { motion } from 'framer-motion'
import { MapPin, Heart, Gem, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

export function WhyChooseUs() {
  const t = useTranslations()

  const features = [
    {
      icon: MapPin,
      title: t('features.localExpertise'),
      description: t('features.localDesc'),
    },
    {
      icon: Heart,
      title: t('features.personalService'),
      description: t('features.personalDesc'),
    },
    {
      icon: Gem,
      title: t('features.exclusiveAccess'),
      description: t('features.exclusiveDesc'),
    },
  ]

  return (
    <section className="py-12 lg:py-16 bg-white border-y border-gray-100">
      <div className="container mx-auto px-4 lg:px-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
          {/* Left: Title */}
          <motion.div
            initial={{ opacity: 0, x: -15 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="lg:max-w-xs"
          >
            <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">{t('sections.ourPromise')}</p>
            <h2 className="font-serif text-xl md:text-2xl text-navy mb-2">
              {t('sections.whyChoose')}
            </h2>
            <Link
              href="/about"
              className="inline-flex items-center gap-1 text-xs text-navy/50 hover:text-gold transition-colors group"
            >
              {t('sections.learnMore')}
              <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </motion.div>

          {/* Right: Features */}
          <div className="flex flex-col sm:flex-row gap-6 lg:gap-10">
            {features.map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 15 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="flex gap-3"
              >
                <div className="shrink-0 w-9 h-9 bg-gold/10 rounded flex items-center justify-center">
                  <feature.icon className="w-4 h-4 text-gold" />
                </div>
                <div>
                  <h3 className="text-sm font-medium text-navy mb-0.5">{feature.title}</h3>
                  <p className="text-xs text-navy/50 leading-relaxed max-w-[180px]">{feature.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
