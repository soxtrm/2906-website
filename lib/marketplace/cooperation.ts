// Co-agency terms for the NEXUS STUDIOS Exchange (2026-11-21).
// Founder rule: commission models are configurable only; nothing is shown, billed or implied until the listing
// agency has agreed the terms in writing. Every figure must spell out its basis (what the percentage is of,
// who pays, when it is due). An agency with no entry here shows "terms not published".
//
// To publish terms: add an entry with the written agreement's reference and date, then release the website.
import type { Cooperation } from './model'

type Terms = Extract<Cooperation, { status: 'confirmed' }>

export const AGREED_TERMS: Record<string, Terms | undefined> = {
  // '2906': { status: 'confirmed', headline: '…', basis: '…', conditions: ['…'], agreedAt: 'YYYY-MM-DD', reference: '…' },
}

export const NOT_PUBLISHED: Cooperation = {
  status: 'not_published',
  note: 'Co-agency terms are agreed per agency. None are published for this listing yet: contact the listing agency.',
}

export const cooperationFor = (agencyKey: string | null): Cooperation => (agencyKey && AGREED_TERMS[agencyKey]) || NOT_PUBLISHED
