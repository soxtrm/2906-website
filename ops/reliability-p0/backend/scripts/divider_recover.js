'use strict'
// Recovers divider packages that arrived before the divider flow existed.
// Runs the SAME code path as a live divider (services/dividerUpload.handleDivider):
// review intake, internal draft, not published, idempotent per divider message.
//
//   node scripts/divider_recover.js <session> <groupId> --dry            list what would run
//   node scripts/divider_recover.js <session> <groupId> <dividerStanzaId> [...]
//   node scripts/divider_recover.js <session> <groupId> --until=<unixTs> --sender=<stanza of any message of that sender>
//        closes a package that never got its "..." with a synthetic divider at <unixTs>
const waha = require('../waha')
const upload = require('../handlers/upload')
const ul = require('../handlers/uploadListing')
const du = require('../services/dividerUpload')

;(async () => {
  const [session, chatId, ...rest] = process.argv.slice(2)
  const opt = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')).map(([k, v]) => [k, v ?? true]))
  const ids = rest.filter(a => !a.startsWith('--'))
  const msgs = (await waha.getChatMessages(session, chatId, 400)).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  const targets = []
  if (opt.until) {
    const like = msgs.find(m => du.stanzaOf(m) === opt.sender)
    if (!like) throw new Error('sender reference message not found')
    if (like.hasMedia || !du.isDivider(String(like.body || ''))) throw new Error('--sender must reference a "..." message written by that sender')
    targets.push({ ...like, id: `false_${chatId}_SYNTH${opt.until}_${String(like.id).split('_').pop()}`, timestamp: Number(opt.until), body: '...' })
  }
  for (const id of ids) { const m = msgs.find(x => du.stanzaOf(x) === id); if (!m) throw new Error('divider not found: ' + id); targets.push(m) }
  for (const d of targets) {
    const phone = await ul.extractSenderPhone(d, session, true)
    const agent = phone ? await ul.resolveAgent(phone) : null
    const pack = du.assemblePackage(msgs, d, { keyOf: du.senderKey })
    console.log(JSON.stringify({ divider: du.stanzaOf(d), at: new Date(d.timestamp * 1000).toISOString(), agent: agent && (agent.username || agent.name), media: pack.mediaCount, chars: pack.text.length, complete: pack.complete, head: pack.text.split('\n')[0].slice(0, 60) }))
    if (opt.dry) continue
    const handled = await du.handleDivider({ payload: d, session, chatId, uploaderPhone: phone, agent, run: upload.cmdUpload, reply: (s, c, t) => require('../lib/sessionRouter').sendVia(s, c, t), settleMs: 0, historyLimit: 400 })
    console.log('handled:', handled)
  }
  const db = require('../db')
  const r = await db.query(`SELECT id, state, media_expected, media_imported, property_ids, property_refs, failure_reason, summary FROM upload_packages WHERE chat_id = $1 ORDER BY id`, [chatId])
  for (const x of r.rows) console.log(JSON.stringify(x))
  setTimeout(() => process.exit(0), 3000)
})().catch(e => { console.error('recover failed:', e.stack || e.message); process.exit(1) })
