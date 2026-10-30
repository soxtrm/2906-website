const { Queue } = require('bullmq')
const config = require('./config')
const log = require('./logger')

const connection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
}

// Queue names must match worker.js QUEUE_NAMES
const QUEUES = {
  'property-intake': new Queue('property-intake', { connection, defaultJobOptions }),
  'client-intake':   new Queue('client-intake',   { connection, defaultJobOptions }),
  'matching':        new Queue('matching',         { connection, defaultJobOptions }),
  'outreach':        new Queue('outreach',         { connection, defaultJobOptions }),
  'rented':          new Queue('rented',           { connection, defaultJobOptions }),
  'facebook-posts':  new Queue('facebook-posts',   { connection, defaultJobOptions }),
  'availability':    new Queue('availability',     { connection, defaultJobOptions }),
  // fb-groups: browser automation, must never retry blindly into a rate limit —
  // one attempt per group, the run's circuit breaker decides what happens next.
  'fb-groups':       new Queue('fb-groups',        { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // fb-repost: the Schedule Board "push it again" icon (2026-08-18). Pure
  // orchestration — each job either polls for an open run or makes ONE call
  // into fbShareQueue.startRun(), which owns the real browser work. Default
  // retry/backoff is fine here (a transient DB error should not kill a whole
  // repost sequence the way a blind browser retry would spam a group).
  'fb-repost':       new Queue('fb-repost',        { connection, defaultJobOptions }),
  // Auto-Owner-Conversation delayed steps (2026-08-29). No retries beyond the
  // default — a failed step just waits for the owner's next message instead
  // of silently spamming a retry into the chat.
  'auto-conversation': new Queue('auto-conversation', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // Client Assistant delayed proactive-eligibility checks (2026-09-03,
  // Prompt 1/5). Separate queue from 'auto-conversation' on purpose — the
  // two automations must never be able to cancel each other's jobs by id
  // collision. attempts:1 for the same reason as auto-conversation: a
  // failed proactive check should not retry-spam the client, it just waits
  // for the next natural trigger.
  'client-assistant': new Queue('client-assistant', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // Owner Assistant / OWNERGROUPS delayed check-in scheduling (2026-09-04,
  // OG-1). Own queue, separate from 'client-assistant' AND from
  // 'auto-conversation' (autoOwnerConversation.js's unrelated hard-stop
  // system) -- three independent job namespaces can never cancel each
  // other's jobs by id collision. attempts:1 for the same reason as the
  // other two: a failed check should wait for the next natural trigger, not
  // retry-spam the owner.
  'owner-assistant': new Queue('owner-assistant', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // OWNERGROUPS 5/5 (2026-09-04): scheduled dashboard outreach campaigns.
  // attempts:1, same reasoning as the other two owner-facing queues -- a
  // failed scheduled send should surface as 'failed' for the dashboard to
  // show, never silently retry-spam the owner.
  'scheduled-outreach': new Queue('scheduled-outreach', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // FB Direct From Owner Convert & TODO (Kev, 2026-09-08). Own queue, same
  // attempts:1 reasoning as the three owner/client-facing queues above -- a
  // failed send should surface as still-pending for a manual !fbcontact
  // retry, never silently retry-spam a brand new lead.
  'fb-owner-lead': new Queue('fb-owner-lead', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // Owner-zu-Upload-Vollautomatisierung timer buffer (Kev, 2026-09-09). Fires
  // once per armed checklist; attempts:1 because a failure here must surface
  // (alertKev, see runAutoPublishJob) rather than silently retry a publish
  // against what could by then be stale checklist data.
  'owner-auto-publish': new Queue('owner-auto-publish', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // ARGUS / NEON outreach planner (Kev, 2026-09-11). attempts:1 -- a failed
  // run must surface as FAILED on the plan (see runScheduledPlan), never
  // silently retry a bulk send against what could by then be stale
  // eligibility. jobId is set to the plan's idempotency_key at schedule
  // time, so BullMQ itself refuses a second identical schedule.
  'outreach-plan': new Queue('outreach-plan', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  // Persistent, idempotent execution record shared by Notes and Website.
  // Transport outcomes are reconciled by the run engine; Bull must never
  // retry an owner-facing send blindly.
  'outreach-run': new Queue('outreach-run', { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
}

async function addJob(queueName, jobData, opts = {}) {
  const queue = QUEUES[queueName]
  if (!queue) throw new Error(`Unknown queue: ${queueName}`)
  const job = await queue.add(queueName, jobData, opts)
  log.debug('Job queued', { queue: queueName, jobId: job.id })
  return job
}

module.exports = { QUEUES, addJob, connection }
