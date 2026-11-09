"""Local-only SQLite change detection and human review queue.

Production integration must use existing ARGUS auth, tenant and property ownership.
"""
from __future__ import annotations
import sqlite3, json
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit
from source_adapter import fingerprint, canonical_url, CATEGORIES

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('long_let','sale')),
  url TEXT NOT NULL UNIQUE,
  authorized INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS external_listings (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  current_fingerprint TEXT NOT NULL,
  current_json TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  missing_scan_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_id, external_id)
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  new_fingerprint TEXT NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  created_at TEXT NOT NULL,
  decision_at TEXT,
  reviewer TEXT,
  UNIQUE(source_id, external_id, event_type, new_fingerprint)
);
CREATE TABLE IF NOT EXISTS approved_imports (
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  last_payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  canonical_property_id TEXT,
  PRIMARY KEY(source_id, external_id)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  successful INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER,
  error TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def add_source(db, label: str, url: str, category: str, authorized: bool = False):
    if category not in CATEGORIES:
        raise ValueError("Only long_let/sale are supported; short let has a separate connector")
    parsed = canonical_url(url)
    if parsed != canonical_url('https://www.mynexthome.mt' + CATEGORIES[category]):
        raise ValueError("Category URL must match approved source entry point")
    with db:
        db.execute("INSERT OR IGNORE INTO sources(label,category,url,authorized,enabled) VALUES (?,?,?,?,0)", (label,category,parsed,1 if authorized else 0))
        return db.execute("SELECT * FROM sources WHERE url=?", (parsed,)).fetchone()["id"]


def _get_source(db, source_id):
    rec = db.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
    if not rec:
        raise ValueError("Source not found")
    return rec


def sanitized_preview(payload: dict) -> dict:
    p = json.loads(json.dumps(payload))
    # Keep exact address and original copyright media private; display source URL to admin.
    p.pop("private_address_candidate", None)
    p.pop("media_source_urls", None)
    p.pop("source_evidence", None)
    return p


def _diff_fields(old: dict, new: dict) -> dict:
    names = ["title", "category", "bedrooms", "bathrooms", "available_from_source", "total_area", "price", "media_source_urls", "private_address_candidate"]
    return {k:{"previous":old.get(k),"new":new.get(k)} for k in names if old.get(k) != new.get(k)}


def ingest_snapshot(db, source_id: int, listings: list[dict], complete: bool = True) -> dict:
    """Upsert *source observations*, generate proposals; never write ARGUS canonical properties.

    A missing source listing is only flagged on a second complete, successful scan.
    """
    source = _get_source(db, source_id)
    if not isinstance(listings, list):
        raise ValueError("Expected a listing array")
    seen, new_count, updates, missing = set(), 0, 0, 0
    ts = now()
    with db:
        run_id = db.execute("INSERT INTO sync_runs(source_id,started_at) VALUES (?,?)",(source_id,ts)).lastrowid
        for item in listings:
            if item.get("category") != source["category"]:
                raise ValueError("Category mismatch: detail-page pills cannot override source category")
            if not item.get("external_id") or not item.get("source_url"):
                raise ValueError("Every external listing needs ID and source_url")
            canonical = canonical_url(item["source_url"])
            if "/directory-apartments/listing/" not in canonical:
                raise ValueError("External listing URL outside approved source section")
            ext_id = item["external_id"]
            if ext_id in seen:
                continue
            seen.add(ext_id)
            fp = fingerprint(item)
            row = db.execute("SELECT * FROM external_listings WHERE source_id=? AND external_id=?",(source_id,ext_id)).fetchone()
            if not row:
                event_type="NEW"
                details={"source":sanitized_preview(item),"field_changes":{},"review": bool(item.get("price",{}).get("review_required",True))}
                db.execute("INSERT INTO external_listings(source_id,external_id,url,current_fingerprint,current_json,first_seen,last_seen) VALUES(?,?,?,?,?,?,?)",(source_id,ext_id,canonical,fp,json.dumps(item,ensure_ascii=False),ts,ts))
                new_count += 1
            elif row["current_fingerprint"] != fp:
                event_type="UPDATED"
                old = json.loads(row["current_json"])
                details={"source":sanitized_preview(item),"field_changes":_diff_fields(old,item),"review":True}
                db.execute("UPDATE external_listings SET url=?,current_fingerprint=?,current_json=?,last_seen=?,missing_scan_count=0 WHERE id=?",(canonical,fp,json.dumps(item,ensure_ascii=False),ts,row["id"]))
                updates += 1
            else:
                event_type=None
                db.execute("UPDATE external_listings SET last_seen=?,missing_scan_count=0 WHERE id=?",(ts,row["id"]))
            if event_type:
                db.execute("INSERT OR IGNORE INTO proposals(source_id,external_id,event_type,new_fingerprint,details_json,created_at) VALUES (?,?,?,?,?,?)",(source_id,ext_id,event_type,fp,json.dumps(details,ensure_ascii=False),ts))
        if complete:
            for row in db.execute("SELECT * FROM external_listings WHERE source_id=?",(source_id,)).fetchall():
                if row["external_id"] in seen:
                    continue
                count = row["missing_scan_count"]+1
                db.execute("UPDATE external_listings SET missing_scan_count=? WHERE id=?",(count,row["id"]))
                if count == 2:
                    missing+=1
                    details = {"source":sanitized_preview(json.loads(row["current_json"])),"missing_scans":count,"note":"Not listed twice. Do NOT infer rented or automatically unpublish."}
                    db.execute("INSERT OR IGNORE INTO proposals(source_id,external_id,event_type,new_fingerprint,details_json,created_at) VALUES (?,?,?,?,?,?)",(source_id,row["external_id"],"MISSING_FROM_SOURCE",row["current_fingerprint"],json.dumps(details,ensure_ascii=False),ts))
        db.execute("UPDATE sync_runs SET finished_at=?,successful=1,item_count=? WHERE id=?",(now(),len(seen),run_id))
        db.execute("UPDATE sources SET last_checked=?,last_error=NULL WHERE id=?",(ts,source_id))
    return {"new":new_count,"updated":updates,"missing_flagged":missing,"items_seen":len(seen),"run_id":run_id}


def decide(db, proposal_id:int, status:str, reviewer:str="local-test"):
    if status not in ("APPROVED","REJECTED"):
        raise ValueError("Must approve or reject")
    with db:
        p=db.execute("SELECT * FROM proposals WHERE id=?",(proposal_id,)).fetchone()
        if p is None or p["status"]!="PENDING":
            raise ValueError("Proposal already decided or not found")
        db.execute("UPDATE proposals SET status=?,reviewer=?,decision_at=? WHERE id=?",(status,reviewer,now(),proposal_id))
        if status=="APPROVED" and p["event_type"] in ("NEW","UPDATED"):
            row=db.execute("SELECT current_json FROM external_listings WHERE source_id=? AND external_id=?",(p["source_id"],p["external_id"])).fetchone()
            if row:
                doc=json.loads(row["current_json"])
                if fingerprint(doc)!=p["new_fingerprint"]:
                    raise ValueError("Proposal is stale; review latest snapshot")
                db.execute("INSERT INTO approved_imports(source_id,external_id,last_payload_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET last_payload_json=excluded.last_payload_json, updated_at=excluded.updated_at",(p["source_id"],p["external_id"],json.dumps(doc,ensure_ascii=False),now()))
    return True


def stats(db):
    kinds = {r["event_type"]:r["n"] for r in db.execute("SELECT event_type,COUNT(*) as n FROM proposals WHERE status='PENDING' GROUP BY event_type")}
    return {"new":kinds.get("NEW",0),"updated":kinds.get("UPDATED",0),"missing":kinds.get("MISSING_FROM_SOURCE",0)}


def list_sources(db):
    return [dict(x) for x in db.execute("SELECT * FROM sources ORDER BY id")]


def list_proposals(db,limit=200):
    return [dict(id=x["id"],source_id=x["source_id"],event_type=x["event_type"],external_id=x["external_id"],status=x["status"],details=json.loads(x["details_json"]),created_at=x["created_at"]) for x in db.execute("SELECT * FROM proposals ORDER BY id DESC LIMIT ?",(limit,))]
