import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'de', 'ar', 'zh', 'it', 'fr', 'es', 'ko', 'uk'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  localeDetection: false,
})
