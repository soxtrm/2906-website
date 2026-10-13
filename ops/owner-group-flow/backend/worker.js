const { Worker } = require('bullmq')
const { connection } = require('./queues')
const log = require('./logger')
const { sendAlert } = require('./telegram')

const { processPropertyIntake } = require('./services/propertyIntake')
const { processClientIntake }   = require('./services/clientIntake')
const { runMatching }           = require('./services/matcher')
const { sendOutreach } = require('./services/outreach')
const { handleRentedMessage }   = require('./services/rented')
const { processFacebookPost } = require('./services/facebookCampaign')
const { processAvailabilityJob } = require('./services/availability')
const { processShareJob }        = require('./services/fbShareQueue')
const { processRepostStep }      = require('./services/fbRepost')
const { processStep: processAutoConversationStep, runAutoPublishJob } = require('./services/autoOwnerConversation')
// CLIENTGROUPS -- START FLOW (Kev, 2026-09-04): this queue has existed since
// Prompt 4 (services/clientAssistant.js's scheduleProactiveCheck() has
// always enqueued into it) but NEVER had a registered processor here -- every
// job silently sat in Redis forever, so evaluateProactiveOpportunity()/
// pickNaturalSendTime() were unreachable in production. runProactiveCheck()
// is the actual processor body: evaluate -> maybe act -> always reschedule
// the next check (see that function's own header for why).
const { runProactiveCheck } = require('./services/clientAssistant')
// OWNERGROUPS (Kev, 2026-09-04, OG-1): registered now even though nothing
// enqueues a job yet (OG-2 is what starts calling ownerAssistant.scheduleCheck())
// -- exactly the CLIENTGROUPS lesson above, applied before the mistake can
// happen a second time rather than after.
const { runCheck: runOwnerAssistantCheck } = require('./services/ownerAssistant')
const { runCampaign: runScheduledOutreachCampaign } = require('./services/scheduledOutreach')
// FB Direct From Owner Convert & TODO (Kev, 2026-09-08).
const { runLeadContactJob } = require('./services/fbOwnerSave')
// ARGUS / NEON outreach planner (Kev, 2026-09-11) -- registered in the SAME
// commit that first enqueues into 'outreach-plan' (armPlan(), services/
// outreachPlanner.js), on purpose: this file's own CLIENTGROUPS comment
// above documents exactly what happens when a queue is created before its
// processor is wired in (jobs sit in Redis forever, silently).
const { runScheduledPlan, reconcileOverdueArmedPlans } = require('./services/outreachPlanner')
const { executeOutreachRun, recoverInterruptedRuns } = require('./services/outreachRunEngine')

const PROCESSORS = {
  'property-intake': (job) => processPropertyIntake(job.data),
  'client-intake':   (job) => processClientIntake(job.data),
  'matching':        (job) => runMatching(job.data),
  'outreach':        (job) => sendOutreach(job.data),
  'rented':          (job) => handleRentedMessage(job.data),
  'facebook-posts':  (job) => processFacebookPost(job),
  'availability':    (job) => processAvailabilityJob(job.data),
  'fb-groups':       (job) => processShareJob(job.data),
  'fb-repost':       (job) => processRepostStep(job.data),
  'auto-conversation': (job) => processAutoConversationStep(job.data),
  'client-assistant': (job) => runProactiveCheck(job.data.stateId, { newPropertyId: job.data.newPropertyId || null }),
  'owner-assistant': (job) => runOwnerAssistantCheck(job.data.stateId, job.data),
  'scheduled-outreach': (job) => runScheduledOutreachCampaign(job.data.campaignId),
  'fb-owner-lead': (job) => runLeadContactJob(job.data.leadId),
  'owner-auto-publish': (job) => runAutoPublishJob(job.data.conversationId),
  'outreach-plan': (job) => runScheduledPlan(job.data.planId),
  'outreach-run': (job) => executeOutreachRun(job.data.runId),
}

function createWorker(queueName) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const fn = PROCESSORS[queueName]
      if (!fn) throw new Error(`No processor registered for queue: ${queueName}`)
      return fn(job)
    },
    {
      connection,
      // outreach + facebook-posts serial (paced delays / one page account)
      // fb-groups serial too: two concurrent group posts is an instant spam flag
      concurrency: (queueName === 'outreach' || queueName === 'facebook-posts'
                    || queueName === 'fb-groups') ? 1 : 3,
      // a browser-driven group post (navigate + upload photos) far outlives 60s
      lockDuration: queueName === 'fb-groups' ? 10 * 60_000 : 60_000,
    }
  )

  worker.on('completed', (job, result) => {
    log.debug('Job done', { queue: queueName, id: job.id, result })
  })

  worker.on('failed', (job, err) => {
    log.error('Job failed', { queue: queueName, id: job?.id, err: err.message })
    if (job?.attemptsMade >= (job?.opts?.attempts ?? 3)) {
      sendAlert(
        `Job permanent failure\nQueue: ${queueName}\nID: ${job?.id}\n${err.message}`,
        'error'
      ).catch(() => {})
    }
  })

  worker.on('error', (err) => {
    log.error('Worker error', { queue: queueName, err })
  })

  log.info('Worker started', { queue: queueName })
  return worker
}

