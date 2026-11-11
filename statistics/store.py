"""BigQuery for visitors and the App Store, both in the site dataset (statistics.json datasets.site).
The App Store tables are defined here and created on first run, so the schema lives in the repo;
site_traffic comes from telemetry/schema.json (setup.sh). Every App Store write replaces a day or a
report instance, so a rerun overwrites, never duplicates. All dates are in the configured time zone."""
import os

from google.cloud import bigquery

import settings

F = bigquery.SchemaField

TABLES = {
    "appstore_sales": ("date", [
        F("date", "DATE", "REQUIRED"), F("sku", "STRING"), F("title", "STRING"), F("version", "STRING"),
        F("product_type", "STRING", description="Apple's Product Type Identifier, F1 = Mac app"),
        F("is_update", "BOOLEAN"), F("units", "INTEGER", description="negative for refunds"),
        F("proceeds", "FLOAT", description="units x developer proceeds per unit"), F("proceeds_currency", "STRING"),
        F("customer_price", "FLOAT"), F("customer_currency", "STRING"), F("country", "STRING"), F("device", "STRING"),
        F("promo_code", "STRING"),
    ]),
    "appstore_analytics": ("date", [
        F("date", "DATE", "REQUIRED"), F("report", "STRING", "REQUIRED"), F("instance_id", "STRING", "REQUIRED"),
        F("event", "STRING", description="Impression, Page view, Tap, or a Download Type"), F("page_type", "STRING"),
        F("source_type", "STRING"), F("territory", "STRING"), F("device", "STRING"), F("counts", "INTEGER"),
        F("unique_counts", "INTEGER"),
    ]),
}


