// Slug helpers for SEO routes. Pure functions — no IO, no React.

const DIACRITIC_MAP: Record<string, string> = {
  'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'ae',
  'ç': 'c', 'ċ': 'c',
  'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
  'ñ': 'n',
  'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o', 'œ': 'oe',
  'ŝ': 's', 'š': 's', 'ş': 's',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
  'ý': 'y', 'ÿ': 'y',
  'ż': 'z', 'ž': 'z', 'ź': 'z',
  'ġ': 'g', 'ħ': 'h',
}

export function slugify(input: string | null | undefined): string {
  if (!input) return ''
  const lower = String(input).toLowerCase().trim()
  const stripped = lower
    .split('')
    .map(ch => DIACRITIC_MAP[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
  return stripped
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

export function locationToSlug(location: string | null | undefined): string {
  if (!location) return ''
  const cleaned = String(location)
    .replace(/\bSt\.?\s+/gi, 'St ')
    .replace(/\bSaint\s+/gi, 'St ')
  return slugify(cleaned)
}

export function slugToLocationCandidates(slug: string): string[] {
  if (!slug) return []
  const base = slug.replace(/-+/g, ' ').trim()
  const titled = base.replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
  const out = new Set<string>([
    base,
    titled,
    titled.replace(/\bSt\b/g, "St"),
    titled.replace(/\bSt\b/g, "St."),
    titled.replace(/\bSt\b/g, "St Paul's").replace(/Paul's Paul's/, "Paul's"),
  ])
  return [...out]
}

export function buildListingSlug(opts: {
  bedrooms?: number | null
  propertyType?: string | null
  location?: string | null
  reference?: string | null
}): string {
  const parts: string[] = []
  if (opts.bedrooms && opts.bedrooms > 0) parts.push(`${opts.bedrooms}-bedroom`)
  if (opts.propertyType) parts.push(slugify(opts.propertyType))
  if (opts.location) parts.push(locationToSlug(opts.location))
  if (opts.reference) parts.push(slugify(opts.reference))
  return parts.filter(Boolean).join('-')
}

export function normalizeLocationKey(location: string | null | undefined): string {
  return locationToSlug(location || '')
}
