'use strict'
// Closes: owner capability tokens accepted as staff sessions by routes/crm.js.
// (Claude, 2026-11-16; see README.md in this folder.)
//
//   node apply-crm-auth-fix.js /opt/2906-system/backend/routes/crm.js            # dry run: shows the change
//   node apply-crm-auth-fix.js /opt/2906-system/backend/routes/crm.js --write    # backup + patch + syntax check
//
// Idempotent. Refuses to touch a file whose auth() does not look exactly like
// the reviewed one, so a production drift is reported instead of guessed.
const fs = require('fs')
const { execFileSync } = require('child_process')

const MARKER = '// staff-audience-guard v1'
const ANCHOR = [
  "  if (payload.aud === 'board') {",
  "    return res.status(403).json({ error: 'Board account — no access to CRM data.' })",
  '  }',
].join('\n')
const GUARD = [
  `  ${MARKER}: only staff sessions reach this router. Owner capability`,
  "  // tokens (aud 'owner-upload', …) share JWT_SECRET but carry no agent id.",
  "  // Legacy staff tokens without aud still need a numeric agent id.",
  "  if ((payload.aud && payload.aud !== 'crm') || !Number.isInteger(payload.id)) {",
  "    return res.status(401).json({ error: 'Session invalid or expired' })",
  '  }',
].join('\n')

// Works on LF and CRLF files alike (some snapshots were deployed from Windows).
function patch(src) {
  if (src.includes(MARKER)) return { src, changed: false, reason: 'already patched' }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const anchor = ANCHOR.split('\n').join(eol)
  const guard = GUARD.split('\n').join(eol)
  const authStart = src.indexOf('function auth(req, res, next) {')
  if (authStart < 0) throw new Error('auth() not found — file differs from the reviewed snapshot; patch by hand')
  const at = src.indexOf(anchor, authStart)
  if (at < 0 || at - authStart > 1200) throw new Error('board check inside auth() not found — file differs from the reviewed snapshot; patch by hand')
  if (src.indexOf(anchor, at + anchor.length) >= 0) throw new Error('board check appears twice — refusing to guess')
  const end = at + anchor.length
  return { src: `${src.slice(0, end)}${eol}${guard}${src.slice(end)}`, changed: true, eol: eol === '\r\n' ? 'CRLF' : 'LF' }
}

if (require.main === module) {
  const file = process.argv[2]
  const write = process.argv.includes('--write')
  if (!file) { console.error('usage: node apply-crm-auth-fix.js <routes/crm.js> [--write]'); process.exit(2) }
  const before = fs.readFileSync(file, 'utf8')
  const out = patch(before)
  if (!out.changed) { console.log(`${file}: ${out.reason}`); process.exit(0) }
  console.log(`${file}: will insert after the board check in auth():\n${GUARD}\n`)
  if (!write) { console.log('dry run — re-run with --write to apply'); process.exit(0) }
  const backup = `${file}.bak-staff-audience-${new Date().toISOString().replace(/[:.]/g, '')}`
  fs.copyFileSync(file, backup)
  fs.writeFileSync(file, out.src)
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }) }
  catch { fs.copyFileSync(backup, file); console.error('syntax check failed — original restored'); process.exit(1) }
  console.log(`patched. backup: ${backup}`)
}
module.exports = { patch, MARKER, GUARD, ANCHOR }
