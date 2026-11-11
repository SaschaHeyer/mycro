"""The private statistics page. IAP stands in front of it; every request is checked again here against
IAP's signed header, so a misconfigured service stays closed. Which tabs exist is set by the modules in
statistics.json: visitors, growth, users, appstore, googleplay, rankings."""
import os
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import markdown
from flask import Flask, abort, g, redirect, render_template, request
from google.api_core.exceptions import NotFound
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

import settings

from . import activity, data, play, users

IAP_CERTS = "https://www.gstatic.com/iap/verify/public_key"
PERIODS = (7, 30, 90, 365)
TABS = [  # (module, path, label, views that light the tab up)
    ("visitors", "/visitors", "Visitors", ("visitors",)),
    ("growth", "/growth", "Growth", ("growth",)),
    ("users", "/users", "Users", ("users",)),
    ("appstore", "/app-store", "App Store", ("appstore",)),
    ("googleplay", "/google-play", "Google Play", ("googleplay", "googleplay_empty")),
    ("rankings", "/keywords", "Keywords", ("keywords", "keyword")),
    ("rankings", "/competitors", "Competitors", ("competitors",)),
    ("rankings", "/search-console", "Search Console", ("gsc", "no_gsc")),
    ("rankings", "/index-status", "Index status", ("index",)),
    ("rankings", "/report", "Weekly report", ("report",)),
]


def iap_email(assertion: str, audience: str) -> str | None:
    claims = id_token.verify_token(assertion, google_requests.Request(), audience=audience, certs_url=IAP_CERTS)
    return claims.get("email")


