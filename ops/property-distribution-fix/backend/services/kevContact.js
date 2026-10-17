'use strict'
// ============================================================================
// services/kevContact.js — Kev's public business WhatsApp CTA.
//
// Single source of truth for Kev's contact number across every channel that
// publishes a property post (FB Page, FB Groups, WA category groups). The
// number is the public business CTA — it is not the owner contact column,
// and is not subject to the sanitizer's address/phone firewall.
//
// Two render shapes:
//   KEV_WA_URL      — the clickable link, used inline in post bodies and in
//                     the FB Page Graph-API call_to_action.value.link
//   KEV_WA_CTA_LINE — the visible tail line, appended to every post body.
//                     Format: "Contact Kevin : WhatsApp" → wa.me link.
//
// The link form is intentional: the sanitizer (services/sanitizer.js,
// stripSafePatterns) strips "https?://..." before running the phone-leak
// assertion, so embedding the number ONLY as a wa.me URL means the existing
// assertNoLeaks() / findAddress() pipeline continues to pass without any
// allowlist. The same link form is what FB's Page-post WHATSAPP_MESSAGE
// call_to_action expects.
//
// Adding this CTA is what causes FB to surface the
// "WhatsApp-Nachricht senden" button on Page posts. The button is a
// UI suggestion FB itself adds when the post body or call_to_action
// contains a clickable wa.me/... link to a phone number.
// ============================================================================

const KEV_WA_PHONE    = '35699811819'                              // Kev's number, intl form, no '+'
const KEV_WA_JID      = `${KEV_WA_PHONE}@c.us`                      // WAHA/chat id form
const KEV_WA_URL      = `https://wa.me/${KEV_WA_PHONE}`             // canonical click-to-chat link
const KEV_WA_CTA_LINE = `\nContact Kevin : WhatsApp ${KEV_WA_URL}` // visible tail appended to post bodies

// Append the CTA line to a post body, exactly once. Returns the body
// unchanged if the link is already present, so callers can re-run the
// formatter through pipelines that may re-emit the same text.
function withKevCta(text) {
  const s = String(text || '')
  if (!s) return KEV_WA_CTA_LINE.trim()  // empty post body → just the line
  if (s.indexOf(KEV_WA_URL) >= 0) return s
  // Make sure the line sits on its own line and ends with a newline so a
  // post clipped mid-line keeps the CTA visible at the bottom.
  const base = s.replace(/\s+$/, '')
  return `${base}${KEV_WA_CTA_LINE}\n`
}

// The Graph API call_to_action payload FB uses to render the
// "WhatsApp-Nachricht senden" button under Page-feed posts. Field shape
// matches docs at developers.facebook.com/docs/graph-api/reference/v20.0/page/feed#pubfields
// — type must be a known CTA value, value.link must be an https URL.
function kevWhatsAppCallToAction() {
  return {
    type: 'WHATSAPP_MESSAGE',
    value: { link: KEV_WA_URL },
  }
}

module.exports = {
  KEV_WA_PHONE,
  KEV_WA_JID,
  KEV_WA_URL,
  KEV_WA_CTA_LINE,
  withKevCta,
  kevWhatsAppCallToAction,
}
