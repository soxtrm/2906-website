export type PropertyType = 
  | 'Apartment' 
  | 'Penthouse' 
  | 'Maisonette' 
  | 'Semi-detached Villa' 
  | 'Detached Villa' 
  | 'Townhouse' 
  | 'Terraced House' 
  | 'Farmhouse'
  | 'Office'
  | 'Retail'
  | 'Warehouse'

export type PropertyStatus = 'available' | 'viewings' | 'rented'

export type PropertyCategory = 'letting' | 'aesthetics' | 'commercial' | 'sales'

export type Region = 
  | 'Central East' 
  | 'Central West' 
  | 'Central Surroundings' 
  | 'North' 
  | 'South' 
  | 'South East' 
  | 'Gozo'

export interface Property {
  id: string
  title: string
  slug: string
  price: number
  priceType: 'month' | 'total'
  bedrooms: number
  bathrooms: number
  area: number
  propertyType: PropertyType
  category: PropertyCategory
  region: Region
  location: string
  status: PropertyStatus
  images: string[]
  description: string
  features: string[]
  availableFrom?: string
  featured: boolean
}

export interface Agent {
  id: string
  name: string
  role: string
  image: string
  phone: string
  whatsapp: string
  email: string
}

export interface RegionInfo {
  id: Region
  name: string
  description: string
  advantages: string[]
  disadvantages: string[]
  priceRange: string
  typicalProperties: string[]
  areas: string[]
}

export type Language = 'en' | 'de' | 'ar' | 'zh' | 'it' | 'fr' | 'es' | 'ko'

export interface NavItem {
  label: string
  href: string
  accentColor?: string
}
