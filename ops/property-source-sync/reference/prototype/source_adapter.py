"""My Next Home pilot parser and evidence-based price selection.

Prototype only: this does not grant permission to mirror third-party media or text.
"""
from __future__ import annotations

from bs4 import BeautifulSoup
from dataclasses import dataclass, asdict
from decimal import Decimal
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote
import hashlib
import re
import json

BASE = "https://www.mynexthome.mt"
CATEGORIES = {"long_let": "/long-let/", "sale": "/for-sale/"}
LISTING_PREFIX = "/directory-apartments/listing/"
MONEY_RE = re.compile(r"(?:€\s*([\d][\d,. ]*)|([\d][\d,. ]*)\s*€)", re.I)
DATE_RE = re.compile(r"\b(?:available\s+(?:as\s+from\s+|from\s+)?)(\d{1,2}/\d{1,2}/20\d{2})\b", re.I)
BEDS_RE = re.compile(r"\b(\d+)\s*[- ]bed(?:room)?s?\b", re.I)
CATEGORIES_TO_IGNORE = {"wifi", "internet", "utilities", "security deposit", "deposit", "water", "electricity", "common area", "charges", "per person", "agent fee", "agency fee", "maintenance"}


def canonical_url(url: str) -> str:
    parts = urlsplit(urljoin(BASE, url))
    if parts.scheme != "https" or parts.hostname not in ("www.mynexthome.mt", "mynexthome.mt"):
        raise ValueError("Unapproved source domain or scheme")
    path = re.sub(r"/+", "/", unquote(parts.path)).rstrip("/") + "/"
    return urlunsplit(("https", "www.mynexthome.mt", path, "", ""))


def amount(text: str) -> Decimal | None:
    raw = text.strip().replace(" ", "")
    if not raw or not re.match(r"^\d", raw):
        return None
    # Malta price punctuation: 1,500 / 1.500 / 1500.00
    if "," in raw and "." in raw:
        raw = raw.replace(",", "")
    elif raw.count(",") == 1 and len(raw.rsplit(",", 1)[1]) == 3:
        raw = raw.replace(",", "")
    elif raw.count(".") == 1 and len(raw.rsplit(".", 1)[1]) == 3:
        raw = raw.replace(".", "")
    else:
        raw = raw.replace(",", "")
    try:
        return Decimal(raw)
    except Exception:
        return None


def amount_from_match(match: re.Match) -> Decimal | None:
    return amount(match.group(1) or match.group(2))


def candidate_prices(lines: list[str], category: str) -> list[dict]:
    """Only explicitly advertised headline/rent/asking prices, never add-on/deposits."""
    out = []
    for pos, line in enumerate(lines):
        low = line.casefold().strip()
        if any(term in low for term in CATEGORIES_TO_IGNORE):
            continue
        for m in MONEY_RE.finditer(line):
            v = amount_from_match(m)
            if v is None or v <= 0:
                continue
            if category == "long_let":
                if "week" in low or "night" in low or "day" in low:
                    continue
                if not ("monthly" in low or "per month" in low or low.startswith("rent:") or low.startswith("rent ") or low.startswith("for rent at") or "monthly rent" in low):
                    continue
                if v < 100 or v > 100000:
                    continue
                basis = "EUR_MONTH"
            elif category == "sale":
                if "month" in low or "week" in low or "night" in low:
                    continue
                if v < 20000:
                    continue
                # Avoid prose amounts unrelated to sales; amount-only headlines are valid.
                if not (len(low) < 30 or "asking" in low or "sale price" in low or "for sale" in low or low.startswith("price")):
                    continue
                basis = "EUR_SALE"
            else:
                continue
            out.append({"amount": str(v), "basis": basis, "evidence": line[:210], "line_index": pos})
    # deduplicate exact values in repeated page sections
    uniq = {}
    for p in out:
        uniq.setdefault((p["amount"], p["basis"]), p)
    return list(uniq.values())


