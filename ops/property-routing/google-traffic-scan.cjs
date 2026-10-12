'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { currentTraffic } = require('/opt/nexus-routing/google-traffic.cjs')
const { appendScannerRun, scannerHealth } = require('./traffic-history-store.cjs')
const { acquireProcessLock, releaseProcessLock } = require('./traffic-process-lock.cjs')

const RUN_DIR = process.env.NEXUS_TRAFFIC_RUN_DIR || '/run/nexus-routing'
const DATA_DIR = process.env.NEXUS_TRAFFIC_DATA_DIR || '/var/lib/nexus-routing'
const OUTPUT = path.join(RUN_DIR, 'google-traffic-current.json')
const LOCK = path.join(RUN_DIR, 'google-traffic-scan.lock')
const BLOCKED = path.join(RUN_DIR, 'google-traffic.blocked.json')
const RUNS = path.join(DATA_DIR, 'traffic-scanner-runs.jsonl')
const OBSERVATIONS = path.join(DATA_DIR, 'traffic-observations.jsonl')
const HEALTH = path.join(RUN_DIR, 'traffic-scanner-health.json')
const MAX_CACHE_AGE_MS = 35 * 60 * 1000
const COLLECTOR_VERSION = 'google-current-v2'

const places = {
  sliema: { id: 'sliema', coordinates: [14.5044, 35.9122] },
  'st-julians': { id: 'st-julians', coordinates: [14.4903, 35.9186] },
  central: { id: 'central-birkirkara', coordinates: [14.4611, 35.8967] },
  north: { id: 'north-mellieha', coordinates: [14.3622, 35.9603] },
  south: { id: 'south-marsaskala', coordinates: [14.5674, 35.8615] },
  portomaso: { id: 'portomaso', coordinates: [14.4891, 35.9224] },
  valletta: { id: 'valletta-gate', coordinates: [14.5083, 35.8956] },
  mdina: { id: 'mdina-gate', coordinates: [14.4035, 35.8869] },
  cirkewwa: { id: 'cirkewwa', coordinates: [14.3298, 35.9875] },
  airport: { id: 'airport', coordinates: [14.4775, 35.8575] },
  'ta-qali': { id: 'ta-qali', coordinates: [14.4205, 35.8943] },
}

const batches = [
  [['sliema', 'valletta'], ['st-julians', 'portomaso'], ['central', 'ta-qali'], ['north', 'cirkewwa'], ['south', 'airport'], ['sliema', 'mdina']],
  [['st-julians', 'valletta'], ['sliema', 'portomaso'], ['central', 'airport'], ['north', 'mdina'], ['south', 'ta-qali'], ['st-julians', 'cirkewwa']],
]

const permissionFailure = reason => /API_KEY|PERMISSION|DENIED|FORBIDDEN|REFERER|REFERRER|BILLING|NOT_ACTIVATED|RESTRICT/i.test(String(reason || ''))
const safeRead = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const atomicWrite = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o640 })
  fs.renameSync(tmp, file)
}
const expectedSlotUtc = epoch => new Date(Math.floor(epoch / 900_000) * 900_000).toISOString()

