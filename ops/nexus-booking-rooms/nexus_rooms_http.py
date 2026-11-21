"""NEXUS Rooms reservations in NEXUS Booking (2026-11-21, nexus-rooms-v1).

NEXUS Booking is the reservation engine for rooms: dates, holds, confirmations and the conflict rule.
ARGUS owns the property, its rooms and prices; it is never written from here.

A stay belongs to one property (ARGUS ref) and covers a "span":
    whole apartment  [0, 1000000)
    room at position n  [n*100, n*100+100)
Two stays conflict when their spans overlap AND their dates overlap (check_out is exclusive). So the whole
apartment conflicts with every room, rooms do not conflict with each other, and rooms added later are covered.
Only HELD (not expired) and CONFIRMED booking stays block. Requests and viewing requests never block, and a
viewing request never becomes a tenancy.

Every check-and-write runs inside one SQLite write transaction (BEGIN IMMEDIATE), so two concurrent requests
for the same dates cannot both be held or confirmed.

Calls are server to server and signed: HMAC-SHA256 over "ts.METHOD.path.sha256(body)" with NEXUS_ROOMS_SECRET,
headers X-Nexus-Rooms-Client (argus | web), X-Nexus-Rooms-Ts, X-Nexus-Rooms-Sig. The website may read
availability and create requests; only ARGUS (owner or agency decisions) may list stays and decide.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import nexus_booking_db as booking_db

PREFIX = '/api/nexus-booking/rooms/'
WHOLE = (0, 1_000_000)
REF_RE = re.compile(r'^[A-Za-z0-9-]{2,40}$')
UNIT_RE = re.compile(r'^(whole|room:\d{1,12})$')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')
_ready = False


def _now() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def ensure_table(path=None) -> None:
    global _ready
    if _ready and path is None:
        return
    with booking_db.connection(path or booking_db.DATABASE_PATH) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS room_stays (
            id TEXT PRIMARY KEY,
            property_ref TEXT NOT NULL,
            unit_key TEXT NOT NULL,
            unit_label TEXT,
            span_lo INTEGER NOT NULL,
            span_hi INTEGER NOT NULL,
            check_in TEXT NOT NULL,
            check_out TEXT NOT NULL,
            market TEXT NOT NULL DEFAULT 'long_let',
            kind TEXT NOT NULL DEFAULT 'booking',
            status TEXT NOT NULL,
            hold_expires_at TEXT,
            guest_name TEXT,
            guest_email TEXT,
            guest_phone TEXT,
            party_size INTEGER,
            note TEXT,
            source TEXT,
            idempotency_key TEXT UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            history TEXT NOT NULL DEFAULT '[]',
            CHECK (span_lo >= 0 AND span_hi > span_lo),
            CHECK (check_out > check_in),
            CHECK (kind IN ('booking','viewing')),
            CHECK (status IN ('requested','held','confirmed','declined','cancelled','expired'))
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS room_stays_property ON room_stays(property_ref, check_in, check_out)")
    if path is None:
        _ready = True


# ── signatures ────────────────────────────────────────────────────────────────
def signature(secret: str, ts: str, method: str, path: str, body: bytes) -> str:
    digest = hashlib.sha256(body or b'').hexdigest()
    return hmac.new(secret.encode(), f'{ts}.{method}.{path}.{digest}'.encode(), hashlib.sha256).hexdigest()


def _verify(handler, method: str, path: str, body: bytes) -> str | None:
    secret = os.getenv('NEXUS_ROOMS_SECRET', '')
    if len(secret) < 32:
        return None
    client = handler.headers.get('X-Nexus-Rooms-Client', '')
    ts = handler.headers.get('X-Nexus-Rooms-Ts', '')
    sig = handler.headers.get('X-Nexus-Rooms-Sig', '')
    if client not in ('argus', 'web') or not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return None
    if not hmac.compare_digest(signature(secret, ts, method, path, body), sig):
        return None
    return client


# ── validation ────────────────────────────────────────────────────────────────
def _date(value, label: str) -> str:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except (TypeError, ValueError):
        raise ValueError(f'{label} is not a valid date')


def _span(unit_key: str, span) -> tuple[int, int]:
    if unit_key == 'whole':
        return WHOLE
    lo, hi = int(span[0]), int(span[1])
    if lo < 100 or hi != lo + 100 or lo % 100:
        raise ValueError('Room span is not valid')
    return lo, hi


def _clean(value, limit: int) -> str | None:
    text = re.sub(r'\s+', ' ', str(value or '')).strip()
    return text[:limit] or None


def _row(r) -> dict:
    return {
        'id': r['id'], 'propertyRef': r['property_ref'], 'unitKey': r['unit_key'], 'unitLabel': r['unit_label'],
        'span': [r['span_lo'], r['span_hi']], 'checkIn': r['check_in'], 'checkOut': r['check_out'], 'market': r['market'],
        'kind': r['kind'], 'status': r['status'], 'holdExpiresAt': r['hold_expires_at'],
        'guest': {'name': r['guest_name'], 'email': r['guest_email'], 'phone': r['guest_phone']}, 'partySize': r['party_size'],
        'note': r['note'], 'source': r['source'], 'createdAt': r['created_at'], 'updatedAt': r['updated_at'],
        'history': json.loads(r['history'] or '[]'),
    }


def _expire(db) -> None:
    db.execute("UPDATE room_stays SET status='expired', updated_at=? WHERE status='held' AND hold_expires_at < ?", (_now(), _now()))


def _conflict(db, ref: str, lo: int, hi: int, check_in: str, check_out: str, except_id: str | None = None):
    return db.execute(
        """SELECT id, unit_key, unit_label, check_in, check_out, status FROM room_stays
            WHERE property_ref=? AND kind='booking' AND status IN ('held','confirmed') AND id <> ?
              AND span_lo < ? AND ? < span_hi AND check_in < ? AND ? < check_out
            ORDER BY check_in LIMIT 1""",
        (ref, except_id or '', hi, lo, check_out, check_in)).fetchone()


def _conflict_message(row) -> str:
    what = 'the whole apartment' if row['unit_key'] == 'whole' else (row['unit_label'] or 'this room')
    return f"Not available: {what} is {'reserved' if row['status'] == 'held' else 'booked'} from {row['check_in']} to {row['check_out']}."


# ── operations ────────────────────────────────────────────────────────────────
def availability(ref: str, start: str | None, end: str | None, path=None) -> dict:
    ensure_table(path)
    start = _date(start, 'From') if start else date.today().isoformat()
    end = _date(end, 'To') if end else (date.today() + timedelta(days=400)).isoformat()
    with booking_db.connection(path or booking_db.DATABASE_PATH) as db:
        db.execute('BEGIN IMMEDIATE')
        _expire(db)
        rows = db.execute(
            """SELECT unit_key, span_lo, span_hi, check_in, check_out, status FROM room_stays
                WHERE property_ref=? AND kind='booking' AND status IN ('held','confirmed') AND check_in < ? AND ? < check_out
                ORDER BY check_in""", (ref, end, start)).fetchall()
    return {'propertyRef': ref, 'from': start, 'to': end,
            'blocks': [{'unitKey': r['unit_key'], 'span': [r['span_lo'], r['span_hi']], 'checkIn': r['check_in'], 'checkOut': r['check_out'], 'status': r['status']} for r in rows]}


def create_request(payload: dict, path=None) -> tuple[int, dict]:
    ensure_table(path)
    ref = str(payload.get('propertyRef') or '')
    unit_key = str(payload.get('unitKey') or '')
    if not REF_RE.match(ref) or not UNIT_RE.match(unit_key):
        raise ValueError('Unknown home or room')
    lo, hi = _span(unit_key, payload.get('span') or WHOLE)
    kind = 'viewing' if payload.get('kind') == 'viewing' else 'booking'
    check_in = _date(payload.get('checkIn'), 'Move-in date')
    check_out = _date(payload.get('checkOut'), 'Move-out date') if kind == 'booking' else (date.fromisoformat(check_in) + timedelta(days=1)).isoformat()
    today = date.today()
    if date.fromisoformat(check_in) < today or date.fromisoformat(check_in) > today + timedelta(days=550):
        raise ValueError('Choose a date within the next 18 months')
    if check_out <= check_in or date.fromisoformat(check_out) > date.fromisoformat(check_in) + timedelta(days=1100):
        raise ValueError('The stay is not valid')
    guest = payload.get('guest') or {}
    name = _clean(guest.get('name'), 120)
    email = _clean(guest.get('email'), 254)
    phone = _clean(guest.get('phone'), 32)
    if not name:
        raise ValueError('Add your name')
    if not ((email and re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email)) or (phone and len(re.sub(r'\D', '', phone)) >= 7)):
        raise ValueError('Add an e-mail or a phone number so the owner or agency can answer you')
    key = _clean(payload.get('idempotencyKey'), 64)
    market = 'short_let' if payload.get('market') == 'short_let' else 'long_let'
    party = payload.get('partySize')
    party = int(party) if isinstance(party, (int, float)) and 1 <= int(party) <= 6 else None
    now = _now()
    with booking_db.connection(path or booking_db.DATABASE_PATH) as db:
        db.execute('BEGIN IMMEDIATE')
        _expire(db)
        if key:
            again = db.execute('SELECT * FROM room_stays WHERE idempotency_key=?', (key,)).fetchone()
            if again:
                return 200, {'stay': _row(again), 'repeated': True}
        if kind == 'booking':
            clash = _conflict(db, ref, lo, hi, check_in, check_out)
            if clash:
                return 409, {'error': 'UNAVAILABLE', 'message': _conflict_message(clash)}
        stay_id = 'rs_' + secrets.token_urlsafe(12)
        history = json.dumps([{'at': now, 'status': 'requested', 'by': str(payload.get('source') or 'web')[:40]}])
        db.execute(
            """INSERT INTO room_stays (id, property_ref, unit_key, unit_label, span_lo, span_hi, check_in, check_out, market, kind, status,
                                       guest_name, guest_email, guest_phone, party_size, note, source, idempotency_key, created_at, updated_at, history)
               VALUES (?,?,?,?,?,?,?,?,?,?,'requested',?,?,?,?,?,?,?,?,?,?)""",
            (stay_id, ref, unit_key, _clean(payload.get('unitLabel'), 40), lo, hi, check_in, check_out, market, kind,
             name, email, phone, party, _clean(payload.get('note'), 1000), _clean(payload.get('source'), 40) or 'marketplace', key, now, now, history))
        row = db.execute('SELECT * FROM room_stays WHERE id=?', (stay_id,)).fetchone()
    return 201, {'stay': _row(row)}


TRANSITIONS = {
    'hold': ({'requested'}, 'held'),
    'confirm': ({'requested', 'held'}, 'confirmed'),
    'decline': ({'requested', 'held'}, 'declined'),
    'cancel': ({'confirmed'}, 'cancelled'),
    'release': ({'held'}, 'requested'),
}


def decide(stay_id: str, payload: dict, path=None) -> tuple[int, dict]:
    ensure_table(path)
    action = str(payload.get('action') or '')
    if action not in TRANSITIONS:
        raise ValueError('Unknown action')
    allowed, target = TRANSITIONS[action]
    actor = _clean(payload.get('actor'), 60) or 'argus'
    now = _now()
    with booking_db.connection(path or booking_db.DATABASE_PATH) as db:
        db.execute('BEGIN IMMEDIATE')
        _expire(db)
        row = db.execute('SELECT * FROM room_stays WHERE id=?', (stay_id,)).fetchone()
        if not row or row['property_ref'] != str(payload.get('propertyRef') or ''):
            return 404, {'error': 'NOT_FOUND', 'message': 'Request not found'}
        if row['status'] not in allowed:
            return 409, {'error': 'INVALID_STATE', 'message': f"This request is {row['status']}; it cannot be {action}ed now."}
        if target in ('held', 'confirmed') and row['kind'] == 'booking':
            clash = _conflict(db, row['property_ref'], row['span_lo'], row['span_hi'], row['check_in'], row['check_out'], except_id=row['id'])
            if clash:
                return 409, {'error': 'UNAVAILABLE', 'message': _conflict_message(clash)}
        hold_until = None
        if target == 'held':
            hours = payload.get('holdHours') or 48
            hours = max(1, min(168, int(hours))) if isinstance(hours, (int, float)) else 48
            hold_until = (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime('%Y-%m-%dT%H:%M:%SZ')
        history = json.loads(row['history'] or '[]')
        history.append({'at': now, 'status': target, 'by': actor, **({'note': _clean(payload.get('note'), 300)} if payload.get('note') else {})})
        db.execute('UPDATE room_stays SET status=?, hold_expires_at=?, updated_at=?, history=? WHERE id=?',
                   (target, hold_until, now, json.dumps(history[-50:]), row['id']))
        row = db.execute('SELECT * FROM room_stays WHERE id=?', (row['id'],)).fetchone()
    return 200, {'stay': _row(row)}


def list_stays(ref: str, path=None) -> dict:
    ensure_table(path)
    with booking_db.connection(path or booking_db.DATABASE_PATH) as db:
        db.execute('BEGIN IMMEDIATE')
        _expire(db)
        rows = db.execute("SELECT * FROM room_stays WHERE property_ref=? AND check_out >= ? ORDER BY check_in, created_at LIMIT 500",
                          (ref, (date.today() - timedelta(days=60)).isoformat())).fetchall()
    return {'stays': [_row(r) for r in rows]}


# ── HTTP ──────────────────────────────────────────────────────────────────────
def handle(handler, method: str, path: str) -> bool:
    if not path.startswith(PREFIX):
        return False
    body = handler._read_raw_body() if method == 'POST' else b''
    client = _verify(handler, method, path, body)
    if not client:
        handler._send_json({'error': 'UNAUTHORIZED', 'message': 'Signed request required'}, 401)
        return True
    query = parse_qs(urlparse(handler.path).query)
    try:
        payload = json.loads(body or b'{}') if method == 'POST' else {}
        if not isinstance(payload, dict):
            raise ValueError('Invalid request')
        if method == 'GET' and path == PREFIX + 'availability':
            ref = (query.get('property') or [''])[0]
            if not REF_RE.match(ref):
                raise ValueError('Unknown home')
            handler._send_json(availability(ref, (query.get('from') or [None])[0], (query.get('to') or [None])[0]))
            return True
        if method == 'POST' and path == PREFIX + 'requests':
            status, out = create_request(payload)
            handler._send_json(out, status)
            return True
        if client != 'argus':
            handler._send_json({'error': 'FORBIDDEN', 'message': 'Not allowed'}, 403)
            return True
        if method == 'GET' and path == PREFIX + 'stays':
            ref = (query.get('property') or [''])[0]
            if not REF_RE.match(ref):
                raise ValueError('Unknown home')
            handler._send_json(list_stays(ref))
            return True
        m = re.match(r'^/api/nexus-booking/rooms/stays/([A-Za-z0-9_-]{8,64})/decide$', path)
        if method == 'POST' and m:
            status, out = decide(m.group(1), payload)
            handler._send_json(out, status)
            return True
        handler._send_json({'error': 'NOT_FOUND', 'message': 'Not found'}, 404)
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        handler._send_json({'error': 'INVALID', 'message': str(error)[:200]}, 400)
    return True
