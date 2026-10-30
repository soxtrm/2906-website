'use strict'

const { randomUUID } = require('crypto')
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const { addJob } = require('../queues')
const outreachIdentity = require('./outreachIdentity')

const DEFAULT_PACING_MODE = process.env.OUTREACH_PARITY_PACING_MODE || 'mixed'
const RECHECK_DELAY_MS = Math.max(60_000, Number(process.env.OUTREACH_RECHECK_DELAY_MS) || 5 * 60_000)
const TERMINAL = new Set(['sent', 'failed', 'skipped'])

const normPhone = value => String(value || '').replace(/\D/g, '')
const safeJobId = value => String(value).replace(/:/g, '-')

function transportOutcomeUnknown(err) {
  const value = `${err?.name || ''} ${err?.code || ''} ${err?.message || ''}`.toLowerCase()
  return /abort|timeout|timed out|etimedout|econnreset|socket hang up|fetch failed|network/.test(value)
}

async function enqueueOutreachRun({
  triggerId, source, session, replySession = null, initiatedBy = null,
  template, contacts, pacingMode = DEFAULT_PACING_MODE, planId = null, runAfter = new Date(),
}) {
  if (!triggerId || !source || !session) throw new Error('triggerId, source and session are required')
  if (!pacingMode) throw new Error('explicit pacingMode is required')
  const normalized = (contacts || []).map(contact => ({ ...contact, phone: normPhone(contact.phone || contact.phone_normalized) })).filter(c => c.phone)
  if (!normalized.length) throw new Error('at least one contact is required')
  const identity = await outreachIdentity.resolveSenderIdentity(session)
  if (!identity) throw new Error(`sender identity unavailable for ${session}`)
  const foreign = outreachIdentity.findForeignSignatures(template, identity.persona)
  if (foreign.length) throw new Error(outreachIdentity.describeMismatch(identity, foreign))
  const runId = randomUUID()
  const inserted = await db.query(
    `INSERT INTO outreach_runs
       (run_id,trigger_id,source,plan_id,session_name,reply_session,initiated_by,
        sender_identity,message_template,contacts,pacing_mode,status,run_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready',$12)
     ON CONFLICT (source,trigger_id) DO NOTHING RETURNING *`,
    [runId, String(triggerId), source, planId, session, replySession, initiatedBy,
     JSON.stringify(identity), String(template || ''), JSON.stringify(normalized), pacingMode, runAfter]
  )
  let run = inserted.rows[0]
  if (!run) run = (await db.query(`SELECT * FROM outreach_runs WHERE source=$1 AND trigger_id=$2`, [source, String(triggerId)])).rows[0]
  if (!run) throw new Error('failed to persist outreach run')
  if (inserted.rows.length) {
    for (const contact of normalized) {
      await db.query(
        `INSERT INTO outreach_run_recipients(run_id,normalized_phone,display_name,payload)
         VALUES($1,$2,$3,$4) ON CONFLICT(run_id,normalized_phone) DO NOTHING`,
        [run.run_id, contact.phone, contact.name || null, JSON.stringify(contact)]
      )
    }
    const delay = Math.max(0, new Date(run.run_after).getTime() - Date.now())
    await addJob('outreach-run', { runId: run.run_id }, { attempts: 1, delay, jobId: safeJobId(`outreach-run-${run.run_id}`) })
  }
  return run
}

async function claimReadyRun(runId) {
  const result = await db.query(
    `UPDATE outreach_runs SET status='claimed',claimed_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW()
      WHERE run_id=$1 AND status='ready' AND run_after<=NOW() RETURNING *`, [runId])
  return result.rows[0] || null
}

async function claimHeldRun(runId) {
  const result = await db.query(
    `UPDATE outreach_runs SET status='claimed',claimed_at=NOW(),updated_at=NOW()
      WHERE run_id=$1 AND status='held' AND run_after<=NOW() RETURNING *`, [runId])
  return result.rows[0] || null
}

function bodyOf(message) {
  return String(message?.body ?? message?.text?.body ?? message?.text ?? message?.message?.conversation ?? '')
}

