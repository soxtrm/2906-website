import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy | 2906 Real Estate Malta',
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-off-white">
      <Header />

      <section className="pt-28 pb-12 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 text-center">
          <h1 className="font-serif text-3xl md:text-4xl text-white mb-3">Privacy Policy</h1>
          <p className="text-white/60 text-sm">Last updated: 2025</p>
        </div>
      </section>

      <section className="py-12">
        <div className="container mx-auto px-4 lg:px-8 max-w-3xl">
          <div className="bg-white rounded-lg p-8 md:p-10 space-y-8 text-navy/70 leading-relaxed">

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">1. Introduction</h2>
              <p>
                2906 Real Estate Malta (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to protecting your personal
                information. This Privacy Policy explains how we collect, use, and safeguard your data when
                you use our website or engage with our services.
              </p>
              <p className="mt-2 text-gold text-sm italic">
                [Kevin — please review and expand this section with your specific practices.]
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">2. Information We Collect</h2>
              <ul className="list-disc list-inside space-y-1">
                <li>Contact details you provide (name, email, phone number)</li>
                <li>Property preferences and search criteria</li>
                <li>Communication records (WhatsApp messages, emails)</li>
                <li>Usage data collected automatically when you browse our website</li>
              </ul>
              <p className="mt-2 text-gold text-sm italic">
                [Kevin — add or remove items as appropriate.]
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">3. How We Use Your Information</h2>
              <ul className="list-disc list-inside space-y-1">
                <li>To respond to your property enquiries</li>
                <li>To match you with suitable properties</li>
                <li>To send you relevant property updates (with your consent)</li>
                <li>To improve our website and services</li>
              </ul>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">4. Data Sharing</h2>
              <p>
                We do not sell your personal data to third parties. We may share information with
                property owners, legal advisors, or service providers strictly as needed to fulfil
                your request.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">5. Data Retention</h2>
              <p>
                We retain your personal data for as long as necessary to provide our services or as
                required by law. You may request deletion of your data at any time.
              </p>
              <p className="mt-2 text-gold text-sm italic">
                [Kevin — specify your actual retention period.]
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">6. Your Rights</h2>
              <p>Under GDPR and Maltese law, you have the right to:</p>
              <ul className="list-disc list-inside space-y-1 mt-2">
                <li>Access the personal data we hold about you</li>
                <li>Request correction or deletion of your data</li>
                <li>Object to or restrict processing</li>
                <li>Data portability</li>
              </ul>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">7. Cookies</h2>
              <p>
                Our website uses cookies to improve user experience and analyse traffic. You can control
                cookie settings through your browser.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">8. Contact</h2>
              <p>
                For any privacy-related questions or to exercise your rights, contact us at:{' '}
                <a href="mailto:contact@2906.estate" className="text-gold hover:underline">
                  contact@2906.estate
                </a>
              </p>
            </div>

          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
