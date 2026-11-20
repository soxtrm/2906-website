#!/usr/bin/env python3
"""Adds the 10-minute website reconcile to cron.js. Usage: cron_patch.py <backend dir> [--check]"""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv
p = os.path.join(root, 'cron.js')
raw = open(p, 'rb').read()
eol = b'\r\n' if b'\r\n' in raw else b'\n'
s = raw.decode('utf-8')
if 'websiteReconcile' in s: print('REFUSE: already applied'); sys.exit(1)
anchor = "  // ── Agent daily digest at 19:00 Malta (17:00 UTC, CEST) ──────────────"
if s.count(anchor) != 1: print('REFUSE: anchor found %dx' % s.count(anchor)); sys.exit(1)
block = """  // Website reconcile, every 10 minutes (2026-11-20): the public website copy follows ARGUS — rented shows
  // as rented, archived / not available / unverified listings leave public search, a changed price is
  // refreshed. A fallback behind the event-driven syncs, with a limit: a run that would change more than 40
  // listings changes nothing and is reported as failed (services/websiteReconcile.js).
  cron.schedule('*/10 * * * *', async () => {
    try {
      const s = await require('./services/websiteReconcile').reconcile({ apply: true })
      if (s.held || s.failed) await beatFail('website_reconcile', 'every 10 min', 10 * 60e3, new Error(s.held ? 'too many changes, nothing applied' : `${s.failed} listing(s) could not be refreshed`))
      else await beatOk('website_reconcile', 'every 10 min', 10 * 60e3, { refresh: s.refresh, rented: s.markRented, hidden: s.hide, shown: s.show, underReviewKept: s.keptUnderReview })
    } catch (err) { log.error('Cron website reconcile error', err); await beatFail('website_reconcile', 'every 10 min', 10 * 60e3, err) }
  })

"""
s = s.replace(anchor, block.replace('\n', eol.decode()) + anchor)
if check: print('check ok'); sys.exit(0)
open(p, 'wb').write(s.encode('utf-8'))
print('patched cron.js')
