# Traffic retention decision

Decision recorded: 2026-10-14 03:29 Europe/Malta

## Requested outcome

The project owner explicitly requested that the traffic collection be saved. The request is implemented to the maximum extent allowed by the current provider contract:

- scanner-run metadata is append-only and durable;
- health and coverage summaries are retained without provider traffic values;
- the latest Google Routes snapshot remains short-lived and replaceable;
- raw Google route durations, traffic durations, distance values, and derivatives are not added to the historical observation store;
- the provider-neutral immutable observation store remains ready for a source whose licence expressly allows historical storage, derived aggregates, and external-map rendering.

## Why Google values are not archived

The billing address may be within the EEA, so the stricter EEA terms are the safe basis until the billing entity is confirmed otherwise. Google Maps Platform's EEA Terms prohibit caching Google Maps Content unless the service-specific terms expressly permit it. The Routes API exception expressly covers temporary latitude/longitude caching for up to 30 days; it does not grant historical storage of route durations or traffic durations. The Routes policy also states that caching of most Routes content is restricted and that Routes results displayed on a map require Google attribution and the applicable Google-map treatment.

Official references checked 2026-10-14:

- [Google Maps Platform EEA Terms of Service](https://cloud.google.com/terms/maps-platform/eea)
- [Google Maps Platform EEA Service Specific Terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
- [Routes API policies and attribution](https://developers.google.com/maps/documentation/routes/policies)

User authorization cannot override the provider licence. The capability gate in `traffic-provider-contract.cjs` therefore remains unchanged: `google-routes-current` allows an ephemeral current snapshot only and is rejected by the immutable historical store.

## What is saved now

Production continuously appends one provider-free run record per scheduled collector execution to `/var/lib/nexus-routing/traffic-scanner-runs.jsonl`. Each record preserves run ID, expected quarter-hour slot, actual start/finish time, lag, status, provider identifier, expected/successful/failed query counts, duplicate-start state, collector version, and a bounded error summary.

At the 2026-10-14 audit:

- 190 v2 run records were durably present from 2026-10-12 04:02 Malta through 2026-10-14 03:15 Malta;
- all 190 were successful and used 190 unique expected slots;
- the last 24 hours contained 97 run records, zero missing slots, zero failed queries, and zero duplicate starts;
- 24 current directional corridors were present in the expiring snapshot;
- historical provider observations remained zero by design.

The repository snapshot `scanner-run-audit.json` stores these operational facts without copying provider traffic values.

## When historical traffic may start

Historical collection may begin at the first successful scan from a provider or licence that explicitly permits all three of the following:

1. historical storage;
2. derived aggregates;
3. rendering on the intended Nexus map.

That start time must be recorded as the beginning of the measured series. Earlier Google runs must not be reconstructed or relabelled as measurements.
