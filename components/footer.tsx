'use client'

import Link from 'next/link'
import { Instagram, Linkedin, Mail, MapPin, Phone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { navItems } from '@/lib/data'

export function Footer() {
  const t = useTranslations()

  return (
    <footer className="bg-navy text-white">
      <div className="container mx-auto px-4 lg:px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 lg:gap-12">
          {/* Brand */}
          <div className="text-center md:text-left">
            <div className="flex items-center justify-center md:justify-start gap-3 mb-4">
              <img src="/logo-icon.png" alt="2906 Real Estate" className="w-9 h-9 object-contain rounded" />
              <span className="font-serif text-gold text-sm font-medium">2906 Real Estate</span>
            </div>
            <p className="text-white/50 text-xs leading-relaxed mb-4 mx-auto md:mx-0 max-w-[200px]">
              {t('footer.tagline')}
            </p>
            <div className="flex gap-3 justify-center md:justify-start">
              <a href="#" className="text-white/40 hover:text-gold transition-colors" aria-label="Instagram">
                <Instagram className="w-4 h-4" />
              </a>
              <a href="#" className="text-white/40 hover:text-gold transition-colors" aria-label="LinkedIn">
                <Linkedin className="w-4 h-4" />
              </a>
            </div>
          </div>

          {/* Links — merged Navigation + Services */}
          <div className="text-center md:text-left">
            <h4 className="font-medium text-xs uppercase tracking-wider text-white/30 mb-3">{t('footer.navigation')}</h4>
            <ul className="space-y-2">
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-white/60 hover:text-gold transition-colors text-xs"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div className="text-center md:text-left">
            <h4 className="font-medium text-xs uppercase tracking-wider text-white/30 mb-3">{t('footer.contact')}</h4>
            <ul className="space-y-2">
              <li className="flex items-start gap-2">
                <MapPin className="w-3 h-3 text-gold shrink-0 mt-0.5" />
                <span className="text-white/60 text-xs">{t('footer.address')}</span>
              </li>
              <li className="flex items-center gap-2">
                <Phone className="w-3 h-3 text-gold shrink-0" />
                <a href="tel:+35699990001" className="text-white/60 hover:text-gold transition-colors text-xs">
                  +356 9999 0001
                </a>
              </li>
              <li className="flex items-center gap-2">
                <Mail className="w-3 h-3 text-gold shrink-0" />
                <a href="mailto:info@2906realestate.mt" className="text-white/60 hover:text-gold transition-colors text-xs">
                  info@2906realestate.mt
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-10 pt-6 border-t border-white/10 flex flex-col sm:flex-row justify-between items-center gap-3 text-center sm:text-left">
          <p className="text-white/30 text-xs">
            &copy; {new Date().getFullYear()} 2906 Real Estate Malta
          </p>
          <div className="flex gap-4 items-center justify-center sm:justify-end">
            <Link href="/privacy" className="text-white/30 hover:text-white/60 text-xs transition-colors">
              {t('footer.privacy')}
            </Link>
            <Link href="/terms" className="text-white/30 hover:text-white/60 text-xs transition-colors">
              {t('footer.terms')}
            </Link>
            <Link href="/admin" className="text-gold/30 hover:text-gold/70 text-xs transition-colors">
              Admin
            </Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
