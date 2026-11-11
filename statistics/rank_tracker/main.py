"""Weekly Google rank tracker for the domain in keywords.json.

    python -m rank_tracker.main                 # the weekly run: SERPs, Search Console, report
    python -m rank_tracker.main --dry-run       # what it would search and what it would cost
    python -m rank_tracker.main --limit 4       # a cheap smoke test

Each step stands alone: a failed Search Console read still leaves a report about the
SERPs, and the job exits non-zero so the failure shows in Cloud Run.
"""
import argparse
import logging
import math
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import requests

from . import config, dataforseo, gsc, index_status, report

log = logging.getLogger("rank_tracker")
PRICE_PER_SERP = 0.0006  # DataForSEO standard queue, USD per page of 10 results


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name, default)
    return v.strip() if isinstance(v, str) else v


def estimate(checks: list, depth: int) -> float:
    return len(checks) * math.ceil(depth / 10) * PRICE_PER_SERP


def run_serps(store, panel: dict, checks: list, week: date) -> int:
    client = dataforseo.Client(env("DATAFORSEO_LOGIN"), env("DATAFORSEO_PASSWORD"))
    posted = client.post(checks, panel["depth"])
    log.info("queued %d of %d searches", len(posted), len(checks))
    done = client.collect(posted, timeout_s=int(env("SERP_TIMEOUT_S", "5400")))
    summaries, results = [], []
    for tid, task in done.items():
        s, rows = dataforseo.parse(task, posted[tid], week)
        summaries.append(s)
        results += rows
    if summaries:
        store.replace_partition("serp_checks", week, summaries)
    if results:
        store.replace_partition("serp_results", week, results)
    log.info("stored %d searches, %d organic results", len(summaries), len(results))
    return len(checks) - len(done)


def run_gsc(store, site: str, days: int, today: date) -> None:
    end = today - timedelta(days=3)          # Search Console's final data lags 2 to 3 days
    start = end - timedelta(days=days - 1)
    http = gsc.session()
    for table, rows in (
        ("gsc_performance", gsc.to_rows(gsc.fetch(http, site, start, end))),
        ("gsc_pages", gsc.to_page_rows(gsc.fetch(http, site, start, end, gsc.PAGE_DIMENSIONS))),
    ):
        by_day = defaultdict(list)
        for r in rows:
            by_day[r["date"]].append(r)
        for day, day_rows in sorted(by_day.items()):
            store.replace_partition(table, date.fromisoformat(day), day_rows)
        log.info("stored %d %s rows for %s to %s", len(rows), table, start, end)


def run_index(store, site: str, sitemaps: list[str], week: date, sample: str | None = None) -> None:
    # The sitemaps are public: fetch them without the Search Console token.
    urls = index_status.sitemap_urls(requests.Session(), sitemaps)
    rows = index_status.inspect(gsc.session(), site, urls, week, sample=sample)
    if rows:
        store.replace_partition("index_status", week, rows)
    log.info("inspected %d of %d sitemap URLs", len(rows), len(urls))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="list the searches and the cost, call nothing")
    p.add_argument("--limit", type=int, help="run only the first N searches (smoke test)")
    p.add_argument("--skip-serp", action="store_true")
    p.add_argument("--skip-gsc", action="store_true")
    p.add_argument("--skip-index", action="store_true", help="skip the URL Inspection of every sitemap URL")
    p.add_argument("--gsc-days", type=int, default=int(env("GSC_DAYS", "14")),
                   help="days of Search Console to (re)load; 14 keeps the comparison week filled")
    p.add_argument("--week", type=date.fromisoformat, help="Monday of the week to file the run under")
    a = p.parse_args(argv)
    logging.basicConfig(level=env("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s: %(message)s")

    panel = config.load_panel()
    checks = config.checks(panel)[: a.limit] if a.limit else config.checks(panel)
    week = config.week_of(a.week) if a.week else config.this_week()
    if a.dry_run:
        for c in checks:
            print(f"{c.market}\t{c.device}\t{c.keyword}")
        print(f"{len(checks)} searches, depth {panel['depth']}, about ${estimate(checks, panel['depth']):.2f}", file=sys.stderr)
        return 0

    from .store import Store
    store = Store(env("GOOGLE_CLOUD_PROJECT"), env("BQ_DATASET", "seo_rankings"), env("BQ_LOCATION", "EU"))
    store.ensure()
    errors, missing = [], 0

    if not a.skip_serp:
        try:
            missing = run_serps(store, panel, checks, week)
        except Exception as e:  # noqa: BLE001  the report still goes out without the SERPs
            log.exception("SERP step failed")
            errors.append(f"SERPs: {e}")
    gsc_ok = False
    if not a.skip_gsc:
        try:
            run_gsc(store, env("GSC_SITE") or f"sc-domain:{panel['our_domain']}", a.gsc_days, datetime.now(config.TZ).date())
            gsc_ok = True
        except Exception as e:  # noqa: BLE001
            log.exception("Search Console step failed")
            errors.append(f"Search Console: {e}")

    index_ok = False
    if not a.skip_index:
        try:
            run_index(store, env("GSC_SITE") or f"sc-domain:{panel['our_domain']}", panel.get("sitemaps", []), week, panel.get("index_sample_pattern"))
            index_ok = True
        except Exception as e:  # noqa: BLE001
            log.exception("index status step failed")
            errors.append(f"Index status: {e}")

    prev = store.previous_week(week)
    gsc_range, gsc_this, gsc_prev = None, [], []
    if gsc_ok and (last := store.gsc_last_date()):
        gsc_range = (last - timedelta(days=6), last)
        gsc_this = store.gsc_by_query(*gsc_range)
        gsc_prev = store.gsc_by_query(last - timedelta(days=13), last - timedelta(days=7))
    md = report.build(week, prev, store.results(week), store.results(prev) if prev else [],
                      store.checks_of(week), panel, gsc_this, gsc_prev, gsc_range, missing,
                      index_rows=store.index_rows(week) if index_ok else None)
    if errors:
        md += "\n\n## Errors this run\n\n" + "\n".join(f"- {e}" for e in errors) + "\n"
    store.replace_partition("weekly_reports", week, [{
        "week": week.isoformat(), "created_at": datetime.now(timezone.utc).isoformat(), "markdown": md}])
    print(md)

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