def select_price(lines: list[str], category: str) -> dict:
    candidates = candidate_prices(lines, category)
    if not candidates:
        return {"amount": None, "basis": None, "candidate_prices": [], "review_required": True, "reason": "No unambiguous comparable advertised amount"}
    chosen = min(candidates, key=lambda p: Decimal(p["amount"]))
    return {"amount": chosen["amount"], "basis": chosen["basis"],
            "candidate_prices": candidates, "review_required": len(candidates) > 1,
            "reason": "Lowest explicitly advertised comparable price in current snapshot" if len(candidates) > 1 else "One supported advertised price"}


def clean_lines(soup: BeautifulSoup) -> list[str]:
    for element in soup.select("script,style,noscript,footer,header,nav"):
        element.decompose()
    return [re.sub(r"\s+", " ", v).strip() for v in soup.get_text("\n").split("\n") if v.strip()]


def links_from_category(html: str, category_url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    urls = []
    for a in soup.select('a[href]'):
        href = a.get("href", "")
        try:
            url = canonical_url(urljoin(category_url, href))
        except ValueError:
            continue
        if LISTING_PREFIX in url and url not in urls:
            urls.append(url)
    return urls


def parse_detail(html: str, url: str, category: str) -> dict:
    if category not in CATEGORIES:
        raise ValueError("Unsupported source category")
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.select_one("h1")
    title = h1.get_text(" ", strip=True) if h1 else "Untitled"
    media = []
    for img in soup.select("img[src]"):
        src = img.get("src", "")
        try:
            full = canonical_url(src) if src.startswith(("https:", "/")) else None
        except ValueError:
            full = None
        # canonical_url adds trailing slash; use raw URL for actual image filenames
        raw = urljoin(url, src)
        if urlsplit(raw).hostname not in ("www.mynexthome.mt", "mynexthome.mt"):
            continue
        if "/wp-content/uploads/" in raw and raw not in media:
            media.append(raw)
    lines = clean_lines(BeautifulSoup(html, "html.parser"))
    price = select_price(lines, category)
    dates = [m.group(1) for line in lines for m in DATE_RE.finditer(line)]
    dates = list(dict.fromkeys(dates))
    title_beds = BEDS_RE.search(title)
    bedrooms = int(title_beds.group(1)) if title_beds else None
    for i, line in enumerate(lines[:-1]):
        if line.lower() == "bedrooms" and lines[i+1].isdigit():
            bedrooms = int(lines[i+1]); break
    bathrooms = None
    for i, line in enumerate(lines[:-1]):
        if line.lower() == "bathrooms" and lines[i+1].isdigit():
            bathrooms = int(lines[i+1]); break
    address = None
    for i,line in enumerate(lines[:-1]):
        if line.lower().strip() == "property address:":
            address = lines[i+1][:300]; break
    total_area = None
    for i,line in enumerate(lines[:-1]):
        if line.lower().strip() == "total area":
            v=re.search(r"\b\d+(?:\.\d+)?\s*sqm\b", lines[i+1], re.I)
            if v: total_area=v.group(0); break
    canonical = canonical_url(url)
    # Keep copyrighted page prose and precise address PRIVATE, never auto-public.
    data = {
        "external_id": hashlib.sha256(canonical.encode()).hexdigest()[:20],
        "source_url": canonical,
        "source_domain": "www.mynexthome.mt",
        "category": category,
        "title": title,
        "bedrooms": bedrooms,
        "bathrooms": bathrooms,
        "available_from_source": dates[0] if dates else None,
        "available_from_conflict": len(dates) > 1,
        "private_address_candidate": address,
        "total_area": total_area,
        "price": price,
        "media_source_urls": media,  # reference only; not authority to redistribute
        "is_authorized_for_publication": False,
        "availability_state": "SOURCE_LISTED_UNVERIFIED",
        "source_evidence": {"source_url":canonical, "price_evidence": [c["evidence"] for c in price["candidate_prices"]]},
    }
    return data


def fingerprint(item: dict) -> str:
    watched = {k: item.get(k) for k in ("category", "title", "bedrooms", "bathrooms", "available_from_source", "private_address_candidate", "total_area", "price", "media_source_urls", "availability_state")}
    return hashlib.sha256(json.dumps(watched, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
