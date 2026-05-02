'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SimpleContactForm() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', subject: '', message: '' })
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const validate = () => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Required'
    if (!form.email.trim()) e.email = 'Required'
    else if (!/\S+@\S+\.\S+/.test(form.email)) e.email = 'Invalid email'
    if (!form.message.trim()) e.message = 'Required'
    return e
  }

  const submit = async () => {
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }
    setSubmitting(true)
    try {
      await fetch('/api/contact/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      setDone(true)
    } catch {
      alert('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const cls = (err?: string) => cn(
    'w-full px-4 py-3 border rounded text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold text-sm',
    err ? 'border-red-400' : 'border-navy/15'
  )

  if (done) {
    return (
      <div className="text-center py-8">
        <div className="w-14 h-14 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="w-7 h-7 text-gold" />
        </div>
        <h3 className="font-serif text-xl text-navy mb-2">Message sent!</h3>
        <p className="text-navy/50 text-sm">We&apos;ll get back to you as soon as possible.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-navy/50 uppercase tracking-wider block mb-1.5">
            Name <span className="text-red-400">*</span>
          </label>
          <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="Your full name" className={cls(errors.name)} />
          {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name}</p>}
        </div>
        <div>
          <label className="text-xs font-medium text-navy/50 uppercase tracking-wider block mb-1.5">
            Email <span className="text-red-400">*</span>
          </label>
          <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
            placeholder="you@email.com" className={cls(errors.email)} />
          {errors.email && <p className="text-xs text-red-400 mt-1">{errors.email}</p>}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-navy/50 uppercase tracking-wider block mb-1.5">Phone (optional)</label>
          <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
            placeholder="+356 ..." className={cls()} />
        </div>
        <div>
          <label className="text-xs font-medium text-navy/50 uppercase tracking-wider block mb-1.5">Subject</label>
          <input value={form.subject} onChange={e => setForm(p => ({ ...p, subject: e.target.value }))}
            placeholder="General inquiry" className={cls()} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-navy/50 uppercase tracking-wider block mb-1.5">
          Message <span className="text-red-400">*</span>
        </label>
        <textarea rows={5} value={form.message} onChange={e => setForm(p => ({ ...p, message: e.target.value }))}
          placeholder="How can we help you?"
          className={cn(cls(errors.message), 'resize-none')} />
        {errors.message && <p className="text-xs text-red-400 mt-1">{errors.message}</p>}
      </div>

      <button type="button" onClick={submit} disabled={submitting}
        className="w-full py-3 bg-navy text-white rounded font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50">
        {submitting ? 'Sending…' : 'Send Message'}
      </button>
    </div>
  )
}
