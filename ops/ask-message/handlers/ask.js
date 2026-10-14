'use strict'
// ============================================================================
// handlers/ask.js — !ask <ref> <question> command (confirm-then-send, same
// pattern as handlers/book.js / handlers/av.js).
//
// Calls the exact same functions the Board's own Ask button does
// (routes/crmScheduleBoard.js /ask/preview + /ask/send):
//   - services/boardAsk.js composeQuestion() — the Gemini rewrite, agent
//     confirms before anything sends (here: the Yes/No prompt below)
//   - services/ownerAsk.js owner/contact resolution and the same audit table
//   - services/bookRelay.js openBoardThread() (Fall A, own listing) /
//     services/listingAgentNotify.js sendComment() (Fall B, someone else's)
//     for delivery — the owner's reply then rides the same relay thread the
//     Board's Ask button opens, so the Default-account feedback loop
//     (services/bookRelay.js sendToAgentPrivate) is inherited for free, not
//     rebuilt here.
//   - the same owner_contact_log row shape, so this command's questions show
//     up in the Board's own history/limit counters exactly like a button ask.
//
// Command path and Button path therefore produce the same DB rows and go
// out through the same account-selection logic — not a second, hand-synced
// implementation.
// ============================================================================

const db       = require('../db')
const log      = require('../logger')
const waha     = require('../waha')
const boardAsk = require('../services/boardAsk')
const ownerAsk = require('../services/ownerAsk')

const pending = new Map()
const PENDING_TTL_MS = 5 * 60 * 1000
function setPending(chatId, info) {
  pending.set(String(chatId), info)
  const t = setTimeout(() => pending.delete(String(chatId)), PENDING_TTL_MS)
  if (t && typeof t.unref === 'function') t.unref()
}

async function reply(session, chatId, text) {
  try { return await waha.sendText(session, chatId, text) }
  catch { /* best-effort */ }
}

// Same shape loadForAction() builds in crmScheduleBoard.js, minus the fields
// only the board's other buttons need. Same bare-numeric convenience
// services/availability.js:resolveProperty gives !av ('247' -> '2906-247') —
// !ask has to accept the same shorthand or it reads as broken next to !book/!av.
const PROP_COLS = `p.id, p.ref, p.town, p.listed_by_agent_id,
            a.id AS agent_id, a.username AS agent_username, a.name AS agent_name,
            a.whatsapp_phones, a.whatsapp_session, a.active AS agent_active`
