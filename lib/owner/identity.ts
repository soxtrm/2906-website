// Owner sign-up and linking to ARGUS (Kev, 19 Nov 2026).
//
// Anyone can register with email and password. Then they add their mobile
// number and confirm it with a code sent to that number (WhatsApp, SMS as
// fallback). Only a CONFIRMED number is matched against the owners ARGUS
// already knows; on a match their homes appear in the workspace at once.
// Typing someone else's number never links anything: without the code there
// is no match.
//
// What the owner sees from ARGUS is a whitelist: name and their homes. Notes,
// ratings, call history and anything else agents wrote about the owner stay
// inside ARGUS. What the owner fills in (company, address, ...) flows back to
// ARGUS only into fields that are still empty there, and every change is logged.
// Pure functions, no I/O, so the backend can use the same rules.

/** "+356 7900 1234", "0035679001234", "79001234" (Malta) → "35679001234" */
export function normalizePhone(raw: string, defaultCountry = '356'): string | null {
  let d = (raw || '').replace(/[^\d+]/g, '')
  if (d.startsWith('+')) d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.length === 8 && defaultCountry === '356') d = `356${d}`
  d = d.replace(/\D/g, '')
  if (d.length < 8 || d.length > 15) return null
  return d
}

/** What ARGUS knows about an owner, as stored there (only some of it may be shown). */
export interface ArgusOwnerRecord {
  contactId: number
  phone: string
  name?: string | null
  email?: string | null
  propertyIds: number[]
  // internal, never shown to the owner:
  internalNotes?: string | null
  rating?: string | null
  doNotContact?: boolean
}

/** The part of an ARGUS record the owner may see after confirming the number. */
export interface OwnerView { contactId: number; name: string | null; propertyIds: number[] }

export function ownerView(r: ArgusOwnerRecord): OwnerView {
  return { contactId: r.contactId, name: r.name || null, propertyIds: [...r.propertyIds] }
}

/** Match a confirmed number against ARGUS. Several records with the same number are merged. */
export function matchOwner(records: ArgusOwnerRecord[], phone: string, confirmed: boolean): OwnerView[] {
  if (!confirmed) return []
  const n = normalizePhone(phone)
  if (!n) return []
  return records.filter(r => normalizePhone(r.phone) === n).map(ownerView)
}

// ── confirmation code ────────────────────────────────────────────────────────
export interface CodeState { phone: string; code: string; sentAt: number; tries: number }
export const CODE_TTL_MS = 10 * 60_000
export const CODE_MAX_TRIES = 5

export function checkCode(st: CodeState | null, entered: string, now: number): 'ok' | 'wrong' | 'expired' | 'locked' | 'none' {
  if (!st) return 'none'
  if (st.tries >= CODE_MAX_TRIES) return 'locked'
  if (now - st.sentAt > CODE_TTL_MS) return 'expired'
  return entered.replace(/\D/g, '') === st.code ? 'ok' : 'wrong'
}

// ── password ─────────────────────────────────────────────────────────────────
export function passwordProblems(pw: string, email = ''): string[] {
  const out: string[] = []
  if (pw.length < 10) out.push('at least 10 characters')
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) out.push('letters and a number')
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 2) out.push('not your email name')
  return out
}

// ── details the owner may give (used on contracts) ─────────────────────────
export interface OwnerDetails {
  legalName?: string
  idNumber?: string            // ID card or passport, only for contracts
  companyName?: string
  companyNumber?: string
  vatNumber?: string
  address?: string
  postcode?: string
  locality?: string
  idVerified?: 'none' | 'pending' | 'verified'
}

export const DETAIL_LABEL: Record<Exclude<keyof OwnerDetails, 'idVerified'>, string> = {
  legalName: 'Full legal name', idNumber: 'ID card or passport number', companyName: 'Company name',
  companyNumber: 'Company registration number', vatNumber: 'VAT number', address: 'Address', postcode: 'Postcode', locality: 'Locality',
}

/**
 * What flows back into ARGUS: only fields ARGUS does not have yet. A value
 * ARGUS already has is never overwritten from the owner side; a difference is
 * returned as a conflict for an agent to look at.
 */
export function backfill(argus: Partial<OwnerDetails>, owner: Partial<OwnerDetails>) {
  const fill: Partial<OwnerDetails> = {}
  const conflicts: { field: keyof OwnerDetails; argus: string; owner: string }[] = []
  for (const k of Object.keys(owner) as (keyof OwnerDetails)[]) {
    const o = (owner[k] || '').toString().trim()
    if (!o || k === 'idVerified') continue
    const a = (argus[k] || '').toString().trim()
    if (!a) (fill as Record<string, string>)[k] = o
    else if (a.toLowerCase() !== o.toLowerCase()) conflicts.push({ field: k, argus: a, owner: o })
  }
  return { fill, conflicts }
}

/** how complete the contract details are, for the friendly progress ring */
export function detailsProgress(d: OwnerDetails, company: boolean) {
  const need: (keyof OwnerDetails)[] = company ? ['legalName', 'idNumber', 'companyName', 'companyNumber', 'address', 'locality'] : ['legalName', 'idNumber', 'address', 'locality']
  const done = need.filter(k => (d[k] || '').toString().trim()).length
  return { done, total: need.length }
}

// ── verification by WhatsApp message (Kev, 19 Nov 2026) ──────────────────────
// The owner taps "Verify with WhatsApp": WhatsApp opens with a prepared message
// to ARGUS Main ("SYNC verify K7P2QX"). When ARGUS Main receives it, the sender
// number is the confirmed number: nobody can send from a phone that is not
// theirs, and the owner does not even type the number. The token is one-time,
// valid 15 minutes, tied to the account that asked for it.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
export const WA_TOKEN_TTL_MS = 15 * 60_000

export function waToken(rand: () => number = Math.random) {
  return Array.from({ length: 6 }, () => TOKEN_ALPHABET[Math.floor(rand() * TOKEN_ALPHABET.length)]).join('')
}
export const waVerifyText = (token: string) => `SYNC verify ${token}`

/** reads the token out of an incoming WhatsApp text, forgiving spacing and case */
export function parseWaVerify(text: string): string | null {
  const m = (text || '').toUpperCase().match(/SYNC\s*(?:VERIFY)?\s*[:#-]?\s*([A-Z2-9]{6})\b/)
  return m ? m[1] : null
}

/** wa.me link that opens WhatsApp with the message ready to send */
export function waLink(mainNumber: string, token: string) {
  const n = normalizePhone(mainNumber)
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(waVerifyText(token))}` : null
}

export type WaPending = { token: string; createdAt: number; accountEmail: string }
/** what the ARGUS Main webhook does with an incoming message */
export function acceptWaVerify(p: WaPending | null, fromPhone: string, text: string, now: number): { ok: true; phone: string } | { ok: false; reason: 'no_token' | 'expired' | 'mismatch' | 'bad_number' } {
  if (!p) return { ok: false, reason: 'no_token' }
  if (now - p.createdAt > WA_TOKEN_TTL_MS) return { ok: false, reason: 'expired' }
  if (parseWaVerify(text) !== p.token) return { ok: false, reason: 'mismatch' }
  const phone = normalizePhone(fromPhone)
  if (!phone) return { ok: false, reason: 'bad_number' }
  return { ok: true, phone }
}
