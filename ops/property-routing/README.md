# Property routing

Independent of ARGUS/WhatsApp. OSRM v6.0.0 uses Geofabrik Malta OSM data with separate car and foot profiles. No live traffic, pickup forecast or official Bolt tariff is inferred.

Production components:
- `/opt/nexus-routing/server.cjs`: loopback HTTP service on 3012, systemd `nexus-routing`.
- `nexus-route-car`: Docker, 127.0.0.1:5011, CH car graph.
- `nexus-route-foot`: Docker, 127.0.0.1:5012, CH pedestrian graph.
- `/opt/nexus-routing/{car,foot}`: graph files, not committed.
- `nexus-routing-warm.timer`: precomputes current public inventory every 30 minutes. Requests resolve new inventory on demand; source snapshots expire in 60 seconds.
- Caddy's IP-host route `/api/public/property-routing` proxies to 3012. Next's `/api/nexus/property-routing` forwards only validated property/place identifiers.

Inputs are current public inventory and registered places. The internal location reader is installed at `/opt/2906-system/backend/scripts/nexus-routing-locations.cjs` and runs inside the existing backend without changing its process. Only exact internal locations qualify for private route origins. Otherwise the public locality anchor is used and labelled AREA_ONLY.

Private origins never appear in responses. Known homes use a deterministic displaced road point 45–200 m away (normally around 65 m); no viable road candidate falls back to the existing locality anchor. Public route drawings start at this public point. Distances are computed internally; their origin basis is disclosed. POI positions stay unchanged. Routes with excessive network snapping remain unavailable instead of inventing an entrance path.

All routing distances are road/pedestrian network results. Durations are MODELLED, not LIVE. Google Routes returned API_KEY_SERVICE_BLOCKED on 2026-09-27. Its key must permit `routes.googleapis.com` before Google traffic can be used. No key was copied or changed.

The OSM map is lazy loaded with Leaflet 1.9.4 (vendored BSD licence). OSM attribution is always visible; no tile bulk download/preload is used.

Rollback: revert frontend changes; stop `nexus-routing-warm.timer` and `nexus-routing`; stop the two routing containers. Caddy backup is `/etc/caddy/Caddyfile.bak.nexus-routing-20260927`. Do not restore that file blindly if someone has since changed Caddy.
