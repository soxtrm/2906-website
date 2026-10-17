'use strict'
// ============================================================================
// services/whatsappReachability.js — can this number receive WhatsApp?
//
// Batch 276 (2026-10-17): !createlist handed out 40 numbers none of which was
// on WhatsApp (29 Maltese landlines 3562…, 11 mobiles; check-exists false on
// three independent sessions, LID lookup null). This module classifies a
// number once, with the documented WAHA endpoint, and never turns a technical
// failure into "has no WhatsApp":
//
//   VALID                    numberExists === true
//   NOT_REGISTERED           numberExists === false (provider answered)
//   TEMPORARILY_UNAVAILABLE  timeout / network / 429 / 5xx / session not ready
//   RESOLUTION_FAILED        any other unexpected answer
//   UNKNOWN                  no number / no session
// ============================================================================
const config = require('../config')
const log = require('../logger')

const TIMEOUT_MS = Number(process.env.WA_REACHABILITY_TIMEOUT_MS || 8000)

async function classify(session, phone, { fetchImpl = globalThis.fetch } = {}) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits || !session) return { status: 'UNKNOWN', phone: digits }
  const base = String(config?.waha?.url || 'http://waha:3000').replace(/\/$/, '')
  const url = `${base}/api/contacts/check-exists?session=${encodeURIComponent(session)}&phone=${encodeURIComponent(digits)}`
  try {
    const res = await fetchImpl(url, {
      headers: config?.waha?.apiKey ? { 'X-Api-Key': config.waha.apiKey } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 429 || res.status >= 500) return { status: 'TEMPORARILY_UNAVAILABLE', phone: digits, detail: `HTTP ${res.status}` }
    if (!res.ok) return { status: 'RESOLUTION_FAILED', phone: digits, detail: `HTTP ${res.status}` }
    const body = await res.json().catch(() => null)
    if (body?.numberExists === true) return { status: 'VALID', phone: digits, chatId: body.chatId || null }
    if (body?.numberExists === false) return { status: 'NOT_REGISTERED', phone: digits }
    return { status: 'RESOLUTION_FAILED', phone: digits, detail: 'no numberExists in response' }
  } catch (err) {
    return { status: 'TEMPORARILY_UNAVAILABLE', phone: digits, detail: err.name === 'TimeoutError' ? 'timeout' : err.message }
  }
}

/** Classify many numbers, `concurrency` at a time; results keep input order. */
async function classifyMany(session, phones, { concurrency = 5, fetchImpl } = {}) {
  const results = new Array(phones.length)
  let next = 0
  const worker = async () => {
    while (next < phones.length) {
      const index = next++
      results[index] = await classify(session, phones[index], { fetchImpl })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, phones.length) }, worker))
  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
  if (counts.TEMPORARILY_UNAVAILABLE || counts.RESOLUTION_FAILED) log.warn('whatsappReachability: some numbers could not be verified', { session, counts })
  return results
}

module.exports = { classify, classifyMany }
