"""Turns Apple's report files into rows. Pure functions, tested without the API."""
import csv
import io
from datetime import date, datetime

# Sales report product types that are updates, not purchases (Apple's Product Type Identifier).
UPDATE_TYPES = {"7", "7F", "7T", "F7"}
DISCOVERY = "App Store Discovery and Engagement Standard"
DOWNLOADS = "App Downloads Standard"


def _tsv(text: str) -> list[dict]:
    return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(io.StringIO(text), delimiter="\t")]


def _int(value: str) -> int:
    return int(float(value)) if value else 0


def _float(value: str) -> float:
    return float(value) if value else 0.0


def sales_rows(text: str) -> list[dict]:
    """The daily Sales summary. Proceeds and price are per unit, so totals are units times proceeds."""
    rows = []
    for r in _tsv(text):
        if not r.get("Begin Date"):
            continue
        units = _int(r.get("Units", ""))
        rows.append({
            "date": datetime.strptime(r["Begin Date"], "%m/%d/%Y").date().isoformat(),
            "sku": r.get("SKU") or None, "title": r.get("Title") or None, "version": r.get("Version") or None,
            "product_type": r.get("Product Type Identifier") or None,
            "is_update": (r.get("Product Type Identifier") or "") in UPDATE_TYPES,
            "units": units, "proceeds": round(units * _float(r.get("Developer Proceeds", "")), 4),
            "proceeds_currency": r.get("Currency of Proceeds") or None,
            "customer_price": _float(r.get("Customer Price", "")), "customer_currency": r.get("Customer Currency") or None,
            "country": r.get("Country Code") or None, "device": r.get("Device") or None,
            "promo_code": r.get("Promo Code") or None,
        })
    return rows


def analytics_rows(text: str, report: str, instance_id: str) -> list[dict]:
    """One row per line of an Analytics Reports segment. The Discovery report names an Event
    (Impression, Page view, Tap), the Downloads report a Download Type (First-time download, ...)."""
    rows = []
    for r in _tsv(text):
        if not r.get("Date"):
            continue
        rows.append({
            "date": date.fromisoformat(r["Date"]).isoformat(), "report": report, "instance_id": instance_id,
            "event": r.get("Event") or r.get("Download Type") or None, "page_type": r.get("Page Type") or None,
            "source_type": r.get("Source Type") or None, "territory": r.get("Territory") or None,
            "device": r.get("Device") or None, "counts": _int(r.get("Counts", "")),
            "unique_counts": _int(r.get("Unique Counts", "")) if r.get("Unique Counts") else None,
        })
    return rows
