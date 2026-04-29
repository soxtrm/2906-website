'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X, ChevronDown } from 'lucide-react'
import { Logo } from './logo'
import { navItems, languages } from '@/lib/data'
import { cn } from '@/lib/utils'

const LOCALES = ['en', 'de', 'ar', 'zh', 'it', 'fr', 'es', 'ko', 'uk']

export function Header({ heroPage = false }: { heroPage?: boolean }) {
  // Init as NOT scrolled on hero pages (transparent) and scrolled on inner pages (white)
  const [isScrolled, setIsScrolled] = useState(!heroPage)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isLangOpen, setIsLangOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()

  // heroPage prop takes precedence; pathname check covers client-side navigation
  const segments = pathname.split('/').filter(Boolean)

  // Derive current locale from URL path
  const currentLocale = (segments.length > 0 && LOCALES.includes(segments[0])) ? segments[0] : 'en'
  const currentLangLabel = languages.find(l => l.code === currentLocale)?.label ?? 'EN'

  function switchLanguage(code: string) {
    const hasLocalePrefix = LOCALES.includes(segments[0]) && segments[0] !== 'en'
    const pathWithoutLocale = hasLocalePrefix ? '/' + segments.slice(1).join('/') : pathname
    const clean = pathWithoutLocale || '/'
    const newPath = code === 'en' ? clean : `/${code}${clean === '/' ? '' : clean}`
    router.push(newPath)
    setIsLangOpen(false)
  }
  const isHeroPage =
    heroPage ||
    segments.length === 0 ||
    (segments.length === 1 && LOCALES.includes(segments[0]))

  const transparent = isHeroPage && !isScrolled

  useEffect(() => {
    if (!isHeroPage) { setIsScrolled(true); return }
    setIsScrolled(window.scrollY > 50)
    const handleScroll = () => setIsScrolled(window.scrollY > 50)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [isHeroPage])

  const getActiveColor = () => {
    const activeItem = navItems.find(item => pathname === item.href)
    if (!activeItem?.accentColor) return 'bg-navy'
    const colorMap: Record<string, string> = {
      'accent-letting': 'bg-accent-letting',
      'accent-aesthetics': 'bg-gold',
      'accent-commercial': 'bg-accent-commercial',
      'accent-sales': 'bg-accent-sales',
    }
    return colorMap[activeItem.accentColor] || 'bg-navy'
  }

  return (
    <>
      <header
        className={cn(
          'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
          transparent
            ? 'bg-transparent py-4'
            : 'bg-white/95 backdrop-blur-sm shadow-sm py-2'
        )}
      >
        <div className="container mx-auto px-4 lg:px-6">
          <nav className="flex items-center justify-between">
            {/* Logo */}
            <Logo variant={transparent ? 'light' : 'dark'} size="sm" />

            {/* Desktop Navigation - Full links visible */}
            <div className="hidden lg:flex items-center gap-6">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'text-[13px] font-medium tracking-wide transition-colors relative py-1',
                    transparent
                      ? pathname === item.href
                        ? 'text-white'
                        : 'text-white/70 hover:text-white'
                      : pathname === item.href
                        ? 'text-navy'
                        : 'text-navy/60 hover:text-navy'
                  )}
                >
                  {item.label}
                  {pathname === item.href && (
                    <motion.div 
                      layoutId="activeTab"
                      className={cn(
                        'absolute -bottom-0.5 left-0 right-0 h-[2px]',
                        item.accentColor ? `bg-${item.accentColor}` : 'bg-gold'
                      )}
                    />
                  )}
                </Link>
              ))}
            </div>

            {/* Language Switcher - Desktop */}
            <div className="hidden lg:block relative">
              <button
                onClick={() => setIsLangOpen(!isLangOpen)}
                className={cn(
                  'flex items-center gap-1 text-[13px] font-medium transition-colors px-2 py-1',
                  transparent ? 'text-white/70 hover:text-white' : 'text-navy/60 hover:text-navy'
                )}
              >
                {currentLangLabel}
                <ChevronDown className={cn('w-3 h-3 transition-transform', isLangOpen && 'rotate-180')} />
              </button>
              
              <AnimatePresence>
                {isLangOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="absolute top-full right-0 mt-1 bg-white rounded shadow-lg py-1 min-w-[60px]"
                  >
                    {languages.map((lang) => (
                      <button
                        key={lang.code}
                        onClick={() => switchLanguage(lang.code)}
                        className={cn(
                          'w-full px-3 py-1.5 text-left text-xs transition-colors',
                          currentLocale === lang.code
                            ? 'text-gold font-medium'
                            : 'text-navy/60 hover:text-navy hover:bg-off-white'
                        )}
                      >
                        {lang.label}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Mobile Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className={cn(
                'lg:hidden p-1.5 transition-colors',
                transparent ? 'text-white' : 'text-navy'
              )}
              aria-label="Toggle menu"
            >
              {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </nav>
        </div>

        {/* Accent line on listing pages */}
        {!isHeroPage && !transparent && (
          <div className={cn('h-[2px] mt-2', getActiveColor())} />
        )}
      </header>

      {/* Mobile Menu */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ type: 'tween', duration: 0.25 }}
            className="fixed inset-0 z-40 bg-navy lg:hidden pt-16"
          >
            <nav className="container mx-auto px-4 py-6">
              <div className="flex flex-col gap-4">
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={cn(
                      'text-xl font-serif transition-colors py-1',
                      pathname === item.href ? 'text-gold' : 'text-white/70 hover:text-white'
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
              
              {/* Mobile Language */}
              <div className="mt-8 pt-6 border-t border-white/10">
                <p className="text-white/40 text-xs mb-3 uppercase tracking-wider">Language</p>
                <div className="flex flex-wrap gap-2">
                  {languages.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => { switchLanguage(lang.code); setIsMobileMenuOpen(false) }}
                      className={cn(
                        'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                        currentLocale === lang.code
                          ? 'bg-gold text-navy'
                          : 'bg-white/10 text-white/70 hover:bg-white/20'
                      )}
                    >
                      {lang.label}
                    </button>
                  ))}
                </div>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
