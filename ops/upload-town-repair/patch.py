#!/usr/bin/env python3
"""Uploads keep their town when the AI text reader is down. Usage: patch.py <backend dir> [--check]

handlers/uploadListing.js: the emergency reader only took a town from a "Location:" line. Agents write it
in the headline ("MODERN APARTMENT – SLIEMA") or on the second line ("Sliema – Amery Street"), so 92 listings
were saved without a town. The fallback now reads the first lines for a name the locality resolver knows.
Exact anchors; nothing is written unless every anchor is found once."""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv
p = os.path.join(root, 'handlers/uploadListing.js')
raw = open(p, 'rb').read()
if b'\r\n' in raw: print('REFUSE: CRLF file'); sys.exit(1)
s = raw.decode('utf-8')
if 'localityFromText' in s: print('REFUSE: already applied'); sys.exit(1)

EDITS = [
    ("async function extractListing(cleanedText, { allowNoOwner = false } = {}) {\n",
     """// The town as the text itself gives it, for when the AI reader is unavailable: the first lines, split at
// dashes and commas, plus the last words of a headline. Only a name the locality resolver knows counts.
async function localityFromText(text) {
  const clean = s => stripEmoji(String(s || '')).replace(/[*_!"“”()\\[\\]]+/g, ' ').replace(/\\s+/g, ' ').trim()
  const lines = String(text || '').split('\\n').map(clean).filter(Boolean).slice(0, 4)
  const seen = new Set()
  for (const line of lines) {
    const frags = line.split(/\\s[–—-]\\s|,|\\||\\/|\\bnear\\b|\\bin\\b|\\bnext to\\b|\\bat\\b/i).map(x => x.trim()).filter(x => x.length >= 3 && x.length <= 40)
    const words = line.split(' ')
    const tail = [3, 2, 1].filter(n => words.length > n).map(n => words.slice(-n).join(' '))
    const head = [3, 2, 1].filter(n => words.length >= n).map(n => words.slice(0, n).join(' '))
    for (const c of [...frags.slice().reverse(), ...frags, ...tail, ...head]) {
      if (seen.has(c)) continue
      seen.add(c)
      try { const town = await matchLocation(c); if (town) return town } catch { return '' }
    }
  }
  return ''
}
async function withTextLocality(listing, text) {
  if (listing && listing.property && !String(listing.property.location || '').trim()) {
    listing.property.location = await localityFromText(text)
  }
  return listing
}

async function extractListing(cleanedText, { allowNoOwner = false } = {}) {
"""),
    ("  if (!ai) return deterministicListingFallback(cleanedText) || (allowNoOwner ? explicitFactsListing(cleanedText) : null)\n",
     "  if (!ai) return withTextLocality(deterministicListingFallback(cleanedText) || (allowNoOwner ? await explicitFactsListing(cleanedText) : null), cleanedText)\n"),
    ("  if (fallback) log.warn('uploadListing: Gemini unavailable — deterministic explicit-facts fallback used')\n  return fallback\n",
     "  if (fallback) log.warn('uploadListing: Gemini unavailable — deterministic explicit-facts fallback used')\n  return withTextLocality(fallback, cleanedText)\n"),
]
for a, b in EDITS:
    if s.count(a) != 1: print('REFUSE: anchor found %dx: %r' % (s.count(a), a[:60])); sys.exit(1)
    s = s.replace(a, b)
if check: print('check ok'); sys.exit(0)
open(p, 'wb').write(s.encode('utf-8'))
print('patched handlers/uploadListing.js')
