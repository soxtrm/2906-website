'use client'

import { motion } from 'framer-motion'
import { MessageCircle, Mail, Phone } from 'lucide-react'

export function Agents() {
  return (
    <section className="py-14 lg:py-18 bg-off-white">
      <div className="container mx-auto px-4 lg:px-6">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">We&apos;re Here to Help</p>
          <h2 className="font-serif text-2xl md:text-3xl text-navy">
            Contact 2906
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-md mx-auto bg-white rounded overflow-hidden border border-gray-100 hover:border-gray-200 hover:shadow-sm transition-all"
        >
          <div className="p-5 text-center">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-navy/10 to-gold/20 flex items-center justify-center mx-auto mb-3">
              <span className="font-serif text-2xl text-navy/60">2906</span>
            </div>
            <h3 className="font-serif text-lg text-navy">2906 Real Estate</h3>
            <p className="text-navy/50 text-xs mt-0.5">Agents Collective · Malta</p>
          </div>

          <div className="px-5 pb-5 flex gap-2">
            <a
              href="https://wa.me/35679010070"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded bg-[#25D366] text-white text-sm font-medium hover:bg-[#20BD5A] transition-colors"
            >
              <MessageCircle className="w-4 h-4" />
              WhatsApp
            </a>
            <a
              href="mailto:contact@2906.estate"
              className="flex items-center justify-center p-2.5 rounded bg-navy/5 text-navy hover:bg-navy hover:text-white transition-colors"
              aria-label="Email 2906"
            >
              <Mail className="w-4 h-4" />
            </a>
            <a
              href="tel:+35679010070"
              className="flex items-center justify-center p-2.5 rounded bg-navy/5 text-navy hover:bg-navy hover:text-white transition-colors"
              aria-label="Call 2906"
            >
              <Phone className="w-4 h-4" />
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
