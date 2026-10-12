'use strict'

const REQUIRED_CAPABILITIES = Object.freeze([
  'historicalStorageAllowed',
  'derivedAggregatesAllowed',
  'externalMapRenderingAllowed',
])

const GOOGLE_ROUTES_CURRENT = Object.freeze({
  id: 'google-routes-current',
  label: 'Google Maps Routes API',
  historicalStorageAllowed: false,
  derivedAggregatesAllowed: false,
  externalMapRenderingAllowed: false,
  attribution: 'Google Maps',
  retention: 'Ephemeral current snapshot only under the present project policy basis.',
})

function assertProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || !provider.id) throw new TypeError('Traffic provider id is required')
  for (const key of REQUIRED_CAPABILITIES) {
    if (typeof provider[key] !== 'boolean') throw new TypeError(`Traffic provider ${provider.id} must declare ${key}`)
  }
  return provider
}

function assertHistoricalUseAllowed(provider) {
  assertProvider(provider)
  const denied = REQUIRED_CAPABILITIES.filter(key => provider[key] !== true)
  if (denied.length) {
    const error = new Error(`TRAFFIC_PROVIDER_HISTORY_NOT_PERMITTED:${provider.id}:${denied.join(',')}`)
    error.code = 'TRAFFIC_PROVIDER_HISTORY_NOT_PERMITTED'
    throw error
  }
  return provider
}

module.exports = { GOOGLE_ROUTES_CURRENT, assertProvider, assertHistoricalUseAllowed }
