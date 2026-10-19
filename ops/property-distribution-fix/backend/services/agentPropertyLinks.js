'use strict'

const PUBLIC_CRM_URL = (process.env.PUBLIC_CRM_URL || 'https://crm.2906.estate').replace(/\/$/, '')

function propertyActionLinks(ref) {
  const encodedRef = encodeURIComponent(String(ref || '').trim())
  if (!encodedRef) return null
  const base = `${PUBLIC_CRM_URL}/schedule-board?ref=${encodedRef}`
  return {
    detail: `${base}&action=detail`,
    book: `${base}&action=book`,
    media: `${base}&action=media`,
  }
}

function withPropertyLink(text, ref) {
  if (/\/schedule-board\?ref=/i.test(String(text || ''))) return text
  const links = propertyActionLinks(ref)
  if (!links) return text
  return `${text}\nOpen property: ${links.detail}`
}

function withAvailableActions(text, ref) {
  const links = propertyActionLinks(ref)
  if (!links) return text
  return `${text}\n\nOpen property / ask again: ${links.detail}\nBook viewing: ${links.book}\nOpen / download photos: ${links.media}`
}

function classifyAgentAvailabilityDecision(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '')
  if (/^still\s+(?:av|available)$/.test(normalized)) return 'available'
  if (normalized === 'rented') return 'rented'
  if (normalized === 'not sure') return 'not_sure'
  return null
}

function agentDecisionPrompt(ref) {
  return withPropertyLink(
    `Reply with exactly one option for #${ref}:\nStill available\nRented\nNot sure`,
    ref)
}

module.exports = {
  propertyActionLinks,
  withPropertyLink,
  withAvailableActions,
  classifyAgentAvailabilityDecision,
  agentDecisionPrompt,
}
