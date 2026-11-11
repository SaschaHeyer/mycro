"""Firebase Auth accounts, read through the Identity Toolkit API with the service's own identity."""
import os

import google.auth
from google.auth.transport.requests import AuthorizedSession

URL = "https://identitytoolkit.googleapis.com/v1/projects/{}/accounts:batchGet"


def fetch_accounts(http=None, project: str | None = None) -> list[dict]:
    if http is None:
        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        http = AuthorizedSession(credentials)
    url = URL.format(project or os.environ["GOOGLE_CLOUD_PROJECT"])
    accounts, token = [], None
    while True:
        r = http.get(url, params={"maxResults": 1000, **({"nextPageToken": token} if token else {})}, timeout=30)
        r.raise_for_status()
        body = r.json()
        accounts += body.get("users", [])
        token = body.get("nextPageToken")
        if not token:
            return accounts
