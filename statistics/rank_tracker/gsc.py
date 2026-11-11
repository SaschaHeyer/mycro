"""Google Search Console: what real searchers saw of the site, per day, query, page,
country and device. The job's service account must be a user on the property."""
import logging
from datetime import date, datetime, timezone
from urllib.parse import quote

log = logging.getLogger(__name__)

SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
API = "https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query"
DIMENSIONS = ["date", "query", "page", "country", "device"]
# Without the query dimension Google drops nothing for privacy, so page totals are complete.
PAGE_DIMENSIONS = ["date", "page", "country", "device"]
PAGE = 25000  # the API's row limit per request


def session():
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    creds, _ = google.auth.default(scopes=[SCOPE])
    return AuthorizedSession(creds)


def fetch(http, site: str, start: date, end: date, dimensions: tuple[str, ...] = tuple(DIMENSIONS)) -> list[dict]:
    """Every row from start to end, both inclusive, final data only."""
    url = API.format(site=quote(site, safe=""))
    rows, start_row = [], 0
    while True:
        r = http.post(url, json={
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": list(dimensions),
            "rowLimit": PAGE,
            "startRow": start_row,
            "dataState": "final",
        }, timeout=120)
        r.raise_for_status()
        page = r.json().get("rows") or []
        rows += page
        if len(page) < PAGE:
            break
        start_row += PAGE
    return rows


def to_rows(api_rows: list[dict], fetched_at: datetime | None = None) -> list[dict]:
    fetched = (fetched_at or datetime.now(timezone.utc)).isoformat()
    out = []
    for r in api_rows:
        day, query, page, country, device = r["keys"]
        out.append({
            "date": day,
            "query": query,
            "page": page,
            "country": country,   # ISO 3166-1 alpha-3, lower case (deu, prt, gbr)
            "device": device.lower(),
            "clicks": int(r.get("clicks", 0)),
            "impressions": int(r.get("impressions", 0)),
            "ctr": float(r.get("ctr", 0.0)),
            "position": float(r.get("position", 0.0)),
            "fetched_at": fetched,
        })
    return out


def to_page_rows(api_rows: list[dict], fetched_at: datetime | None = None) -> list[dict]:
    fetched = (fetched_at or datetime.now(timezone.utc)).isoformat()
    out = []
    for r in api_rows:
        day, page, country, device = r["keys"]
        out.append({
            "date": day, "page": page, "country": country, "device": device.lower(),
            "clicks": int(r.get("clicks", 0)), "impressions": int(r.get("impressions", 0)),
            "ctr": float(r.get("ctr", 0.0)), "position": float(r.get("position", 0.0)),
            "fetched_at": fetched,
        })
    return out
