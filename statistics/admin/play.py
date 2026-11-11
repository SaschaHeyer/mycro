"""The Google Play tab (module googleplay): installs, uninstalls, active devices, ratings, crashes and
ANRs, the store listing's visitors and conversion, countries and earnings, from BigQuery's Google Play
transfer (data source `play`) into the dataset statistics.json names as datasets.play.

The transfer copies Play Console's bulk reports into tables named like Installs_country_<suffix>.
Google documents the table names but not their columns, and the report files have renamed columns
before. So nothing here hard-codes a schema: every page view reads the dataset's
INFORMATION_SCHEMA, picks each table by its name, picks each number from a list of the names it has
gone by, and leaves out whatever is not there. A renamed column shows as a missing number, never as
a broken page. The queries use the views (no p_ prefix), which need no _PARTITIONTIME filter.

Until Play Console has written its first report for the app, the dataset is empty and the tab says
so; references/manual-steps.md has the command that creates the transfer. Built for paperlauncher.app
on 10 November 2026, before any Play report existed, so the column names below come from Play's report
files as documented then; a rename costs a dash on the page, not an error.
"""
import re
from datetime import date, timedelta

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Each kind of table: a regex on the view's name. A transfer may hold several suffixes; the first
# match in name order wins.
TABLES = {
    "installs": r"^Installs_country_",
    "ratings": r"^Ratings_country_",
    "crashes": r"^Crashes_app_version_",
    "store": r"^Store_Performance_country_",
    "earnings": r"^Earnings_",
}
# The names each number has had in Play's reports, best first.
COLUMNS = {
    "date": ["Date"],
    "package": ["Package_Name", "Package_name"],
    "country": ["Country", "Country_Region", "Country_region"],
    "installs": ["Daily_Device_Installs", "Daily_User_Installs", "Install_events", "Install_Events"],
    "uninstalls": ["Daily_Device_Uninstalls", "Daily_User_Uninstalls", "Uninstall_events", "Uninstall_Events"],
    "active": ["Active_Device_Installs", "Active_devices", "Total_User_Installs"],
    "rating": ["Daily_Average_Rating", "Daily_average_rating"],
    "total_rating": ["Total_Average_Rating", "Total_average_rating"],
    "crashes": ["Daily_Crashes", "Daily_crashes"],
    "anrs": ["Daily_ANRs", "Daily_ANRS", "Daily_anrs"],
    "visitors": ["Store_Listing_Visitors", "Store_listing_visitors"],
    "acquisitions": ["Store_Listing_Acquisitions", "Store_listing_acquisitions"],
    "earn_date": ["Transaction_Date", "Transaction_date"],
    "earn_package": ["Product_id", "Product_Id", "Package_Name", "Product_ID"],
    "amount": ["Amount__Merchant_Currency_", "Amount_Merchant_Currency", "Amount__Merchant_Currency",
               "Amount__Buyer_Currency_"],
    "currency": ["Merchant_Currency", "Merchant_currency"],
}


def pick(columns: set[str], kind: str) -> str | None:
    """The first name for `kind` the table has, compared without regard to case."""
    lower = {c.lower(): c for c in columns}
    for name in COLUMNS[kind]:
        if name.lower() in lower:
            found = lower[name.lower()]
            return found if IDENT.match(found) else None
    return None


def find_tables(schema: dict[str, set[str]]) -> dict[str, str]:
    """kind -> view name, from {table name: columns}. Only views (no p_ prefix) are used."""
    out = {}
    for kind, pattern in TABLES.items():
        names = sorted(t for t in schema if re.match(pattern, t) and IDENT.match(t))
        if names:
            out[kind] = names[0]
    return out


def _date(col: str) -> str:
    # Report dates arrive as DATE or as text, depending on the report; this reads either.
    return f"COALESCE(SAFE_CAST(`{col}` AS DATE), SAFE.PARSE_DATE('%Y-%m-%d', CAST(`{col}` AS STRING)))"


def daily_sql(table: str, columns: set[str], kinds: list[str], dataset: str, package: str | None,
              package_kind: str = "package", date_kind: str = "date", agg: str = "SUM") -> str | None:
    """One row per day with the given numbers, or None if the table lacks a date or all of them."""
    day = pick(columns, date_kind)
    found = [(k, pick(columns, k)) for k in kinds]
    found = [(k, c) for k, c in found if c]
    if not day or not found:
        return None
    where = [f"{_date(day)} >= @since"]
    pkg = pick(columns, package_kind)
    if package and pkg:
        where.append(f"`{pkg}` = @package")
    sums = ", ".join(f"{agg}(SAFE_CAST(`{c}` AS FLOAT64)) AS {k}" for k, c in found)
    return (f"SELECT {_date(day)} AS day, {sums} FROM `{dataset}.{table}` "
            f"WHERE {' AND '.join(where)} GROUP BY day ORDER BY day")


def country_sql(table: str, columns: set[str], dataset: str, package: str | None) -> str | None:
    """Installs per country over the period, for the top-countries table."""
    day, country, installs = pick(columns, "date"), pick(columns, "country"), pick(columns, "installs")
    if not (day and country and installs):
        return None
    where = [f"{_date(day)} >= @since"]
    pkg = pick(columns, "package")
    if package and pkg:
        where.append(f"`{pkg}` = @package")
    return (f"SELECT `{country}` AS name, SUM(SAFE_CAST(`{installs}` AS FLOAT64)) AS installs FROM `{dataset}.{table}` "
            f"WHERE {' AND '.join(where)} GROUP BY name HAVING installs > 0 ORDER BY installs DESC LIMIT 15")


