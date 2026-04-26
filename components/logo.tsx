'use client'

import Link from 'next/link'

interface LogoProps {
  variant?: 'light' | 'dark'
  size?: 'sm' | 'md' | 'lg'
}

export function Logo({ size = 'sm' }: LogoProps) {
  const widths = { sm: 96, md: 120, lg: 150 }

  return (
    <Link href="/" className="flex items-center group">
      <img
        src="/logo-wide.png"
        alt="2906 Real Estate"
        width={widths[size]}
        className="shrink-0 transition-opacity duration-300 group-hover:opacity-75"
      />
    </Link>
  )
}
