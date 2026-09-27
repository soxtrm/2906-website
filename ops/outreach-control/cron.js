const cron = require('node-cron')
const log = require('./logger')
const db = require('./db')
const config = require('./config')
const waha = require('./waha')
const { sendAlert } = require('./telegram')
const { runMatching } = require('./services/matcher')
const { ensureAllSessionsWorking } = require('./waha')
const replyMonitor = require('./services/replyMonitor')
const { sendClientDigest } = require('./services/clientDigest')
const { syncToSheets } = require('./services/sheetsSync')
const { scanAllChats } = require('./services/warmScanner')
const { formatReminderBriefing } = require('./services/reminderService')
const reminderScheduler = require('./services/reminderScheduler')
// Single source of truth for the morning brief and the hourly health tick.
// active_properties semantics (current public inventory vs legacy) are pinned
// by test/healthStats.test.js. Do NOT inline any COUNT() for these counts
// here — route through services/healthStats.js so the endpoint and the cron
// can never drift apart.
const { getDailyStats, runHealthTickJob } = require('./services/healthStats')
// Cookie-health wrapper: pure helper in services/fbCookieHealth.js, this cron
// tick is the only side-effecting layer.
const { runCookieHealthTick: runFbCookieHealthTick } = require('./services/fbCookieHealth')
const { refreshOnce: runFbCookieRefresh } = require('./services/fbCookieRefresher')
const { processUnenrichedIfFbLive } = require('./services/fbOwnerSave')
const reminderPoster = require('./services/reminderPoster')
// >60h availability auto-reachout. Every safety rail — the 08:00–20:00 Malta
// contact window, the AVAILABILITY_REACHOUT_DAILY_CAP, the per-property
// same-day guard and the AVAILABILITY_AUTO_REACHOUT arming flag — lives inside
// the service. Without the flag scanAndReachOut is a dry run that sends
// nothing, so the tick below is safe to register unconditionally.
// Tomorrow-morning warm-burst queue (06:00 UTC = 08:00 Malta). Self-contained;
// registers a daily cron schedule that picks the 50 oldest-untouched warm
// contacts (20d–1y window, per-contact most-recent account) and sends the
// Jasmine warm-burst body. Dry-runs unless WARM_BURST_FIRE=1 is set in env.
require('./scripts/warm_burst_morning_cron')
// Daily recheck runner (05:00 UTC = 07:00 Malta, AXIS B cadence + cross-account
// cooldown). Dry-run default; only fires when RECHECK_FIRE=1 is set in env.
require('./scripts/recheck_runner_cron')
// WAHA session health watcher — alerts Kev via Telegram when any session
// goes FAILED or SCAN_QR_CODE. Every 30 min. No auto-restart (QR scan needs
// operator). Self-registers via cron.schedule when imported.
require('./scripts/waha_session_watcher')
// Planned Message flush (Kev, 2026-08-28) — every 2 min, sends any
// owner_contact_log row whose scheduled_for has arrived. Also fixes the
// pre-existing "queued outside the contact window" case, which nothing was
// ever flushing before this file existed. Self-registers when imported.
require('./scripts/planned_message_flush_cron')

