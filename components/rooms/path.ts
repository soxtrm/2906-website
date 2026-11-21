'use client'
import { useEffect, useState } from 'react'
// Marketplace links work on nexusstudios.one (/marketplace/…) and on preview/dev hosts (/studios/marketplace/…).
// The prefix is set after mount, so the server render and the first client render agree.
export function useMpPath() {
  const [prefix, setPrefix] = useState('')
  useEffect(() => { if (window.location.pathname.startsWith('/studios/')) setPrefix('/studios') }, [])
  return (p: string) => `${prefix}${p}`
}
