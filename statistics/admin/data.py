"""Turns a week's rows into what the admin page shows. Pure functions, tested without BigQuery."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from rank_tracker.config import is_domain
from rank_tracker.report import position_of


def _ranked(domain: str, now: dict, keys: list[tuple]) -> list[int]:
    return [p for k in keys if (p := position_of(now.get(k, {}), domain))]


def keyword_rows(now: dict, before: dict, keys: list[tuple], ours: str, watch: list[str]) -> list[dict]:
    """One row per keyword: our best position over the markets per device, its change, and the
    best-placed competitor with the market it ranks in."""
    rows = {}

    def best(snap, keyword, device, domain_match):
        hits = [(p, m) for (m, dv, kw) in keys if kw == keyword and dv == device
                for d, p in snap.get((m, dv, kw), {}).items() if domain_match(d)]
        return min(hits) if hits else (None, None)

    for keyword in sorted({k[2] for k in keys}):
        row = rows.setdefault(keyword, {"keyword": keyword, "rival": None, "rival_pos": None,
                                        **{f"{d}{x}": None for d in ("desktop", "mobile") for x in ("", "_market", "_change")}})
        for device in sorted({k[1] for k in keys}):
            pos, market = best(now, keyword, device, lambda d: is_domain(d, ours))
            row[device], row[f"{device}_market"] = pos, market
            checked_before = any(kw == keyword and dv == device and (m, dv, kw) in before for (m, dv, kw) in keys)
            prev, _ = best(before, keyword, device, lambda d: is_domain(d, ours))
            row[f"{device}_change"] = (None if not checked_before else "new" if pos and not prev
                                       else "gone" if prev and not pos else (prev - pos if pos else None))
        for (m, dv, kw) in keys:
            if kw != keyword:
                continue
            for domain, p in now.get((m, dv, kw), {}).items():
                if any(is_domain(domain, w) for w in watch) and (row["rival_pos"] is None or p < row["rival_pos"]):
                    row["rival"], row["rival_pos"] = domain, p

    def order(r):
        return min([p for p in (r.get("desktop"), r.get("mobile")) if p] or [99]), r["keyword"]
    return sorted(rows.values(), key=order)


def domain_row(domain: str, now: dict, before: dict, keys: list[tuple], group: str = "") -> dict:
    ranked = _ranked(domain, now, keys)
    before_keys = [k for k in keys if k in before]
    return {
        "domain": domain, "group": group, "top3": sum(p <= 3 for p in ranked), "top10": sum(p <= 10 for p in ranked),
        "top20": len(ranked), "average": sum(ranked) / len(ranked) if ranked else None,
        "top10_change": (sum(p <= 10 for p in ranked) - sum(p <= 10 for p in _ranked(domain, before, before_keys))) if before else None,
    }


def competitor_rows(now: dict, before: dict, keys: list[tuple], panel: dict) -> list[dict]:
    rows = [domain_row(panel["our_domain"], now, before, keys, "Us")]
    rows += [domain_row(d, now, before, keys, group) for group, domains in panel["competitors"].items() for d in domains]
    return sorted(rows, key=lambda r: (-r["top10"], -r["top20"], r["domain"]))


def unlisted_domains(now: dict, keys: list[tuple], panel: dict) -> list[dict]:
    """Domains in the top 20 that are on no list, so a new competitor does not go unnoticed."""
    known = [panel["our_domain"], *panel["watch_domains"], *panel.get("ignored_domains", [])]
    domains = {d for k in keys for d in now.get(k, {}) if not any(is_domain(d, x) for x in known)}
    rows = [domain_row(d, now, {}, keys) for d in domains]
    return sorted(rows, key=lambda r: (-r["top10"], -r["top20"], r["domain"]))[:40]


def summary(now: dict, before: dict, keys: list[tuple], ours: str) -> dict:
    def count(snap, ks, top):
        return sum(1 for k in ks if (p := position_of(snap.get(k, {}), ours)) and p <= top)
    prev_keys = [k for k in keys if k in before]
    out = {"searches": len(keys), "keywords": len({k[2] for k in keys})}
    for top in (3, 10, 20):
        out[f"top{top}"] = count(now, keys, top)
        out[f"top{top}_change"] = out[f"top{top}"] - count(before, prev_keys, top) if before else None
    ranked = _ranked(ours, now, keys)
    out["average"] = sum(ranked) / len(ranked) if ranked else None
    return out


def trend(history: list[dict], ours: str) -> dict:
    """device -> [(week, our position or None)], one point per week the keyword ran."""
    weeks = sorted({r["week"] for r in history})
    out = {}
    for device in sorted({r["device"] for r in history}):
        out[device] = []
        for week in weeks:
            hits = [r["rank_group"] for r in history
                    if r["week"] == week and r["device"] == device and is_domain(r["domain"], ours)]
            out[device].append((week, min(hits) if hits else None))
    return out


def sparkline(points: list[tuple], width: int = 560, height: int = 120, depth: int = 21) -> str:
    """SVG polyline points for positions over time; position 1 at the top, gaps skipped."""
    n = max(len(points) - 1, 1)
    return " ".join(f"{i / n * width:.1f},{(p - 1) / (depth - 1) * height:.1f}" for i, (_, p) in enumerate(points) if p)


def heatmap_grid(rows: list[dict]) -> list[list[int]]:
    """Seven rows, Monday first, of 24 hourly visit counts."""
    grid = [[0] * 24 for _ in range(7)]
    for r in rows:
        grid[r["day"]][r["hour"]] = r["visits"]
    return grid


def _scale(bars: list[dict], values: bool) -> dict:
    """A y-axis with at most about five steps of a round size, and the top rounded up to one."""
    peak = max([b["value"] for b in bars] + [1])
    step = next(s for s in (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000) if peak / s <= 5)
    top = -(-peak // step) * step
    return {"bars": bars, "top": top, "ticks": list(range(0, int(top) + 1, step)), "values": values}


def _labels(bars: list[dict], every: int) -> None:
    """Dates under every n-th bar, counted back from the newest so the latest one is always labelled."""
    for i, b in enumerate(bars):
        b["label"] = b["day"].strftime("%d %b") if (len(bars) - 1 - i) % every == 0 else ""


def daily_chart(rows: list[dict], days: int, today) -> dict:
    """Every day of the range, days without visits as zero, with the y-axis steps and which dates to label."""
    by_day = {r["day"]: r for r in rows}
    bars = []
    for n in range(days - 1, -1, -1):
        d = today - timedelta(days=n)
        visits, visitors = by_day.get(d, {}).get("visits", 0), by_day.get(d, {}).get("visitors", 0)
        bars.append({"day": d, "value": visits, "shown": str(visits),
                     "title": f"{d.strftime('%a %d %b %Y')}: {visits} visits, {visitors} visitors"})
    _labels(bars, max(1, round(days / 8)))
    return _scale(bars, days <= 31)


def appstore_chart(rows: list[dict], days: int, today) -> dict:
    """Purchases per day over the range, days without any as zero; page views in each bar's title."""
    by_day = {r["day"]: r for r in rows}
    bars = []
    for n in range(days - 1, -1, -1):
        d = today - timedelta(days=n)
        units, views = by_day.get(d, {}).get("units", 0), by_day.get(d, {}).get("page_views", 0)
        bars.append({"day": d, "value": max(units, 0), "shown": str(units),
                     "title": f"{d.strftime('%a %d %b %Y')}: {units} purchases, {views} product page views"})
    _labels(bars, max(1, round(days / 8)))
    return _scale(bars, days <= 31)


