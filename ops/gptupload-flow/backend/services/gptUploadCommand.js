'use strict'

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

module.exports = { GPT_COMMAND_RE, UPLOAD_COMMAND_RE, parseUploadCommand, stripUploadCommands }
