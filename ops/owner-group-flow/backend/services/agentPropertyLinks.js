'use strict'

const PUBLIC_CRM_URL = (process.env.PUBLIC_CRM_URL || 'https://crm.2906.estate').replace(/\/$/, '')

function propertyActionLinks(ref) {
  const encodedRef = encodeURIComponent(String(ref || '').trim())
  if (!encodedRef) return null
  const base = `${PUBLIC_CRM_URL}/schedule-board?ref=${encodedRef}`
  return {
    book: `${base}&action=book`,
    media: `${base}&action=media`,
  }
}

function withAvailableActions(text, ref) {
  const links = propertyActionLinks(ref)
  if (!links) return text
  return `${text}\n\nBook viewing: ${links.book}\nOpen / download photos: ${links.media}`
}

module.exports = { propertyActionLinks, withAvailableActions }