def play_chart(rows: list[dict], days: int, today) -> dict:
    """Google Play installs per day over the range, days without a report as zero; uninstalls in each bar's title."""
    by_day = {r["day"]: r for r in rows}
    bars = []
    for n in range(days - 1, -1, -1):
        d = today - timedelta(days=n)
        installs = int(round(by_day.get(d, {}).get("installs") or 0))
        uninstalls = int(round(by_day.get(d, {}).get("uninstalls") or 0))
        bars.append({"day": d, "value": installs, "shown": str(installs),
                     "title": f"{d.strftime('%a %d %b %Y')}: {installs} installs, {uninstalls} uninstalls"})
    _labels(bars, max(1, round(days / 8)))
    return _scale(bars, days <= 31)


def period_chart(rows: list[dict], label, unit: str, today_period) -> dict:
    """Visits per week or month: one bar per row, its number on top; the running period is marked as so far."""
    bars = []
    for r in rows:
        so_far = r["day"] == today_period
        bars.append({"day": r["day"], "value": r["visits"], "shown": str(r["visits"]),
                     "title": f"{unit} {label(r['day'])}: {r['visits']} visits, {r['visitors']} daily visitors summed" + (" (so far)" if so_far else ""),
                     "label": label(r["day"]), "partial": so_far})
    every = max(1, round(len(bars) / 10))
    for i, b in enumerate(bars):
        if (len(bars) - 1 - i) % every:
            b["label"] = ""
    return _scale(bars, True)


