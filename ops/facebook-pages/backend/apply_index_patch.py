#!/usr/bin/env python3
"""Anchor patch for the LIVE backend index.js (ARGUS Facebook Pages, 2026-11-14).

Adds exactly two things, nothing else:
  1. the two routers, right after the owner-nexus mount (before the /api/crm catch-all);
  2. the publish worker start, right after startCrons(), wrapped so a failure can
     never stop the backend from starting.

Keeps the file's own line endings (index.js is CRLF in production). Refuses if an
anchor is missing or not unique. Idempotent: does nothing when the marker exists.

  python3 apply_index_patch.py /opt/2906-system/backend/index.js           # patch in place
  python3 apply_index_patch.py /opt/2906-system/backend/index.js --check   # rehearsal only
  python3 apply_index_patch.py IN --out OUT                                # write elsewhere
"""
import sys

MARKER = "ARGUS Facebook Pages (Claude, 2026-11-14)"
MOUNT_ANCHOR = 'app.use("/api/crm/owner-nexus", require("./routes/crmOwnerNexus"))'
MOUNT_LINES = [
    "// " + MARKER + ": agent Facebook Business Page publishing.",
    "// Staff API before the /api/crm catch-all; Meta's signed callbacks on their own prefix.",
    'app.use("/api/crm/facebook-pages", require("./routes/crmFacebookPages"))',
    'app.use("/api/facebook-pages-meta", require("./routes/facebookPagesMeta"))',
]
START_ANCHOR = "  startCrons()"
START_LINES = [
    "  // " + MARKER + ": publish worker + sweeper; never blocks startup.",
    "  try { require('./services/facebookPages/jobs').start() } catch (err) { log.error('facebook-pages worker failed to start', { err: err.message }) }",
]


def patch(text):
    if MARKER in text:
        return text, False
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(eol)
    def find(anchor):
        hits = [i for i, l in enumerate(lines) if l.rstrip("\r") == anchor]
        if len(hits) != 1:
            raise SystemExit("ABORT: anchor %r found %d times" % (anchor, len(hits)))
        return hits[0]
    m = find(MOUNT_ANCHOR)
    lines[m + 1:m + 1] = MOUNT_LINES
    s = find(START_ANCHOR)
    lines[s + 1:s + 1] = START_LINES
    return eol.join(lines), True


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    src = argv[1]
    check = "--check" in argv
    out = argv[argv.index("--out") + 1] if "--out" in argv else src
    with open(src, "r", encoding="utf-8", newline="") as f:
        text = f.read()
    new, changed = patch(text)
    if not changed:
        print("already patched")
        return
    if check:
        print("check ok: anchors found once each; %d lines would be added" % (len(MOUNT_LINES) + len(START_LINES)))
        return
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    print("patched", out)


if __name__ == "__main__":
    main(sys.argv)
