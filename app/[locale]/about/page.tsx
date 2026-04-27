'use client'

import { motion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'

export default function AboutPage() {
  const t = useTranslations('about')

  const stats = [
    { val: t('stat_properties_val'), label: t('stat_properties_label') },
    { val: t('stat_clients_val'),    label: t('stat_clients_label') },
    { val: t('stat_years_val'),      label: t('stat_years_label') },
    { val: t('stat_satisfaction_val'), label: t('stat_satisfaction_label') },
  ]

  return (
    <main className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="pt-28 pb-16 bg-navy">
        <div className="container mx-auto px-4 lg:px-8">
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

      {/* Stats */}
      <section className="py-14 bg-white">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 max-w-4xl mx-auto">
            {stats.map((stat, i) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                className={`text-center px-6 py-8 ${i < stats.length - 1 ? 'lg:border-r border-navy/8' : ''} ${i % 2 === 0 ? 'border-r border-navy/8 lg:border-r-0' : ''}`}
              >
                <p className="font-serif text-4xl md:text-5xl text-gold mb-2 tracking-tight">{stat.val}</p>
                <p className="text-navy/50 text-[10px] uppercase tracking-[0.15em] leading-relaxed">{stat.label}</p>
              </motion.div>
            ))}
          </div>
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
