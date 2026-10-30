'use strict'

const DEFAULT_HUMAN_ACTIVE_HOURS = 40

function humanActiveHours(env = process.env) {
  const parsed = Number(env.OWNER_HUMAN_ACTIVE_HOURS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HUMAN_ACTIVE_HOURS
}

function isTemporaryHumanPauseActive(updatedAt, now = new Date(), hours = humanActiveHours()) {
  const updated = updatedAt instanceof Date ? updatedAt : new Date(updatedAt)
  const reference = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(updated.getTime()) || !Number.isFinite(reference.getTime())) return true
  return reference.getTime() - updated.getTime() < hours * 60 * 60 * 1000
}

module.exports = { DEFAULT_HUMAN_ACTIVE_HOURS, humanActiveHours, isTemporaryHumanPauseActive }