def _monday(d):
    return d - timedelta(days=d.weekday())


def weekly_active(days_by_user: dict[str, set], weeks: int, today) -> dict:
    """Learners active in each week (Monday to Sunday), and how many of them were new that week."""
    first = {u: min(ds) for u, ds in days_by_user.items() if ds}
    bars = []
    for n in range(weeks - 1, -1, -1):
        start = _monday(today) - timedelta(weeks=n)
        end = start + timedelta(days=6)
        active = sum(1 for ds in days_by_user.values() if any(start <= d <= end for d in ds))
        new = sum(1 for f in first.values() if start <= f <= end)
        bars.append({"day": start, "value": active, "shown": str(active),
                     "title": f"Week of {start.strftime('%d %b %Y')}: {active} active, {new} new"})
    _labels(bars, max(1, round(weeks / 8)))
    return _scale(bars, True)


def retention(days_by_user: dict[str, set], today, cohorts: int = 8, after: int = 4) -> list[dict]:
    """One row per starting week: how many began learning then, and the share active again 1 to `after` weeks later.
    A week that has not ended yet counts as far as it went; one that has not started is left empty."""
    this_week = _monday(today)
    rows = []
    for n in range(cohorts - 1, -1, -1):
        start = this_week - timedelta(weeks=n)
        members = [ds for ds in days_by_user.values() if ds and _monday(min(ds)) == start]
        later = []
        for k in range(1, after + 1):
            week = start + timedelta(weeks=k)
            if week > this_week or not members:
                later.append(None)
                continue
            back = sum(1 for ds in members if any(week <= d <= week + timedelta(days=6) for d in ds))
            later.append(round(100 * back / len(members)))
        rows.append({"week": start, "size": len(members), "later": later})
    return rows


def _change(now: float, before: float) -> int | None:
    """Percent change, or None when there is nothing to compare with."""
    return round(100 * (now - before) / before) if before else None


def _windows(today) -> dict[str, tuple]:
    """Rolling windows ending today, so a half-finished week or month never looks like a drop:
    WoW compares the last 7 days with the 7 before, MoM the last 30 days with the 30 before."""
    return {k: ((today - timedelta(days=n - 1), today), (today - timedelta(days=2 * n - 1), today - timedelta(days=n)))
            for k, n in (("wow", 7), ("mom", 30))}


