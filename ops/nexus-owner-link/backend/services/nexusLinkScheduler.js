'use strict'
// ============================================================================
// services/nexusLinkScheduler.js — the one timer of the ARGUS × NEXUS owner
// link (Claude, 2026-11-12, queue addendum 01).
//
// Each pass: release distribution routes that are due, take back releases whose
// listing has ended, then deliver waiting outbox events (only if a NEXUS
// receiver is configured). The schedule itself lives in the database, so a
// restart loses nothing and a second instance cannot release anything twice.
//
// OFF by default: it only runs with NEXUS_LINK_SCHEDULER=1. It sends no message
// to anyone and is independent of cron.js, the outreach crons and the queues.
// ============================================================================
const log = require('../logger')

const intervalMs = (env = process.env) => {
  const s = Number(env.NEXUS_LINK_SCHEDULER_SECONDS)
  return (Number.isFinite(s) && s >= 30 && s <= 3600 ? s : 300) * 1000
}

let timer = null
let running = false

// One pass. Never throws; never overlaps with itself in this process.
async function runOnce() {
  if (running) return { skipped: 'previous pass still running' }
  running = true
  try {
    const routing = await require('./nexusDistributionRouting').tick()
    const delivery = await require('./nexusOwnerLink').deliverDue()
    if (routing.released || routing.revokedEnded || routing.withdrawnEnded || routing.errors || delivery.delivered || delivery.failed) log.info('nexus link scheduler pass', { routing, delivery })
    return { routing, delivery }
  } catch (err) {
    log.error('nexus link scheduler pass failed', { err: err.message })
    return { error: err.message }
  } finally { running = false }
}

function start(env = process.env) {
  if (env.NEXUS_LINK_SCHEDULER !== '1') return { started: false, reason: 'NEXUS_LINK_SCHEDULER is not 1' }
  if (timer) return { started: true, already: true }
  const every = intervalMs(env)
  timer = setInterval(runOnce, every)
  if (timer.unref) timer.unref() // never keeps the process alive on shutdown
  log.info('nexus link scheduler started', { everySeconds: every / 1000 })
  return { started: true, everySeconds: every / 1000 }
}
function stop() { if (timer) clearInterval(timer); timer = null }

module.exports = { start, stop, runOnce, intervalMs }
