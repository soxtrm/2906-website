'use strict'

const UI_STATUS = Object.freeze({
  ACTIVE: 'AI_ACTIVE',
  TAKEOVER: 'AGENT_TAKEOVER',
  PAUSED: 'AI_PAUSED',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
})

function statusText(value) {
  const raw = typeof value === 'string' ? value : value?.status || value?.state || ''
  return String(raw || '').toUpperCase()
}

function deriveAutomationStatus({ connection, assistant, intelligence, standDown, describeBlock = value => value } = {}) {
  let status = UI_STATUS.ACTIVE
  let reason = null
  if (!['WORKING','CONNECTED'].includes(String(connection || '').toUpperCase())) {
    status = UI_STATUS.CONNECTION_ERROR
    reason = `WhatsApp session is ${String(connection || 'unavailable').toLowerCase()}.`
  } else if (intelligence?.automation_status === UI_STATUS.PAUSED) {
    status = UI_STATUS.PAUSED
    reason = intelligence.automation_reason || 'AI was paused explicitly.'
  } else if (assistant?.status === 'HUMAN_ACTIVE' || intelligence?.human_active || standDown === 'human_active') {
    status = UI_STATUS.TAKEOVER
    reason = 'An agent replied manually. AI remains paused until an explicit resume or the configured quiet-window rule completes.'
  } else if (standDown || !assistant?.enabled || ['PAUSED','DISABLED'].includes(String(assistant?.status || '').toUpperCase())) {
    status = UI_STATUS.PAUSED
    reason = standDown ? describeBlock(standDown) : assistant?.disabled_reason || 'Owner automation is not armed for this conversation.'
  }
  return { status, reason }
}

module.exports = { UI_STATUS, statusText, deriveAutomationStatus }
