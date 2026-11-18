#!/usr/bin/env python3
"""Weekly owner recheck (2026-11-18): exact-anchor patches on the live backend files.
Usage: apply_patches.py <backend_root> [--check]
Refuses on any anchor mismatch; keeps each file's line endings; idempotent (marker)."""
import sys, os

ROOT = sys.argv[1]
CHECK = '--check' in sys.argv
MARK = 'recheck7d-20261118'

P = {}
P['cron.js'] = [
    ("      const result = await require('./services/availabilityReachout').runScheduledInactivity({\n        trigger: 'daily_cron',\n      })",
     "      // " + MARK + ": weekly owner recheck (one message per owner, never Sunday, any working account)\n"
     "      const result = await require('./services/ownerRecheck7d').runScheduled({\n        trigger: 'daily_cron',\n      })"),
]
P['services/availability.js'] = [
    # 1. inbound hook, before the portfolio reply consumer
    ("    // A reply to the fixed portfolio list is command-like input. Consume it\n",
     "    // " + MARK + ": weekly recheck list replies, viewings/price follow-up, quiet\n"
     "    // \"no\" chats marked read, owner answers to agent questions = still available.\n"
     "    try {\n"
     "      const recheck = await require('./ownerRecheck7d').handleInbound({ payload, session, text: t, senderPhone, chatId })\n"
     "      if (recheck && recheck.handled) return true\n"
     "    } catch (err) {\n"
     "      log.warn('[av] weekly recheck reply handling failed', { err: err.message })\n"
     "    }\n\n"
     "    // A reply to the fixed portfolio list is command-like input. Consume it\n"),
    # 2. owner-wide nothing available: close the recheck conversation, keep the chat read
    ("      if (wide.handled) {\n",
     "      if (wide.handled) {\n"
     "        // " + MARK + "\n"
     "        require('./ownerRecheck7d').onOwnerWideUnavailable({ ownerId: wide.ownerId, session, chatId }).catch(() => {})\n"),
    # 3. implicit availability
    ("  if (verdict.status === 'unclear' || verdict.status === 'replied_unclear') {\n",
     "  // " + MARK + ": an owner who answers us without saying it is rented is telling\n"
     "  // us it is still on the market (Kev). Single open listing only, never a guess across units.\n"
     "  if (verdict.status === 'unclear' && distinctProps.length <= 1 && require('./ownerRecheck7d').impliesAvailable(text)) {\n"
     "    log.info('[av] owner answered without a rented/negative signal - read as still available', { checkId: check.id, ref: check.ref })\n"
     "    verdict = { status: 'replied_available', via: 'implicit_answer' }\n"
     "  }\n"
     "  if (verdict.status === 'unclear' || verdict.status === 'replied_unclear') {\n"),
    # 4. robot yes: our own follow-up instead of the agent-style viewing/entrance questions
    ("  const followUp = decideStillAvailableFollowUp({ needsEntranceDate, needsViewingWindow })\n",
     "  // " + MARK + ": the weekly robot asks viewings -> wishes -> price itself\n"
     "  const followUp = check.source === 'auto_inactivity'\n"
     "    ? { asked: 'none', text: null }\n"
     "    : decideStillAvailableFollowUp({ needsEntranceDate, needsViewingWindow })\n"),
    ("  log.info('[av] still-available flow complete', { checkId: check.id, ref, listingReplies: posted, asked: followUp.asked })\n",
     "  if (check.source === 'auto_inactivity') {\n"
     "    try { await require('./ownerRecheck7d').afterSingleAvailable(check, { ownerSession, ownerChat }) }\n"
     "    catch (err) { log.warn('[av] weekly recheck follow-up failed', { checkId: check.id, err: err.message }) }\n"
     "  }\n"
     "  log.info('[av] still-available flow complete', { checkId: check.id, ref, listingReplies: posted, asked: followUp.asked })\n"),
    # 5. do not wait for a dead source account
    ("  return { session: null, dbSession: source.db_session, waiting: true, reason: 'source_offline', tried: [source.db_session] }\n}\n",
     "  // " + MARK + ": do not insist on the old account. Another account that talked to\n"
     "  // this owner, else an outreach account, sends instead of waiting (Kev).\n"
     "  for (const other of rows.slice(1)) {\n"
     "    let l2 = null\n"
     "    try { l2 = await resolveLiveSession(other.db_session) } catch { l2 = null }\n"
     "    if (l2) return { session: l2, dbSession: other.db_session, lastTouch: other.last_touch, reason: 'source_offline_other_history', tried: [source.db_session] }\n"
     "  }\n"
     "  for (const name of FIRST_CONTACT_ACCOUNTS) {\n"
     "    let l3 = null\n"
     "    try { l3 = await resolveLiveSession(name) } catch { l3 = null }\n"
     "    if (l3) return { session: l3, dbSession: name, reason: 'source_offline_outreach_account', tried: [source.db_session] }\n"
     "  }\n"
     "  return { session: null, dbSession: source.db_session, waiting: true, reason: 'source_offline', tried: [source.db_session] }\n}\n"),
]
P['waha.js'] = [
    ("async function markChatUnread(session, phone) {\n  try {\n",
     "async function markChatUnread(session, phone) {\n"
     "  // " + MARK + ": a plain \"no / nothing / sorry\" with no data in it stays read.\n"
     "  try {\n"
     "    if (await require('./services/ownerRecheck7d').shouldStayRead(session, phone)) {\n"
     "      await sendSeen(session, String(phone).includes('@') ? phone : `${phone}@c.us`)\n"
     "      return\n"
     "    }\n"
     "  } catch { /* fall through to the old behaviour */ }\n"
     "  try {\n"),
]

ok = True
out = {}
for rel, reps in P.items():
    path = os.path.join(ROOT, rel)
    s = open(path, encoding='utf-8', newline='').read()
    if MARK in s:
        print(f'{rel}: already patched'); continue
    nl = '\r\n' if '\r\n' in s else '\n'
    for a, b in reps:
        a2, b2 = a.replace('\n', nl), b.replace('\n', nl)
        n = s.count(a2)
        if n != 1:
            print(f'ANCHOR MISMATCH {rel}: found {n}x: {a[:70]!r}'); ok = False; continue
        s = s.replace(a2, b2)
    out[path] = s
if not ok:
    sys.exit(1)
for path, s in out.items():
    if CHECK: print(f'check ok: {path}')
    else:
        open(path, 'w', encoding='utf-8', newline='').write(s); print(f'patched: {path}')
