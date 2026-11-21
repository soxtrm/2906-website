'use strict'
// ============================================================================
// services/safeDraftsPack.js — Kev's Safe Drafts pack v1.1 (2026-11-21):
// 150 candidate texts, 50 each for Kevin, Gabriela and Cedric, 10 intents.
// Parsed from data/argus_safe_drafts_v1_1.md exactly as written (no rewriting)
// and imported into outreach_library_templates as review_status
// 'pending_review'. Nothing here sends; only approved texts are ever picked.
// ============================================================================
const fs = require('fs')
const path = require('path')

const PERSONA_BY_CODE = { KEVIN: 'kev', GABRIELA: 'gabriela', CEDRIC: 'cedric' }
const PLACEHOLDERS = ['greeting', 'opening', 'agreed_followup_time_phrase', 'followup_subject', 'property_label', 'upcoming_property_label',
  'property_list', 'missing_field_label', 'client_requirement_summary']

function parse(markdown) {
  const out = []
  const blocks = String(markdown).replace(/\r\n/g, '\n').split(/\n(?=### ARGUS-)/)
  for (const block of blocks) {
    const head = /^### (ARGUS-([A-Z]+)-([A-Z_]+)-(\d+))\n/.exec(block)
    if (!head) continue
    const meta = /^Intent: `([a-z_]+)` · Required context: `([^`]*)` · Approval: `([A-Z_]+)`\s*$/m.exec(block)
    if (!meta) throw new Error(`no meta line in ${head[1]}`)
    const persona = PERSONA_BY_CODE[head[2]]
    if (!persona) throw new Error(`unknown persona in ${head[1]}`)
    const afterMeta = block.slice(block.indexOf(meta[0]) + meta[0].length)
    // the body ends at the next top-level heading (persona section) if any
    const body = afterMeta.split(/\n#{1,2} /)[0].trim()
    const used = [...body.matchAll(/\{\{([a-z_]+)\}\}/g)].map(m => m[1])
    const unknown = used.filter(u => !PLACEHOLDERS.includes(u))
    if (unknown.length) throw new Error(`unknown placeholder ${unknown[0]} in ${head[1]}`)
    out.push({
      code: head[1], persona, intent: meta[1], number: Number(head[4]),
      requiredContext: meta[2] === 'none' ? [] : meta[2].split(',').map(s => s.trim()).filter(Boolean),
      approval: meta[3], body, placeholders: [...new Set(used)],
    })
  }
  return out
}

function loadPack(file = path.join(__dirname, '..', 'data', 'argus_safe_drafts_v1_1.md')) {
  return parse(fs.readFileSync(file, 'utf8'))
}

// Imports every text that is not there yet (by code). Existing rows — Kev's
// own texts and anything already reviewed — are never touched.
async function importPack(db, { actor = 'pack-v1.1', file } = {}) {
  const lib = require('./outreachLibrary')
  const rows = loadPack(file)
  let inserted = 0
  const refused = []
  for (const r of rows) {
    const problem = lib.validateBody(r.persona, r.body, { allowPlaceholders: true })
    if (problem) { refused.push({ code: r.code, problem }); continue }
    const res = await db.query(
      `INSERT INTO outreach_library_templates (persona, number, body, active, source, updated_by, code, intent, required_context, review_status)
       VALUES ($1, (SELECT COALESCE(MAX(number),0)+1 FROM outreach_library_templates WHERE persona=$1), $2, TRUE, 'kev_pack_v1_1', $3, $4, $5, $6, 'pending_review')
       ON CONFLICT (code) WHERE code IS NOT NULL DO NOTHING RETURNING id`,
      [r.persona, r.body, actor, r.code, r.intent, r.requiredContext])
    inserted += res.rows.length
  }
  return { parsed: rows.length, inserted, refused }
}

module.exports = { parse, loadPack, importPack, PLACEHOLDERS }
