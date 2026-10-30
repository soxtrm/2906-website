'use strict'

/**
 * reminderCapture.js
 *
 * Captures notes from the REMINDER GROUP. Notes are wrapped in dot/slash
 * separators (".....") and contain free-text timing info plus an owner phone:
 *
 *   .....
 *   Joseph Cassar might have something in Msida in 3 months
 *   +356 7902 2467
 *   .....
 *
 * Each line arrives as its own WhatsApp message, so we bundle messages in a
 * 2-min window keyed by groupId (same shape as autoAdvertise.js). Separator
 * messages finalize the previous bundle and start the next.
 *
 * On finalize: parse phone, ask Gemini for owner_name + timing + estimated
 * date, save row in `reminders`, DM the poster a confirmation.
 *
 * Hooked from routes/webhook.js — only the 'default' session triggers this
 * handler (dedup, same rule as AutoAdvertise).
 */

const { GoogleGenAI } = require('@google/genai')
const log    = require('../logger')
const waha   = require('../waha')
const db     = require('../db')

const BUNDLE_WINDOW_MS  = 2 * 60 * 1000
const REMINDER_LEAD_DAYS = 21  // contact_due = estimated - 21 days

// groupId → { lines, session, posterPhone, sourceMessageId, timer, startedAt }
const reminderBundles = new Map()

// ── Gemini ────────────────────────────────────────────────────────────────────

let _ai = null
function getAI() {
  if (_ai) return _ai
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  _ai = new GoogleGenAI({ apiKey })
  return _ai
}

// ── Bundle helpers ────────────────────────────────────────────────────────────

function startReminderBundle(payload, session) {
  const groupId = payload.from
  const posterPhone =
    payload.participant ||
    payload._data?.author ||
    payload._data?.participant ||
    payload.author ||
    null

  const bundle = {
    lines:           [],
    session,
    posterPhone,
    sourceMessageId: payload.id || payload.key?.id || null,
    startedAt:       Date.now(),
    timer:           setTimeout(() => finalizeReminderBundle(groupId), BUNDLE_WINDOW_MS),
  }
  reminderBundles.set(groupId, bundle)

  log.info('reminderCapture: bundle started', {
    groupId: groupId.slice(0, 15),
    posterPhone: posterPhone ? String(posterPhone).slice(0, 25) : null,
  })
  return bundle
}

function appendToBundle(groupId, text) {
  const b = reminderBundles.get(groupId)
  if (!b) return
  const trimmed = text.trim()
  if (trimmed) b.lines.push(trimmed)
}

// ── Timing parser ─────────────────────────────────────────────────────────────

async function parseReminderTiming(noteText) {
  const today = new Date().toISOString().split('T')[0]
  const empty = { owner_name: null, timing_text: null, estimated_date: null, contact_due_date: null }

  const ai = getAI()
  if (!ai) {
    log.warn('reminderCapture: Gemini not configured')
    return empty
  }

  const prompt =
    `You're parsing a real estate reminder note. Today is ${today}.\n\n` +
    `Extract from this note:\n` +
    `1. owner_name (person name if mentioned, else null)\n` +
    `2. timing_text (the exact phrase about when the owner will be available, e.g. "September/October", "in 3 months", "End of summer", "Feb 2027")\n` +
    `3. estimated_date (YYYY-MM-DD, best estimate of when the owner will have the property available; null if completely unclear)\n\n` +
    `Return ONLY valid JSON with these 3 fields. No prose, no markdown fences.\n\n` +
    `Rules:\n` +
    `- "in X months" → today + X months\n` +
    `- A month name without year → this year if month >= current month, otherwise next year\n` +
    `- "end of summer" → August 31 (current year if before Sep 1, else next year)\n` +
    `- "beginning of [month]" → 5th\n` +
    `- "mid [month]" → 15th\n` +
    `- "end of [month]" → 25th\n\n` +
    `Note:\n"""${noteText}"""`

  try {
    const r = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { temperature: 0 },
    })

    let raw = (r.text || '').trim()
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

    const parsed = JSON.parse(raw)

    let contact_due_date = null
    if (parsed.estimated_date) {
      const d = new Date(parsed.estimated_date)
      if (!isNaN(d.getTime())) {
        d.setDate(d.getDate() - REMINDER_LEAD_DAYS)
        contact_due_date = d.toISOString().split('T')[0]
      }
    }

    return {
      owner_name:      parsed.owner_name || null,
      timing_text:     parsed.timing_text || null,
      estimated_date:  parsed.estimated_date || null,
      contact_due_date,
    }
  } catch (err) {
    log.warn('reminderCapture: Gemini parse failed', { err: err.message, snippet: noteText.slice(0, 80) })
    return empty
  }
}

