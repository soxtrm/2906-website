#!/usr/bin/env python3
"""Facebook browser profile lock + backlog watchdog (2026-11-21). Usage: patch.py <backend dir> [--check]

services/fbBrowser.js
  - the stale-lock recovery never ran for Chromium's "profile appears to be in use by another Chromium process ... on
    another computer" message (it says process_singleton, the check looked for ProcessSingleton). Now recognised.
  - a lock written by ANOTHER host (an earlier container of the same volume) can never belong to a process of this
    container: remove the lock files without touching any process. Same-host locks keep the old, careful rule
    (kill only a process whose command line names OUR profile).
services/fbShareBacklog.js
  - watchdogTick re-armed itself unconditionally, so every boot that raced an in-flight tick added a chain
    (6 chains found on 21 Nov). It now re-arms only when no other watchdog is waiting -> collapses to one.
  - a run paused for more than 24 h is NOT resumed automatically (and no browser is launched for it): restarting
    group posting after a long stop is the operator's decision (!fbbacklog). Shorter stalls keep the old self-heal.
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'services/fbBrowser.js': [
        ("  return /ProcessSingleton|SingletonLock/i.test(String(err && err.message))\n",
         "  return /ProcessSingleton|process_singleton|SingletonLock|profile appears to be in use/i.test(String(err && err.message))\n"),
        ("function recoverFromStaleLock() {\n  const pid = singletonLockPid()\n  if (pid) {\n",
         "function recoverFromStaleLock() {\n"
         "  // A lock written by another host (an earlier container on the same volume) cannot belong to a process in this\n"
         "  // container: drop the lock files, touch no process.\n"
         "  let lockHost = null\n"
         "  try { lockHost = (fs.readlinkSync(path.join(PROFILE_DIR, 'SingletonLock')).match(/^(.*)-\\d+$/) || [])[1] || null } catch {}\n"
         "  const foreign = !!lockHost && lockHost !== require('os').hostname()\n"
         "  if (foreign) log.warn('fbBrowser: profile lock left by another container, removing the lock files only', { lockHost })\n"
         "  const pid = foreign ? null : singletonLockPid()\n"
         "  if (pid) {\n"),
    ],
    'services/fbShareBacklog.js': [
        ("  const run = r.rows[0]\n  if (!run) return { skipped: 'nothing_stalled' }\n",
         "  const run = r.rows[0]\n  if (!run) return { skipped: 'nothing_stalled' }\n"
         "  // Paused for more than a day: restarting group posting after a long stop is the operator's call\n"
         "  // (!fbbacklog), not the watchdog's. Stay paused and do not even open the browser for it.\n"
         "  if (new Date(run.updated_at).getTime() < Date.now() - 24 * 3600e3) return { stayPaused: 'stale_run', runId: run.id }\n"),
        ("    if (await isQueueReachable(QUEUE_NAME)) {\n      await addJob(QUEUE_NAME, { backlogWatchdog: true }, { delay: WATCHDOG_EVERY_MS })\n",
         "    if (await isQueueReachable(QUEUE_NAME)) {\n"
         "      // one chain only: if another watchdog is already waiting, this one ends here (duplicates collapse)\n"
         "      const others = (await QUEUES[QUEUE_NAME].getDelayed()).filter(j => j && j.data && j.data.backlogWatchdog)\n"
         "      if (!others.length) await addJob(QUEUE_NAME, { backlogWatchdog: true }, { delay: WATCHDOG_EVERY_MS })\n"),
    ],
}
plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}'); continue
        hit = None
        for nl in ('\n', '\r\n'):
            o, n = old.replace('\n', nl), new.replace('\n', nl)
            c = text.count(o)
            if c == 1: hit = (o, n); break
            if c > 1: print(f'ANCHOR {c}x in {rel}: {old[:70]!r}'); sys.exit(1)
        if not hit: print(f'ANCHOR 0x in {rel}: {old[:70]!r}'); sys.exit(1)
        text = text.replace(hit[0], hit[1])
    plan.append((path, text))
if check: print('anchors ok'); sys.exit(0)
for path, text in plan:
    open(path, 'wb').write(text.encode('utf-8')); print('patched', path)
