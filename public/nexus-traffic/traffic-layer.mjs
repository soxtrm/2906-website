const WEEKDAYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])

export const UNKNOWN_TRAFFIC_STATE = Object.freeze({
  trafficPressure: null,
  trafficClass: 'UNKNOWN',
  confidence: 'UNKNOWN',
  sampleCount: 0,
  daysObserved: 0,
  travelTimeIndex: null,
  speedRatio: null,
  sourceProfile: null,
})

const copyUnknown = () => ({ ...UNKNOWN_TRAFFIC_STATE })

function assertSlot(slot, slots) {
  if (!slots.includes(slot)) throw new RangeError(`Invalid Nexus traffic time slot: ${slot}`)
}

function assertWeekday(weekday) {
  if (weekday != null && !WEEKDAYS.includes(weekday)) throw new RangeError(`Invalid Nexus traffic weekday: ${weekday}`)
}

function stateFor(general, weekdayProfile, segmentId, { weekday, timeSlot }) {
  assertSlot(timeSlot, general.slots)
  assertWeekday(weekday)
  const weekdayState = weekday == null ? null : weekdayProfile.segments?.[segmentId]?.[weekday]?.[timeSlot]
  if (weekdayState && weekdayState.confidence !== 'UNKNOWN') return { ...weekdayState, sourceProfile: 'weekday' }
  const generalState = general.segments?.[segmentId]?.[timeSlot]
  if (generalState && generalState.confidence !== 'UNKNOWN') return { ...generalState, sourceProfile: 'general' }
  return copyUnknown()
}

export async function createNexusTrafficDataSource({
  baseUrl = '/nexus-traffic',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required')
  const read = async name => {
    const response = await fetchImpl(`${baseUrl}/${name}`)
    if (!response.ok) throw new Error(`Nexus traffic artifact unavailable: ${name} (${response.status})`)
    return response.json()
  }
  const [metadata, general, weekdayProfile, mapping] = await Promise.all([
    read('traffic-metadata.json'),
    read('traffic-15min-profile.json'),
    read('traffic-weekday-profile.json'),
    read('traffic-segment-mapping.json'),
  ])
  if (general.slots?.length !== 96 || weekdayProfile.slots?.length !== 96) {
    throw new Error('Nexus traffic profiles must contain exactly 96 quarter-hour slots')
  }

  const getTrafficState = (segmentId, selection) => stateFor(general, weekdayProfile, segmentId, selection)

  const getTrafficSnapshot = ({ weekday = null, timeSlot, includeUnknown = false }) => {
    assertSlot(timeSlot, general.slots)
    assertWeekday(weekday)
    const features = (mapping.segments || []).flatMap(segment => {
      const state = getTrafficState(segment.segmentId, { weekday, timeSlot })
      if (!includeUnknown && state.confidence === 'UNKNOWN') return []
      return [{
        type: 'Feature',
        id: segment.segmentId,
        properties: {
          segmentId: segment.segmentId,
          roadName: segment.roadName ?? null,
          direction: segment.direction ?? null,
          ...state,
        },
        geometry: segment.geometry,
      }]
    })
    return { type: 'FeatureCollection', features }
  }

  const getTrafficTimeline = (segmentId, { weekday = null } = {}) => {
    assertWeekday(weekday)
    return general.slots.map(timeSlot => ({
      timeSlot,
      ...getTrafficState(segmentId, { weekday, timeSlot }),
    }))
  }

  return Object.freeze({
    metadata,
    slots: Object.freeze([...general.slots]),
    weekdays: WEEKDAYS,
    mapping,
    getTrafficState,
    getTrafficSnapshot,
    getTrafficTimeline,
  })
}
