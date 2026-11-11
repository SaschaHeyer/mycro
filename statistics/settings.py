"""Everything project-specific, read once from statistics.json next to this file (or the file STATS_CONFIG names).

The code itself is the same in every project; a new project only fills in statistics.json and keywords.json.
"""
import json
import os
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULES = ("visitors", "growth", "users", "appstore", "googleplay", "rankings")


@lru_cache(maxsize=1)
def load(path: str | None = None) -> dict:
    cfg = json.loads(Path(path or os.environ.get("STATS_CONFIG") or HERE / "statistics.json").read_text(encoding="utf-8"))
    cfg.setdefault("timezone", "Europe/Berlin")
    cfg.setdefault("currency", "EUR")
    cfg["modules"] = {m: bool(cfg.get("modules", {}).get(m)) for m in MODULES}
    cfg.setdefault("theme", {})
    cfg.setdefault("datasets", {})
    cfg["datasets"].setdefault("site", "site_analytics")
    cfg["datasets"].setdefault("rankings", "seo_rankings")
    cfg["datasets"].setdefault("play", "play")
    cfg.setdefault("googleplay", {})
    cfg.setdefault("growth", {})
    cfg["growth"].setdefault("people", "users")
    cfg["growth"].setdefault("activity", {"source": "none"})
    cfg["growth"].setdefault("revenue", "none")
    return cfg


def on(module: str) -> bool:
    return load()["modules"][module]


def origins() -> set[str]:
    """Sites allowed to send visits: the domain with and without www, plus any listed extra."""
    cfg = load()
    d = cfg["domain"]
    return {f"https://{d}", f"https://www.{d}", *cfg.get("extra_origins", [])}
