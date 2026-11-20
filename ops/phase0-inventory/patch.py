#!/usr/bin/env python3
"""Phase 0 inventory: no default property type; website review route. Usage: patch.py <backend dir> [--check]
Exact anchors; nothing is written unless every anchor is found exactly once."""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv
NON_RESIDENTIAL = "['commercial', 'office', 'shop', 'retail', 'garage', 'warehouse', 'room', 'land']"
EDITS = {
    'handlers/upload.js': [
        ("  const ptype = intakeMode === 'commercial' ? 'commercial' : String(p.type || 'apartment').toLowerCase()\n",
         "  // 2026-11-20: never \"apartment\" by default. The kind is what the listing's own text names; when it names\n"
         "  // none, or two different ones, it stays empty for the reviewer (services/propertyTypeResolver.js).\n"
         "  const _readType = String(p.type || '').toLowerCase().trim()\n"
         "  const ptype = intakeMode === 'commercial' ? 'commercial'\n"
         "    : " + NON_RESIDENTIAL + ".includes(_readType) ? _readType\n"
         "    : require('../services/propertyTypeResolver').resolve(_readType, rawText).type\n"),
    ],
    'handlers/uploadListing.js': [
        ("  const ptype = String(p.type || 'apartment').toLowerCase()\n",
         "  // 2026-11-20: never \"apartment\" by default (services/propertyTypeResolver.js)\n"
         "  const _readType = String(p.type || '').toLowerCase().trim()\n"
         "  const ptype = " + NON_RESIDENTIAL + ".includes(_readType) ? _readType\n"
         "    : require('../services/propertyTypeResolver').resolve(_readType, cleanText).type\n"),
        ("    \"type\": \"apartment\" | \"penthouse\" | \"house\" | \"maisonette\" | \"commercial\",\n",
         "    \"type\": \"studio\" | \"apartment\" | \"penthouse\" | \"maisonette\" | \"house\" | \"villa\" | \"commercial\" | \"\",\n"),
        ("Use 0 / null / empty string for missing fields. Phones array as digits only",
         "type: the kind of property the message itself names (a studio is \"studio\", a townhouse or house of character is \"house\", a villa or bungalow is \"villa\"). If the message does not name the kind, answer \"\"; never assume \"apartment\".\n"
         "Use 0 / null / empty string for missing fields. Phones array as digits only"),
    ],
    'index.js': [
        ("app.use(\"/api/crm/sync-inbox\", require(\"./routes/crmSyncInbox\"))\n",
         "app.use(\"/api/crm/sync-inbox\", require(\"./routes/crmSyncInbox\"))\n"
         "app.use(\"/api/crm/website-review\", require(\"./routes/crmWebsiteReview\"))\n"),
    ],
}
out = {}
for rel, edits in EDITS.items():
    raw = open(os.path.join(root, rel), 'rb').read()
    crlf = b'\r\n' in raw
    s = raw.decode('utf-8')
    if crlf: s = s.replace('\r\n', '\n')
    if 'propertyTypeResolver' in s or 'crmWebsiteReview' in s: print('REFUSE: %s already patched' % rel); sys.exit(1)
    for i, (a, b) in enumerate(edits):
        if s.count(a) != 1: print('REFUSE: %s edit %d anchor found %dx' % (rel, i + 1, s.count(a))); sys.exit(1)
        s = s.replace(a, b)
    out[rel] = s.replace('\n', '\r\n') if crlf else s
if check: print('check ok'); sys.exit(0)
for rel, s in out.items(): open(os.path.join(root, rel), 'wb').write(s.encode('utf-8'))
print('patched: ' + ', '.join(sorted(out)))
