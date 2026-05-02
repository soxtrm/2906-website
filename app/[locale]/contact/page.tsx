'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { SimpleContactForm } from '@/components/simple-contact-form'
import { ContactForm } from '@/components/contact-form'
import { PublicPropertyForm } from '@/components/public-property-form'
import { ReferralForm } from '@/components/referral-form'

type Tab = 'contact' | 'search' | 'property' | 'referral'

const TABS = [
  { key: 'contact' as Tab,  label: 'Contact Us',          desc: 'General inquiry',     icon: '✉️' },
  { key: 'search' as Tab,   label: 'About your Search',   desc: 'Find your home',      icon: '🔍' },
  { key: 'property' as Tab, label: 'Add your Property',   desc: 'List with us',        icon: '🏠' },
  { key: 'referral' as Tab, label: 'Referral',            desc: 'Earn 10% commission', icon: '🎯' },
]

export default function ContactPage() {
  const [tab, setTab] = useState<Tab>('contact')

  return (
    <main className="min-h-screen bg-off-white">
      <Header />

      {/* Hero */}
      <section className="pt-28 pb-10 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 text-center max-w-2xl">
          <p className="text-gold text-xs tracking-[0.2em] uppercase mb-3">2906 Estate</p>
          <h1 className="font-serif text-3xl md:text-4xl text-white mb-3">How can we help?</h1>
          <p className="text-white/60 text-sm">Malta&apos;s premier property agency — tell us what you need.</p>
        </div>
      </section>

      <section className="py-10">
        <div className="container mx-auto px-4 lg:px-8 max-w-3xl">

          {/* Tab buttons */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`p-4 rounded-xl border-2 text-left transition-all ${
                  tab === t.key
                    ? 'border-gold bg-gold/5 shadow-sm'
                    : 'border-navy/10 bg-white hover:border-navy/20'
                }`}
              >
                <span className="text-xl block mb-1">{t.icon}</span>
                <p className="font-medium text-sm text-navy">{t.label}</p>
                <p className="text-xs text-navy/40 mt-0.5">{t.desc}</p>
              </button>
            ))}
          </div>

          {/* Form panel */}
          <div className="bg-white rounded-xl border border-navy/5 shadow-sm p-6 md:p-8">
            {tab === 'contact' && (
              <div>
                <h2 className="font-serif text-xl text-navy mb-1">Contact Us</h2>
                <p className="text-navy/50 text-sm mb-6">Send us a message and we&apos;ll get back to you.</p>
                <SimpleContactForm />
              </div>
            )}
            {tab === 'search' && (
              <div>
                <h2 className="font-serif text-xl text-navy mb-1">About your Search</h2>
                <p className="text-navy/50 text-sm mb-6">Tell us what you&apos;re looking for and we&apos;ll match you with 20,000+ Malta properties.</p>
                <ContactForm />
              </div>
            )}
            {tab === 'property' && (
              <div>
                <h2 className="font-serif text-xl text-navy mb-1">List Your Property</h2>
                <p className="text-navy/50 text-sm mb-6">Submit your property and we&apos;ll match it with qualified tenants and buyers.</p>
                <PublicPropertyForm />
              </div>
            )}
            {tab === 'referral' && (
              <div>
                <h2 className="font-serif text-xl text-navy mb-1">Referral Program</h2>
                <p className="text-navy/50 text-sm mb-6">Refer someone looking for property in Malta and earn 10% commission.</p>
                <ReferralForm />
              </div>
            )}
          </div>

        </div>
      </section>

      <Footer />
    </main>
  )
}