def active_change(days_by_user: dict[str, set], today) -> dict:
    """Learners active in the last 7 and 30 days, with the change against the period before."""
    out = {}
    for k, (now, before) in _windows(today).items():
        a = sum(1 for ds in days_by_user.values() if any(now[0] <= d <= now[1] for d in ds))
        b = sum(1 for ds in days_by_user.values() if any(before[0] <= d <= before[1] for d in ds))
        out[k] = {"now": a, "before": b, "change": _change(a, b), "fresh": a > 0}
    return out


SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "CHF": "CHF"}


def _euro(cents: int, currency: str | None = None) -> str:
    """An amount in the configured currency, e.g. 1,234.50 €."""
    import settings
    cur = (currency or settings.load()["currency"]).upper()
    return f"{cents / 100:,.2f} {SYMBOLS.get(cur, cur)}"


def revenue(charges: list[dict], weeks: int, today, tz=None) -> dict:
    """Stripe payments per week (amount less refunds), totals, and the latest payments."""
    tz = tz or _tz()
    paid = [c for c in charges if c.get("paid") and c.get("status") == "succeeded"]
    for c in paid:
        c["when"] = datetime.fromtimestamp(c["created"], tz)
        c["kept"] = c["amount"] - (c.get("amount_refunded") or 0)
        bt = c.get("balance_transaction")
        c["net"] = bt.get("net") if isinstance(bt, dict) else None
    bars = []
    for n in range(weeks - 1, -1, -1):
        start = _monday(today) - timedelta(weeks=n)
        cents = sum(c["kept"] for c in paid if start <= c["when"].date() <= start + timedelta(days=6))
        count = sum(1 for c in paid if start <= c["when"].date() <= start + timedelta(days=6))
        bars.append({"day": start, "value": cents / 100, "shown": _euro(cents) if cents else "",
                     "title": f"Week of {start.strftime('%d %b %Y')}: {_euro(cents)}, {count} payments"})
    _labels(bars, max(1, round(weeks / 8)))
    month = datetime.now(tz) - timedelta(days=30)
    changes = {}
    for k, (now, before) in _windows(today).items():
        a = sum(c["kept"] for c in paid if now[0] <= c["when"].date() <= now[1])
        b = sum(c["kept"] for c in paid if before[0] <= c["when"].date() <= before[1])
        changes[k] = {"now": _euro(a), "before": _euro(b), "change": _change(a, b), "fresh": a > 0}
    nets = [c["net"] for c in paid if c["net"] is not None]
    return {"chart": _scale(bars, True), "changes": changes, "total": _euro(sum(c["kept"] for c in paid)), "count": len(paid),
            "month": _euro(sum(c["kept"] for c in paid if c["when"] >= month)),
            "net": _euro(sum(nets)) if len(nets) == len(paid) else None,
            "recent": [{"when": c["when"], "amount": _euro(c["kept"]),
                        "email": (c.get("billing_details") or {}).get("email") or c.get("receipt_email") or "–",
                        "what": c.get("description") or ", ".join(f"{k}: {v}" for k, v in (c.get("metadata") or {}).items())} for c in sorted(paid, key=lambda c: -c["created"])[:20]]}


def _tz() -> ZoneInfo:
    import settings
    return ZoneInfo(settings.load()["timezone"])


def _when(ms: str | None) -> datetime | None:
    return datetime.fromtimestamp(int(ms) / 1000, _tz()) if ms else None


def user_summary(accounts: list[dict], now: datetime) -> dict:
    """Firebase accounts, newest signup first, with counts for the last 7 and 30 days."""
    rows = sorted(({"email": a.get("email") or "–", "signup": _when(a.get("createdAt")), "login": _when(a.get("lastLoginAt"))} for a in accounts),
                  key=lambda r: r["signup"] or now - timedelta(days=36500), reverse=True)

    def since(field: str, days: int) -> int:
        return sum(1 for r in rows if r[field] and r[field] >= now - timedelta(days=days))
    return {"total": len(rows), "signups_7": since("signup", 7), "signups_30": since("signup", 30),
            "active_7": since("login", 7), "active_30": since("login", 30), "rows": rows}
