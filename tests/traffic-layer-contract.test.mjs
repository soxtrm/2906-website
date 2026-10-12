import assert from 'node:assert/strict'
import test from 'node:test'
import { createNexusTrafficDataSource } from '../public/nexus-traffic/traffic-layer.mjs'

const slots = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

const fixtures = {
  'traffic-metadata.json': { datasetStatus: 'READY' },
  'traffic-15min-profile.json': {
    slots,
    segments: {
      northbound: {
        '08:00': { trafficPressure: 0.62, trafficClass: 'BUSY', confidence: 'HIGH', sampleCount: 10 },
      },
    },
  },
  'traffic-weekday-profile.json': {
    slots,
    segments: {
      northbound: {
        monday: {
          '08:00': { trafficPressure: 0.81, trafficClass: 'VERY_BUSY', confidence: 'MEDIUM', sampleCount: 3 },
        },
      },
    },
  },
  'traffic-segment-mapping.json': {
    segments: [{ segmentId: 'northbound', roadName: 'Example Road', direction: 'northbound', geometry: { type: 'LineString', coordinates: [[14.4, 35.9], [14.41, 35.91]] } }],
  },
}

const fetchImpl = async url => {
  const name = url.split('/').at(-1)
  return name in fixtures
    ? { ok: true, json: async () => fixtures[name] }
    : { ok: false, status: 404, json: async () => ({}) }
}

test('loads exactly 96 slots and prefers a defensible weekday state', async () => {
  const traffic = await createNexusTrafficDataSource({ baseUrl: '/fixtures', fetchImpl })
  assert.equal(traffic.slots.length, 96)
  assert.equal(traffic.getTrafficState('northbound', { weekday: 'monday', timeSlot: '08:00' }).trafficClass, 'VERY_BUSY')
})

test('falls back to the general profile and preserves unknown cells', async () => {
  const traffic = await createNexusTrafficDataSource({ baseUrl: '/fixtures', fetchImpl })
  assert.equal(traffic.getTrafficState('northbound', { weekday: 'tuesday', timeSlot: '08:00' }).trafficClass, 'BUSY')
  assert.deepEqual(traffic.getTrafficState('northbound', { weekday: 'monday', timeSlot: '08:15' }), {
    trafficPressure: null,
    trafficClass: 'UNKNOWN',
    confidence: 'UNKNOWN',
    sampleCount: 0,
    daysObserved: 0,
    travelTimeIndex: null,
    speedRatio: null,
    sourceProfile: null,
  })
})

test('builds a GeoJSON snapshot without modifying base-road geometry', async () => {
  const traffic = await createNexusTrafficDataSource({ baseUrl: '/fixtures', fetchImpl })
  const snapshot = traffic.getTrafficSnapshot({ weekday: 'monday', timeSlot: '08:00' })
  assert.equal(snapshot.type, 'FeatureCollection')
  assert.equal(snapshot.features[0].id, 'northbound')
  assert.equal(snapshot.features[0].properties.trafficPressure, 0.81)
  assert.equal(snapshot.features[0].geometry.type, 'LineString')
})

test('rejects times outside the quarter-hour grid', async () => {
  const traffic = await createNexusTrafficDataSource({ baseUrl: '/fixtures', fetchImpl })
  assert.throws(() => traffic.getTrafficState('northbound', { weekday: 'monday', timeSlot: '08:07' }), RangeError)
})
