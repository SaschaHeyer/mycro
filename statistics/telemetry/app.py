"""Public collector for visitor statistics: one row per visit. With consent the browser sends its
own ids. Without, a daily hash of IP address and browser counts unique visitors and nothing is
stored on the device. The IP address is never stored. Allowed origins and the dataset come from
statistics.json, so the same collector serves any site."""
import hashlib
import hmac
import json
import logging
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

from flask import Flask, Response, request

import settings

log = logging.getLogger(__name__)
ALLOWED_ORIGINS = settings.origins()
MAX_BODY = 4096

AI_REFERRERS = {
    "chatgpt.com": "chatgpt", "openai.com": "chatgpt", "perplexity.ai": "perplexity", "claude.ai": "claude",
    "gemini.google.com": "gemini", "copilot.microsoft.com": "copilot", "you.com": "you", "poe.com": "poe",
    "mistral.ai": "mistral", "grok.com": "grok", "x.ai": "grok", "deepseek.com": "deepseek", "meta.ai": "meta",
    "kimi.com": "kimi", "kimi.moonshot.cn": "kimi",
}
AI_UTM_NAMES = ("chatgpt", "openai", "perplexity", "claude", "gemini", "copilot", "grok", "deepseek", "kimi")
SEARCH_PREFIXES = ("google.", "yahoo.", "yandex.")
SEARCH_DOMAINS = ("bing.com", "duckduckgo.com", "ecosia.org", "brave.com", "startpage.com", "qwant.com", "kagi.com")
SOCIAL_DOMAINS = ("linkedin.com", "lnkd.in", "x.com", "twitter.com", "t.co", "facebook.com", "fb.com", "instagram.com",
                  "reddit.com", "tiktok.com", "youtube.com", "youtu.be", "threads.net", "pinterest.com", "bsky.app",
                  "news.ycombinator.com", "producthunt.com", "mastodon.social")
# Time zones of the larger markets; any other zone shows as its own name. Add zones your visitors come from.
TZ_COUNTRY = {
    "Europe/Berlin": "Germany", "Europe/Busingen": "Germany", "Europe/Vienna": "Austria", "Europe/Zurich": "Switzerland",
    "Europe/Amsterdam": "Netherlands", "Europe/Paris": "France", "Europe/Luxembourg": "Luxembourg", "Europe/Brussels": "Belgium",
    "Europe/Copenhagen": "Denmark", "Europe/Warsaw": "Poland", "Europe/Prague": "Czechia", "Europe/Rome": "Italy",
    "Europe/Madrid": "Spain", "Europe/Lisbon": "Portugal", "Europe/London": "United Kingdom", "Europe/Dublin": "Ireland",
    "Europe/Stockholm": "Sweden", "Europe/Oslo": "Norway", "Europe/Helsinki": "Finland", "Europe/Budapest": "Hungary",
    "Europe/Kiev": "Ukraine", "Europe/Kyiv": "Ukraine", "Europe/Istanbul": "Turkey", "Atlantic/Canary": "Spain",
    "Atlantic/Madeira": "Portugal",
    "America/New_York": "United States", "America/Chicago": "United States", "America/Denver": "United States",
    "America/Phoenix": "United States", "America/Los_Angeles": "United States", "America/Anchorage": "United States",
    "America/Detroit": "United States", "America/Boise": "United States", "Pacific/Honolulu": "United States",
    "America/Indiana/Indianapolis": "United States", "America/Kentucky/Louisville": "United States",
    "America/Toronto": "Canada", "America/Vancouver": "Canada", "America/Edmonton": "Canada", "America/Winnipeg": "Canada",
    "America/Halifax": "Canada", "America/Mexico_City": "Mexico", "America/Sao_Paulo": "Brazil",
    "America/Argentina/Buenos_Aires": "Argentina", "America/Bogota": "Colombia", "America/Santiago": "Chile",
    "Asia/Tokyo": "Japan", "Asia/Seoul": "South Korea", "Asia/Shanghai": "China", "Asia/Hong_Kong": "Hong Kong",
    "Asia/Taipei": "Taiwan", "Asia/Singapore": "Singapore", "Asia/Kolkata": "India", "Asia/Calcutta": "India",
    "Asia/Dubai": "United Arab Emirates", "Asia/Jerusalem": "Israel", "Asia/Tel_Aviv": "Israel", "Asia/Bangkok": "Thailand",
    "Asia/Jakarta": "Indonesia", "Asia/Manila": "Philippines", "Asia/Ho_Chi_Minh": "Vietnam",
    "Australia/Sydney": "Australia", "Australia/Melbourne": "Australia", "Australia/Brisbane": "Australia",
    "Australia/Perth": "Australia", "Australia/Adelaide": "Australia", "Pacific/Auckland": "New Zealand",
    "Africa/Johannesburg": "South Africa", "Africa/Lagos": "Nigeria", "Africa/Cairo": "Egypt",
}
BOT = re.compile(r"bot|crawl|spider|slurp|headless|lighthouse|preview", re.I)


def domain_of(referrer: str | None) -> str | None:
    if not referrer:
        return None
    host = urlparse(referrer if "//" in referrer else f"//{referrer}").hostname
    return host[4:] if host and host.startswith("www.") else host


def _matches(domain: str, candidate: str) -> bool:
    return domain == candidate or domain.endswith("." + candidate)