// ── Finalize ──────────────────────────────────────────────────────────────────

async function finalizeReminderBundle(groupId) {
  const bundle = reminderBundles.get(groupId)
  if (!bundle) return
  reminderBundles.delete(groupId)

  if (bundle.lines.length === 0) {
    log.debug('reminderCapture: empty bundle dropped', { groupId: groupId.slice(0, 15) })
    return
  }

  const fullText = bundle.lines.join('\n').trim()
  if (fullText.length < 5) {
    log.debug('reminderCapture: bundle too short', { groupId: groupId.slice(0, 15), chars: fullText.length })
    return
  }

  // ── Owner phone — take the LAST phone-like match in the bundle ────────────
  // Reminder notes typically end with the owner number; earlier numbers are
  // usually part of the note prose (e.g. "called him 3 times").
  const phoneRegex = /\+?(?:\d[\d\s\-()]{7,20}\d)/g
  const matches = fullText.match(phoneRegex) || []
  let ownerPhone = null
  for (let i = matches.length - 1; i >= 0; i--) {
    const digits = matches[i].replace(/\D/g, '')
    if (digits.length >= 8) { ownerPhone = digits; break }
  }

  if (!ownerPhone) {
    log.warn('reminderCapture: no owner phone found, dropping bundle', {
      groupId: groupId.slice(0, 15), snippet: fullText.slice(0, 120),
    })
    return
  }

  const internal = await db.query(
    `SELECT 1 FROM agents a
      WHERE a.active IS DISTINCT FROM FALSE AND (
        regexp_replace(COALESCE(a.whatsapp_phone,''), '\\D', '', 'g') = $1 OR
        regexp_replace(COALESCE(a.public_phone,''), '\\D', '', 'g') = $1 OR
        EXISTS (SELECT 1 FROM unnest(COALESCE(a.whatsapp_phones, ARRAY[]::text[])) p
                 WHERE regexp_replace(p, '\\D', '', 'g') = $1)
      ) LIMIT 1`, [ownerPhone])
  if (internal.rows.length) {
    log.info('reminderCapture: ignored internal agent/admin number', { ownerPhone: ownerPhone.slice(-4) })
    return
  }

  // ── Note text — remove the phone line(s) and any separators ───────────────
  const noteText = fullText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^[.…]{3,}$/.test(l) && !/^\/{3,}$/.test(l))
    .filter(l => !phoneRegex.test(l) || l.replace(/\D/g, '').length < 8)
    .join(' ')
    .trim()
  // global regex needs reset between filters
  phoneRegex.lastIndex = 0

  if (noteText.length < 5) {
    log.warn('reminderCapture: note text too short after stripping phone', { ownerPhone, fullText: fullText.slice(0, 120) })
    return
  }

  log.info('reminderCapture: parsing timing', { ownerPhone, chars: noteText.length })
  const parsed = await parseReminderTiming(noteText)

  // ── Insert ────────────────────────────────────────────────────────────────
  // contact_due_date is NOT NULL in schema, so when Gemini fails to parse we
  // fall back to "today + 14 days" so the row is still visible in the next
  // upcoming-reminders post (the poster will see ⚠️ unclear-timing and can
  // edit manually with !cancelreminder / re-add).
  const fallbackDue = new Date()
  fallbackDue.setDate(fallbackDue.getDate() + 14)
  const contactDue = parsed.contact_due_date || fallbackDue.toISOString().split('T')[0]

  const posterPhoneDigits = bundle.posterPhone
    ? String(bundle.posterPhone).replace(/@.*/, '').replace(/\D/g, '')
    : null

  const result = await db.query(
    `INSERT INTO reminders (
       source_session, source_phone, source_message_id,
       owner_phone, owner_name, original_note,
       parsed_timing, estimated_owner_date, contact_due_date, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING id`,
    [
      bundle.session,
      posterPhoneDigits,
      bundle.sourceMessageId,
      ownerPhone,
      parsed.owner_name,
      noteText,
      parsed.timing_text,
      parsed.estimated_date,
      contactDue,
    ]
  )

  const reminderId = result.rows[0].id
  log.info('reminderCapture: saved', {
    id: reminderId,
    ownerPhone,
    estimated:   parsed.estimated_date,
    contact_due: contactDue,
    auto:        !parsed.contact_due_date,
  })

  // ── DM confirmation to the poster ─────────────────────────────────────────
  if (bundle.posterPhone) {
    const posterJid = String(bundle.posterPhone).includes('@')
      ? String(bundle.posterPhone)
      : `${posterPhoneDigits}@s.whatsapp.net`

    const lines = [
      `🚨 Reminder #${reminderId} saved`,
      `Owner: ${parsed.owner_name || `+${ownerPhone}`}`,
      `Timing: ${parsed.timing_text || 'unclear'}`,
      parsed.estimated_date
        ? `Owner-date: ${parsed.estimated_date}`
        : `⚠️ Could not parse owner-date — please clarify`,
      parsed.contact_due_date
        ? `Will remind you: ${parsed.contact_due_date}`
        : `⚠️ Fallback reminder in 14d (${contactDue}) — edit if needed`,
    ]

    if (posterJid.endsWith('@lid')) {
      log.warn('reminderCapture: poster JID is @lid, cannot DM', { posterJid })
    } else {
      try {
        await waha.sendText(bundle.session, posterJid, lines.join('\n'))
        log.info('reminderCapture: poster notified', { posterJid: posterJid.slice(0, 25) })
      } catch (err) {
        log.warn('reminderCapture: poster notify failed', { err: err.message })
      }
    }
  }
}

