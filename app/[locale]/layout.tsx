import type { Metadata, Viewport } from 'next'
import { Outfit, Playfair_Display } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { Analytics } from '@vercel/analytics/next'
import { notFound } from 'next/navigation'
import { routing } from '@/i18n/routing'

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
})

export const metadata: Metadata = {
  title: '2906 Real Estate Malta | Exceptional Properties. Trusted Service.',
  description: "Malta's Premier Real Estate. Discover exceptional properties in Malta with 2906 Real Estate - your trusted partner for luxury rentals, sales, and commercial properties.",
  keywords: ['Malta real estate', 'luxury properties Malta', 'Malta rentals', 'Sliema apartments', "St Julian's property", 'Malta commercial', 'Gozo real estate'],
  authors: [{ name: '2906 Real Estate Malta' }],
  openGraph: {
    title: '2906 Real Estate Malta | Exceptional Properties. Trusted Service.',
    description: "Malta's Premier Real Estate. Discover exceptional properties in Malta.",
    type: 'website',
    locale: 'en_MT',
  },
}

export const viewport: Viewport = {
  themeColor: '#1B2A4A',
  width: 'device-width',
  initialScale: 1,
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!routing.locales.includes(locale as any)) {
    notFound()
  }

  const messages = await getMessages()

  const isRtl = locale === 'ar'

  return (
    <html lang={locale} dir={isRtl ? 'rtl' : 'ltr'} className="bg-background">
      <body className={`${outfit.variable} ${playfair.variable} font-sans antialiased`}>
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