def earnings_sql(table: str, columns: set[str], dataset: str, package: str | None) -> str | None:
    """Earnings per month in the merchant currency, newest first."""
    day, amount = pick(columns, "earn_date"), pick(columns, "amount")
    if not (day and amount):
        return None
    currency = pick(columns, "currency")
    where = [f"{_date(day)} >= @since"]
    pkg = pick(columns, "earn_package")
    if package and pkg:
        where.append(f"`{pkg}` = @package")
    cur = f"ANY_VALUE(`{currency}`)" if currency else "''"
    return (f"SELECT DATE_TRUNC({_date(day)}, MONTH) AS month, SUM(SAFE_CAST(`{amount}` AS FLOAT64)) AS amount, "
            f"{cur} AS currency FROM `{dataset}.{table}` WHERE {' AND '.join(where)} GROUP BY month ORDER BY month DESC")


def _window_sum(rows: list[dict], key: str, start: date, end: date) -> float | None:
    vals = [r.get(key) for r in rows if r.get("day") and start <= r["day"] <= end and r.get(key) is not None]
    return sum(vals) if vals else None


def _latest(rows: list[dict], key: str):
    vals = [(r["day"], r[key]) for r in rows if r.get("day") and r.get(key) is not None]
    return max(vals)[1] if vals else None


def _change(now, before) -> int | None:
    return round(100 * (now - before) / before) if now is not None and before else None


def summarise(daily: dict[str, list[dict]], today: date) -> dict:
    """The tiles: rolling 7 and 30 days against the period before, plus the latest of the levels."""
    def window(key: str, rows: list[dict]) -> dict:
        out = {}
        for k, n in (("wow", 7), ("mom", 30)):
            now = _window_sum(rows, key, today - timedelta(days=n - 1), today)
            before = _window_sum(rows, key, today - timedelta(days=2 * n - 1), today - timedelta(days=n))
            out[k] = {"now": now, "before": before, "change": _change(now, before), "fresh": bool(now)}
        return out
    installs, ratings = daily.get("installs", []), daily.get("ratings", [])
    crashes, store = daily.get("crashes", []), daily.get("store", [])
    visitors = _window_sum(store, "visitors", today - timedelta(days=29), today)
    acquired = _window_sum(store, "acquisitions", today - timedelta(days=29), today)
    return {
        "installs": window("installs", installs), "uninstalls": window("uninstalls", installs),
        "active": _latest(installs, "active"), "rating": _latest(ratings, "total_rating") or _latest(ratings, "rating"),
        "crashes_30": _window_sum(crashes, "crashes", today - timedelta(days=29), today),
        "anrs_30": _window_sum(crashes, "anrs", today - timedelta(days=29), today),
        "visitors_30": visitors, "acquired_30": acquired,
        "conversion": 100 * acquired / visitors if visitors and acquired is not None else None,
    }


def weekly(rows: list[dict], key: str, weeks: int, today: date) -> dict[date, float]:
    """{Monday: sum of `key`} for the last `weeks` weeks, for the bar charts."""
    out: dict[date, float] = {}
    first = today - timedelta(days=today.weekday()) - timedelta(weeks=weeks - 1)
    for r in rows:
        d, v = r.get("day"), r.get(key)
        if d and v is not None and d >= first:
            monday = d - timedelta(days=d.weekday())
            out[monday] = out.get(monday, 0) + v
    return {k: int(round(v)) for k, v in out.items()}


def fetch(bq, project: str, dataset: str, package: str | None, days: int = 400) -> dict:
    """Everything the Play tab shows, read live. `bq` is a google.cloud.bigquery Client."""
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery

    if not IDENT.match(dataset):
        raise ValueError(f"bad dataset name {dataset!r}")
    full = f"{project}.{dataset}"
    try:
        cols = list(bq.query(f"SELECT table_name, column_name FROM `{full}.INFORMATION_SCHEMA.COLUMNS`").result())
    except NotFound:
        return {"ready": False, "tables": {}}
    schema: dict[str, set[str]] = {}
    for r in cols:
        schema.setdefault(r["table_name"], set()).add(r["column_name"])
    tables = find_tables(schema)
    if not tables:
        return {"ready": False, "tables": {}}

    since = date.today() - timedelta(days=days)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("since", "DATE", since),
        bigquery.ScalarQueryParameter("package", "STRING", package or ""),
    ])

    def run(sql: str | None) -> list[dict]:
        return [dict(r) for r in bq.query(sql, job_config=cfg).result()] if sql else []

    plans = {
        "installs": ("installs", ["installs", "uninstalls", "active"], {}),
        "ratings": ("ratings", ["rating", "total_rating"], {"agg": "AVG"}),
        "crashes": ("crashes", ["crashes", "anrs"], {}),
        "store": ("store", ["visitors", "acquisitions"], {}),
    }
    daily, missing = {}, []
    for name, (kind, kinds, extra) in plans.items():
        if kind not in tables:
            missing.append(name)
            continue
        t = tables[kind]
        # Active devices is a level, not a flow: sum it over countries, never over days.
        daily[name] = run(daily_sql(t, schema[t], kinds, full, package, **extra))
    countries = run(country_sql(tables["installs"], schema[tables["installs"]], full, package)) if "installs" in tables else []
    earnings = run(earnings_sql(tables["earnings"], schema[tables["earnings"]], full, package)) if "earnings" in tables else []
    return {"ready": True, "tables": tables, "missing": missing, "daily": daily, "countries": countries, "earnings": earnings}
