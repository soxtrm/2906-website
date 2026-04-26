'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Header } from '@/components/header'
import { Footer } from '@/components/footer'
import { MapPin, Phone, Mail, Clock, Send, MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function ContactPage() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    subject: '',
    message: '',
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    await new Promise(resolve => setTimeout(resolve, 1500))
    setIsSubmitting(false)
    setIsSubmitted(true)
  }

  return (
    <main className="min-h-screen">
      <Header />

      <section className="pt-28 pb-16 bg-navy">
        <div className="container mx-auto px-4 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center max-w-3xl mx-auto"
          >
            <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-6">Get in Touch</h1>
            <p className="text-white/80 text-lg">
              We&apos;d love to hear from you. Whether you&apos;re looking to buy, sell, or rent, our team is here to help.
            </p>
          </motion.div>
        </div>
      </section>

      <section className="py-16 bg-off-white">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="grid lg:grid-cols-3 gap-12">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="lg:col-span-1"
            >
              <h2 className="font-serif text-2xl text-navy mb-8">Contact Information</h2>
              <div className="space-y-6">
                {[
                  { Icon: MapPin, title: 'Address', content: 'Tower Road, Sliema\nSLM 1605, Malta' },
                  { Icon: Phone, title: 'Phone', content: '+356 9999 0001', href: 'tel:+35699990001' },
                  { Icon: Mail, title: 'Email', content: 'info@2906realestate.mt', href: 'mailto:info@2906realestate.mt' },
                ].map(({ Icon, title, content, href }) => (
                  <div key={title} className="flex items-start gap-4">
                    <div className="w-10 h-10 bg-gold/10 rounded-full flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-gold" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-navy mb-1">{title}</h3>
                      {href ? (
                        <a href={href} className="text-navy/60 hover:text-gold transition-colors whitespace-pre-line">{content}</a>
                      ) : (
                        <p className="text-navy/60 whitespace-pre-line">{content}</p>
                      )}
                    </div>
                  </div>
                ))}
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-gold/10 rounded-full flex items-center justify-center shrink-0">
                    <Clock className="w-5 h-5 text-gold" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-navy mb-1">Office Hours</h3>
                    <p className="text-navy/60">
                      Monday – Friday: 9:00 AM – 6:00 PM<br />
                      Saturday: 10:00 AM – 2:00 PM<br />
                      Sunday: By appointment
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-8">
                <a
                  href="https://wa.me/35699990001"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-6 py-3 rounded bg-[#25D366] text-white font-medium hover:bg-[#20BD5A] transition-colors"
                >
                  <MessageCircle className="w-5 h-5" />
                  Chat on WhatsApp
                </a>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="lg:col-span-2"
            >
              <div className="bg-white rounded-lg shadow-sm p-8">
                <h2 className="font-serif text-2xl text-navy mb-8">Send us a Message</h2>
                {isSubmitted ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="text-center py-12"
                  >
                    <div className="w-16 h-16 bg-status-available/10 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Send className="w-8 h-8 text-status-available" />
                    </div>
                    <h3 className="font-serif text-xl text-navy mb-2">Message Sent!</h3>
                    <p className="text-navy/60">Thank you for contacting us. We&apos;ll get back to you within 24 hours.</p>
                  </motion.div>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid md:grid-cols-2 gap-6">
                      {[
                        { id: 'name', label: 'Full Name *', type: 'text', required: true, placeholder: 'John Doe' },
                        { id: 'email', label: 'Email Address *', type: 'email', required: true, placeholder: 'john@example.com' },
                        { id: 'phone', label: 'Phone Number', type: 'tel', required: false, placeholder: '+356 9999 0000' },
                      ].map(({ id, label, type, required, placeholder }) => (
                        <div key={id}>
                          <label htmlFor={id} className="block text-sm font-medium text-navy mb-2">{label}</label>
                          <input
                            type={type}
                            id={id}
                            required={required}
                            value={formData[id as keyof typeof formData]}
                            onChange={(e) => setFormData(prev => ({ ...prev, [id]: e.target.value }))}
                            className="w-full px-4 py-3 border border-navy/10 rounded text-navy placeholder:text-navy/40 focus:outline-none focus:ring-2 focus:ring-gold/50 focus:border-gold"
                            placeholder={placeholder}
                          />
                        </div>
                      ))}
                      <div>
                        <label htmlFor="subject" className="block text-sm font-medium text-navy mb-2">Subject *</label>
                        <select
                          id="subject"
                          required
                          value={formData.subject}
                          onChange={(e) => setFormData(prev => ({ ...prev, subject: e.target.value }))}
                          className="w-full px-4 py-3 border border-navy/10 rounded text-navy focus:outline-none focus:ring-2 focus:ring-gold/50 focus:border-gold"
                        >
                          <option value="">Select a subject</option>
                          <option value="rental">Rental Inquiry</option>
                          <option value="purchase">Property Purchase</option>
                          <option value="commercial">Commercial Property</option>
                          <option value="valuation">Property Valuation</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label htmlFor="message" className="block text-sm font-medium text-navy mb-2">Message *</label>
                      <textarea
                        id="message"
                        required
                        rows={5}
                        value={formData.message}
                        onChange={(e) => setFormData(prev => ({ ...prev, message: e.target.value }))}
                        className="w-full px-4 py-3 border border-navy/10 rounded resize-none text-navy placeholder:text-navy/40 focus:outline-none focus:ring-2 focus:ring-gold/50 focus:border-gold"
                        placeholder="Tell us about your property needs..."
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className={cn(
                        'flex items-center justify-center gap-2 px-8 py-3 rounded bg-navy text-white font-medium hover:opacity-90 transition-opacity',
                        'disabled:opacity-50 disabled:cursor-not-allowed'
                      )}
                    >
                      {isSubmitting ? (
                        <>
                          <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Sending...
                        </>
                      ) : (
                        <>
                          <Send className="w-5 h-5" />
                          Send Message
                        </>
                      )}
                    </button>
                  </form>
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
