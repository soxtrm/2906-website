'use strict'

const DISCRIMINATION_RE = /\b(?:no|not|never|only|prefer(?:s|red)?|won't|will not|don't|do not|refus(?:e|es|ed)|avoid)\b[^.!?\n]{0,100}\b(?:indians?|pakistanis?|arabs?|africans?|black|white|muslims?|christians?|jewish|jews?|gay|lesbian|trans(?:gender)?|disabled|pregnant|single mother|nationalit(?:y|ies)|religion|race|ethnic(?:ity)?)\b/i
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const WHATSAPP_ID_RE = /\b\d{7,20}@(c\.us|s\.whatsapp\.net|g\.us)\b/gi
const PHONE_RE = /(?<![\d+])(?:(?:\+|00)\s?\d{1,3}[\s().-]*)?(?:\d[\s().-]*){7,15}(?!\d)/g
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi
const PAYMENT_RE = /\b(?:\d[ -]*?){13,19}\b/g
const ID_DOCUMENT_RE = /\b(?:passport|identity card|id card|residence permit|social security|tax id)\b\s*(?:no\.?|number|#|:)?\s*[A-Z0-9-]{4,}/gi

function escapeRe(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function replaceKnown(text, values, label, labels) {
  let out = text
  for (const raw of values || []) {
    const value = String(raw || '').trim()
    if (value.length < 3) continue
    const re = new RegExp(`\\b${escapeRe(value)}\\b`, 'gi')
    if (re.test(out)) { labels.add(label);out=out.replace(re,`[${label}]`) }
  }
  return out
}
function replacePattern(text, pattern, replacement, label, labels) {
  pattern.lastIndex=0
  if (!pattern.test(text)) return text
  pattern.lastIndex=0;labels.add(label)
  return text.replace(pattern,replacement)
}
function restrictDiscriminatoryClauses(text, labels=new Set()) {
  const chunks=String(text||'').split(/(?<=[.!?\n])\s+/)
  let restricted=false
  const safe=chunks.map(chunk=>{ if(!DISCRIMINATION_RE.test(chunk)) return chunk;restricted=true;return '[RESTRICTED — COMPLIANCE REVIEW]' }).join(' ')
  if(restricted) labels.add('COMPLIANCE RESTRICTED')
  return { text:safe,restricted,labels:[...labels] }
}
function redactBusinessMessage(body,privateValues={}) {
  const labels=new Set()
  const restricted=restrictDiscriminatoryClauses(body,labels)
  let text=restricted.text
  text=replaceKnown(text,privateValues.names,'NAME REDACTED',labels)
  text=replaceKnown(text,privateValues.addresses,'PRIVATE ADDRESS REDACTED',labels)
  text=replaceKnown(text,privateValues.phones,'PHONE REDACTED',labels)
  text=replaceKnown(text,privateValues.emails,'EMAIL REDACTED',labels)
  text=replacePattern(text,WHATSAPP_ID_RE,'[WHATSAPP ID REDACTED]','WHATSAPP ID REDACTED',labels)
  text=replacePattern(text,EMAIL_RE,'[EMAIL REDACTED]','EMAIL REDACTED',labels)
  text=replacePattern(text,IBAN_RE,'[BANK DETAILS REDACTED]','BANK DETAILS REDACTED',labels)
  text=replacePattern(text,ID_DOCUMENT_RE,'[IDENTITY DOCUMENT REDACTED]','IDENTITY DOCUMENT REDACTED',labels)
  text=replacePattern(text,PHONE_RE,'[PHONE REDACTED]','PHONE REDACTED',labels)
  text=replacePattern(text,PAYMENT_RE,'[PAYMENT DETAILS REDACTED]','PAYMENT DETAILS REDACTED',labels)
  return { text:text.trim(),labels:[...labels],restricted:restricted.restricted }
}
function agencyMatches(viewerAgencyId,resourceAgencyId) { return Number(viewerAgencyId)>0 && Number(viewerAgencyId)===Number(resourceAgencyId) }

module.exports={ redactBusinessMessage,restrictDiscriminatoryClauses,agencyMatches }
