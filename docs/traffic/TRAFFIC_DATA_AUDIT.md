# Nexus traffic data audit

Audit snapshot: 2026-10-12 02:47 Europe/Malta (00:47 UTC)

Operational follow-up: 2026-10-14 03:29 Europe/Malta. The v2 append-only run journal now contains 190 successful records across 190 unique expected slots, with zero failed queries or duplicate starts in the last 24 hours. Historical traffic observations remain zero because the Google adapter is intentionally blocked from the immutable value store. The owner requested persistence on 14 October; the permitted retention boundary and official policy references are recorded in `TRAFFIC_RETENTION_DECISION.md`.

## Result

The repository and production host do **not** contain a 15-day traffic measurement series. The Google traffic collector first produced a successful run on 2026-10-10 at 07:16:03 Europe/Malta. It intentionally keeps only an expiring current snapshot at `/run/nexus-routing/google-traffic-current.json`; every later run replaces that file.

The journal proves that requests ran, but it stores only batch-level counters. It does not retain the returned durations. Those counters cannot be reconstructed into traffic pressure, road speeds, street states, or a 15-minute history.

## Exact inventory

| Item | Verified value |
| --- | --- |
| First successful collector run | 2026-10-10 05:16:03 UTC / 07:16:03 Europe/Malta |
| Last run included in this audit | 2026-10-12 00:46:56 UTC / 02:46:56 Europe/Malta |
| Calendar dates represented by run logs | 3: October 10, 11, and 12 |
| Complete operational calendar days | 1: October 11 |
| Partial operational calendar days | 2: October 10 and 12 |
| Complete days with retained measurements | 0 |
| Successful service runs | 174 |
| Batch-reported completed route responses | 2,088 |
| Persisted historical traffic observations | 0 |
| Persisted directional route snapshots | 24 current entries only |
| Persisted road-segment geometries | 0 |
| Unique canonical road segments | 0 |
| Historical duplicate observations | Not measurable; values were not retained |
| Immediate duplicate service starts | 1 pair, 1.016 seconds apart at initial activation |
| Collector cadence after that duplicate | 900.389–920.318 seconds; median 910.919 seconds |
| Gaps over 20 minutes | 0 |
| Original timestamp convention | UTC ISO-8601 |
| Analysis/display timezone | Europe/Malta |
| Provider | Google Maps Routes API |

Runs by Malta calendar date:

| Date | Successful runs | Distinct local quarter-hour buckets represented in logs |
| --- | ---: | ---: |
| 2026-10-10 | 68 | 67 |
| 2026-10-11 | 94 | 94 |
| 2026-10-12 through 02:46 | 12 | 12 |

The 94 buckets on October 11 do not mean that two quarters were definitively missed. The timer uses `OnUnitActiveSec=15min` plus up to 20 seconds of randomized delay, so launches drift across wall-clock quarter boundaries. There were no intervals longer than 20 minutes.

## Current collector scope

Two alternating batches request six origin/destination pairs in both directions. Together they cover 24 directional corridors between Sliema, St Julian's, Birkirkara, Mellieħa, Marsaskala, Portomaso, Valletta Gate, Mdina Gate, Ċirkewwa, the airport, and Ta' Qali.

This is route-level coverage between selected anchors. It is not a scan of every Malta road and it does not produce stable street-segment identities.

## Files and services checked

- Production systemd units `nexus-google-traffic.service` and `nexus-google-traffic.timer`.
- Production scripts `/opt/nexus-routing/google-traffic-scan.cjs` and `/opt/nexus-routing/google-traffic.cjs`.
- Production run directory and traffic-related files under `/opt`, `/run`, `/var/lib`, and `/var/log`.
- PostgreSQL table names containing `traffic` or `route` where locally accessible on the host; no historical traffic table was found.
- Repository traffic, routing, JSON, JSONL, CSV, SQLite, Parquet, and map references.
- systemd journal from 2026-09-01 through the audit time.

No additional historical traffic store was found.

## Existing map behavior

The internal CRM page `/crm/nexus-map` already uses the Google Maps JavaScript API and can toggle a native `google.maps.TrafficLayer`. That layer is a current provider-rendered view; it is not the collected 15-minute dataset requested by this audit.

The separate public Nexus 3D map uses Mapbox. Google Routes API results must not be copied onto that map under the standard Routes policy. The provider says most Routes content cannot be cached and Routes results displayed on a map must be displayed on a Google Map. See the official [Routes API policies](https://developers.google.com/maps/documentation/routes/policies) and the applicable [Google Maps Platform service terms](https://cloud.google.com/maps-platform/terms/maps-service-terms).

## Consequence

A truthful all-day scrubber cannot be populated from the current files. The prepared profile artifacts therefore contain all 96 valid time slots but no fabricated segment values. Every unresolved state is `UNKNOWN` until a licensable historical source with street geometry is connected.
