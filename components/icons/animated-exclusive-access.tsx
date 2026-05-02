'use client'

import { motion } from 'framer-motion'

export function AnimatedExclusiveAccess() {
  return (
    <motion.svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      className="text-gold"
      initial={{ rotate: -15, opacity: 0 }}
      animate={{ rotate: 0, opacity: 1 }}
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
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, delay: 0.2 }}
      />
      <motion.path
        d="M15.5 8.5L20 4M20 4H17M20 4V7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.5 }}
      />
      <motion.path
        d="M12 11L7.5 15.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.8 }}
      />
    </motion.svg>
  )
}
