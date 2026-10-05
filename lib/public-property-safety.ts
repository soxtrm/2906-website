type PublicProperty = { propertyReference?: unknown; id?: unknown; price?: unknown; priceType?: unknown; priceAfter?: unknown }

const quarantinedReferences = new Set(['2906-9398'])

export function isPubliclyPlausibleProperty(property: PublicProperty) {
  if (quarantinedReferences.has(String(property.propertyReference || property.id || ''))) return false
  const monthly = property.priceType === 'month' || /month/i.test(String(property.priceAfter || ''))
  const price = Number(property.price)
  return !(monthly && (!Number.isFinite(price) || price < 100))
}
