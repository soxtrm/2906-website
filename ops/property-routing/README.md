# Property routing

Independent of ARGUS/WhatsApp. OSRM v6.0.0 uses Geofabrik Malta OSM data with separate car and foot profiles. No live traffic, pickup forecast or official Bolt tariff is inferred.

Production components:
- `/opt/nexus-routing/server.cjs`: loopback HTTP service on 3012, systemd `nexus-routing`.
- `nexus-route-car`: Docker, 127.0.0.1:5011, CH car graph.
- `nexus-route-foot`: Docker, 127.0.0.1:5012, CH pedestrian graph.
- `/opt/nexus-routing/{car,foot}`: graph files, not committed.
- `nexus-routing-warm.timer`: precomputes current public inventory every 15 minutes. Requests resolve new inventory on demand; source snapshots expire in 60 seconds. This is an OSRM cache warmer and does not call Google Traffic.
- Caddy's IP-host route `/api/public/property-routing` proxies to 3012. Next's `/api/nexus/property-routing` forwards only validated property/place identifiers.

Inputs are current public inventory and registered places. The internal location reader is installed at `/opt/2906-system/backend/scripts/nexus-routing-locations.cjs` and runs inside the existing backend without changing its process. Only exact internal locations qualify for private route origins. Otherwise the public locality anchor is used and labelled AREA_ONLY.

Private origins never appear in responses. Known homes use a deterministic displaced road point 45–200 m away (normally around 65 m); no viable road candidate falls back to the existing locality anchor. Public route drawings start at this public point. Distances are computed internally; their origin basis is disclosed. POI positions stay unchanged. Routes with excessive network snapping remain unavailable instead of inventing an entrance path.

All default routing distances are road/pedestrian network results. Durations are MODELLED, not LIVE. The separate `traffic=1` request path calls Google Routes with `TRAFFIC_AWARE_OPTIMAL`, returns `Cache-Control: no-store`, labels its source as Google Maps and describes the value as a traffic-informed prediction rather than a completed journey.

Pedestrian routing can legitimately contain an OSM ferry step. Matrix summaries do not include step evidence, so the public UI labels those unexpanded values only as a mapped route and requires a destination-level route request before calling the result a walk. A selected route exposes its ferry steps, changes the mode label to `Walk + ferry`, and keeps waiting time, fare and the live departure unknown. The Sliema–Valletta / Tas-Sliema–Marsamxett corridor is matched to Transport Malta's official corridor page and the operator's live schedule page; unknown ferry names remain `ROUTED_ONLY`. Route geometry is rejected in the client if it is malformed, reduced to an implausible long two-point connector, or contains an unexplained long gap. No straight connector is substituted when geometry fails validation.

The historical `API_KEY_SERVICE_BLOCKED` result from 2026-09-27 is resolved. A targeted Sliema-origin access check on 2026-10-10 returned all eight configured overview destinations, including Valletta Gate, Mdina, Portomaso, Ċirkewwa, the airport and Ta' Qali. The separate `nexus-google-traffic.timer` now refreshes six deliberately selected public corridors in both directions every 15 minutes. Two alternating batches cover Sliema/St Julian's plus central, northern and southern comparison origins and the six standard destinations without running a blind origins × destinations matrix. Its only output is the expiring current snapshot at `/run/nexus-routing/google-traffic-current.json`; it does not create a historical archive. The OSRM warmer remains a different timer and must not be reported as a Google observation.

Google's current Routes API policy says caching of most Routes content is restricted, while the service-specific terms expressly allow only limited caching fields. Until an applicable licence or written policy basis permits a time-series archive, traffic durations must remain live, request-scoped and unpersisted. Any user-facing value needs Google attribution and must remain separate from the OSM map and from taxi-price observations. Policy references: https://developers.google.com/maps/documentation/routes/policies and https://cloud.google.com/maps-platform/terms/maps-service-terms

The v2 collector also appends provider-free scanner run metadata to `/var/lib/nexus-routing/traffic-scanner-runs.jsonl` and publishes `/run/nexus-routing/traffic-scanner-health.json`. `traffic-history-store.cjs` is the immutable observation adapter for a future licensed provider; its capability gate intentionally rejects the current Google adapter. See `docs/traffic/TRAFFIC_COLLECTION_ARCHITECTURE.md` and `docs/traffic/TRAFFIC_CORRIDORS.md`.

The OSM map is lazy loaded with Leaflet 1.9.4 (vendored BSD licence). OSM attribution is always visible; no tile bulk download/preload is used.

Rollback: revert frontend changes; stop `nexus-routing-warm.timer` and `nexus-routing`; stop the two routing containers. Caddy backup is `/etc/caddy/Caddyfile.bak.nexus-routing-20260927`. Do not restore that file blindly if someone has since changed Caddy.
