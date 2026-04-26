'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { MessageCircle, Mail, Phone } from 'lucide-react'
import { agents } from '@/lib/data'
import { cn } from '@/lib/utils'

export function Agents() {
  return (
    <section className="py-14 lg:py-18 bg-off-white">
      <div className="container mx-auto px-4 lg:px-6">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <p className="text-gold text-xs tracking-[0.2em] uppercase mb-1">Get in Touch</p>
          <h2 className="font-serif text-2xl md:text-3xl text-navy">
            Meet the Team
          </h2>
        </motion.div>

        {/* Agents Grid */}
        <div className="grid sm:grid-cols-2 gap-5 max-w-xl mx-auto">
          {agents.map((agent, index) => (
            <AgentCard key={agent.id} agent={agent} index={index} />
          ))}
        </div>
      </div>
    </section>
  )
}

function AgentCard({ agent, index }: { agent: (typeof agents)[0]; index: number }) {
  const [imgError, setImgError] = useState(false)
  const hasPhoto = agent.image && !imgError

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.1 }}
      className="bg-white rounded overflow-hidden border border-gray-100 hover:border-gray-200 hover:shadow-sm transition-all"
    >
      <div className="p-4 flex items-center gap-4">
        {/* Avatar — photo or initial fallback */}
        <div className="w-14 h-14 rounded-full overflow-hidden bg-gradient-to-br from-navy/5 to-gold/10 flex items-center justify-center shrink-0">
          {hasPhoto ? (
            <img
              src={agent.image}
              alt={agent.name}
              onError={() => setImgError(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="font-serif text-xl text-navy/40">
              {agent.name.charAt(0)}
            </span>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-base text-navy truncate">{agent.name}</h3>
          <p className="text-navy/50 text-xs">{agent.role}</p>
        </div>
      </div>

      {/* Contact Buttons */}
      <div className="px-4 pb-4 flex gap-2">
        <a
          href={`https://wa.me/${agent.whatsapp.replace(/[^0-9]/g, '')}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded',
            'bg-[#25D366] text-white text-xs font-medium',
            'hover:bg-[#20BD5A] transition-colors'
          )}
        >
          <MessageCircle className="w-3.5 h-3.5" />
          WhatsApp
        </a>
        <a
          href={`mailto:${agent.email}`}
          className="flex items-center justify-center p-2 rounded bg-navy/5 text-navy hover:bg-navy hover:text-white transition-colors"
          aria-label={`Email ${agent.name}`}
        >
          <Mail className="w-3.5 h-3.5" />
        </a>
        <a
          href={`tel:${agent.phone}`}
          className="flex items-center justify-center p-2 rounded bg-navy/5 text-navy hover:bg-navy hover:text-white transition-colors"
          aria-label={`Call ${agent.name}`}
        >
          <Phone className="w-3.5 h-3.5" />
        </a>
      </div>
    </motion.div>
  )
}
