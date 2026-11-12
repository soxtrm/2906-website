'use strict'
// Read-only: lists the divider-terminated packages in a group and whether each was imported.
//   node scripts/divider_packages_scan.js <session> <groupId> [limit]
const waha = require('../waha')
const db = require('../db')
const du = require('../services/dividerUpload')

;(async () => {
  const [session, chatId, limit = '400'] = process.argv.slice(2)
  const msgs = (await waha.getChatMessages(session, chatId, Number(limit))).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  const body = m => String(m.body || m._data?.body || m.caption || '').trim()
  console.log('messages', msgs.length, 'from', new Date((msgs[0]?.timestamp || 0) * 1000).toISOString())
  const out = []
  for (const m of msgs) {
    if (m.fromMe || !du.isDivider(body(m))) continue
    const pack = du.assemblePackage(msgs, m, { keyOf: du.senderKey })
    if (!pack.complete) continue
    const known = await db.query(`SELECT id, state, property_refs FROM upload_packages WHERE chat_id = $1 AND divider_stanza_id = $2`, [chatId, du.stanzaOf(m)]).catch(() => ({ rows: [] }))
    out.push({ divider: m.id, at: new Date(m.timestamp * 1000).toISOString(), sender: du.senderKey(m).slice(-6), media: pack.mediaCount, chars: pack.text.length,
      first: new Date(pack.firstTs * 1000).toISOString(), head: pack.text.split('\n')[0].slice(0, 70), package: known.rows[0] || null })
  }
  for (const o of out) console.log(JSON.stringify(o))
  // tail without a closing divider
  const last = msgs.filter(m => !m.fromMe).slice(-60)
  const lastDiv = [...last].reverse().find(m => du.isDivider(body(m)))
  const open = last.filter(m => !lastDiv || m.timestamp > lastDiv.timestamp)
  console.log('after the last divider:', open.length, 'messages,', open.filter(m => m.hasMedia).length, 'media')
  for (const m of open.filter(x => body(x))) console.log('  ', new Date(m.timestamp * 1000).toISOString(), du.senderKey(m).slice(-6), body(m).slice(0, 80).replace(/\n/g, ' | '))
  process.exit(0)
})().catch(e => { console.error('scan failed:', e.message); process.exit(1) })
