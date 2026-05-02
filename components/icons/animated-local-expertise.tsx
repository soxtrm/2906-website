'use client'

import { motion } from 'framer-motion'

export function AnimatedLocalExpertise() {
  return (
    <motion.svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      className="text-gold"
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}
      whileHover={{ scale: 1.15, y: -1 }}
    >
      <motion.path
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, delay: 0.2 }}
      />
      <motion.circle
        cx="12"
        cy="9"
        r="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.7, type: 'spring', stiffness: 300 }}
      />
    </motion.svg>
  )
}
