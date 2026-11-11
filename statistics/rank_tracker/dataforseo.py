"""DataForSEO Google organic SERP API, standard queue (task_post, tasks_ready, task_get).

The standard queue is the cheapest mode and answers within minutes, which is fine for a
weekly job. Every search runs from a fixed country, language and device with no account
or history behind it, so week N and week N+1 are comparable.
"""
import logging
import time
from datetime import datetime, timezone

import requests

from .config import Check, normalize_domain

log = logging.getLogger(__name__)

API = "https://api.dataforseo.com/v3/serp/google/organic"
BATCH = 100          # the API's limit per task_post
TASK_CREATED = 20100
OK = 20000


class DataForSEOError(RuntimeError):
    pass


class Client:
    def __init__(self, login: str, password: str, session: requests.Session | None = None):
        if not login or not password:
            raise DataForSEOError("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set")
        self.s = session or requests.Session()
        self.s.auth = (login, password)

    def _call(self, method: str, path: str, **kw) -> dict:
        r = self.s.request(method, f"{API}/{path}", timeout=60, **kw)
        try:
            body = r.json()
        except ValueError:
            r.raise_for_status()
            raise
        # The API explains a refusal in the body (40104 "Please verify your account"), so
        # that message is what the error carries, not just the HTTP status.
        if not r.ok and body.get("status_code") is None:
            r.raise_for_status()
        if body.get("status_code") != OK:
            raise DataForSEOError(f"{path}: {body.get('status_code')} {body.get('status_message')}")
        return body

    def post(self, checks: list[Check], depth: int) -> dict[str, Check]:
        """Queues every check. Returns task id -> check for the ones the API accepted."""
        posted: dict[str, Check] = {}
        for i in range(0, len(checks), BATCH):
            batch = checks[i:i + BATCH]
            body = self._call("POST", "task_post", json=[{
                "keyword": c.keyword,
                "location_code": c.location_code,
                "language_code": c.language_code,
                "device": c.device,
                "depth": depth,
                "tag": c.tag,
            } for c in batch])
            by_tag = {c.tag: c for c in batch}
            for t in body.get("tasks") or []:
                tag = (t.get("data") or {}).get("tag")
                if t.get("status_code") == TASK_CREATED and tag in by_tag:
                    posted[t["id"]] = by_tag[tag]
                else:
                    log.warning("task not created: %s %s (%s)", t.get("status_code"), t.get("status_message"), tag)
        return posted

    def ready_ids(self) -> set[str]:
        body = self._call("GET", "tasks_ready")
        return {r["id"] for t in body.get("tasks") or [] for r in (t.get("result") or [])
                if isinstance(r, dict) and r.get("id")}

    def get(self, task_id: str) -> dict:
        body = self._call("GET", f"task_get/advanced/{task_id}")
        return (body.get("tasks") or [{}])[0]

    def collect(self, posted: dict[str, Check], timeout_s: int = 5400, poll_s: int = 30,
                sleep=time.sleep) -> dict[str, dict]:
        """Waits for the queued tasks and returns task id -> task. Gives up on stragglers
        after timeout_s; the run then records what came back and says what is missing."""
        pending, done, retry = set(posted), {}, set()
        deadline = time.monotonic() + timeout_s
        while pending:
            try:
                ready = self.ready_ids() & pending
            except (requests.RequestException, DataForSEOError) as e:
                log.warning("tasks_ready failed, retrying: %s", e)
                ready = set()
            # A fetch that failed is retried directly: the ready list may not show it again.
            for tid in ready | retry:
                try:
                    done[tid] = self.get(tid)
                except (requests.RequestException, DataForSEOError) as e:
                    log.warning("task %s not fetched, retrying: %s", tid, e)
                    retry.add(tid)
                    continue
                pending.discard(tid)
                retry.discard(tid)
            if not pending or time.monotonic() > deadline:
                break
            log.info("waiting for %d of %d tasks", len(pending), len(posted))
            sleep(poll_s)
        if pending:
            log.error("%d tasks did not finish in time", len(pending))
        return done


def _reference_domains(node) -> set[str]:
    """Every domain an AI Overview cites, wherever the references sit in the item."""
    found = set()
    if isinstance(node, dict):
        for ref in node.get("references") or []:
            if isinstance(ref, dict) and ref.get("domain"):
                found.add(normalize_domain(ref["domain"]))
        for v in node.values():
            if isinstance(v, (dict, list)):
                found |= _reference_domains(v)
    elif isinstance(node, list):
        for v in node:
            found |= _reference_domains(v)
    return found


def parse(task: dict, check: Check, week, checked_at: datetime | None = None) -> tuple[dict, list[dict]]:
    """One finished task -> (the check's summary row, its organic result rows)."""
    checked_at = checked_at or datetime.now(timezone.utc)
    base = {
        "week": week.isoformat(),
        "market": check.market,
        "location_code": check.location_code,
        "language_code": check.language_code,
        "device": check.device,
        "keyword": check.keyword,
    }
    result = (task.get("result") or [None])[0] or {}
    items = result.get("items") or []
    organic = [{
        **base,
        "rank_group": it.get("rank_group"),
        "rank_absolute": it.get("rank_absolute"),
        "domain": normalize_domain(it.get("domain")),
        "url": it.get("url"),
        "title": it.get("title"),
    } for it in items if it.get("type") == "organic"]
    summary = {
        **base,
        "task_id": task.get("id"),
        "status_code": task.get("status_code"),
        "cost": task.get("cost"),
        "checked_at": checked_at.isoformat(),
        "se_results_count": result.get("se_results_count"),
        "features": sorted({it.get("type") for it in items if it.get("type") and it.get("type") != "organic"}),
        "ai_overview_domains": sorted(_reference_domains([it for it in items if it.get("type") == "ai_overview"])),
        "organic_count": len(organic),
    }
    return summary, organic
