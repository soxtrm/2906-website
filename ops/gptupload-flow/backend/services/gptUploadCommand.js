'use strict'

const crypto = require('crypto')

const GPT_COMMAND_RE = /^!(gptuploadv|gptupload)\s*([1-9])?(?:\s+([SC]))?\b/i
const UPLOAD_COMMAND_RE = /^!upload([1-9])?(?:\s+([SC]))?\b/i

function parseUploadCommand(text) {
  const value = String(text || '').trim()
  const gpt = value.match(GPT_COMMAND_RE)
  if (gpt) {
    const command = gpt[1].toLowerCase()
    return {
      variantSuffix: gpt[2] || '',
      intakeMode: gpt[3] ? (gpt[3].toUpperCase() === 'S' ? 'sale' : 'commercial') : null,
      photoMode: command === 'gptuploadv' ? 'vision' : 'pimp',
    }
  }
  const upload = value.match(UPLOAD_COMMAND_RE)
  if (!upload) return null
  return {
    variantSuffix: upload[1] || '',
    intakeMode: upload[2] ? (upload[2].toUpperCase() === 'S' ? 'sale' : 'commercial') : null,
    photoMode: null,
  }
}

function stripUploadCommands(text) {
  return String(text || '').replace(
    /!(?:gptuploadv|gptupload|upload)\s*[1-9]?\b(?:\s+(?:S|C|force|group|noad)\b)*/gi,
    '')
}

// A single WhatsApp group message is delivered once per connected WAHA
// session. Provider message ids are not stable across those deliveries, so a
// provider-id dedup key can both drop a command (the nominated session never
// saw the group) and execute it twice (two sessions expose different ids).
// Group, provider timestamp and normalized body are stable for the logical
// human action. Keep ordinary chat outside this key; only commands and replies
// to an armed confirmation need cross-session claiming.
function groupCommandDedupKey({ chatId, actorId, timestamp, text } = {}) {
  const body = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase()
  const actor = String(actorId || '').trim().toLowerCase()
  const rawTs = Number(timestamp || 0)
  const ts = rawTs > 1e12 ? Math.floor(rawTs / 1000) : Math.floor(rawTs)
  const actionable = body.startsWith('!') || /^(?:yes|y|no|n|cancel)$/i.test(body)
  if (!chatId || !ts || !actionable) return null
  const digest = crypto.createHash('sha256').update(`${chatId}|${actor}|${ts}|${body}`).digest('hex')
  return `group-command:${digest}`
}

// Backward-compatible name used by the first upload-only deployment.
function uploadEventDedupKey(input = {}) {
  return parseUploadCommand(input.text) ? groupCommandDedupKey(input) : null
}

module.exports = {
  GPT_COMMAND_RE,
  UPLOAD_COMMAND_RE,
  parseUploadCommand,
  stripUploadCommands,
  groupCommandDedupKey,
  uploadEventDedupKey,
}
