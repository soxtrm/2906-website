'use client'

import { useRef } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { Sun, Plane, Shield, Building2 } from 'lucide-react'

const benefits = [
  {
    icon: Sun,
    title: '300+ Days of Sunshine',
    description: 'Mediterranean climate with mild winters and warm summers year-round.',
  },
  {
    icon: Plane,
    title: 'Gateway to Europe',
    description: 'Direct flights to major European cities, perfect for business and travel.',
  },
  {
    icon: Shield,
    title: 'Safe & Stable',
    description: 'EU member state with English as an official language and low crime rates.',
  },
  {
    icon: Building2,
    title: 'Tax Advantages',
    description: 'Attractive tax regimes for residents and favorable property investment.',
  },
]

// Simple bird silhouette: two wing curves
function Bird({ size = 24, opacity = 0.7 }: { size?: number; opacity?: number }) {
  return (
    <svg width={size} height={size * 0.5} viewBox="0 0 48 24" fill="none">
      <path
        d="M 0,12 Q 8,2 16,10 Q 24,18 32,10 Q 40,2 48,12"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity={opacity}
      />
    </svg>
  )
}

// Config for 3 birds — spread across the right half, deliberately staggered
const BIRDS = [
  { right: '8%',  startY: '-20%', endY: '60%',  size: 28, opacity: 0.55, delay: 0 },
  { right: '28%', startY: '15%',  endY: '85%',  size: 20, opacity: 0.40, delay: 0.5 },
  { right: '48%', startY: '-35%', endY: '45%',  size: 16, opacity: 0.30, delay: 0.2 },
]

export function MaltaLifestyle() {
  const sectionRef = useRef<HTMLDivElement>(null)

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start end', 'end start'],
  })

  const bgY      = useTransform(scrollYProgress, [0, 1], ['-10%', '10%'])
  const glowY    = useTransform(scrollYProgress, [0, 1], ['-5%', '18%'])
  const contentY = useTransform(scrollYProgress, [0, 1], ['3%', '-3%'])

  const birdY0 = useTransform(scrollYProgress, [0, 1], [BIRDS[0].startY, BIRDS[0].endY])
  const birdY1 = useTransform(scrollYProgress, [0, 1], [BIRDS[1].startY, BIRDS[1].endY])
  const birdY2 = useTransform(scrollYProgress, [0, 1], [BIRDS[2].startY, BIRDS[2].endY])
  const birdYs = [birdY0, birdY1, birdY2]

  return (
    <section
      ref={sectionRef}
      className="relative py-24 lg:py-36 overflow-hidden"
    >
      {/* Layer 1: Malta illustration */}
      <motion.div
        style={{ y: bgY }}
        className="absolute inset-0 scale-[1.2] origin-center"
      >
        <img
          src="/malta-illustration.png"
          alt=""
          className="w-full h-full object-cover object-center"
        />
      </motion.div>

      {/* Gradient overlays */}
      <div className="absolute inset-0 bg-gradient-to-r from-navy/90 via-navy/70 to-navy/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-navy/60 via-transparent to-navy/20" />

      {/* Gold glow */}
      <motion.div
        style={{ y: glowY }}
        className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-gold/8 rounded-full blur-[100px] pointer-events-none"
      />

      {/* Birds — right side, parallax scroll, hidden on mobile */}
      {BIRDS.map((bird, idx) => (
        <motion.div
          key={idx}
          style={{ y: birdYs[idx], right: bird.right }}
          className="absolute pointer-events-none z-10 hidden md:block"
          animate={{ x: [0, 6, -4, 8, 0] }}
          transition={{ duration: 4 + idx * 0.7, repeat: Infinity, ease: 'easeInOut', delay: bird.delay }}
        >
          <Bird size={bird.size} opacity={bird.opacity} />
        </motion.div>
      ))}

      {/* Content */}
      <motion.div
        style={{ y: contentY }}
        className="relative z-10 container mx-auto px-4 lg:px-6"
      >
        <div className="max-w-xl">
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7 }}
          >
            <p className="text-gold text-xs tracking-[0.2em] uppercase mb-3">Why Malta</p>
            <h2 className="font-serif text-3xl md:text-4xl lg:text-5xl mb-5 text-white leading-tight">
              Your Mediterranean<br />
              <span className="text-gold">Home Base</span>
            </h2>
            <p className="text-white/70 text-sm leading-relaxed mb-8 max-w-md">
              Malta offers an exceptional quality of life combining rich history,
              stunning coastlines, and modern amenities. Whether you&apos;re seeking
              a permanent residence, investment property, or vacation home,
              Malta delivers unmatched value in the heart of the Mediterranean.
            </p>
          </motion.div>

          <div className="grid sm:grid-cols-2 gap-5">
            {benefits.map((benefit, i) => (
              <motion.div
                key={benefit.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.12, duration: 0.5 }}
                className="flex gap-3 group"
              >
                <div className="shrink-0 w-9 h-9 rounded-lg bg-white/10 backdrop-blur-sm border border-white/10 flex items-center justify-center group-hover:bg-gold/20 transition-colors duration-300">
                  <benefit.icon className="w-4 h-4 text-gold" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white mb-1">{benefit.title}</h3>
                  <p className="text-xs text-white/55 leading-relaxed">{benefit.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  )
}
