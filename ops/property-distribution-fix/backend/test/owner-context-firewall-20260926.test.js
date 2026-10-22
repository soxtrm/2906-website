'use strict'
const assert = require('assert')
const fs = require('fs')
const db = require('/app/db')
const gate = require('/app/services/ownerSendGate')
const av = require('/app/services/availability')
const auto = require('/app/services/autoOwnerConversation')

let pass = 0
async function t(name, fn) {
  await fn()
  pass++
  console.log(`  ok  ${name}`)
}

;(async () => {
  console.log('=== owner context firewall 2026-09-26 ===')

  await t('bare phone number is contact data, not an availability reply', async () => {
    assert.strictEqual(av.isContactOrTransportOnly({ type: 'chat' }, '+356 9999 0000'), true)
    assert.strictEqual(av.isContactOrTransportOnly({ type: 'contact' }, 'John'), true)
    assert.strictEqual(av.isContactOrTransportOnly({ type: 'chat' }, "No, it's rented"), false)
  })

  await t('WAHA timestamps are normalized without inventing an event time', async () => {
    assert.strictEqual(av.inboundEventMs({ timestamp: 1_800_000_000 }), 1_800_000_000_000)
    assert.strictEqual(av.inboundEventMs({ timestamp: 1_800_000_000_123 }), 1_800_000_000_123)
    assert.strictEqual(av.inboundEventMs({}), null)
  })

  await t('sending-account persona selects the agency answer', async () => {
    assert.strictEqual(await auto.approvedAgencyAnswer('Cedric'), auto.CEDRIC_AGENCY_ANSWER)
    assert.strictEqual(await auto.approvedAgencyAnswer('Gabriela'), auto.GABRIELA_AGENCY_ANSWER)
    assert.strictEqual(await auto.approvedAgencyAnswer('default'), auto.KEVIN_AGENCY_ANSWER)
    assert.strictEqual(await auto.approvedAgencyAnswer('Argus2'), auto.KEVIN_AGENCY_ANSWER)
  })

  await t('registered WhatsApp/admin account can never become owner evidence', async () => {
    const admin = (await db.query(
      `SELECT phone, session_name FROM whatsapp_accounts WHERE is_active=TRUE AND phone IS NOT NULL ORDER BY id LIMIT 1`
    )).rows[0]
    assert.ok(admin, 'need an active WhatsApp account fixture')
    const p = await av.verifiedInboundOwnerPhone({
      session: admin.session_name, senderPhone: admin.phone, chatId: `${admin.phone}@c.us`,
    })
    assert.strictEqual(p, null)
  })

  await t('unknown LID cannot use a session-wide open-check fallback', async () => {
    const original = gate.resolveChatPhone
    gate.resolveChatPhone = async () => null
    try {
      const before = Number((await db.query(`SELECT count(*) n FROM availability_checks WHERE status='awaiting'`)).rows[0].n)
      const r = await av.handleOwnerReply({
        payload: { id: 'FIREWALL-LID', fromMe: false, timestamp: Math.floor(Date.now()/1000), type: 'chat' },
        session: 'default', text: "No, it's rented", senderPhone: '227590', chatId: '227590@lid',
      })
      const after = Number((await db.query(`SELECT count(*) n FROM availability_checks WHERE status='awaiting'`)).rows[0].n)
      assert.deepStrictEqual(r, { matched: false })
      assert.strictEqual(after, before)
    } finally { gate.resolveChatPhone = original }
  })

  await t('plain property-group rented text is never queued for mutation', async () => {
    const src = fs.readFileSync('/app/routes/webhook.js', 'utf8')
    const propertyBranch = src.slice(src.indexOf("if (groupCfg.group_type === 'property')"), src.indexOf("} else if (groupCfg.group_type === 'client')"))
    assert.ok(propertyBranch.includes('explicit authorized command required'))
    assert.ok(!propertyBranch.includes("addJob('rented'"))
  })

  console.log(`\n${pass} passed, 0 failed`)
  await db.end().catch(() => {})
  process.exit(0)
})().catch(async err => {
  console.error(err.stack || err)
  await db.end().catch(() => {})
  process.exit(1)
})
