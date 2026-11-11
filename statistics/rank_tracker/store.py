"""BigQuery: the tables are defined here and created on first run, so the schema lives
in the repo and not only in the console. Every write replaces one partition (a week or
a day), which makes a rerun safe: it overwrites, never duplicates."""
from datetime import date

from google.api_core.exceptions import NotFound
from google.cloud import bigquery

F = bigquery.SchemaField

CHECK_KEY = [
    F("week", "DATE", "REQUIRED", description="Monday of the run's week, configured time zone"),
    F("market", "STRING", "REQUIRED", description="keywords.json market id, e.g. de"),
    F("location_code", "INTEGER"),
    F("language_code", "STRING"),
    F("device", "STRING", "REQUIRED"),
    F("keyword", "STRING", "REQUIRED"),
]

TABLES = {
    "serp_checks": ("week", CHECK_KEY + [
        F("task_id", "STRING"),
        F("status_code", "INTEGER"),
        F("cost", "FLOAT"),
        F("checked_at", "TIMESTAMP"),
        F("se_results_count", "INTEGER"),
        F("features", "STRING", "REPEATED", description="SERP feature types on the page besides organic"),
        F("ai_overview_domains", "STRING", "REPEATED", description="domains the AI Overview cites"),
        F("organic_count", "INTEGER"),
    ]),
    "serp_results": ("week", CHECK_KEY + [
        F("rank_group", "INTEGER", description="position among organic results"),
        F("rank_absolute", "INTEGER", description="position among all SERP items"),
        F("domain", "STRING"),
        F("url", "STRING"),
        F("title", "STRING"),
    ]),
    "gsc_performance": ("date", [
        F("date", "DATE", "REQUIRED"),
        F("query", "STRING"),
        F("page", "STRING"),
        F("country", "STRING"),
        F("device", "STRING"),
        F("clicks", "INTEGER"),
        F("impressions", "INTEGER"),
        F("ctr", "FLOAT"),
        F("position", "FLOAT", description="average position, 1 = top"),
        F("fetched_at", "TIMESTAMP"),
    ]),
    "gsc_pages": ("date", [
        F("date", "DATE", "REQUIRED"),
        F("page", "STRING"),
        F("country", "STRING"),
        F("device", "STRING"),
        F("clicks", "INTEGER"),
        F("impressions", "INTEGER"),
        F("ctr", "FLOAT"),
        F("position", "FLOAT"),
        F("fetched_at", "TIMESTAMP"),
    ]),
    "index_status": ("week", [
        F("week", "DATE", "REQUIRED"),
        F("url", "STRING", "REQUIRED"),
        F("locale", "STRING"),
        F("verdict", "STRING", description="PASS = indexed; NEUTRAL = not indexed (e.g. unknown to Google)"),
        F("coverage_state", "STRING"),
        F("indexing_state", "STRING"),
        F("page_fetch_state", "STRING"),
        F("robots_txt_state", "STRING"),
        F("google_canonical", "STRING"),
        F("user_canonical", "STRING"),
        F("last_crawl_time", "TIMESTAMP"),
        F("checked_at", "TIMESTAMP"),
    ]),
    "weekly_reports": ("week", [
        F("week", "DATE", "REQUIRED"),
        F("created_at", "TIMESTAMP"),
        F("markdown", "STRING"),
    ]),
}


class Store:
    def __init__(self, project: str, dataset: str, location: str = "EU", client: bigquery.Client | None = None):
        self.bq = client or bigquery.Client(project=project)
        self.project, self.dataset, self.location = project or self.bq.project, dataset, location

    def table(self, name: str) -> str:
        return f"{self.project}.{self.dataset}.{name}"

    def ensure(self) -> None:
        """Creates what is missing. Looks before creating: the job's account may edit the
        dataset (setup.sh creates it) without being allowed to create datasets."""
        try:
            self.bq.get_dataset(f"{self.project}.{self.dataset}")
        except NotFound:
            ds = bigquery.Dataset(f"{self.project}.{self.dataset}")
            ds.location = self.location
            self.bq.create_dataset(ds, exists_ok=True)
        existing = {t.table_id for t in self.bq.list_tables(f"{self.project}.{self.dataset}")}
        for name, (part, schema) in TABLES.items():
            if name in existing:
                continue
            t = bigquery.Table(self.table(name), schema=schema)
            t.time_partitioning = bigquery.TimePartitioning(type_=bigquery.TimePartitioningType.DAY, field=part)
            self.bq.create_table(t, exists_ok=True)

    def replace_partition(self, name: str, day: date, rows: list[dict]) -> None:
        """Replaces one day partition (for weekly tables, the week's Monday) with rows."""
        cfg = bigquery.LoadJobConfig(
            schema=TABLES[name][1],
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        )
        dest = f"{self.table(name)}${day.strftime('%Y%m%d')}"
        self.bq.load_table_from_json(rows, dest, job_config=cfg).result()

    def _rows(self, sql: str, **params) -> list[dict]:
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter(k, "DATE" if isinstance(v, date) else "STRING", v) for k, v in params.items()
        ])
        return [dict(r) for r in self.bq.query(sql, job_config=cfg, location=self.location).result()]

    def previous_week(self, week: date) -> date | None:
        rows = self._rows(f"SELECT MAX(week) AS w FROM `{self.table('serp_checks')}` WHERE week < @week", week=week)
        return rows[0]["w"] if rows and rows[0]["w"] else None

    def results(self, week: date) -> list[dict]:
        return self._rows(f"SELECT market, device, keyword, rank_group, domain, url FROM `{self.table('serp_results')}` WHERE week = @week", week=week)

    def checks_of(self, week: date) -> list[dict]:
        return self._rows(f"SELECT market, device, keyword, ai_overview_domains, organic_count FROM `{self.table('serp_checks')}` WHERE week = @week", week=week)

    def gsc_by_query(self, start: date, end: date) -> list[dict]:
        """Clicks, impressions and impression-weighted average position per query."""
        return self._rows(f"""
            SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                   SAFE_DIVIDE(SUM(position * impressions), SUM(impressions)) AS position
            FROM `{self.table('gsc_performance')}`
            WHERE date BETWEEN @start AND @end
            GROUP BY query""", start=start, end=end)

    def index_rows(self, week: date) -> list[dict]:
        return self._rows(f"SELECT url, locale, verdict, coverage_state, last_crawl_time FROM `{self.table('index_status')}` WHERE week = @week", week=week)

    def latest_week(self) -> date | None:
        rows = self._rows(f"SELECT MAX(week) AS w FROM `{self.table('serp_checks')}`")
        return rows[0]["w"] if rows and rows[0]["w"] else None

    def history(self, keyword: str) -> list[dict]:
        """Every week's organic results for one keyword, for the admin page's trend."""
        return self._rows(f"""
            SELECT week, market, device, domain, url, title, rank_group FROM `{self.table('serp_results')}`
            WHERE keyword = @keyword ORDER BY week, market, device, rank_group""", keyword=keyword)

    def report(self, week: date) -> str | None:
        rows = self._rows(f"SELECT markdown FROM `{self.table('weekly_reports')}` WHERE week = @week ORDER BY created_at DESC LIMIT 1", week=week)
        return rows[0]["markdown"] if rows else None

    def gsc_last_date(self) -> date | None:
        rows = self._rows(f"SELECT MAX(date) AS d FROM `{self.table('gsc_performance')}`")
        return rows[0]["d"] if rows and rows[0]["d"] else None
