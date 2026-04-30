import Link from 'next/link'
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
            Tell us what you&apos;re looking for
          </h1>
          <p className="text-white/70 text-base md:text-lg leading-relaxed mb-3">
            We can&apos;t list all 20,000+ Malta properties online. Tell us what you&apos;re looking for and we&apos;ll match you with all our options.
          </p>
          <p className="text-gold/80 text-sm flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 bg-gold rounded-full inline-block animate-pulse" />
            Reply as soon as possible via WhatsApp or Email
          </p>
        </div>
      </section>

      {/* Quick Action Cards */}
      <section className="bg-off-white py-10 border-b border-navy/8">
        <div className="container mx-auto px-4 lg:px-8 max-w-4xl">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href="/add-client"
              className="group bg-white rounded-xl border border-navy/8 p-6 flex flex-col items-center text-center hover:border-gold/40 hover:shadow-md transition-all"
            >
              <span className="text-3xl mb-3">🔍</span>
              <h3 className="font-serif text-navy text-lg mb-1 group-hover:text-gold transition-colors">Add Your Search</h3>
              <p className="text-navy/50 text-sm">Tell us what you&apos;re looking for</p>
            </Link>

            <Link
              href="/add-property"
              className="group bg-white rounded-xl border border-navy/8 p-6 flex flex-col items-center text-center hover:border-gold/40 hover:shadow-md transition-all"
            >
              <span className="text-3xl mb-3">🏠</span>
              <h3 className="font-serif text-navy text-lg mb-1 group-hover:text-gold transition-colors">Add Your Property</h3>
              <p className="text-navy/50 text-sm">List your property with us</p>
            </Link>

            <Link
              href="/referral"
              className="group bg-white rounded-xl border border-navy/8 p-6 flex flex-col items-center text-center hover:border-gold/40 hover:shadow-md transition-all"
            >
              <span className="text-3xl mb-3">🎯</span>
              <h3 className="font-serif text-navy text-lg mb-1 group-hover:text-gold transition-colors">Referral Program</h3>
              <p className="text-navy/50 text-sm">Earn 10% commission per referral</p>
            </Link>
          </div>
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
