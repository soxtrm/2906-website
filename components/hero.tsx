'use client'

import { useRef, useEffect, useState } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { useTranslations } from 'next-intl'

export function Hero() {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoReady, setVideoReady] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const t = useTranslations()

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end start'],
  })

  const contentOpacity = useTransform(scrollYProgress, [0, 0.5], [1, 0])
  const contentY = useTransform(scrollYProgress, [0, 0.5], ['0%', '20%'])

  // Pause/resume autoplay video based on visibility
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {})
        } else {
          video.pause()
        }
      },
      { threshold: 0 }
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  return (
    <section ref={containerRef} className="relative h-screen overflow-hidden">
      {/* Autoplay loop video background */}
      {!videoError && (
        <video
          ref={videoRef}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          className="absolute inset-0 w-full h-full object-cover"
          onCanPlayThrough={() => setVideoReady(true)}
          onError={() => setVideoError(true)}
        >
          <source src="/videos/hero.mp4" type="video/mp4" />
        </video>
      )}

      {/* Fallback / loading: Malta illustration shown until video is ready */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-navy"
        style={{
          backgroundImage: 'url(/hero-loading.png)',
          opacity: videoReady && !videoError ? 0 : 1,
          transition: 'opacity 0.8s ease',
        }}
      />

      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-gradient-to-b from-navy/40 via-navy/20 to-navy/70" />

      {/* Heading */}
      <motion.div
        className="relative z-10 h-full flex flex-col items-center justify-center px-4"
        style={{ opacity: contentOpacity, y: contentY }}
      >
        <div className="text-center max-w-3xl mx-auto">
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="text-gold text-sm tracking-[0.3em] uppercase mb-4"
          >
            {t('hero.tagline')}
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="font-sans font-semibold text-4xl md:text-5xl lg:text-6xl text-white mb-6 leading-[1.1] tracking-tight text-balance"
          >
            {t('hero.headline')}
            <br />
            <span className="text-gold">{t('hero.headline2')}</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.6 }}
            className="text-white/80 text-base md:text-lg font-light max-w-xl mx-auto"
          >
            {t('hero.subheadline')}
          </motion.p>
        </div>
      </motion.div>

      {/* Scroll indicator — chevron only, no text */}
      <motion.div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2 }}
        style={{ opacity: contentOpacity }}
      >
        <motion.div
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          className="flex flex-col items-center text-white/50"
        >
          <ChevronDown className="w-5 h-5" />
        </motion.div>
      </motion.div>
    </section>
  )
}