async function reconcileRecipient(run, recipient) {
  const chatId = `${recipient.normalized_phone}@s.whatsapp.net`
  let messages
  try {
    messages = await waha.getChatMessagesStrict(run.session_name, chatId, 30)
  } catch (err) {
    // This recipient already crossed the pre-wire `sending` checkpoint.
    // Keep it ambiguous while history is unavailable; `held` is reserved for
    // contacts whose pre-send history check failed and are safe to recheck.
    await db.query(`UPDATE outreach_run_recipients SET state='ambiguous',last_error=$3,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`,
      [run.run_id, recipient.normalized_phone, `history_unknown:${err.message}`])
    return 'ambiguous'
  }
  const started = new Date(recipient.sending_started_at || run.started_at || run.created_at).getTime() - 30_000
  const match = messages.find(message => message?.fromMe === true
    && ((Number(message.timestamp || 0) * 1000) >= started)
    && bodyOf(message).trim() === String(recipient.rendered_message || '').trim())
  if (match) {
    await db.query(`UPDATE outreach_run_recipients SET state='sent',sent_at=COALESCE(sent_at,TO_TIMESTAMP($3)),last_error=NULL,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`,
      [run.run_id, recipient.normalized_phone, Number(match.timestamp || Date.now() / 1000)])
    return 'sent'
  }
  await db.query(`UPDATE outreach_run_recipients SET state='ambiguous',last_error='accepted_send_not_found_in_history',updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`,
    [run.run_id, recipient.normalized_phone])
  return 'ambiguous'
}

// `at` (2026-10-29): a run paused by the 19:30 cutoff resumes at the next
// 08:30 window start instead of re-waking every 5 minutes overnight.
async function scheduleRecheck(runId, at = null) {
  const runAfter = at ? new Date(Math.max(Date.now() + 60_000, new Date(at).getTime())) : new Date(Date.now() + RECHECK_DELAY_MS)
  const delay = Math.max(0, runAfter.getTime() - Date.now())
  await db.query(`UPDATE outreach_runs SET status='held',run_after=$2,updated_at=NOW() WHERE run_id=$1`, [runId, runAfter])
  await addJob('outreach-run', { runId, recheck: true }, {
    attempts: 1, delay,
    jobId: safeJobId(`outreach-recheck-${runId}-${runAfter.getTime()}`),
  })
}

