"""Activity and payments for the Growth tab, read live with the service's own identity.

Activity is {user id: set of days the user was active}. Everything on the Growth tab (weekly active users,
WoW/MoM, retention cohorts) is computed from that one shape, so a new project only has to produce it.
Built-in sources, chosen by growth.activity.source in statistics.json:

- "firestore_days": documents in a collection group (growth.activity.collection, e.g. progress under
  users/<uid>/progress/...) keep a map field (growth.activity.field, e.g. days) with one ISO date key per
  active day. This is how angelschein-lernen records learning days.
- "none": no activity; the Growth tab shows revenue only.

Any other store (Postgres, BigQuery events, an API) gets its own fetch function here that returns the
same shape; see references/growth-sources.md.

Payments: Stripe charges, with the fee per charge from its balance transaction (growth.revenue = "stripe").
"""
import os
from datetime import date

import google.auth
import requests
from google.auth.transport.requests import AuthorizedSession

FIRESTORE = "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents:runQuery"


def fetch_active_days(http=None, project: str | None = None) -> dict[str, set[date]]:
    """{uid: active days}, from the source statistics.json names."""
    import settings
    source = settings.load()["growth"]["activity"]
    if source.get("source") == "firestore_days":
        return fetch_firestore_days(http, project, source.get("collection", "progress"), source.get("field", "days"))
    return {}


def fetch_firestore_days(http=None, project: str | None = None, collection: str = "progress", field: str = "days") -> dict[str, set[date]]:
    """{uid: days}, merged over all of a user's documents in the collection group. The uid is the
    document id that follows users/ in the path."""
    if http is None:
        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        http = AuthorizedSession(credentials)
    query = {"structuredQuery": {"from": [{"collectionId": collection, "allDescendants": True}],
                                 "select": {"fields": [{"fieldPath": field}]}}}
    r = http.post(FIRESTORE.format(project or os.environ["GOOGLE_CLOUD_PROJECT"]), json=query, timeout=60)
    r.raise_for_status()
    days: dict[str, set[date]] = {}
    for row in r.json():
        doc = row.get("document")
        if not doc:
            continue
        path = doc["name"].split("/documents/")[1]
        uid = path.split("/")[1] if path.startswith("users/") else path.split("/")[0]
        found = days.setdefault(uid, set())
        for key in doc.get("fields", {}).get(field, {}).get("mapValue", {}).get("fields", {}):
            try:
                found.add(date.fromisoformat(key))
            except ValueError:
                continue
    return days


def fetch_charges(key: str | None = None, context: str | None = None, http=requests) -> list[dict]:
    """All Stripe charges, newest first, each with its balance transaction (for the fee).
    Empty when growth.revenue is not "stripe" or no key is set. STRIPE_CONTEXT is for a sandbox or
    connected account."""
    import settings
    if settings.load()["growth"]["revenue"] != "stripe":
        return []
    key = key or os.environ.get("STRIPE_SECRET_KEY", "")
    context = context or os.environ.get("STRIPE_CONTEXT", "")
    if not key:
        return []
    headers = {"Authorization": f"Bearer {key}", "Stripe-Version": "2025-03-31.basil", **({"Stripe-Context": context} if context else {})}
    charges, after = [], None
    while True:
        params = {"limit": 100, "expand[]": "data.balance_transaction", **({"starting_after": after} if after else {})}
        r = http.get("https://api.stripe.com/v1/charges", headers=headers, params=params, timeout=30)
        r.raise_for_status()
        body = r.json()
        charges += body["data"]
        if not body.get("has_more") or not body["data"]:
            return charges
        after = body["data"][-1]["id"]
