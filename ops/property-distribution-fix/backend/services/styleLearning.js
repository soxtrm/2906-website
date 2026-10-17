'use strict'
// ============================================================================
// styleLearning.js — STYLE-1 (Kev, 2026-09-04). Generic infrastructure for
// "the bot increasingly writes like Kev" -- deliberately NOT owner-only,
// used today by OG-2's check-in loop and, over time, by the Client
// Assistant (CLIENTGROUPS) too. Migration 062 (style_examples,
// phrasing_variants).
//
// Two collection sources (Kev's own spec):
//   1. owner_takeover_learning_log — the 40h learning log built earlier
//      today. HONEST STATE as of this build: 0 rows, any direction. Per
//      Kev's own explicit instruction the day it was built (see memory
//      2026-09-02, "Teil C"), nothing here fabricates examples against an
//      empty table — extractFromTakeoverLog() checks the real count and
//      reports it plainly. Come back to this once real takeovers exist.
//   2. Kev's own real manual chat messages — collectManualChatSample() reads
//      live WAHA chat history for a genuinely hand-typed, non-command,
//      non-bot-authored message sample. This is the one source with real
//      data available today.
//
// Nothing collected here is used anywhere until Kev approves it
// (`approved` on both tables) — no blind self-learning, per his explicit
// instruction. Approval is a deliberate manual step (approveExample/
// approveVariant below); there is no cron or automatic promotion.
// ============================================================================
const db = require('../db')
const log = require('../logger')

