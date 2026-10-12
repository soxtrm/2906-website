'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { assertHistoricalUseAllowed } = require('./traffic-provider-contract.cjs')

const RUN_FIELDS = Object.freeze([
  'run_id', 'expected_slot_utc', 'started_at', 'finished_at', 'lag_seconds',
  'status', 'source', 'expected_queries', 'successful_queries', 'failed_queries',
  'duplicate_start_detected', 'collector_version', 'error_summary',
])
const OBSERVATION_FIELDS = Object.freeze([
  'observation_id', 'scanner_run_id', 'source', 'source_segment_id', 'corridor_id',
  'nexus_segment_id', 'direction', 'observed_at_utc', 'observed_at_malta',
  'geometry_ref', 'road_name', 'distance', 'duration', 'duration_in_traffic',
  'freeflow_duration', 'speed', 'freeflow_speed', 'delay', 'traffic_metric_raw',
  'source_confidence', 'collector_version',
])

const ensureDir = file => fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 })
const readJsonLines = file => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
const appendJsonLines = (file, rows) => {
  if (!rows.length) return
  ensureDir(file)
  const fd = fs.openSync(file, 'a', 0o640)
  try {
    fs.writeSync(fd, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}
const exactShape = (source, fields) => Object.fromEntries(fields.map(field => [field, source[field] ?? null]))

function appendScannerRun(file, run) {
  if (!run?.run_id) throw new TypeError('run_id is required')
  if (readJsonLines(file).some(row => row.run_id === run.run_id)) throw new Error(`DUPLICATE_RUN_ID:${run.run_id}`)
  appendJsonLines(file, [exactShape(run, RUN_FIELDS)])
}

function appendTrafficObservations(file, provider, observations) {
  assertHistoricalUseAllowed(provider)
  if (!Array.isArray(observations) || observations.length === 0) return 0
  const existing = new Set(readJsonLines(file).map(row => row.observation_id))
  const incoming = new Set()
  const rows = observations.map(observation => {
    if (!observation?.observation_id || !observation?.scanner_run_id) throw new TypeError('observation_id and scanner_run_id are required')
    if (existing.has(observation.observation_id) || incoming.has(observation.observation_id)) {
      throw new Error(`DUPLICATE_OBSERVATION_ID:${observation.observation_id}`)
    }
    incoming.add(observation.observation_id)
    return exactShape({ ...observation, source: provider.id }, OBSERVATION_FIELDS)
  })
  appendJsonLines(file, rows)
  return rows.length
}

function scannerHealth({ runsFile, observationsFile, currentSnapshotFile, now = Date.now() }) {
  const runs = readJsonLines(runsFile)
  const observations = readJsonLines(observationsFile)
  const recent = runs.filter(run => Date.parse(run.started_at || '') >= now - 86_400_000)
  const successful = recent.filter(run => run.status === 'SUCCESS')
  const lastSuccessful = successful.at(-1) || null
  let currentCorridorCount = 0
  try { currentCorridorCount = JSON.parse(fs.readFileSync(currentSnapshotFile, 'utf8')).routes?.length || 0 } catch {}
  const nextExpected = lastSuccessful
    ? new Date(Date.parse(lastSuccessful.expected_slot_utc) + 900_000).toISOString()
    : null
  const expectedSlots = lastSuccessful ? Math.min(96, Math.floor((now - Date.parse(successful[0]?.expected_slot_utc || now)) / 900_000) + 1) : 0
  return {
    generated_at: new Date(now).toISOString(),
    last_successful_scan: lastSuccessful?.finished_at || null,
    next_expected_scan: nextExpected,
    runs_last_24h: recent.length,
    missing_slots_last_24h: Math.max(0, expectedSlots - new Set(recent.map(run => run.expected_slot_utc)).size),
    successful_queries_last_24h: recent.reduce((sum, run) => sum + Number(run.successful_queries || 0), 0),
    failed_queries_last_24h: recent.reduce((sum, run) => sum + Number(run.failed_queries || 0), 0),
    duplicate_starts_last_24h: recent.filter(run => run.duplicate_start_detected).length,
    historical_observation_count: observations.length,
    current_corridor_count: currentCorridorCount,
    alerts: [
      lastSuccessful && now - Date.parse(lastSuccessful.finished_at) > 1_800_000 ? 'NO_SUCCESSFUL_SCAN_OVER_30_MINUTES' : null,
      recent.some(run => run.duplicate_start_detected) ? 'DUPLICATE_START_DETECTED' : null,
      recent.reduce((sum, run) => sum + Number(run.failed_queries || 0), 0) > 0 ? 'QUERY_FAILURES_PRESENT' : null,
    ].filter(Boolean),
  }
}

module.exports = {
  RUN_FIELDS, OBSERVATION_FIELDS, readJsonLines, appendScannerRun,
  appendTrafficObservations, scannerHealth,
}