// ── Webhook entry point ───────────────────────────────────────────────────────

async function handleReminderMessage(payload, session) {
  try {
    const groupId = payload.from
    if (!groupId) return

    const text = (
      payload.body || payload.caption || payload._data?.body || payload._data?.caption || ''
    ).trim()

    // Separator — flush current bundle if it has content, then start a new one.
    if (/^[.…]{3,}$/.test(text) || /^\/{3,}$/.test(text)) {
      const existing = reminderBundles.get(groupId)
      if (existing && existing.lines.length > 0) {
        clearTimeout(existing.timer)
        await finalizeReminderBundle(groupId)
      } else if (existing) {
        // empty bundle — just refresh the timer with the new poster context
        clearTimeout(existing.timer)
        reminderBundles.delete(groupId)
      }
      startReminderBundle(payload, session)
      return
    }

    if (!text) return  // media-only / system message — ignore

    let bundle = reminderBundles.get(groupId)
    if (!bundle) bundle = startReminderBundle(payload, session)

    appendToBundle(groupId, text)
    log.debug('reminderCapture: line appended', {
      groupId: groupId.slice(0, 15), lines: bundle.lines.length,
    })
  } catch (err) {
    log.error('reminderCapture: handler crashed', { err: err.message, stack: err.stack })
  }
}

module.exports = { handleReminderMessage }
