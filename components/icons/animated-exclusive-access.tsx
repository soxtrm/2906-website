'use client'

import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'

export function AnimatedExclusiveAccess() {
  const ref = useRef<SVGSVGElement>(null)
  const isInView = useInView(ref, { once: true, amount: 0.5 })

  return (
    <motion.svg
      ref={ref}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      className="text-gold"
      initial={{ rotate: -15, opacity: 0 }}
      animate={isInView ? { rotate: 0, opacity: 1 } : { rotate: -15, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 12, delay: 0.15 }}
      whileHover={{ rotate: 12, scale: 1.1 }}
    >
      <motion.circle
        cx="7.5"
        cy="15.5"
        r="4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: isInView ? 1 : 0 }}
        transition={{ duration: 0.7, delay: 0.2 }}
      />
      <motion.path
        d="M15.5 8.5L20 4M20 4H17M20 4V7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: isInView ? 1 : 0, opacity: isInView ? 1 : 0 }}
        transition={{ duration: 0.6, delay: 0.5 }}
      />
      <motion.path
        d="M12 11L7.5 15.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: isInView ? 1 : 0, opacity: isInView ? 1 : 0 }}
        transition={{ duration: 0.4, delay: 0.8 }}
      />
    </motion.svg>
  )
}