class Store:
    def __init__(self, project: str | None = None, dataset: str | None = None, location: str = "EU", bq=None):
        self.project = project or os.environ["GOOGLE_CLOUD_PROJECT"]
        self.dataset = dataset or os.environ.get("BQ_DATASET") or settings.load()["datasets"]["site"]
        self.tz = settings.load()["timezone"]
        self.location = location
        self.bq = bq or bigquery.Client(project=self.project)

    def table(self, name: str) -> str:
        return f"{self.project}.{self.dataset}.{name}"

    def ensure_tables(self) -> None:
        for name, (partition, schema) in TABLES.items():
            t = bigquery.Table(self.table(name), schema=schema)
            t.time_partitioning = bigquery.TimePartitioning(field=partition)
            self.bq.create_table(t, exists_ok=True)

    def _query(self, sql: str, params: list | None = None) -> list[dict]:
        cfg = bigquery.QueryJobConfig(query_parameters=params or [])
        return [dict(r) for r in self.bq.query(sql, job_config=cfg, location=self.location).result()]

    def _replace(self, name: str, where: str, params: list, rows: list[dict]) -> None:
        self._query(f"DELETE FROM `{self.table(name)}` WHERE {where}", params)
        if rows:
            cfg = bigquery.LoadJobConfig(schema=TABLES[name][1], write_disposition="WRITE_APPEND")
            self.bq.load_table_from_json(rows, self.table(name), job_config=cfg, location=self.location).result()

    def replace_sales(self, day: str, rows: list[dict]) -> None:
        self._replace("appstore_sales", "date = @d", [bigquery.ScalarQueryParameter("d", "DATE", day)], rows)

    def replace_instance(self, instance_id: str, rows: list[dict]) -> None:
        self._replace("appstore_analytics", "instance_id = @i", [bigquery.ScalarQueryParameter("i", "STRING", instance_id)], rows)

    def loaded_instances(self) -> set[str]:
        return {r["instance_id"] for r in self._query(f"SELECT DISTINCT instance_id FROM `{self.table('appstore_analytics')}`")}

    def visits(self, days: int) -> dict:
        """The visitor page: totals, breakdowns, the weekday/hour heat map, weeks and months."""
        table = f"`{self.table('site_traffic')}`"
        where = "ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)"
        params = [bigquery.ScalarQueryParameter("days", "INT64", days)]

        def rows(sql: str) -> list[dict]:
            return self._query(sql, params)

        def top(column: str, limit: int = 15) -> list[dict]:
            return rows(f"""SELECT {column} AS name, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS visitors FROM {table}
                            WHERE {where} AND {column} IS NOT NULL GROUP BY name ORDER BY visits DESC LIMIT {limit}""")

        return {
            # A visitor is a browser on one day, so unique visitors add up per day.
            "totals": rows(f"""SELECT COUNT(*) AS visits, COUNT(DISTINCT CONCAT(DATE(ts, '{self.tz}'), visitor_id)) AS visitors,
                               COUNT(DISTINCT visitor_id) AS unique_ids, COUNTIF(source = 'ai') AS ai,
                               COUNTIF(is_returning) AS returning FROM {table} WHERE {where}""")[0],
            "daily": rows(f"""SELECT DATE(ts, '{self.tz}') AS day, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS visitors
                              FROM {table} WHERE {where} GROUP BY day ORDER BY day"""),
            # Weeks and months ignore the chosen period: the last 26 weeks and 24 months, Monday weeks, Berlin time.
            "weekly": self._query(f"""SELECT DATE_TRUNC(DATE(ts, '{self.tz}'), WEEK(MONDAY)) AS day, COUNT(*) AS visits,
                                      COUNT(DISTINCT CONCAT(DATE(ts, '{self.tz}'), visitor_id)) AS visitors FROM {table}
                                      WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 182 DAY) GROUP BY day ORDER BY day"""),
            "monthly": self._query(f"""SELECT DATE_TRUNC(DATE(ts, '{self.tz}'), MONTH) AS day, COUNT(*) AS visits,
                                       COUNT(DISTINCT CONCAT(DATE(ts, '{self.tz}'), visitor_id)) AS visitors FROM {table}
                                       WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 730 DAY) GROUP BY day ORDER BY day"""),
            "heatmap": rows(f"""SELECT MOD(EXTRACT(DAYOFWEEK FROM ts AT TIME ZONE '{self.tz}') + 5, 7) AS day,
                                EXTRACT(HOUR FROM ts AT TIME ZONE '{self.tz}') AS hour, COUNT(*) AS visits
                                FROM {table} WHERE {where} GROUP BY day, hour"""),
            "sources": top("source"), "ai": top("ai_source"), "referrers": top("referrer_domain"),
            "countries": top("country"), "browsers": top("browser"), "devices": top("device"), "systems": top("os"),
            "pages": top("path"), "campaigns": top("utm_campaign"),
            "sections": top("REGEXP_EXTRACT(path, r'^/([^/]+)/')", 16),
        }

    def appstore(self, days: int) -> dict:
        """The App Store page: purchases and proceeds from Sales reports, impressions and page views
        from Analytics reports. Both run a day or two behind."""
        sales, analytics = f"`{self.table('appstore_sales')}`", f"`{self.table('appstore_analytics')}`"
        where = f"date >= DATE_SUB(CURRENT_DATE('{self.tz}'), INTERVAL @days DAY)"
        params = [bigquery.ScalarQueryParameter("days", "INT64", days)]
        bought = f"{where} AND NOT is_update"
        event = "LOWER(event)"
        return {
            "totals": self._query(f"""SELECT COALESCE(SUM(units), 0) AS units, COUNTIF(units < 0) AS refunds
                                      FROM {sales} WHERE {bought}""", params)[0],
            "proceeds": self._query(f"""SELECT proceeds_currency AS currency, ROUND(SUM(proceeds), 2) AS amount
                                        FROM {sales} WHERE {bought} GROUP BY currency ORDER BY amount DESC""", params),
            "funnel": self._query(f"""SELECT COALESCE(SUM(IF({event} = 'impression', counts, 0)), 0) AS impressions,
                                      COALESCE(SUM(IF({event} = 'page view', counts, 0)), 0) AS page_views,
                                      COALESCE(SUM(IF({event} = 'first-time download', counts, 0)), 0) AS first_downloads
                                      FROM {analytics} WHERE {where}""", params)[0],
            "daily": self._query(f"""WITH s AS (SELECT date, SUM(units) AS units FROM {sales} WHERE {bought} GROUP BY date),
                                     a AS (SELECT date, SUM(IF({event} = 'page view', counts, 0)) AS page_views
                                           FROM {analytics} WHERE {where} GROUP BY date)
                                     SELECT COALESCE(s.date, a.date) AS day, COALESCE(units, 0) AS units, COALESCE(page_views, 0) AS page_views
                                     FROM s FULL JOIN a ON s.date = a.date ORDER BY day""", params),
            "countries": self._query(f"""SELECT country AS name, SUM(units) AS units FROM {sales} WHERE {bought}
                                         GROUP BY name ORDER BY units DESC LIMIT 20""", params),
            "sources": self._query(f"""SELECT source_type AS name, SUM(IF({event} = 'page view', counts, 0)) AS page_views,
                                       SUM(IF({event} = 'first-time download', counts, 0)) AS downloads
                                       FROM {analytics} WHERE {where} AND source_type IS NOT NULL
                                       GROUP BY name ORDER BY page_views DESC""", params),
            "versions": self._query(f"""SELECT version AS name, SUM(units) AS units FROM {sales} WHERE {where} AND is_update
                                        GROUP BY name ORDER BY name DESC""", params),
            "last": self._query(f"""SELECT (SELECT MAX(date) FROM {sales}) AS sales, (SELECT MAX(date) FROM {analytics}) AS analytics""")[0],
        }