// ── the deterministic em-dash filter (hard backstop, not just a prompt
// rule) — same "prompt instruction + hard check on the actual output"
// defense-in-depth pattern as autoOwnerConversation.js's own
// stripListFormatting(), reused as the model here rather than trusting an
// LLM's own restraint. Strips em-dash (—), en-dash used as a spaced
// separator (–), and a typed "--" standing in for one — but leaves a real
// hyphenated compound ("2-bedroom", "check-in", "co-op") completely alone,
// since those have no surrounding whitespace and are not dash punctuation.
function stripEmDash(text) {
  const s = String(text || '')
  if (!s) return s
  return s
    // em-dash or en-dash with whitespace on at least one side (real dash
    // usage) — replace with a comma, the closest single-character
    // equivalent that keeps the sentence readable without redesigning it.
    .replace(/\s*[—–]\s*/g, ', ')
    // a bare em/en-dash with NO surrounding whitespace at all (still dash
    // punctuation typed mid-word, e.g. "today—tomorrow") — same treatment.
    .replace(/[—–]/g, ', ')
    // "--" used as a typed em-dash substitute, spaced on at least one side
    // (a bare "--" with no spaces at all is vanishingly unlikely to be
    // anything other than an actual double-hyphen typo, left untouched).
    .replace(/\s+--\s+|\s+--(?=\S)|(?<=\S)--\s+/g, ', ')
    // Kev, 2026-09-10 (owner-conversation refinements #3): a SINGLE bare
    // hyphen used as a sentence pause ("Looking for a home - great
    // location") slipped straight through the two rules above, which only
    // ever looked for em/en-dash or a literal double hyphen. The tell that
    // this is dash punctuation and not a hyphenated compound ("well-
    // equipped", "2-bedroom", "check-in") is whitespace on BOTH sides of
    // the hyphen itself -- a real compound never has a space next to its
    // own hyphen. [ \t] only (not \s) on purpose, same restriction the
    // cleanup step below already uses: a hyphen right after a newline is a
    // "- " list marker (stripListFormatting's own bullet pattern), never a
    // mid-sentence pause, and must never be touched here.
    .replace(/[ \t]+-[ \t]+/g, ', ')
    // cleanup: collapse anything the substitutions above left doubled up.
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    // Kev, 2026-09-09 (real bug, live on #2906-9212 and every other post
    // through categoryFormatter.js since this filter was wired in there
    // today): `\s` matches newlines too, so this was collapsing every
    // blank-line paragraph break (price/headline/intro/feature-list
    // section breaks) down to a single space -- an ENTIRE multi-section ad
    // came out as 2-3 giant run-on lines instead of the canonical template
    // layout. Only spaces/tabs are what the dash-substitution cleanup above
    // can actually double up; restricting to those (same pattern
    // services/sanitizer.js's tidyLine() already uses) leaves every real
    // newline -- single AND blank-line -- exactly as the caller wrote it.
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ── collection, source 1: the 40h learning log(s) ────────────────────────
// Client/Owner-Flow-Korrekturen Part 3 (2026-09-08): the client side
// (services/clientAssistant.js's logClientLearningIfActive) now has the
// exact same 40h takeover-learning-log shape the owner side already had --
// same columns that matter here (direction, text), just a different table
// and a different id column name (state_id vs conversation_id) neither of
// which this extraction ever reads. Shared helper, not two copy-pasted
// functions, so both stay in sync by construction.
async function extractFromLogTable(table, sourceTag) {
  const r = await db.query(`SELECT direction, COUNT(*)::int AS n FROM ${table} GROUP BY direction`)
  if (!r.rows.length) {
    log.info(`styleLearning: ${table} is still empty, nothing to extract`)
    return { extracted: 0, reason: `${table} has zero rows` }
  }
  // Kev-authored side only ('kevin'/'human'/whatever direction value the
  // log actually uses for OUR side) — the log's own schema owns that
  // value; this reads it back rather than assuming a literal string.
  const outbound = r.rows.filter(row => /kev|human|us|out/i.test(row.direction))
  let extracted = 0
  for (const row of outbound) {
    const rows = await db.query(
      `SELECT id, text FROM ${table} WHERE direction = $1 AND text IS NOT NULL AND btrim(text) <> ''`,
      [row.direction])
    for (const rr of rows.rows) {
      await db.query(
        `INSERT INTO style_examples (source, text) VALUES ($1, $2)`,
        [sourceTag, rr.text])
      extracted++
    }
  }
  log.info(`styleLearning: extracted from ${table}`, { extracted })
  return { extracted, byDirection: r.rows }
}
async function extractFromTakeoverLog() {
  return extractFromLogTable('owner_takeover_learning_log', 'takeover_log')
}
async function extractFromClientTakeoverLog() {
  return extractFromLogTable('client_takeover_learning_log', 'client_takeover_log')
}

// ── collection, source 2: Kev's real manual chat messages ────────────────
// Heuristic filter, not perfect — that is exactly why approval exists as a
// separate, manual step afterward. Excludes: not fromMe, any leading '!'
// command, and the handful of emoji this bot's OWN templates always start
// with (so a bot-authored message read back through chat history is not
// mistaken for Kev's own voice).
const BOT_PREFIX_RE = /^[✅🎯🆕🔄🛑⚠️📋]/
function looksHandTyped(msg) {
  const body = String(msg?.body || '').trim()
  if (!msg?.fromMe || !body) return false
  if (body.startsWith('!')) return false
  if (BOT_PREFIX_RE.test(body)) return false
  return true
}

async function collectManualChatSample({ session, chatId, limit = 200, max = 30 }) {
  const waha = require('../waha')
  const messages = await waha.getChatMessages(session, chatId, limit)
  const candidates = messages.filter(looksHandTyped).slice(0, max)
  let inserted = 0
  for (const m of candidates) {
    const exists = await db.query(
      `SELECT 1 FROM style_examples WHERE source='manual_chat_sample' AND session=$1 AND chat_id=$2 AND text=$3`,
      [session, chatId, m.body])
    if (exists.rows.length) continue
    await db.query(
      `INSERT INTO style_examples (source, session, chat_id, text) VALUES ('manual_chat_sample',$1,$2,$3)`,
      [session, chatId, m.body])
    inserted++
  }
  log.info('styleLearning: collected manual chat sample', { session, chatId, scanned: messages.length, candidates: candidates.length, inserted })
  return { scanned: messages.length, candidates: candidates.length, inserted }
}

// ── approval workflow (Kev's explicit "no blind self-learning") ─────────
async function listPendingExamples(limit = 100) {
  const r = await db.query(`SELECT * FROM style_examples WHERE approved = FALSE ORDER BY created_at DESC LIMIT $1`, [limit])
  return r.rows
}
async function approveExample(id, reviewedBy = null) {
  await db.query(`UPDATE style_examples SET approved = TRUE, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $1`, [id, reviewedBy])
}
async function rejectExample(id) {
  await db.query(`DELETE FROM style_examples WHERE id = $1`, [id])
}

async function listPendingVariants(purpose = null) {
  const r = purpose
    ? await db.query(`SELECT * FROM phrasing_variants WHERE approved = FALSE AND purpose = $1 ORDER BY created_at DESC`, [purpose])
    : await db.query(`SELECT * FROM phrasing_variants WHERE approved = FALSE ORDER BY created_at DESC`)
  return r.rows
}
async function addVariant(purpose, text, source = 'manual', sourceExampleId = null) {
  const r = await db.query(
    `INSERT INTO phrasing_variants (purpose, text, source, source_example_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [purpose, text, source, sourceExampleId])
  return r.rows[0].id
}
async function approveVariant(id, reviewedBy = null) {
  await db.query(`UPDATE phrasing_variants SET approved = TRUE, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $1`, [id, reviewedBy])
}
async function rejectVariant(id) {
  await db.query(`DELETE FROM phrasing_variants WHERE id = $1`, [id])
}

// The actual growable pool a caller (OG-2, CLIENTGROUPS) reads from. Empty
// until Kev approves at least one variant for that purpose — callers keep
// their own existing hardcoded fallback array for exactly that reason; this
// is additive, never a hard dependency.
async function getVariantPool(purpose) {
  const r = await db.query(`SELECT text FROM phrasing_variants WHERE purpose = $1 AND approved = TRUE`, [purpose])
  return r.rows.map(row => row.text)
}

module.exports = {
  stripEmDash,
  extractFromTakeoverLog,
  extractFromClientTakeoverLog,
  collectManualChatSample,
  listPendingExamples,
  approveExample,
  rejectExample,
  listPendingVariants,
  addVariant,
  approveVariant,
  rejectVariant,
  getVariantPool,
}