function startWorkers() {
  const workers = Object.keys(PROCESSORS).map(createWorker)

  // A restart in the middle of a multi-hour FB backlog would otherwise leave it
  // stalled: the run that was in flight when the process died never reaches
  // finishRun, so nothing schedules the next listing. No-op unless the backlog
  // is enabled AND no run is live.
  require('./services/fbShareBacklog').bootstrap()
    .catch(err => log.warn('fb backlog bootstrap failed', { err: err.message }))

  // Same shape, same reason (Kev, 2026-08-30): a restart mid-!foutreach used
  // to erase the remaining contacts silently — see services/
  // outreachRecovery.js and the checkpointing in services/adminCommands.js's
  // runDirectOutreach().
  require('./services/outreachRecovery').bootstrap()
    .catch(err => log.warn('outreach recovery bootstrap failed', { err: err.message }))
  recoverInterruptedRuns()
    .catch(err => log.error('persistent outreach run recovery failed', { err: err.message }))

  // Kev's Prompt C, step 4 (2026-08-30): the match reconciliation fallback
  // sync — every event hook (see services/matchReconciliation.js's header)
  // is the fast path; this is the safety net for whatever they missed.
  // Deliberately a plain setInterval here, NOT one more cron.js job — Kev's
  // own instruction, given that file's WAHA-restart-loop incident history.
  // First pass fires 2 minutes after boot (own watermark handles "how far
  // back" safely — see getWatermark()'s 6h first-run cap), then every 2.5h.
  const RECONCILE_INTERVAL_MS = Number(process.env.MATCH_RECONCILE_INTERVAL_MS) || 2.5 * 3600_000
  const matchReconciliation = require('./services/matchReconciliation')
  const reconcileTimeout = setTimeout(() => {
    matchReconciliation.reconcile().catch(err => log.warn('match reconciliation (first pass) failed', { err: err.message }))
  }, 2 * 60_000)
  const reconcileInterval = setInterval(() => {
    matchReconciliation.reconcile().catch(err => log.warn('match reconciliation failed', { err: err.message }))
  }, RECONCILE_INTERVAL_MS)

  // Outreach Plan watchdog (2026-09-17 incident fix): startup catch-up
  // immediately, then every 60s. Finds any ARMED+overdue plan with no live
  // BullMQ job tracked against it (worker was down at fire time, job lost,
  // etc.) and executes it through the exact same runScheduledPlan() path
  // the scheduler itself uses — never a special bypass. This is what makes
  // "the time passed and nothing happened" impossible: a missed timer tick
  // is caught within 60s instead of leaving an obligation stuck forever.
  reconcileOverdueArmedPlans().catch(err => log.error('outreach-plan startup reconciliation failed', { err: err.message }))
  const outreachWatchdogInterval = setInterval(() => {
    reconcileOverdueArmedPlans().catch(err => log.error('outreach-plan watchdog tick failed', { err: err.message }))
  }, 60_000)

  // WA identity conflict watchdog (Phase C, multi-agent hardening pass,
  // 2026-09-17): read-only, never disconnects anything — logs an ERROR
  // (visible to alerting) the moment two ARGUS sessions (legacy
  // whatsapp_accounts or an agent's self-serve whatsapp_session) are
  // connected/configured for the SAME physical phone number. Confirmed
  // live the day this was added: agents.id=1's 'agent_1' session and the
  // legacy 'default' session are both bound to 35699811819. 30-minute
  // cadence, same as the pre-existing waha_session_watcher cron — this is
  // deliberately a SEPARATE interval, not folded into the existing
  // restart-decision health-check loop, so it can never influence that
  // loop's own (already incident-hardened) restart logic.
  const { detectDuplicatePhysicalNumbers } = require('./services/waIdentityAudit')
  detectDuplicatePhysicalNumbers().catch(err => log.error('wa identity startup check failed', { err: err.message }))
  const waIdentityWatchdogInterval = setInterval(() => {
    detectDuplicatePhysicalNumbers().catch(err => log.error('wa identity watchdog tick failed', { err: err.message }))
  }, 30 * 60_000)

  // Owner-group approval expiry. The SQL claim only moves rows that are still
  // PENDING, so a reply arriving on the same tick wins or loses atomically.
  // Explicit-policy timeouts stop; only an owner-level trusted-timeout policy
  // proceeds through the same createViewingGroup() engine.
  const ownerGroupRequests = require('./services/ownerGroupRequests')
  ownerGroupRequests.reconcileExpired().catch(err => log.error('owner group startup reconciliation failed',{err:err.message}))
  const ownerGroupRequestInterval = setInterval(() => {
    ownerGroupRequests.reconcileExpired().catch(err => log.error('owner group reconciliation failed',{err:err.message}))
  }, 30_000)

  async function closeAll() {
    log.info('Closing workers...')
    clearTimeout(reconcileTimeout)
    clearInterval(reconcileInterval)
    clearInterval(outreachWatchdogInterval)
    clearInterval(waIdentityWatchdogInterval)
    clearInterval(ownerGroupRequestInterval)
    await Promise.all(workers.map(w => w.close()))
    log.info('Workers closed')
  }

  // index.js owns shutdown; expose close for it to call
  return { workers, closeAll }
}

module.exports = { startWorkers }