function startCrons() {
  // Day-11 market review: creates one internal review card per qualifying
  // newly listed property. No owner message is generated or sent here.
  cron.schedule('15 7 * * *', async () => {
    try {
      const result = await require('./services/marketFollowupReview').ensureMarketFollowupTasks()
      if (result.created) log.info('Cron: day-11 market reviews prepared', result)
    } catch (err) {
      log.error('Cron day-11 market review error', err)
    }
  })

  // Prepare the next account queue two hours before its 24h15 eligibility
  // boundary. This creates an editable saved draft only; it never arms or
  // sends and therefore remains safe while owner automation is REVIEW_ONLY.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await require('./services/outreachPlanner').prepareDueAccountPlans()
      if (result.prepared.length) log.info('Cron: outreach drafts prepared two hours ahead', result)
    } catch (err) {
      log.error('Cron outreach two-hour preparation error', err)
    }
  })

  // ── ARGUS Agent Layer scheduled messages — every minute (Kev, 2026-09-17)
  // Each message gets its own mandatory pre-send recheck inside
  // services/scheduledMessages.js (WA session health, property still
  // active, recipient not marked unreachable, not already answered, not a
  // duplicate) -- this tick just finds what's due, it never sends blindly.
  cron.schedule('* * * * *', async () => {
    try {
      const { processed } = await require('./services/scheduledMessages').processDue()
      if (processed) log.info('Cron: scheduled messages processed', { processed })
    } catch (err) {
      log.error('Cron scheduled-messages error', err)
    }
  })

  // ── Matching every 30 minutes — PAUSED ───────────────────────
  // cron.schedule('*/30 * * * *', async () => {
  //   log.info('Cron: matcher run')
  //   try {
  //     await runMatching({})
  //   } catch (err) {
  //     log.error('Cron matcher error', err)
  //   }
  // })

  // ── Client digest at 07:00 ───────────────────────────────────────
  cron.schedule('0 7 * * *', async () => {
    log.info('Cron: client digest')
    try {
      await sendClientDigest()
    } catch (err) {
      log.error('Cron client digest error', err)
    }
  })

  // ── Continuous Page direct-sharing — throttled 2026-08-21 ────
  // Facebook flagged the account for suspected automation. The previous
  // schedule was */12 * * * * — 24/7, zero jitter, ~120 identical-cadence
  // ticks/day, always landing on the same handful of groups. That is a
  // textbook bot signature. Replaced with 3 daytime anchors, each jittered
  // +/- 40 min and gated to Malta waking hours, so the real fire time is
  // never the same twice and nothing runs overnight. Kev asked for
  // "3-4/day" — this lands at up to 3. Do not widen this without Kev.
  cron.schedule('0 7,12,16 * * *', () => {
    const jitterMs = (Math.random() * 80 - 40) * 60 * 1000 // +/- 40 min
    setTimeout(async () => {
      const maltaHour = (new Date().getUTCHours() + 2) % 24 // CEST approx
      if (maltaHour < 8 || maltaHour > 20) return
      try {
        const r = await require('./services/fbContinuous').tick()
        log.info('Cron FB continuous direct-share', r)
      } catch (err) { log.error('Cron FB continuous direct-share error', err) }
    }, Math.max(0, jitterMs))
  })

  // ── History-sync ALL sessions nightly at 04:00 ───────────────
  // Force-sync every whatsapp_accounts row (including inactive ones like
  // Kevsecond) by walking WAHA's chat history directly. Builds
  // contact_account_history rows + auto-promotes replied-owners to 'hot'.
  // Skips VertexAI classifier (403 forbidden on this project).
  cron.schedule('0 4 * * *', async () => {
    log.info('Cron: history_sync_force')
    try {
      const { syncAllSessionsForce } = require('./services/historySync')
      const r = await syncAllSessionsForce()
      log.info('Cron history_sync_force done', { results: r })
    } catch (err) {
      log.error('Cron history_sync_force error', err)
    }
  })

  // ── Daily group-share scheduler at 07:30 ─────────────────────
  // Phase-6: build a 30-slot plan for the day and enqueue fb-groups
  // share jobs. Runs BEFORE the morning briefing so the briefing's
  // "today's plan" line can include the just-scheduled shares. The
  // worker (services/dailyShareWorker.js) is the side-effecting layer
  // that talks to BullMQ; the planner (services/dailyShareScheduler.js)
  // is pure and the contract is unit-tested.
  cron.schedule('30 7 * * *', async () => {
    log.info('Cron: daily group-share plan')
    try {
      const { enqueueDailyPlan } = require('./services/dailyShareWorker')
      const r = await enqueueDailyPlan()
      log.info('Cron daily-share plan complete', {
        day: r.day, plan: r.plan, queued: r.queued, skipped: r.skipped,
        errors: r.errors.slice(0, 3),
      })
    } catch (err) {
      log.error('Cron daily-share plan error', err)
    }
  })

  // ── Morning briefing at 08:00 (WA notes + Telegram) ─────────────
  cron.schedule('0 8 * * *', async () => {
    try {
      // getDailyStats(db) honours the active_properties semantics pinned by
      // services/healthStats.js (website_properties is the current public
      // count; owner_properties is legacyActiveProperties for drift watch).
      const s = await getDailyStats(db)
      const blacklistR = await db.query('SELECT COUNT(*) FROM blacklist')
      const pendingCyclesR = await db.query(
        "SELECT COUNT(*) FROM owner_outreach_cycles WHERE status='pending'"
      )
      const reminderSection = await formatReminderBriefing().catch(() => null)

      const briefing =
        `*Morning Briefing 🌅*\n\n` +
        `Active listings: ${s.activeProperties}\n` +
        `New clients (24h): ${s.newClientsToday}\n` +
        `Outreach (24h): ${s.outreachToday}\n` +
        `Matches (24h): ${s.matchedToday}\n` +
        `Pending cycles: ${pendingCyclesR.rows[0].count}\n` +
        `Blacklisted: ${blacklistR.rows[0].count}` +
        // Surface the legacy count as a sanity reference so a future drift
        // between the two pipelines is visible without changing the line
        // any existing consumer of the brief reads.
        (s.legacyActiveProperties != null && s.legacyActiveProperties !== s.activeProperties
          ? `\n(legacy owner_properties: ${s.legacyActiveProperties})`
          : '') +
        (reminderSection ? `\n${reminderSection}` : '')

      await sendAlert(briefing, 'info')
      // Also send to admin WA notes
      try {
        const sess = await waha.getActiveSession()
        await waha.sendText(sess, config.admin.botNumber, briefing)
      } catch {}
    } catch (err) {
      log.error('Morning briefing error', err)
    }
  })

  // ── Hourly DB health check ────────────────────────────────────
  // Routed through services/healthStats.runHealthTickJob so the count
  // emitted here is the same one /health reports. The wrapper logs the
  // structured "Health tick" line on success and alerts on DB failure.
  cron.schedule('0 * * * *', async () => {
    try {
      await runHealthTickJob(db, { log, sendAlert })
    } catch { /* alert already emitted by runHealthTickJob */ }
  })

  // ── WAHA session health every 2 minutes ──────────────────────
  cron.schedule('*/2 * * * *', async () => {
    try {
      await ensureAllSessionsWorking()
      // A backend restart can begin while WAHA is already WORKING, in which
      // case no fresh session.status transition arrives to wake persisted
      // queues. Flush explicitly on every health pass as the recovery net.
      const router = require('./lib/sessionRouter')
      await router.flushQueue()
      await router.flushWaitingDeliveries()
    } catch (err) {
      log.error('Cron WAHA health check error', err)
    }
  })

  // ── 24h ghost check every 30 minutes ─────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      await replyMonitor.processExpiredMonitors()
    } catch (err) {
      log.error('Cron ghost check error', err)
    }
  })

  // DUE owner reminders — individual messages, pre-send owner/friend/stop
  // classification, and assigned-account routing. Five claims per minute
  // keeps the board responsive while preserving human-looking pacing.
  cron.schedule('* * * * *', async () => {
    try {
      const reminderOutreach = require('./services/reminderOutreach')
      const mode = await require('./services/ownerSendGate').getAutomationMode()
      if (mode === 'REVIEW_ONLY') {
        const reviewed = await require('./services/ownerRecheck').recheckDueReminders({ limit: 500 })
        if (reviewed.checked) log.info('Cron due-reminder recheck (review only)', reviewed)
        return
      }
      const staged = await reminderOutreach.stageUnplannedReminders({ limit: 500 })
      const result = await reminderOutreach.runDueAutoBatch({ limit: 5 })
      if (result.due) log.info('Cron due-reminder outreach', {
        staged: staged.queued,
        newlyBlocked: staged.blocked,
        due: result.due,
        sent: result.sent.length,
        blocked: result.blocked.length,
        waiting: result.waiting.length,
        failed: result.failed.length,
      })
    } catch (err) {
      log.error('Cron due-reminder outreach error', err)
    }
  })

  // ── Google Sheets sync every 30 minutes ───────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      await syncToSheets()
    } catch (err) {
      log.error('Cron sheets sync error', err)
    }
  })

  // ── Reminder sweep every 30 minutes ───────────────────────────
  // Fires fire3w (T-21d) and fire1d (T-2d). Each fired reminder posts a
  // single concise message to the REMINDER channel (owner phone + content
  // + time-of-fire label) via reminderPoster.postReminder. !reminders shows
  // everything from T-1MONTH (see services/reminderPoster.listRecent).
  cron.schedule('*/30 * * * *', async () => {
    try {
      const result = await reminderScheduler.runReminderSweep(new Date(), {
        postToReminderChannel: reminderPoster.postReminder,
      })
      if (result.count > 0) log.info('Cron reminder sweep fired', { count: result.count, posted: result.posted })
    } catch (err) {
      log.error('Cron reminder sweep error', err)
    }
  })

  // ── availability auto-reachout — REMOVED FROM CRON (Kev, 2026-08-30) ──
  // This used to run unattended every 30 minutes forever (scanAndReachOut,
  // plus routeNeverContactedToReview). After an incident where an
  // already-armed env flag combined with newly-armed properties sent real
  // availability checks to 15 owners with nobody having pressed a button
  // that day, Kev's explicit call: this mechanism must never run
  // unattended again, in any form — not just the sending half.
  // scanAndReachOut/routeNeverContactedToReview still exist in
  // services/availabilityReachout.js and are reachable ONLY from the new
  // !reachoutbatch admin command (services/adminCommands.js) — an explicit
  // command, an explicit YES, nothing else calls them. If a scheduled
  // version of this is ever wanted again, that is a deliberate future
  // decision, not a default to restore.

  // ── Availability: queue flush + 7-9 day inactivity scan (Kev, 2026-09-22) ──
  // 1. Every 2 min: release "Still Available" checks that were queued because the
  //    owner's SOURCE WhatsApp session was offline — only when that same session is
  //    live again, never through another account (services/availability.js
  //    flushQueuedChecks). Sends nothing unless a real queued row exists.
  cron.schedule('*/2 * * * *', async () => {
    try { await require('./services/availability').flushQueuedChecks() }
    catch (err) { log.error('Cron availability queue flush error', err) }
  })
  // 2. Every 30 min: the 7-9 day inactivity check (services/availabilityReachout
  //    scanInactivity). This is Kev's explicit 2026-09-22 spec and the deliberate
  //    "future decision" the 2026-08-30 note above reserved. It stays INERT until the
  //    break-glass env flag is set: without AVAILABILITY_AUTO_REACHOUT=1 it is a dry
  //    run (selects, logs "wouldSend", sends nothing). With it: 08-20 Malta window,
  //    daily cap from reachout_settings, 2 sends per pass with a gap, source-session
  //    only, full pre-send gate.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const r = await require('./services/availabilityReachout').scanInactivity()
      if (!r.skipped && (r.sent.length || r.wouldSend.length)) {
        log.info('Cron inactivity scan', { armed: r.armed, sent: r.sent.length, wouldSend: r.wouldSend.length, waiting: r.waiting.length })
      }
    } catch (err) { log.error('Cron inactivity scan error', err) }
  })
  // 3. Every 5 min: ask the owner to OK proposed / re-confirm withdrawn booking
  //    slots (services/bookingOwnerAsk.js, Kev 2026-09-25). Viewings from tomorrow
  //    on, 15-40 min after booking, 08-20 Malta, source session + pre-send gate.
  //    BOOKING_OWNER_ASK=0 turns it into a dry run.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await require('./services/bookingOwnerAsk').runPass({ dryRun: process.env.BOOKING_OWNER_ASK === '0' })
      if (r.sent.length || r.wouldSend.length) log.info('Cron booking owner ask', r)
    } catch (err) { log.error('Cron booking owner ask error', err) }
  })

  // ── Mark clients older than 30 days as expired (daily midnight) ──
  cron.schedule('0 0 * * *', async () => {
    try {
      const r = await db.query(
        `UPDATE clients SET status='closed', updated_at=NOW()
         WHERE created_at < NOW() - INTERVAL '30 days'
           AND status NOT IN ('closed','rented')
         RETURNING id`
      )
      if (r.rows.length > 0) {
        log.info('Expired clients closed', { count: r.rows.length })
      }
    } catch (err) {
      log.error('Cron expired clients error', err)
    }
  })

  // ── Warm contact rescan every 12 hours ───────────────────────
  cron.schedule('0 */12 * * *', async () => {
    log.info('Cron: warm scan')
    try {
      const total = await scanAllChats()
      log.info('Cron warm scan done', { total })
    } catch (err) {
      log.error('Cron warm scan error', err)
    }
  })

  // ── FB cookie health check every 6 hours ─────────────────────
  // Reads the session cookie jar, surfaces any critical-cookie alert
  // (xs/c_user/fr/datr < 7 days or missing), and Telegrams Kev only when
  // the alert signature is new or has been silent for 24h+. See
  // services/fbCookieHealth.js for the pure contract.
  cron.schedule('0 */6 * * *', async () => {
    log.info('Cron: FB cookie health')
    try {
      await runFbCookieHealthTick({ sendAlert, log })
    } catch (err) {
      log.error('Cron FB cookie health error', err)
    }
  })

  // Daily at 05:00 — refresh the FB session by visiting the homepage. Keeps
  // cookies alive without Kev having to re-import them. Outside the :00-:05
  // FB rate-limit window (memory note 1). Failures are swallowed; the cookie
  // health tick above will alert if the jar actually needs Kev's attention.
  cron.schedule('0 5 * * *', async () => {
    log.info('Cron: FB cookie refresh')
    try {
      await runFbCookieRefresh({ log, sendAlert })
    } catch (err) {
      log.error('Cron FB cookie refresh error', err)
    }
  })

  // Kev, 2026-09-10: drain the FB-TODO backlog (owner posts saved with a link
  // but never successfully scraped, usually because FB was logged out at
  // capture time) the moment Facebook is reachable again — "damit wir nicht
  // 50 Jahre warten bis ich wieder eingeloggt werde". Every 5 minutes so the
  // gap between FB coming back and the backlog draining is small, but the DB
  // check inside is cheap and the Chromium checkLogin() call only happens
  // when there is actual backlog waiting — a quiet tick costs one query.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await processUnenrichedIfFbLive()
      if (result.processed) log.info('Cron: FB-TODO backlog drained', result)
    } catch (err) {
      log.error('Cron FB-TODO backlog drain error', err)
    }
  })

  // ── Agent daily digest at 19:00 Malta (17:00 UTC, CEST) ──────────────
  // "Alle laufenden Anfragen" (today's open av/ask/chat requests) posted
  // into each agent's own WhatsApp group, so an owner who hasn't answered
  // gets a same-day follow-up (Kev, 2026-09-15). Scoped to Katya + Olga
  // only — services/agentDailyDigest.js DIGEST_AGENT_IDS is the one place
  // that list lives. Fixed UTC time assumes Malta is on CEST (UTC+2) like
  // the FB-continuous job above — drifts 1h across the DST switch, same
  // known limitation as every other fixed-UTC schedule in this file.
  cron.schedule('0 17 * * *', async () => {
    log.info('Cron: agent daily digest')
    try {
      const { runDailyDigest } = require('./services/agentDailyDigest')
      await runDailyDigest()
    } catch (err) {
      log.error('Cron agent daily digest error', err)
    }
  })

  log.info('Crons scheduled (clientDigest/7am, dailyShare/7:30, briefing/8am, health/1h, waha/2min, ghost/30min, sheets/30min, reminders/30min, reachout/30min, expire/midnight, warm/12h, fbCookie/6h, fbCookieRefresh/daily, fbTodoBacklog/5min, agentDigest/19:00malta)')
}

module.exports = { startCrons }
