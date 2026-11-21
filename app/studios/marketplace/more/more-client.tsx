'use client'
import { useEffect, useState } from 'react'
import { MorePage } from '../sections'
export function MorePageClient() {
  const [ex, setEx] = useState('/exchange')
  useEffect(() => { setEx(window.location.pathname.startsWith('/studios') ? '/studios/exchange' : '/exchange') }, [])
  return <MorePage exchangeHref={ex} />
}