async function loadPropForAsk(rawRef) {
  const ref = String(rawRef || '').trim().replace(/^#/, '')
  if (!ref || !/^[\w-]{1,24}$/.test(ref)) return null
  let r = await db.query(
    `SELECT ${PROP_COLS} FROM properties p LEFT JOIN agents a ON a.id = p.listed_by_agent_id
      WHERE LOWER(p.ref) = LOWER($1) LIMIT 1`, [ref])
  if (r.rows.length) return r.rows[0]
  if (/^\d{1,6}$/.test(ref)) {
    // GREATEST(3, LENGTH($1)): plain LPAD($1,3,'0') TRUNCATES a 4-digit ref
    // ('9101' -> '910') instead of leaving it alone — Postgres LPAD always
    // returns exactly its target length. availability.js:resolveProperty
    // has this same 3-digit assumption (fine for the old '2906-042' refs,
    // silently wrong for every current '2906-9101'-style one); not touched
    // here, but !ask must not inherit the bug by copying it.
    r = await db.query(
      `SELECT ${PROP_COLS} FROM properties p LEFT JOIN agents a ON a.id = p.listed_by_agent_id
        WHERE p.ref ILIKE '%-' || LPAD($1, GREATEST(3, LENGTH($1)), '0')
        ORDER BY p.id DESC LIMIT 1`, [ref])
    if (r.rows.length) return r.rows[0]
  }
  return null
}

async function cmdAsk(session, chatId, arg, ctx = {}) {
  const { senderPhone = '', realSenderPhone = null, payload = null } = ctx
  const t = String(arg || '').trim()
  const m = t.match(/^(\S+)(?:\s+([\s\S]+))?$/)
  if (!m) {
    await reply(session, chatId,
      '❓ *!ask <ref> <question>*\n\nOr reply to a question with *!ask <ref>*\nExample: !ask 247 pets ok?')
    return
  }
  const [, refArg, inlineNote] = m
  const quotedNote = payload ? require('../lib/quotedMessage').quotedFromPayload(payload).body : null
  const note = String(inlineNote || quotedNote || '').trim()
  if (!note) {
    await reply(session, chatId,
      '❓ Add the question after the reference, or reply to the customer question with *!ask <ref>*.')
    return
  }

  const prop = await loadPropForAsk(refArg)
  if (!prop) { await reply(session, chatId, `❌ Property ${refArg} not found.`); return }

  const askPhone = realSenderPhone || senderPhone
  const agent = await ownerAsk.resolveAgentByPhone(askPhone)
  if (!agent) {
    await reply(session, chatId,
      `❌ Could not match your number to an active agent. Ask from the number on your board profile.`)
    return
  }

  const isMine = !!(prop.listed_by_agent_id && prop.listed_by_agent_id === agent.id)

  const owner = isMine ? await ownerAsk.ownerFor(prop.id) : null
  if (isMine && (!owner || !owner.phone_normalized || owner.do_not_contact)) {
    await reply(session, chatId,
      `❌ This owner cannot be contacted right now (#${prop.ref}).`)
    return
  }

  const recipientName = isMine ? null : (ownerAsk.humanName(prop.agent_name) || prop.agent_username || null)

  let composed
  try {
    composed = await boardAsk.composeQuestion({
      mode: isMine ? 'owner' : 'agent',
      ref: prop.ref,
      agentName: agent.name || agent.display_name || agent.username,
      recipientName,
      rawNote: note,
      isReachout: isMine ? await ownerAsk.isReachout(owner.phone_normalized, prop.id) : false,
    })
  } catch (err) {
    await reply(session, chatId, `❌ ${err.message}`)
    return
  }

  setPending(chatId, {
    ref: prop.ref, propertyId: prop.id, prop, isMine,
    text: composed.text,
    agentId: agent.id, agentName: agent.name || agent.display_name || agent.username,
    agentPhone: agent.notify_whatsapp || (agent.whatsapp_phones || [])[0] || askPhone,
  })

  await reply(session, chatId,
    `❓ Send to ${isMine ? 'the owner' : (recipientName || 'the listing agent')} of *#${prop.ref}*:\n\n"${composed.text}"\n\n` +
    `Reply *Yes* to send, *No* to cancel.`)
}

// Called for ANY incoming message; consumes a pending !ask confirm or
// returns false so the normal dispatcher keeps going. Mirrors
// handlers/book.js:cmdBookConfirm exactly.
async function cmdAskConfirm({ session, chatId, text }) {
  const key = String(chatId)
  const p = pending.get(key)
  if (!p) return false

  const t = String(text || '').trim().toLowerCase()
  if (!t) return false
  if (t === 'no' || t === 'n' || t === 'cancel') {
    pending.delete(key)
    await reply(session, chatId, 'Cancelled.')
    return true
  }
  if (t !== 'yes' && t !== 'y') return false
  pending.delete(key)

  try {
    const now      = new Date()
    const inWindow = boardAsk.insideWindow(now)
    const sendAt   = inWindow ? now : boardAsk.nextSendTime(now)
    const day      = boardAsk.maltaDay(sendAt)
    const owner    = p.isMine ? await ownerAsk.ownerFor(p.propertyId) : null

    // Same table, same columns as routes/crmScheduleBoard.js /ask/send —
    // this is what makes the daily cap and the Board's own history list
    // see a command-sent question exactly like a button-sent one.
    const ins = await db.query(
      `INSERT INTO owner_contact_log
         (owner_contact_id, owner_phone, property_id, ref, agent_id, kind, status,
          body, scheduled_for, malta_day, is_mine, agent_name, agent_phone)
       VALUES ($1,$2,$3,$4,$5,'question',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [owner ? owner.id : null,
       owner ? owner.phone_normalized : `agent:${p.prop.listed_by_agent_id || 0}`,
       p.propertyId, p.ref, p.agentId,
       inWindow ? 'sent' : 'queued',
       p.text, sendAt, day, p.isMine, p.agentName, p.agentPhone])
    const logId = ins.rows[0].id

    if (!inWindow) {
      await reply(session, chatId,
        `⏳ Queued — outside the ${boardAsk.WINDOW_START_HOUR}:00–${boardAsk.WINDOW_END_HOUR}:00 Malta window. Goes out at 08:00.`)
      return true
    }

    if (p.isMine) {
      // Fall A — opens/uses this agent's Board relay thread for this
      // listing, exactly like the Board's own Ask button. The owner's
      // reply rides that thread from here: services/bookRelay.js already
      // forwards it to the agent's private number on the Default account
      // (sendToAgentPrivate) — nothing new to wire up for the feedback loop.
      const bookRelay = require('../services/bookRelay')
      const opened = await bookRelay.openBoardThread({
        ref: p.ref, agentId: p.agentId, agentName: p.agentName,
        agentPhone: p.agentPhone, initialText: p.text, action: 'question',
      })
      if (!opened.ok) throw new Error(opened.message || 'Could not reach the owner.')
    } else {
      // Fall B — relayed to the listing agent, same as the Board's comment button.
      const notify = require('../services/listingAgentNotify')
      await notify.sendComment({
        operator: { email: null, name: p.agentName },
        ref: p.ref, note: p.text,
        agentRow: {
          id: p.prop.agent_id, username: p.prop.agent_username, name: p.prop.agent_name,
          whatsapp_phones: p.prop.whatsapp_phones || [], whatsapp_session: p.prop.whatsapp_session,
        },
      })
    }
    await db.query(`UPDATE owner_contact_log SET sent_at = now() WHERE id = $1`, [logId])
    await reply(session, chatId,
      p.isMine ? `✅ Sent to the owner of #${p.ref}.` : `✅ Sent to ${p.prop.agent_name || p.prop.agent_username}.`)
  } catch (err) {
    log.warn('[ask] send failed', { ref: p.ref, err: err.message })
    await reply(session, chatId, `❌ Could not send: ${err.message.slice(0, 200)}`)
  }
  return true
}

module.exports = { cmdAsk, cmdAskConfirm }
