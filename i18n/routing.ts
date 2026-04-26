import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'de', 'ar', 'zh', 'it', 'fr', 'es', 'ko'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  localeDetection: false,
})
