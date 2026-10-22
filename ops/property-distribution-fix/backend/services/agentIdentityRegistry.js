'use strict'

const DEFAULT_IDENTITIES = Object.freeze({
  default: {
    name: 'Kevin', brand: '2906', agency: '2906',
    position: 'Independent Real Estate Agent', experience: 'four years',
    clientDescription: 'clients looking for long-term rentals, including working professionals and families depending on the property',
  },
  kevsecond: {
    name: 'Kevin', brand: '2906', agency: '2906',
    position: 'Independent Real Estate Agent', experience: 'four years',
    clientDescription: 'clients looking for long-term rentals, including working professionals and families depending on the property',
  },
  kevthirdd: {
    name: 'Kevin', brand: '2906', agency: '2906',
    position: 'Independent Real Estate Agent', experience: 'four years',
    clientDescription: 'clients looking for long-term rentals, including working professionals and families depending on the property',
  },
  kev40: {
    name: 'Kevin', brand: '2906', agency: '2906',
    position: 'Independent Real Estate Agent', experience: 'four years',
    clientDescription: 'clients looking for long-term rentals, including working professionals and families depending on the property',
  },
  cedric: {
    name: 'Cedric', agency: 'QuickLets', position: 'Rental Agent',
    clientDescription: 'clients looking for long-term rentals, including working professionals and families depending on the property',
  },
  gabriella: {
    name: 'Gabriella', agency: "Sotheby's", position: 'Real Estate Agent',
    clientDescription: 'clients looking for suitable long-term rentals, depending on the property',
  },
})

function configuredOverrides() {
  if (!process.env.ARGUS_AGENT_IDENTITIES_JSON) return {}
  try {
    const parsed = JSON.parse(process.env.ARGUS_AGENT_IDENTITIES_JSON)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

function resolveAgentIdentity(senderAccountId, accountPersona = null) {
  const key = String(senderAccountId || '').trim().toLowerCase()
  const persona = String(accountPersona || '').trim().toLowerCase()
  const overrides = configuredOverrides()
  return overrides[key] || overrides[persona] || DEFAULT_IDENTITIES[key] || DEFAULT_IDENTITIES[persona] || null
}

function agencyAnswer(identity) {
  if (!identity) return null
  const role = identity.position ? `, ${identity.position}` : ''
  const experience = identity.experience ? ` I have ${identity.experience} of experience in real estate.` : ''
  return `I'm ${identity.name} from ${identity.agency}${role}.${experience}`.replace(/\s+/g, ' ').trim()
}

function clientTypeAnswer(identity) {
  if (!identity?.clientDescription) return null
  return `We work with ${identity.clientDescription}.`
}

module.exports = { DEFAULT_IDENTITIES, resolveAgentIdentity, agencyAnswer, clientTypeAnswer }
