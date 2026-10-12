# Nexus traffic schema

## Actual Google snapshot schema

The collector currently writes one object with snapshot metadata and a `routes` array.

| Field | Meaning | Unit | Nullable | Origin | Classification |
| --- | --- | --- | --- | --- | --- |
| `status` | Provider connection result | enum | No | Collector | Derived status |
| `generatedAt` | Snapshot write time | UTC ISO-8601 | No | Collector clock | Measured timestamp |
| `expiresAt` | Current-cache expiry | UTC ISO-8601 | No | Collector | Derived |
| `batch` | Alternating batch index | integer | No | Collector | Derived |
| `coverage.requested` | Requests planned in this run | count | No | Collector | Derived |
| `coverage.completed` | Requests returning required duration fields | count | No | Collector | Derived |
| `coverage.cachedRoutes` | Fresh route entries retained in current snapshot | count | No | Collector | Derived |
| `routes[].id` | Nexus-owned directional anchor-pair key | string | No | Collector | Derived |
| `routes[].from` / `to` | Nexus-owned public anchor IDs | string | No | Collector | Derived |
| `routes[].distanceMetres` | Returned route distance | metres | Yes | Google Routes | Provider content |
| `routes[].trafficSeconds` | Predicted duration using current traffic | seconds | No for accepted entry | Google Routes `duration` | Provider prediction, not a completed trip measurement |
| `routes[].noTrafficSeconds` | Static duration without traffic conditions | seconds | No for accepted entry | Google Routes `staticDuration` | Provider estimate |
| `routes[].observedAt` | Request completion time | UTC ISO-8601 | No | Collector clock | Measured timestamp |
| `routes[].confidence` | Current collector label (`LIVE`) | enum | No | Collector | Derived label |
| `routes[].source` | Provider label | string | No | Collector | Provenance |
| `routes[].meaning` | Human-readable interpretation | string | No | Collector | Metadata |

## Attributes that do not exist

The source does not return or retain road names, per-road segment IDs, route polylines, per-segment speed, free-flow speed, jam level, lane state, incident state, or traffic along individual streets. The request field mask contains only duration, static duration, and distance.

Of the candidate metrics in the specification, the current source supports only route-level `travel_time_index = trafficSeconds / noTrafficSeconds`. It cannot support a street-level speed ratio or provider congestion class. Because the values are not historically retained, even the route-level index cannot be aggregated across time.

## Normalized layer schema

The isolated layer contract accepts future, properly licensed observations in this form:

```json
{
  "segmentId": "stable-directional-id",
  "weekday": "monday",
  "timeSlot": "17:30",
  "trafficPressure": null,
  "trafficClass": "UNKNOWN",
  "confidence": "UNKNOWN",
  "sampleCount": 0,
  "daysObserved": 0,
  "travelTimeIndex": null,
  "speedRatio": null,
  "median": null,
  "mean": null,
  "p25": null,
  "p75": null,
  "p90": null,
  "minimum": null,
  "maximum": null,
  "standardDeviation": null
}
```

Opposite directions must have different `segmentId` values. Geometry is stored once in the segment mapping and profiles stay compact by keying values to that ID.

No thresholds or pressure formula are selected yet. Choosing them without a retained distribution would manufacture precision.
