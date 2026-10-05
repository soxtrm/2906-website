'use client'

import { motion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'

export default function AboutPage() {
  const t = useTranslations('about')

  return (
    <main className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="pt-28 pb-16 bg-navy">
        <div className="container mx-auto px-4 lg:px-8">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6 }}
            className="flex justify-center mb-10"
          >
            <img
              src="/about-animation.gif"
              alt="2906 Estate"
              width={850}
              height={492}
              loading="eager"
              className="w-full max-w-4xl h-auto"
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center max-w-3xl mx-auto"
          >
            <p className="text-gold text-xs tracking-[0.2em] uppercase mb-4">Agents Collective · Malta & Gozo</p>
            <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-8">
              {t('title')}
            </h1>
          </motion.div>
        </div>
      </section>

      {/* Story */}
      <section className="py-16 bg-off-white">
        <div className="container mx-auto px-4 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="max-w-2xl mx-auto"
          >
            <div className="space-y-6 text-navy/70 text-base leading-[1.85]">
              <p>{t('story_p1')}</p>
              <p className="font-medium text-navy/90">{t('story_p2')}</p>
            </div>
          </motion.div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
