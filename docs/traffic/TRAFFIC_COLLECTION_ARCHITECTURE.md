# Traffic collection repair

## Exact overwrite root cause

The scheduler invokes `ops/property-routing/google-traffic-scan.cjs`. `currentTraffic()` in `google-traffic.cjs` normalizes Google `duration`, `staticDuration`, and `distanceMeters`. `main()` then calls `atomicWrite()` for `/run/nexus-routing/google-traffic-current.json`. `atomicWrite()` writes a temporary file and renames it over the single current target. No historical insert ever existed, so previous values disappeared by design when the snapshot was replaced.

## Licensing decision

The current Google adapter is declared `snapshotOnly`. The standard Routes policy restricts caching of most Routes content and requires Routes results shown on a map to be shown on a Google Map. The project therefore does not archive Google durations, derive a historical model from them, or export them to Nexus Mapbox. The native Google `TrafficLayer` remains a separate live Google-only view.

`traffic-provider-contract.cjs` makes this enforceable. A future adapter must explicitly declare all three capabilities before the immutable store accepts values:

- historical storage allowed;
- derived aggregates allowed;
- external map rendering allowed.

## Persistence architecture

- **RUNS**: append-only `traffic-scanner-runs.jsonl`; operational metadata only, no provider traffic values.
- **RAW**: append-only `traffic-observations.jsonl`; accepts only a provider that passes the capability gate.
- **CURRENT**: replaceable `google-traffic-current.json`; expiring Google current snapshot.
- **DERIVED**: future 15-minute general, weekday, and segment statistics produced only from RAW.
- **MAP CONTRACT**: compact artifacts under `public/nexus-traffic`; currently all values remain `UNKNOWN`.

Each run now records its actual start, canonical quarter-hour slot, lag, source, expected/successful/failed query counts, duplicate state, collector version, completion status, and error summary. The health file summarizes the last 24 hours without copying provider values.

The process lock is host-wide and contains the owner PID. A live owner yields `DUPLICATE_SKIPPED` before any request. A dead owner is treated as a stale lock and safely replaced. This is the existing project filesystem lock mechanism made crash-aware; it is not an in-memory flag.

## Persistence proof

`tests/traffic-persistence.test.cjs` runs four controlled scans from separate Node processes using a storage-permitted fixture adapter. Counts progress `2 → 4 → 6`, the collector process restarts, then scan four produces `8`. IDs from scans one through three remain byte-for-byte present. A separate policy test proves that the same store rejects the Google current adapter.

This proves the append-only implementation, process-restart durability, and provider gate without spending Google quota or unlawfully persisting Google values. It does not claim that a licensable real-world traffic provider is connected.

## Claude visualization gate

Claude can safely start visualizing only after a real provider passes the three capability declarations, emits stable directional segment IDs plus permitted geometry references, and completes the same four-scan persistence proof with actual observations. Until then, the map contract must continue returning `UNKNOWN` and the Nexus visual map must remain untouched.
