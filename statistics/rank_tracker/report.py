"""The weekly report, as Markdown, stored in BigQuery and shown on the admin page. Pure functions over rows, so it is tested without
BigQuery: positions this week against the previous week, where the watched competitor
sits above us, our moves, newcomers to the top 10, AI Overviews and Search Console."""
from collections import defaultdict
from datetime import date

from .config import is_domain

MAX_ROWS = 40
MOVE = 3  # places; smaller moves are noise between weekly snapshots


def positions(results: list[dict]) -> dict[tuple, dict[str, int]]:
    """(market, device, keyword) -> domain -> best organic position."""
    out: dict[tuple, dict[str, int]] = defaultdict(dict)
    for r in results:
        key = (r["market"], r["device"], r["keyword"])
        d, pos = r["domain"], r["rank_group"]
        if d and pos and (d not in out[key] or pos < out[key][d]):
            out[key][d] = pos
    return out


def position_of(pos: dict[str, int], domain: str) -> int | None:
    hits = [p for d, p in pos.items() if is_domain(d, domain)]
    return min(hits) if hits else None


def _fmt(p: int | None) -> str:
    return str(p) if p else "–"


def _table(head: list[str], rows: list[list], more_label: str = "more") -> list[str]:
    if not rows:
        return ["None this week.", ""]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows[:MAX_ROWS]]
    if len(rows) > MAX_ROWS:
        lines.append(f"\n…and {len(rows) - MAX_ROWS} {more_label}.")
    return lines + [""]


def market_summary(now: dict, before: dict, keys: list[tuple], ours: str, rival: str) -> list[list]:
    rows = []
    for market in sorted({k[0] for k in keys}):
        mk = [k for k in keys if k[0] == market]

        def count(snap, domain, top):
            return sum(1 for k in mk if (p := position_of(snap.get(k, {}), domain)) and p <= top)

        cells = [market, len(mk)]
        for domain in (ours, rival):
            for top in (10, 20):
                n, b = count(now, domain, top), count(before, domain, top) if before else None
                cells.append(f"{n}" + (f" ({n - b:+d})" if b is not None and n != b else ""))
        rows.append(cells)
    return rows


def rival_ahead(now: dict, keys: list[tuple], ours: str, rival: str) -> list[list]:
    rows = []
    for k in keys:
        r, o = position_of(now.get(k, {}), rival), position_of(now.get(k, {}), ours)
        if r and (not o or r < o):
            rows.append([k[0], k[1], k[2], r, _fmt(o)])
    return sorted(rows, key=lambda r: (r[3], r[0], r[2]))


def our_moves(now: dict, before: dict, keys: list[tuple], ours: str) -> list[list]:
    rows = []
    for k in keys:
        if k not in before:
            continue  # a new keyword or market has no week to compare with
        n, b = position_of(now.get(k, {}), ours), position_of(before.get(k, {}), ours)
        if n == b:
            continue
        if n and b:
            if abs(n - b) < MOVE:
                continue
            change = f"{b - n:+d}"
        else:
            change = "new" if n else "gone"
        rows.append([k[0], k[1], k[2], _fmt(b), _fmt(n), change])
    return sorted(rows, key=lambda r: (r[5] not in ("new", "gone"), r[0], r[2]))


def new_in_top10(now: dict, before: dict, ours: str) -> list[list]:
    """Domains in a market's top 10 this week that were in none of its top 10s last week."""
    def by_market(snap):
        seen = defaultdict(lambda: defaultdict(set))
        for (market, device, kw), pos in snap.items():
            for d, p in pos.items():
                if p <= 10:
                    seen[market][d].add(kw)
        return seen
    n, b = by_market(now), by_market(before)
    checked_before = {k[0] for k in before}  # a market with no top-10 entry last week still counts
    rows = []
    for market, domains in n.items():
        if market not in checked_before:
            continue
        for d, kws in domains.items():
            if d not in b[market] and not is_domain(d, ours):
                rows.append([market, d, len(kws), ", ".join(sorted(kws)[:3])])
    return sorted(rows, key=lambda r: (-r[2], r[0], r[1]))


def watched(now: dict, before: dict, keys: list[tuple], domains: list[str]) -> list[list]:
    """Per watched domain: searches in the top 10 and top 20, with the change since last week."""
    rows = []
    for domain in domains:
        cells = [domain]
        for top in (10, 20):
            n = sum(1 for k in keys if (p := position_of(now.get(k, {}), domain)) and p <= top)
            if before:
                b = sum(1 for k in keys if k in before and (p := position_of(before.get(k, {}), domain)) and p <= top)
                cells.append(f"{n} ({n - b:+d})" if n != b else f"{n}")
            else:
                cells.append(f"{n}")
        rows.append(cells)
    return rows


def ai_overviews(checks: list[dict], ours: str, rival: str) -> list[list]:
    per = defaultdict(lambda: [0, 0, 0])
    for c in checks:
        doms = c.get("ai_overview_domains") or []
        if not doms:
            continue
        p = per[c["market"]]
        p[0] += 1
        p[1] += any(is_domain(d, ours) for d in doms)
        p[2] += any(is_domain(d, rival) for d in doms)
    return [[m, *v] for m, v in sorted(per.items())]


