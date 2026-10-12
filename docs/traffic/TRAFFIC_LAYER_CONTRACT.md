# Nexus Live Map traffic layer contract

The traffic package is independent of base roads, buildings, properties, POIs, and map controls.

## Files Claude may consume

- `/nexus-traffic/traffic-metadata.json`
- `/nexus-traffic/traffic-15min-profile.json`
- `/nexus-traffic/traffic-weekday-profile.json`
- `/nexus-traffic/traffic-segment-mapping.json`
- `/nexus-traffic/traffic-layer.mjs`

Claude should not read the scanner, API key, systemd unit, routing cache, or property-routing implementation.

## API

```js
const traffic = await createNexusTrafficDataSource()

traffic.getTrafficState(segmentId, {
  weekday: 'monday',
  timeSlot: '17:30'
})

traffic.getTrafficSnapshot({
  weekday: 'monday',
  timeSlot: '17:30'
})

traffic.getTrafficTimeline(segmentId, { weekday: 'monday' })
```

`getTrafficState` uses a weekday value only when that cell exists and is defensible. Otherwise it transparently falls back to the general profile. If neither exists it returns an explicit frozen `UNKNOWN` state.

All 96 slots load in one compact profile request. Scrubbing must not trigger 96 network requests.

## Layer placement

1. Nexus base map
2. Existing roads
3. `nexus-traffic-pressure` independent line layer
4. Properties, buildings, POIs, and Nexus UI

Suggested source ID: `nexus-traffic-segments`. Suggested layer ID: `nexus-traffic-pressure`. Visibility and selection state belong to this layer only:

```js
trafficLayer.visible = true
trafficLayer.time = '17:30'
trafficLayer.day = 'monday'
```

Do not mutate or replace road geometry. Do not merge opposite directions. Styling must preserve `UNKNOWN` and low-confidence states rather than interpolating them into apparent certainty.

## Current readiness

The contract is ready. The dataset is intentionally empty because no licensable historical street observations were found. Claude must keep the layer disabled or show a coverage state until `traffic-metadata.json` reports `READY`.
