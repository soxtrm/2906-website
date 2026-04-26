import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms & Conditions | 2906 Real Estate Malta',
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-off-white">
      <Header />

      <section className="pt-28 pb-12 bg-navy">
        <div className="container mx-auto px-4 lg:px-8 text-center">
          <h1 className="font-serif text-3xl md:text-4xl text-white mb-3">Terms &amp; Conditions</h1>
          <p className="text-white/60 text-sm">Last updated: 2025</p>
        </div>
      </section>

      <section className="py-12">
        <div className="container mx-auto px-4 lg:px-8 max-w-3xl">
          <div className="bg-white rounded-lg p-8 md:p-10 space-y-8 text-navy/70 leading-relaxed">

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">1. Acceptance of Terms</h2>
              <p>
                By accessing or using the 2906 Real Estate Malta website, you agree to be bound by
                these Terms &amp; Conditions. If you do not agree, please do not use our services.
              </p>
              <p className="mt-2 text-gold text-sm italic">
                [Kevin — review and expand with your specific terms.]
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">2. Services</h2>
              <p>
                2906 Real Estate Malta provides property listings, letting services, and real estate
                consultancy. All property details are provided in good faith and are subject to
                availability and change without notice.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">3. Property Information</h2>
              <p>
                All property descriptions, prices, and availability are indicative and may change.
                We endeavour to keep information accurate but do not warrant its completeness or
                accuracy. Independent verification is recommended before making any decisions.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">4. Agent Fees &amp; Commissions</h2>
              <p>
                Agency fees and commission structures will be communicated clearly prior to entering
                into any agreement.
              </p>
              <p className="mt-2 text-gold text-sm italic">
                [Kevin — add your standard fee structure here.]
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">5. User Obligations</h2>
              <p>You agree not to:</p>
              <ul className="list-disc list-inside space-y-1 mt-2">
                <li>Use the website for any unlawful purpose</li>
                <li>Provide false or misleading information</li>
                <li>Reproduce or redistribute our content without permission</li>
              </ul>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">6. Intellectual Property</h2>
              <p>
                All content on this website, including text, images, and logos, is the property of
                2906 Real Estate Malta and may not be used without prior written consent.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">7. Limitation of Liability</h2>
              <p>
                2906 Real Estate Malta is not liable for any indirect, incidental, or consequential
                damages arising from the use of our website or services.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">8. Governing Law</h2>
              <p>
                These terms are governed by the laws of Malta. Any disputes shall be subject to the
                exclusive jurisdiction of the Maltese courts.
              </p>
            </div>

            <div>
              <h2 className="font-serif text-xl text-navy mb-3">9. Contact</h2>
              <p>
                For any queries regarding these terms, contact us at:{' '}
                <a href="mailto:info@2906realestate.mt" className="text-gold hover:underline">
                  info@2906realestate.mt
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