def gsc_section(this: list[dict], prev: list[dict], start: date, end: date) -> list[str]:
    if not this:
        return ["No Search Console data yet. The job's service account needs access to the property.", ""]

    def totals(rows):
        clicks = sum(r["clicks"] for r in rows)
        imps = sum(r["impressions"] for r in rows)
        pos = sum((r["position"] or 0) * r["impressions"] for r in rows) / imps if imps else None
        return clicks, imps, pos

    c, i, p = totals(this)
    pc, pi, pp = totals(prev) if prev else (None, None, None)

    def delta(a: int | None, b: int | None) -> str:
        return f" ({a - b:+d})" if a is not None and b is not None and a != b else ""

    lines = [
        f"{start:%d %b} to {end:%d %b %Y}, all countries, against the 7 days before.",
        "",
        f"- Clicks: **{c}**{delta(c, pc)}",
        f"- Impressions: **{i}**{delta(i, pi)}",
        f"- Average position: **{p:.1f}**" + (f" (was {pp:.1f})" if pp else "") if p else "- Average position: –",
        "",
        "Top queries by impressions (lower position is better):",
        "",
    ]
    before = {r["query"]: r for r in prev}
    rows = []
    for r in sorted(this, key=lambda r: -r["impressions"])[:15]:
        b = before.get(r["query"])
        was = f"{b['position']:.1f}" if b and b["position"] else "–"
        rows.append([r["query"], r["impressions"], r["clicks"], f"{r['position']:.1f}" if r.get("position") else "–", was])
    return lines + _table(["Query", "Impressions", "Clicks", "Position", "Last week"], rows)


def index_section(rows: list[dict] | None, key_pages: list[str]) -> list[str]:
    if rows is None:
        return ["Index status was not checked this run.", ""]
    if not rows:
        return ["No sitemap URL was inspected.", ""]
    per = defaultdict(lambda: [0, 0])
    for r in rows:
        per[r["locale"]][0] += r["verdict"] == "PASS"
        per[r["locale"]][1] += 1
    indexed = sum(v[0] for v in per.values())
    lines = [f"**{indexed} of {len(rows)}** inspected URLs are in Google's index.", ""]
    lines += _table(["Section", "Indexed", "Inspected"], [[loc, v[0], v[1]] for loc, v in sorted(per.items())])
    states = defaultdict(int)
    for r in rows:
        states[r["coverage_state"] or "unknown"] += 1
    lines += _table(["Google's status", "URLs"], sorted(([s, n] for s, n in states.items()), key=lambda x: -x[1]))
    by_url = {r["url"]: r for r in rows}
    key = [[u, (by_url[u]["coverage_state"] or "–") if u in by_url else "not in sitemap"] for u in key_pages]
    if key:
        lines += ["Key pages:", ""] + _table(["Page", "Status"], key)
    return lines


def build(week: date, prev_week: date | None, results: list[dict], prev_results: list[dict],
          checks: list[dict], panel: dict, gsc_this: list[dict], gsc_prev: list[dict],
          gsc_range: tuple[date, date] | None, missing: int = 0,
          index_rows: list[dict] | None = None) -> str:
    ours = panel["our_domain"]
    rival = panel["watch_domains"][0]
    now, before = positions(results), positions(prev_results)
    keys = sorted({(c["market"], c["device"], c["keyword"]) for c in checks})
    lines = [
        f"# Google rankings, week of {week:%d %B %Y}",
        "",
        f"{len(keys)} searches: fixed keywords per market, desktop and mobile, top 20, no personalisation."
        + (f" Compared with the week of {prev_week:%d %B}." if prev_week else " First week, nothing to compare with yet."),
    ]
    if missing:
        lines.append(f"\n**{missing} searches did not come back in time and are missing this week.**")
    lines += ["", "## Is Google indexing us?", ""]
    lines += index_section(index_rows, panel.get("key_pages", []))
    lines += [f"## Per market: searches where we and {rival} rank", ""]
    lines += _table(["Market", "Searches", f"{ours} top 10", f"{ours} top 20", f"{rival} top 10", f"{rival} top 20"],
                    market_summary(now, before, keys, ours, rival))
    lines += ["## Us and every watched competitor", ""]
    lines += _table(["Domain", "Searches in top 10", "Searches in top 20"],
                    watched(now, before, keys, [ours, *panel["watch_domains"]]))
    lines += [f"## Where {rival} ranks above us", ""]
    lines += _table(["Market", "Device", "Search", rival, ours], rival_ahead(now, keys, ours, rival), "more searches")
    lines += ["## Our moves of 3 places or more", ""]
    lines += _table(["Market", "Device", "Search", "Last week", "This week", "Change"],
                    our_moves(now, before, keys, ours) if prev_week else [], "more moves")
    lines += ["## New in a market's top 10", ""]
    lines += _table(["Market", "Domain", "Searches", "For example"], new_in_top10(now, before, ours) if prev_week else [])
    lines += ["## AI Overviews", ""]
    lines += _table(["Market", "Searches with one", f"Cite {ours}", f"Cite {rival}"], ai_overviews(checks, ours, rival))
    lines += ["## Search Console: what real searchers saw", ""]
    lines += gsc_section(gsc_this, gsc_prev, *gsc_range) if gsc_range else ["Search Console was not read this run.", ""]
    return "\n".join(lines)
