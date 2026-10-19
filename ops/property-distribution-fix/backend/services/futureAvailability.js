'use strict'

const MS_PER_DAY = 86_400_000
// The user-facing "three month" board is a planning window, not a cliff at
// midnight on the exact matching date. A 21-day handover buffer keeps late
// December and mid-January stock visible at the end of September while truly
// distant inventory remains in Future Inventory.
const BOARD_WINDOW_GRACE_DAYS = 21

function utcDay(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function daysUntilAvailable(value, now = new Date()) {
  const target = utcDay(value)
  const today = utcDay(now)
  if (target == null || today == null) return null
  return Math.round((target - today) / MS_PER_DAY)
}

// Product rule: the lock starts after three calendar months, rather than at
// an approximate number of days. This keeps dates such as 28 February and
// 31 May predictable across every upload, board and outreach path.
function threeMonthCutoff(now = new Date()) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (!Number.isFinite(date.getTime())) return null
  const cutoff = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  cutoff.setUTCMonth(cutoff.getUTCMonth() + 3)
  cutoff.setUTCDate(cutoff.getUTCDate() + BOARD_WINDOW_GRACE_DAYS)
  return cutoff
}

function isFarFuture(value, now = new Date()) {
  const target = utcDay(value)
  const cutoff = threeMonthCutoff(now)
  return target != null && cutoff != null && target > cutoff.getTime()
}

function availabilityStatus(value, now = new Date()) {
  return isFarFuture(value, now) ? 'upcoming' : 'available'
}

module.exports = { BOARD_WINDOW_GRACE_DAYS, daysUntilAvailable, threeMonthCutoff, isFarFuture, availabilityStatus }
