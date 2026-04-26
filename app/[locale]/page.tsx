import { Header } from '@/components/header'
import { Hero } from '@/components/hero'
import { PropertySearch } from '@/components/property-search'
import { WhyChooseUs } from '@/components/why-choose-us'
import { MaltaMap } from '@/components/malta-map'
import { FeaturedProperties } from '@/components/featured-properties'
import { MaltaLifestyle } from '@/components/malta-lifestyle'
import { Footer } from '@/components/footer'

export default function HomePage() {
  return (
    <main>
      <Header heroPage />
      <Hero />
      <div className="bg-navy/95 border-b border-white/10">
        <div className="container mx-auto px-4 py-3">
          <PropertySearch />
        </div>
      </div>
      <WhyChooseUs />
      <FeaturedProperties />
      <MaltaMap />
      <MaltaLifestyle />
      <Footer />
    </main>
  )
}
