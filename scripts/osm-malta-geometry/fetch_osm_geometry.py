#!/usr/bin/env python3
"""Cache public OSM geometry used by the Nexus Malta map.

The runtime never calls Overpass. Run this importer deliberately, review the
counts, then deploy the generated GeoJSON files with the site.
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# Kumi currently has a valid certificate in the Windows/Python runtime used by
# this workspace. The primary endpoint can be passed explicitly later if
# infrastructure changes.
OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"
BOUNDS = {
    "gozo-comino": (35.965, 14.17, 36.09, 14.42),
    "malta": (35.78, 14.31, 36.01, 14.59),
}
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets"


def query_overpass(query: str, retries: int = 4) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(
        OVERPASS_URL,
        data=body,
        headers={"User-Agent": "NexusLink-Malta-Geometry/1.0 (2906.estate)"},
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.load(response)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(4 * (attempt + 1))
    raise RuntimeError("Overpass request failed")


def closed_ring(geometry: list[dict]) -> list[list[float]] | None:
    ring = [[point["lon"], point["lat"]] for point in geometry]
    if len(ring) < 3:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def number(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.lower().replace("meters", "").replace("meter", "").replace("m", "").strip()
    try:
        result = float(cleaned)
        return result if math.isfinite(result) else None
    except ValueError:
        return None


def vegetation_feature(element: dict) -> dict | None:
    tags = element.get("tags", {})
    properties = {
        "osm_id": f'{element["type"]}/{element["id"]}',
        "name": tags.get("name"),
        "species": tags.get("species") or tags.get("species:en"),
        "height": number(tags.get("height")),
        "source": "OpenStreetMap contributors",
    }
    if element["type"] == "node" and tags.get("natural") == "tree":
        properties["kind"] = "tree"
        return {"type": "Feature", "properties": properties, "geometry": {"type": "Point", "coordinates": [element["lon"], element["lat"]]}}
    geometry = element.get("geometry") or []
    if tags.get("natural") == "tree_row" and len(geometry) >= 2:
        properties["kind"] = "tree_row"
        return {"type": "Feature", "properties": properties, "geometry": {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in geometry]}}
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
        ring = closed_ring(geometry)
        if ring:
            properties["kind"] = "woodland"
            return {"type": "Feature", "properties": properties, "geometry": {"type": "Polygon", "coordinates": [ring]}}
    return None


def building_feature(element: dict) -> dict | None:
    tags = element.get("tags", {})
    ring = closed_ring(element.get("geometry") or [])
    if not ring:
        return None
    exact_height = number(tags.get("height"))
    levels = number(tags.get("building:levels"))
    height = exact_height if exact_height is not None else levels * 3 if levels is not None else None
    if height is None:
        return None
    return {
        "type": "Feature",
        "properties": {
            "osm_id": f'{element["type"]}/{element["id"]}',
            "name": tags.get("name"),
            "building": tags.get("building"),
            "height": round(height, 2),
            "height_basis": "height" if exact_height is not None else "building:levels × 3m",
            "min_height": number(tags.get("min_height")) or 0,
            "source": "OpenStreetMap contributors",
        },
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }


def fetch_layer(layer: str) -> list[dict]:
    found: dict[str, dict] = {}
    for label, bbox in BOUNDS.items():
        bounds = ",".join(str(value) for value in bbox)
        if layer == "vegetation":
            selectors = f'''node["natural"="tree"]({bounds});way["natural"="tree_row"]({bounds});way["natural"="wood"]({bounds});way["landuse"="forest"]({bounds});'''
            convert = vegetation_feature
        else:
            selectors = f'''way["building"]["height"]({bounds});way["building"]["building:levels"]({bounds});way["building:part"]["height"]({bounds});way["building:part"]["building:levels"]({bounds});'''
            convert = building_feature
        payload = query_overpass(f"[out:json][timeout:160];({selectors});out tags geom;")
        for element in payload.get("elements", []):
            feature = convert(element)
            if feature:
                found[feature["properties"]["osm_id"]] = feature
        print(f"{layer}: {label} complete ({len(found)} unique features)")
        time.sleep(2)
    return list(found.values())


def write_collection(output: Path, name: str, features: list[dict]) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    path = output / name
    counts: dict[str, int] = {}
    for feature in features:
        kind = feature["properties"].get("kind", "height_enriched_building")
        counts[kind] = counts.get(kind, 0) + 1
    collection = {
        "type": "FeatureCollection",
        "nexus": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "OpenStreetMap contributors",
            "source_url": "https://www.openstreetmap.org/copyright",
            "license": "ODbL 1.0",
            "counts": counts,
        },
        "features": features,
    }
    path.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size / 1024:.1f} KiB): {counts}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer", choices=("vegetation", "buildings", "all"), default="all")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    if args.layer in ("vegetation", "all"):
        write_collection(args.output, "malta-osm-vegetation.geojson", fetch_layer("vegetation"))
    if args.layer in ("buildings", "all"):
        write_collection(args.output, "malta-osm-buildings.geojson", fetch_layer("buildings"))


if __name__ == "__main__":
    main()
