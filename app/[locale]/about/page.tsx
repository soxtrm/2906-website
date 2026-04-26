'use client'

import { motion } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { Award, Clock, Users, Building2 } from 'lucide-react'

const stats = [
  { icon: Building2, value: '500+', label: 'Properties Managed' },
  { icon: Users, value: '1,000+', label: 'Happy Clients' },
  { icon: Clock, value: '5+', label: 'Years Experience' },
  { icon: Award, value: '100%', label: 'Client Satisfaction' },
]

export default function AboutPage() {
  return (
    <main className="min-h-screen">
      <Header />

      {/* Hero Section */}
      <section className="pt-28 pb-16 bg-navy">
        <div className="container mx-auto px-4 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center max-w-3xl mx-auto"
          >
            <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-6">
              About <span className="text-gold">2906</span> Real Estate
            </h1>
            <p className="text-white/80 text-lg leading-relaxed">
              Founded in 2020, 2906 Real Estate Malta has quickly established itself as a trusted name in Malta&apos;s property market. We combine local expertise with personalized service to help you find your perfect property.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="py-16 bg-off-white">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8">
            {stats.map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="text-center"
              >
                <div className="w-14 h-14 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <stat.icon className="w-6 h-6 text-gold" />
                </div>
                <p className="font-serif text-3xl text-navy mb-1">{stat.value}</p>
                <p className="text-navy/60 text-sm">{stat.label}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Story Section */}
      <section className="py-16 bg-white">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <h2 className="font-serif text-2xl md:text-3xl text-navy mb-6 text-center">
                Our Story
              </h2>
              <div className="space-y-5 text-navy/70 text-base leading-relaxed">
                <p>
                  2906 Real Estate was built on a single conviction: property transactions in Malta deserve the same precision and care that the island itself inspires. Founded by Kevin and Olga — two professionals who fell in love with Malta&apos;s character before falling into its market — the agency brings an outsider&apos;s appreciation and an insider&apos;s knowledge to every mandate.
                </p>
                <p>
                  We cover the full spectrum of Malta&apos;s residential and commercial property landscape, from a studio in Gzira to a seafront penthouse in Sliema, a boutique office in St Julian&apos;s to a restored palazzo in Valletta. Our Aesthetics collection caters to clients who expect more than four walls — properties curated for design, light, and lifestyle above €2,500/month.
                </p>
                <p>
                  The name 2906 marks the moment this journey began. It is a daily reminder that every key we hand over is a milestone in someone&apos;s story — and we take that seriously.
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Values Section */}
      <section className="py-16 bg-navy text-white">
        <div className="container mx-auto px-4 lg:px-8">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="font-serif text-2xl md:text-3xl text-center mb-12"
          >
            Our Values
          </motion.h2>
          <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {[
              {
                title: 'Integrity',
                description: 'We believe in transparent, honest dealings. What we say is what you get.',
              },
              {
                title: 'Excellence',
                description: 'We maintain the highest standards in everything we do, from property selection to client service.',
              },
              {
                title: 'Personal Touch',
                description: 'Every client is unique. We take time to understand your needs and exceed your expectations.',
              },
            ].map((value, index) => (
              <motion.div
                key={value.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="text-center"
              >
                <h3 className="font-serif text-xl text-gold mb-3">{value.title}</h3>
                <p className="text-white/70">{value.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
