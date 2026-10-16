'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const patchPath = path.join(
  __dirname,
  '..',
  'ops',
  'owner-group-flow',
  'patches',
  '2026-10-16-whatsapp-command-dispatch.patch')
const patch = fs.readFileSync(patchPath, 'utf8')

assert.match(patch, /'message\.any'/, 'self-authored group commands need message.any')
assert.match(patch, /!waha\.wasSentByBackend\(payload\.id\)/, 'backend echoes must not become commands')
assert.match(patch, /resolvePhone\(session, senderJid\)/, 'opaque group LIDs must be verified')
assert.match(patch, /isGroup && \/@lid\$/, 'LID resolution must stay limited to group senders')

console.log('WhatsApp group command dispatch contract: 4 checks passed')
