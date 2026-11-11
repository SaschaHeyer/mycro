"""The keyword panel (keywords.json) and the week a run belongs to."""
import json
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import settings

TZ = ZoneInfo(settings.load()["timezone"])
KEYWORDS_FILE = Path(os.environ.get("KEYWORDS_FILE", Path(__file__).resolve().parent.parent / "keywords.json"))


@dataclass(frozen=True)
class Check:
    """One Google search the panel runs: a keyword in a market on a device."""
    market: str
    location_code: int
    language_code: str
    device: str
    keyword: str

    @property
    def tag(self) -> str:
        # DataForSEO hands the tag back with the result, so a result maps to its check
        # without keeping the task ids anywhere.
        return f"{self.market}|{self.device}|{self.keyword}"


def load_panel(path: Path = KEYWORDS_FILE) -> dict:
    panel = json.loads(Path(path).read_text(encoding="utf-8"))
    panel["watch_domains"] = [d for group in panel["competitors"].values() for d in group]
    return panel


def checks(panel: dict) -> list[Check]:
    out = []
    for m in panel["markets"]:
        for device in panel["devices"]:
            for kw in panel["keyword_sets"][m["keywords"]]:
                out.append(Check(m["id"], m["location_code"], m["language_code"], device, kw))
    return out


def week_of(day: date) -> date:
    """The Monday that starts the week (in the configured time zone) a day belongs to."""
    return day - timedelta(days=day.weekday())


def this_week(now: datetime | None = None) -> date:
    return week_of((now or datetime.now(TZ)).astimezone(TZ).date())


def normalize_domain(domain: str | None) -> str:
    d = (domain or "").strip().lower()
    return d[4:] if d.startswith("www.") else d


def is_domain(domain: str | None, target: str) -> bool:
    d = normalize_domain(domain)
    return d == target or d.endswith("." + target)
