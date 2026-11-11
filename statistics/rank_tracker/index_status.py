"""Is Google indexing our pages? Search Console's URL Inspection API, once a week. If the
sitemap holds more pages of one kind (index_sample_pattern in keywords.json, e.g. "/question/")
than the quota of 2,000 inspections a day per property allows, a run checks all other pages plus a
slice of those pages that moves on each week, and their figure is a sample.
"""
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

log = logging.getLogger(__name__)

INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>")
MAX_URLS = 1500  # stays under the daily quota with room for a rerun by hand
MAX_SECONDS = 3600  # inspections take seconds each; rows are only stored after the loop


def sitemap_urls(http, sitemaps: list[str]) -> list[str]:
    """Every <loc> in the sitemaps, in order, without duplicates. A sitemap index is
    followed one level down."""
    seen, out = set(), []
    for sm in sitemaps:
        r = http.get(sm, timeout=60)
        r.raise_for_status()
        body = r.text
        locs = LOC.findall(body)
        if "<sitemapindex" in body:
            locs = sitemap_urls(http, locs)
        for u in locs:
            if u not in seen:
                seen.add(u)
                out.append(u)
    return out


def locale_of(url: str) -> str:
    """The site section (the first path segment) a URL belongs to."""
    return urlparse(url).path.strip("/").split("/")[0] or "-"


def select(urls: list[str], week, limit: int = MAX_URLS, sample: str | None = None) -> list[str]:
    """All pages except the sampled kind, then this week's slice of the sampled kind."""
    pages = [u for u in urls if not sample or sample not in u]
    questions = [u for u in urls if sample and sample in u]
    room = max(limit - len(pages), 0)
    if not questions or not room:
        return pages[:limit]
    start = (week.toordinal() // 7 * room) % len(questions)
    return pages + (questions + questions)[start:start + min(room, len(questions))]


def inspect(http, site: str, urls: list[str], week, sleep=time.sleep, clock=time.monotonic, budget_s: int = MAX_SECONDS,
            sample: str | None = None) -> list[dict]:
    checked = datetime.now(timezone.utc).isoformat()
    rows = []
    deadline = clock() + budget_s
    for i, url in enumerate(select(urls, week, sample=sample)):
        if clock() >= deadline:
            log.warning("time budget used after %d URLs; the rest waits for next week", i)
            break
        r = http.post(INSPECT, json={"inspectionUrl": url, "siteUrl": site}, timeout=60)
        if r.status_code == 429:
            log.warning("inspection quota hit after %d URLs; the rest waits for next week", i)
            break
        if r.status_code in (401, 403):
            # No access to the property: every other URL would fail the same way.
            r.raise_for_status()
        try:
            body = r.json() if r.content else {}
        except ValueError:  # an HTML error page from a proxy; record the URL as an error
            body = {}
        res = (body.get("inspectionResult") or {}).get("indexStatusResult") or {}
        rows.append({
            "week": week.isoformat(),
            "url": url,
            "locale": locale_of(url),
            "verdict": res.get("verdict") or ("ERROR" if not r.ok else None),
            "coverage_state": res.get("coverageState") or (body.get("error") or {}).get("message"),
            "indexing_state": res.get("indexingState"),
            "page_fetch_state": res.get("pageFetchState"),
            "robots_txt_state": res.get("robotsTxtState"),
            "google_canonical": res.get("googleCanonical"),
            "user_canonical": res.get("userCanonical"),
            "last_crawl_time": res.get("lastCrawlTime"),
            "checked_at": checked,
        })
        sleep(0.15)  # the API allows 600 a minute; this stays well under it
    return rows

