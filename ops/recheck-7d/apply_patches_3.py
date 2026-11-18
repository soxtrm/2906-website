#!/usr/bin/env python3
"""2026-11-18 (9747): a delayed owner reply/reaction that failed because the WhatsApp
session was briefly down is retried (3, 6, 9 min) instead of being lost."""
import sys, os
ROOT = sys.argv[1]; CHECK = '--check' in sys.argv; MARK = 'send-retry-20261118'
rel = 'services/availability.js'
A = "  // A relay send has to be logged against its thread, or the \"did Kev type this\n"
B = ("  // " + MARK + ": the session was briefly down (9747: 👍 + reply lost) -> try again later.\n"
     "  // The pre-send gate above runs again on every retry, so a later human reply still wins.\n"
     "  if ((!out.sent && text && out.error) || (!text && reactTo && reactEmoji && !out.reacted)) {\n"
     "    const transient = !out.error || /session status|not as expected|ECONNRE|timed? ?out|socket hang up|\\b50[234]\\b|SCAN_QR|STARTING/i.test(out.error)\n"
     "    const next = (data.retry || 0) + 1\n"
     "    if (transient && next <= 3) {\n"
     "      try {\n"
     "        await addJob(humanDelay.QUEUE_NAME, { ...data, retry: next },\n"
     "          { jobId: `${label || 'owner'}-retry-${next}-${Date.now()}`, delay: next * 3 * 60_000 })\n"
     "        out.retryQueued = next\n"
     "      } catch (err) { log.warn('[av] delayed owner send retry could not be queued', { label, err: err.message }) }\n"
     "    }\n"
     "  }\n" + A)
path = os.path.join(ROOT, rel); s = open(path, encoding='utf-8', newline='').read()
if MARK in s: print('already patched'); sys.exit(0)
nl = '\r\n' if '\r\n' in s else '\n'
a2, b2 = A.replace('\n', nl), B.replace('\n', nl)
if s.count(a2) != 1: print('ANCHOR MISMATCH', s.count(a2)); sys.exit(1)
s = s.replace(a2, b2)
if CHECK: print('check ok')
else: open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)
