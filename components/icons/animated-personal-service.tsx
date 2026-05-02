'use client'

import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'

export function AnimatedPersonalService() {
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
      initial={{ scale: 0.6, opacity: 0 }}
      animate={isInView ? { scale: 1, opacity: 1 } : { scale: 0.6, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 12, delay: 0.2 }}
      whileHover={{ scale: 1.15 }}
    >
      <motion.path
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: isInView ? 1 : 0 }}
        transition={{ duration: 0.9, delay: 0.3 }}
      />
      {isInView && (
        <motion.path
          d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut', delay: 1.2 }}
          style={{ transformOrigin: 'center' }}
        />
      )}
    </motion.svg>
  )
}