function persistRun(run) {
  appendScannerRun(RUNS, { ...run, finished_at: run.finished_at || new Date().toISOString() })
  atomicWrite(HEALTH, scannerHealth({ runsFile: RUNS, observationsFile: OBSERVATIONS, currentSnapshotFile: OUTPUT }))
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o750 })
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 })
  const started = Date.now()
  const baseRun = {
    run_id: crypto.randomUUID(), expected_slot_utc: expectedSlotUtc(started),
    started_at: new Date(started).toISOString(), lag_seconds: Math.floor((started % 900_000) / 1000),
    source: 'google-routes-current', expected_queries: 12, successful_queries: 0,
    failed_queries: 0, duplicate_start_detected: false,
    collector_version: COLLECTOR_VERSION, error_summary: null,
  }

  if (fs.existsSync(BLOCKED)) {
    persistRun({ ...baseRun, status: 'BLOCKED', failed_queries: 12, error_summary: 'PROVIDER_ACCESS_BLOCKED' })
    console.error('Google traffic scan remains blocked; no request was sent')
    process.exitCode = 77
    return
  }
  const lock = acquireProcessLock(LOCK)
  if (lock == null) {
    persistRun({ ...baseRun, status: 'DUPLICATE_SKIPPED', duplicate_start_detected: true, error_summary: 'ACTIVE_COLLECTOR_LOCK' })
    console.log(JSON.stringify({ status: 'DUPLICATE_SKIPPED', runId: baseRun.run_id }))
    return
  }

  let successfulQueries = 0
  try {
    const previous = safeRead(OUTPUT)
    const previousBatch = previous && Number.isInteger(previous.batch) ? previous.batch : null
    const batchIndex = previousBatch == null ? Math.floor(Date.now() / 900_000) % batches.length : (previousBatch + 1) % batches.length
    const directional = []
    for (const [a, b] of batches[batchIndex]) directional.push([a, b], [b, a])
    const seen = new Set()
    const fresh = []
    for (const [fromKey, toKey] of directional) {
      const from = places[fromKey]
      const to = places[toKey]
      const id = `${from.id}--${to.id}`
      if (seen.has(id)) continue
      seen.add(id)
      const result = await currentTraffic(from.coordinates, [to], `public:${from.id}`)
      if (result.status !== 'CONNECTED') {
        const failure = { blockedAt: new Date().toISOString(), reason: result.reason || 'UNKNOWN' }
        if (permissionFailure(failure.reason)) atomicWrite(BLOCKED, failure)
        throw new Error(failure.reason)
      }
      const route = result.routes && result.routes[0]
      if (!route || !Number.isFinite(route.trafficSeconds) || !Number.isFinite(route.noTrafficSeconds)) throw new Error(`INCOMPLETE_ROUTE:${id}`)
      successfulQueries += 1
      fresh.push({ id, from: from.id, to: to.id, distanceMetres: route.distanceMetres, trafficSeconds: route.trafficSeconds, noTrafficSeconds: route.noTrafficSeconds, observedAt: route.observedAt, confidence: route.confidence, source: route.source, meaning: route.meaning })
    }

    const now = Date.now()
    const merged = new Map()
    if (previous && Array.isArray(previous.routes)) {
      for (const route of previous.routes) {
        const observed = Date.parse(route.observedAt || '')
        if (Number.isFinite(observed) && now - observed <= MAX_CACHE_AGE_MS) merged.set(route.id, route)
      }
    }
    for (const route of fresh) merged.set(route.id, route)
    const generatedAt = new Date().toISOString()
    atomicWrite(OUTPUT, {
      status: 'CONNECTED', generatedAt, expiresAt: new Date(now + 20 * 60 * 1000).toISOString(),
      batch: batchIndex, live: true, source: 'Google Maps Routes API', attribution: 'Google Maps',
      storage: 'ephemeral current snapshot; not a historical measurement archive',
      coverage: { requested: directional.length, completed: fresh.length, cachedRoutes: merged.size },
      routes: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)),
    })
    persistRun({ ...baseRun, status: 'SUCCESS', successful_queries: successfulQueries })
    console.log(JSON.stringify({ status: 'CONNECTED', runId: baseRun.run_id, batch: batchIndex, completed: fresh.length, cachedRoutes: merged.size }))
  } catch (error) {
    persistRun({ ...baseRun, status: permissionFailure(error.message) ? 'BLOCKED' : 'FAILED', successful_queries: successfulQueries, failed_queries: Math.max(1, 12 - successfulQueries), error_summary: String(error.message || error).slice(0, 500) })
    console.error(error.message)
    process.exitCode = 1
  } finally {
    releaseProcessLock(LOCK, lock)
  }
}

main()
