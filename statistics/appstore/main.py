"""Daily job: copies the App Store's Sales and Analytics reports for the app in statistics.json into BigQuery.

Sales: the daily summary for each of the last DAYS days, replaced day by day (Apple corrects late).
Analytics: an ongoing report request (created once, Apple then makes reports daily), and every
daily instance of the two Standard reports not loaded yet.

  python -m appstore.main [--days N] [--skip-sales] [--skip-analytics] [--dry-run]
"""
import argparse
import logging
import os
from datetime import date, timedelta

import settings
from store import Store

from .client import Client, NoReport
from .reports import DISCOVERY, DOWNLOADS, analytics_rows, sales_rows

log = logging.getLogger("appstore")
APP_ID = os.environ.get("APP_ID") or settings.load()["appstore"]["app_id"]


def client() -> Client:
    return Client(os.environ["ASC_KEY"], os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"])


def load_sales(asc: Client, store: Store | None, days: int, today: date) -> int:
    total = 0
    for back in range(days, 0, -1):
        day = (today - timedelta(days=back)).isoformat()
        try:
            text = asc.report("/v1/salesReports", {
                "filter[frequency]": "DAILY", "filter[reportType]": "SALES", "filter[reportSubType]": "SUMMARY",
                "filter[vendorNumber]": os.environ["ASC_VENDOR_NUMBER"], "filter[reportDate]": day, "filter[version]": "1_1"})
            # One vendor can sell several apps; keep this one.
            rows = [r for r in sales_rows(text) if r["sku"] in (None, os.environ.get("APP_SKU") or settings.load()["appstore"]["sku"])]
        except NoReport:
            rows = []
        total += len(rows)
        log.info("sales %s: %d rows", day, len(rows))
        if store:
            store.replace_sales(day, rows)
    return total


def report_request(asc: Client) -> str:
    """The app's ongoing Analytics report request, made on the first run."""
    existing = asc.all(f"/v1/apps/{APP_ID}/analyticsReportRequests", {"filter[accessType]": "ONGOING"})
    if existing:
        return existing[0]["id"]
    made = asc.post("/v1/analyticsReportRequests", {"data": {
        "type": "analyticsReportRequests", "attributes": {"accessType": "ONGOING"},
        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})
    log.info("created the ongoing analytics report request %s; reports follow within a day or two", made["data"]["id"])
    return made["data"]["id"]


def load_analytics(asc: Client, store: Store | None) -> int:
    request_id = report_request(asc)
    loaded = store.loaded_instances() if store else set()
    total = 0
    for name in (DISCOVERY, DOWNLOADS):
        reports = asc.all(f"/v1/analyticsReportRequests/{request_id}/reports", {"filter[name]": name})
        if not reports:
            log.info("%s: not made yet", name)
            continue
        for instance in asc.all(f"/v1/analyticsReports/{reports[0]['id']}/instances", {"filter[granularity]": "DAILY"}):
            if instance["id"] in loaded:
                continue
            rows = []
            for segment in asc.all(f"/v1/analyticsReportInstances/{instance['id']}/segments"):
                rows += analytics_rows(asc.download(segment["attributes"]["url"]), name, instance["id"])
            total += len(rows)
            log.info("%s %s: %d rows", name, instance["attributes"].get("processingDate"), len(rows))
            if store:
                store.replace_instance(instance["id"], rows)
    return total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--skip-sales", action="store_true")
    parser.add_argument("--skip-analytics", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="read from Apple, write nothing")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

    asc = client()
    store = None if args.dry_run else Store()
    if store:
        store.ensure_tables()
    if not args.skip_sales:
        load_sales(asc, store, args.days, date.today())
    if not args.skip_analytics:
        load_analytics(asc, store)


if __name__ == "__main__":
    main()
