'use strict'
// ============================================================================
// services/facebookPages/jobs.js — background execution on the backend's
// existing BullMQ + Redis (same connection as queues.js), in one queue
// "facebook-page-publish" whose processor is registered in this same file,
// so the queue can never exist without its processor (the CLIENTGROUPS lesson
// in worker.js). Jobs carry only a publication id; the row is the truth.
//   • attempts: 1 — retries are decided by the publisher, never blindly by Bull.
//   • jobId fbpub-<id>-<attempt> — the same attempt can only be queued once.
//   • concurrency 1 — one Page post at a time across the backend.
//   • a sweeper every 2 minutes re-queues due retries and recovers crashed runs.
//   • the auto-publish scanner runs every 10 minutes only with ARGUS_FB_AUTOPUBLISH_SCAN=1.
// ============================================================================
const settings = require('./settings')
const publisher = require('./publisher')
const autoPublish = require('./autoPublish')

const QUEUE = 'facebook-page-publish'
let queue = null, worker = null, timers = []

function log() { try { return require('../../logger') } catch { return console } }

async function enqueue(publicationId, delayMs = 0, attempt = 0) {
  if (!queue) throw new Error('facebook-page-publish queue not started')
  await queue.add(QUEUE, { publicationId: Number(publicationId) }, {
    jobId: `fbpub-${publicationId}-${attempt}`, delay: Math.max(0, Math.round(delayMs)), attempts: 1, removeOnComplete: true, removeOnFail: true,
  })
}

function start() {
  if (queue) return { stop }
  const { Queue, Worker } = require('bullmq')
  const { connection } = require('../../queues')
  queue = new Queue(QUEUE, { connection })
  worker = new Worker(QUEUE, job => publisher.run(job.data.publicationId), { connection, concurrency: 1, lockDuration: 5 * 60_000 })
  worker.on('failed', (job, e) => log().error('facebook-page-publish job failed', { id: job && job.id, err: e && e.message }))
  publisher.setEnqueue(enqueue)
  const every = (ms, fn) => { const t = setInterval(() => fn().catch(e => log().error('facebook-pages timer failed', { err: e.message })), ms); if (t.unref) t.unref(); timers.push(t) }
  every(2 * 60_000, () => publisher.sweep())
  if (settings.read().autoPublishScan) every(10 * 60_000, () => autoPublish.scan({ enqueue: (row, delay) => enqueue(row.id, delay, row.attempt_count || 0) }))
  log().info('facebook-pages: publish worker started', { autoPublishScan: settings.read().autoPublishScan, configured: settings.isConfigured() })
  return { stop }
}

async function stop() {
  timers.forEach(clearInterval); timers = []
  if (worker) await worker.close()
  if (queue) await queue.close()
  worker = null; queue = null
}

module.exports = { start, stop, enqueue, QUEUE }