def create_app(store=None, ranks=None, panel=None, verify=iap_email, allowed=None, audience=None,
               accounts=users.fetch_accounts, active_days=activity.fetch_active_days, charges=activity.fetch_charges,
               play_data=None) -> Flask:
    cfg = settings.load()
    app = Flask(__name__)
    allowed = {e.lower() for e in (allowed if allowed is not None else
                                   [e for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()])}
    audience = audience or os.environ.get("IAP_AUDIENCE")
    tz = ZoneInfo(cfg["timezone"])
    tabs = [(path, label, views) for module, path, label, views in TABS if cfg["modules"][module]]

    if cfg["modules"]["rankings"]:
        from rank_tracker import config, report
        panel = panel or config.load_panel()

    def get_store():
        nonlocal store
        if store is None:
            from store import Store
            store = Store()
        return store

    def get_ranks():
        nonlocal ranks
        if ranks is None:
            from rank_tracker.store import Store as RankStore
            ranks = RankStore(os.environ.get("GOOGLE_CLOUD_PROJECT"), cfg["datasets"]["rankings"])
        return ranks

    def today() -> date:
        return datetime.now(tz).date()

    def period() -> int:
        days = request.args.get("days", default=30, type=int)
        return days if days in PERIODS else 30

    def page(view: str, **kw):
        return render_template("page.html", view=view, cfg=cfg, tabs=tabs, panel=panel, periods=PERIODS, **kw)

    @app.before_request
    def require_owner():
        assertion = request.headers.get("x-goog-iap-jwt-assertion")
        if not assertion or not audience:
            abort(403)
        try:
            email = (verify(assertion, audience) or "").lower()
        except ValueError:
            abort(403)
        if email not in allowed:
            abort(403)
        g.email = email

    @app.errorhandler(NotFound)
    def no_run(_):
        return page("no_run"), 200

    @app.get("/")
    def home():
        return redirect(tabs[0][0] if tabs else "/visitors")

    if cfg["modules"]["visitors"]:
        @app.get("/visitors")
        def visitors():
            days = period()
            stats = get_store().visits(days)
            grid = data.heatmap_grid(stats["heatmap"])
            now = today()
            return page("visitors", days=days, stats=stats, grid=grid, peak=max(max(row) for row in grid) or 1,
                        chart=data.daily_chart(stats["daily"], days, now),
                        weekly=data.period_chart(stats["weekly"], lambda d: d.strftime("%d %b"), "Week of", now - timedelta(days=now.weekday())),
                        monthly=data.period_chart(stats["monthly"], lambda d: d.strftime("%b %y"), "", now.replace(day=1)))

    if cfg["modules"]["growth"]:
        @app.get("/growth")
        def growth():
            weeks = request.args.get("weeks", default=12, type=int)
            weeks = weeks if weeks in (8, 12, 26, 52) else 12
            days = active_days()
            return page("growth", weeks=weeks, people=len(days), has_activity=bool(days) or cfg["growth"]["activity"].get("source") != "none",
                        wau=data.weekly_active(days, weeks, today()), active=data.active_change(days, today()),
                        cohorts=data.retention(days, today()), money=data.revenue(charges(), weeks, today()),
                        has_revenue=cfg["growth"]["revenue"] != "none")

    if cfg["modules"]["users"]:
        @app.get("/users")
        def signed_up():
            return page("users", users=data.user_summary(accounts(), datetime.now(timezone.utc)))

    if cfg["modules"]["appstore"]:
        @app.get("/app-store")
        def app_store():
            days = period()
            stats = get_store().appstore(days)
            funnel = stats["funnel"]
            return page("appstore", days=days, stats=stats,
                        conversion=(stats["totals"]["units"] / funnel["page_views"] * 100) if funnel["page_views"] else None,
                        chart=data.appstore_chart(stats["daily"], days, today()))

    if cfg["modules"]["googleplay"]:
        @app.get("/google-play")
        def google_play():
            days = period()
            if play_data is not None:
                p = play_data()
            else:
                from google.cloud import bigquery
                project = os.environ.get("GOOGLE_CLOUD_PROJECT")
                p = play.fetch(bigquery.Client(project=project), project, cfg["datasets"]["play"], cfg["googleplay"].get("package"))
            if not p["ready"]:
                return page("googleplay_empty")
            installs = p["daily"].get("installs", [])
            return page("googleplay", days=days, p=p, s=play.summarise(p["daily"], today()),
                        chart=data.play_chart(installs, days, today()), has_installs=bool(installs))

    if cfg["modules"]["rankings"]:
        def snapshot():
            s = get_ranks()
            week = s.latest_week()
            if not week:
                raise NotFound("no run yet")
            prev = s.previous_week(week)
            keys = sorted({(c["market"], c["device"], c["keyword"]) for c in s.checks_of(week)})
            return week, prev, keys, report.positions(s.results(week)), report.positions(s.results(prev)) if prev else {}

        @app.get("/keywords")
        def keywords():
            week, prev, keys, now, before = snapshot()
            return page("keywords", week=week, prev=prev, summary=data.summary(now, before, keys, panel["our_domain"]),
                        keywords=data.keyword_rows(now, before, keys, panel["our_domain"], panel["watch_domains"]))

        @app.get("/keyword")
        def keyword():
            kw = request.args.get("q", "")
            history = get_ranks().history(kw)
            if not history:
                abort(404)
            latest = max(r["week"] for r in history)
            trend = data.trend(history, panel["our_domain"])
            groups = sorted({(r.get("market", ""), r["device"]) for r in history if r["week"] == latest})
            results = {f"{m.upper()} {d}".strip(): [r for r in history if r["week"] == latest and (r.get("market", ""), r["device"]) == (m, d)]
                       for m, d in groups}
            return page("keyword", week=latest, keyword=kw, trend=trend, lines={d: data.sparkline(p) for d, p in trend.items()},
                        results=results, ours=panel["our_domain"])

        @app.get("/competitors")
        def competitors():
            week, prev, keys, now, before = snapshot()
            return page("competitors", week=week, prev=prev, rows=data.competitor_rows(now, before, keys, panel),
                        unlisted=data.unlisted_domains(now, keys, panel))

        @app.get("/search-console")
        def search_console():
            s = get_ranks()
            last = s.gsc_last_date()
            if not last:
                return page("no_gsc")
            this = s.gsc_by_query(last - timedelta(days=27), last)
            return page("gsc", last=last, rows=sorted(this, key=lambda r: -r["impressions"])[:200],
                        clicks=sum(r["clicks"] for r in this), impressions=sum(r["impressions"] for r in this))

        @app.get("/index-status")
        def index_status():
            s = get_ranks()
            week = s.latest_week()
            if not week:
                raise NotFound("no run yet")
            rows = s.index_rows(week)
            states: dict[str, int] = {}
            for r in rows:
                states[r["coverage_state"] or "unknown"] = states.get(r["coverage_state"] or "unknown", 0) + 1
            return page("index", week=week, total=len(rows), indexed=sum(r["verdict"] == "PASS" for r in rows),
                        states=sorted(states.items(), key=lambda x: -x[1]), rows=rows[:300])

        @app.get("/report")
        def weekly_report():
            s = get_ranks()
            week = date.fromisoformat(request.args["week"]) if request.args.get("week") else s.latest_week()
            md = s.report(week) if week else None
            if not md:
                raise NotFound("no report yet")
            return page("report", week=week, html=markdown.markdown(md, extensions=["tables"]))

    return app


def make_app():
    """gunicorn entry point: admin.app:make_app()"""
    return create_app()