async function executeOutreachRun(runId) {
  let run = await claimReadyRun(runId)
  if (!run) run = await claimHeldRun(runId)
  if (!run) return { claimed: false }
  const client = await db.connect()
  const lockKey = `outreach-session:${String(run.session_name).toLowerCase()}`
  let dispatchResult = null
  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [lockKey])
    const recipients = (await db.query(
      `SELECT * FROM outreach_run_recipients WHERE run_id=$1 AND state IN ('pending','held','sending','ambiguous') ORDER BY id`, [run.run_id])).rows

    for (const recipient of recipients.filter(r => r.state === 'sending' || r.state === 'ambiguous')) {
      await reconcileRecipient(run, recipient)
    }
    const sendableRows = (await db.query(
      `SELECT * FROM outreach_run_recipients WHERE run_id=$1 AND state IN ('pending','held') ORDER BY id`, [run.run_id])).rows
    if (sendableRows.length) {
      const lifecycle = {
        beforeSend: async (phone, renderedMessage) => {
          const result = await db.query(
            `UPDATE outreach_run_recipients
                SET state='sending',rendered_message=$3,sending_started_at=NOW(),attempt_count=attempt_count+1,last_error=NULL,updated_at=NOW()
              WHERE run_id=$1 AND normalized_phone=$2 AND state IN ('pending','held') RETURNING id`,
            [run.run_id, normPhone(phone), renderedMessage])
          if (!result.rows.length) throw Object.assign(new Error('recipient is no longer sendable'), { code: 'RECIPIENT_NOT_SENDABLE' })
        },
        sent: async phone => db.query(`UPDATE outreach_run_recipients SET state='sent',sent_at=NOW(),last_error=NULL,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2 AND state='sending'`, [run.run_id, normPhone(phone)]),
        failed: async (phone, err) => db.query(`UPDATE outreach_run_recipients SET state='failed',last_error=$3,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`, [run.run_id, normPhone(phone), String(err?.message || err)]),
        ambiguous: async (phone, err) => db.query(`UPDATE outreach_run_recipients SET state='ambiguous',last_error=$3,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`, [run.run_id, normPhone(phone), String(err?.message || err)]),
        held: async (phone, reason) => db.query(`UPDATE outreach_run_recipients SET state='held',last_error=$3,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`, [run.run_id, normPhone(phone), String(reason || 'history_unknown')]),
        skipped: async (phone, reason) => db.query(`UPDATE outreach_run_recipients SET state='skipped',last_error=$3,updated_at=NOW() WHERE run_id=$1 AND normalized_phone=$2`, [run.run_id, normPhone(phone), String(reason || 'skipped')]),
        transportOutcomeUnknown,
      }
      await db.query(`UPDATE outreach_runs SET status='running',updated_at=NOW() WHERE run_id=$1`, [run.run_id])
      const { runDirectOutreach } = require('./adminCommands')
      dispatchResult = await runDirectOutreach(run.initiated_by, run.reply_session || run.session_name, run.session_name,
        sendableRows.map(row => ({ ...(row.payload || {}), phone: row.normalized_phone, name: row.display_name })),
        run.message_template, {
          planId: run.plan_id, runId: run.run_id, pacingType: run.pacing_mode,
          frozenIdentity: run.sender_identity, sessionLockHeld: true,
          suppressMirroredProgress: true, lifecycle,
        })
    }
    const unresolved = (await db.query(
      `SELECT * FROM outreach_run_recipients WHERE run_id=$1 AND state IN ('sending','ambiguous')`, [run.run_id])).rows
    for (const recipient of unresolved) await reconcileRecipient(run, recipient)
    const counts = (await db.query(`SELECT state,COUNT(*)::int AS n FROM outreach_run_recipients WHERE run_id=$1 GROUP BY state`, [run.run_id])).rows
    const count = Object.fromEntries(counts.map(row => [row.state, row.n]))
    if (run.plan_id) await require('./outreachPlanner').reconcilePlanFromRun(run.plan_id, run.run_id)
    if ((count.held || 0) > 0 || (count.ambiguous || 0) > 0 || (count.sending || 0) > 0 || (count.pending || 0) > 0) {
      await scheduleRecheck(run.run_id, dispatchResult?.resumeAt || null)
      return { claimed: true, status: 'held', counts: count, resumeAt: dispatchResult?.resumeAt || null }
    }
    const status = (count.failed || 0) > 0 && (count.sent || 0) === 0 ? 'failed' : 'completed'
    await db.query(`UPDATE outreach_runs SET status=$2,completed_at=NOW(),updated_at=NOW() WHERE run_id=$1`, [run.run_id, status])
    return { claimed: true, status, counts: count }
  } catch (err) {
    log.error('outreachRunEngine: execution failed', { runId, err: err.message })
    const active = (await db.query(`SELECT COUNT(*)::int AS n FROM outreach_run_recipients WHERE run_id=$1 AND state IN ('sending','ambiguous','held')`, [runId])).rows[0]?.n || 0
    if (active) await scheduleRecheck(runId)
    else await db.query(`UPDATE outreach_runs SET status='failed',last_error=$2,completed_at=NOW(),updated_at=NOW() WHERE run_id=$1`, [runId, err.message])
    throw err
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [lockKey]).catch(() => {})
    client.release()
  }
}

async function recoverInterruptedRuns() {
  await db.query(
    `UPDATE outreach_run_recipients r SET state='ambiguous',last_error='process_interrupted_after_send_started',updated_at=NOW()
      FROM outreach_runs o WHERE r.run_id=o.run_id AND o.status IN ('claimed','running') AND r.state='sending'`)
  const runs = (await db.query(
    `UPDATE outreach_runs SET status='held',run_after=NOW(),last_error='process_interrupted',updated_at=NOW()
      WHERE status IN ('claimed','running') RETURNING run_id`)).rows
  for (const row of runs) {
    await addJob('outreach-run', { runId: row.run_id, recheck: true }, { attempts: 1, jobId: safeJobId(`outreach-recover-${row.run_id}-${Date.now()}`) })
  }
  return runs.length
}

module.exports = {
  DEFAULT_PACING_MODE, enqueueOutreachRun, claimReadyRun, executeOutreachRun,
  recoverInterruptedRuns, reconcileRecipient, transportOutcomeUnknown,
}