def classify(referrer: str | None, utm_source: str | None) -> tuple[str, str | None, str | None]:
    """(source, ai_source, referrer_domain)"""
    domain = domain_of(referrer)
    if domain:
        for candidate, name in AI_REFERRERS.items():
            if _matches(domain, candidate):
                return "ai", name, domain
        if domain.startswith(SEARCH_PREFIXES) or any(_matches(domain, c) for c in SEARCH_DOMAINS):
            return "search", None, domain
        if any(_matches(domain, c) for c in SOCIAL_DOMAINS):
            return "social", None, domain
    if utm_source:
        lowered = utm_source.lower()
        for name in AI_UTM_NAMES:
            if name in lowered:
                return "ai", name, domain
        return "other", None, domain
    return ("other", None, domain) if domain else ("direct", None, None)


def parse_agent(ua: str) -> tuple[str, str, str]:
    """(device, browser, os). Order matters: Edge and Samsung also say Chrome, Chrome also says Safari."""
    device = "tablet" if re.search(r"iPad|Tablet|Android(?!.*Mobile)", ua) else "mobile" if "Mobi" in ua or "iPhone" in ua else "desktop"
    browser = next((name for pattern, name in (
        (r"Edg", "Edge"), (r"OPR|Opera", "Opera"), (r"SamsungBrowser", "Samsung Internet"), (r"Firefox|FxiOS", "Firefox"),
        (r"Chrome|CriOS", "Chrome"), (r"Safari", "Safari")) if re.search(pattern, ua)), "Other")
    system = next((name for pattern, name in (
        (r"iPhone|iPad", "iOS"), (r"Android", "Android"), (r"Windows", "Windows"), (r"Mac OS X", "macOS"), (r"Linux", "Linux"))
        if re.search(pattern, ua)), "Other")
    return device, browser, system


def country_of(tz: str | None) -> str | None:
    return TZ_COUNTRY.get(tz or "", tz or None)


def _text(body: dict, key: str, limit: int = 300) -> str | None:
    value = body.get(key)
    return value[:limit] if isinstance(value, str) and value else None


def daily_visitor(ip: str, ua: str, salt: str | None) -> str | None:
    """The same browser hashes alike for one day only, so visitors can't be followed across days."""
    if not salt or not ip:
        return None
    day = datetime.now(timezone.utc).date().isoformat()
    return hmac.new(salt.encode(), f"{day}|{ip}|{ua}".encode(), hashlib.sha256).hexdigest()[:32]


def to_row(body: dict, ua: str, anonymous_id: str | None = None) -> dict:
    # Query strings can carry personal data, so only origin and path are kept.
    referrer = _text(body, "referrer")
    if referrer:
        referrer = referrer.split("?")[0].split("#")[0]
    path = (_text(body, "path") or "/").split("?")[0].split("#")[0]
    utm_source = _text(body, "utm_source", 100)
    source, ai_source, referrer_domain = classify(referrer, utm_source)
    device, browser, system = parse_agent(ua)
    tz = _text(body, "timezone", 64)
    return {
        "ts": datetime.now(timezone.utc).isoformat(), "path": path, "referrer": referrer, "referrer_domain": referrer_domain,
        "source": source, "ai_source": ai_source, "utm_source": utm_source, "utm_medium": _text(body, "utm_medium", 100),
        "utm_campaign": _text(body, "utm_campaign", 100), "session_id": _text(body, "session_id", 64),
        "visitor_id": _text(body, "visitor_id", 64) or anonymous_id, "is_returning": body.get("is_returning") is True, "timezone": tz,
        "country": country_of(tz), "locale": _text(body, "locale", 20), "device": device, "browser": browser, "os": system,
    }


def create_app(insert=None) -> Flask:
    app = Flask(__name__)

    def default_insert(row: dict, row_id: str) -> None:
        from google.cloud import bigquery
        table = f"{os.environ['GOOGLE_CLOUD_PROJECT']}.{os.environ.get('BQ_DATASET') or settings.load()['datasets']['site']}.site_traffic"
        errors = bigquery.Client().insert_rows_json(table, [row], row_ids=[row_id])
        if errors:
            raise RuntimeError(f"BigQuery rejected the row: {errors}")

    write = insert or default_insert

    @app.post("/visit")
    def visit():
        # sendBeacon with text/plain needs no CORS preflight; the origin check keeps other sites out.
        ua = request.headers.get("User-Agent", "")
        if request.headers.get("Origin") not in ALLOWED_ORIGINS or BOT.search(ua) or (request.content_length or 0) > MAX_BODY:
            return Response(status=204)
        try:
            body = json.loads(request.get_data(as_text=True))
            # Cloud Run appends the caller's address last; anything before it can be forged.
            ip = request.headers.get("X-Forwarded-For", "").split(",")[-1].strip()
            row = to_row(body, ua, daily_visitor(ip, ua, os.environ.get("VISITOR_SALT")))
        except (ValueError, AttributeError):
            return Response(status=400)
        try:
            write(row, row["session_id"] or uuid4().hex)
        except Exception:  # noqa: BLE001  statistics must never bother the visitor
            log.exception("visit not stored")
        return Response(status=204)

    @app.get("/health")
    def health():
        return {"ok": True}

    return app


app = create_app()
