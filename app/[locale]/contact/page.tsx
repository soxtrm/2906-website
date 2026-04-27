import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { ContactForm } from '@/components/contact-form'

export default function ContactPage() {
  return (
    <main className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="pt-28 pb-12 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 text-center max-w-3xl">
          <p className="text-gold text-xs tracking-[0.2em] uppercase mb-4">Off-Market Access</p>
          <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-5 leading-tight">
            Tell us what you're looking for
          </h1>
          <p className="text-white/70 text-base md:text-lg leading-relaxed mb-3">
            We can't list all 20,000+ Malta properties online. Tell us what you're looking for and we'll match you with off-market options.
          </p>
          <p className="text-gold/80 text-sm flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 bg-gold rounded-full inline-block animate-pulse" />
            Reply within 24 hours via WhatsApp
          </p>
        </div>
      </section>

      {/* Form */}
      <section className="py-12 bg-off-white">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="bg-white rounded-xl shadow-sm border border-navy/5 p-6 md:p-10 max-w-2xl mx-auto">
            <ContactForm />
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
