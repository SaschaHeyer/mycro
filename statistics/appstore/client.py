"""A small App Store Connect API client: a fresh ES256 token per call, JSON for the API and
raw bytes for the gzipped reports. The key is the Admin key also used by scripts/asc.py."""
import gzip
import time

import jwt
import requests

API = "https://api.appstoreconnect.apple.com"


class NoReport(Exception):
    """Apple has no report for that day (yet), or nothing was sold."""


class Client:
    def __init__(self, key: str, key_id: str, issuer: str, http=None):
        self.key, self.key_id, self.issuer = key, key_id, issuer
        self.http = http or requests.Session()

    def _headers(self, accept: str = "application/json") -> dict:
        now = int(time.time())
        token = jwt.encode({"iss": self.issuer, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
                           self.key, algorithm="ES256", headers={"kid": self.key_id})
        return {"Authorization": f"Bearer {token}", "Accept": accept}

    def get(self, path: str, params: dict | None = None) -> dict:
        r = self.http.get(path if path.startswith("http") else API + path, params=params, headers=self._headers(), timeout=60)
        r.raise_for_status()
        return r.json()

    def all(self, path: str, params: dict | None = None) -> list[dict]:
        """Every item across pages."""
        body = self.get(path, {"limit": 200, **(params or {})})
        items = body["data"]
        while body.get("links", {}).get("next"):
            body = self.get(body["links"]["next"])
            items += body["data"]
        return items

    def post(self, path: str, body: dict) -> dict:
        r = self.http.post(API + path, json=body, headers=self._headers(), timeout=60)
        r.raise_for_status()
        return r.json()

    def report(self, path: str, params: dict) -> str:
        """A gzipped TSV report from the API, as text."""
        for attempt in range(3):
            r = self.http.get(API + path, params=params, headers=self._headers("application/a-gzip"), timeout=120)
            # The Sales API answers an odd day with a 500 that a second try gets past.
            if r.status_code < 500:
                break
            time.sleep(2 * (attempt + 1))
        if r.status_code == 404:
            raise NoReport(path)
        r.raise_for_status()
        return gzip.decompress(r.content).decode("utf-8")

    def download(self, url: str) -> str:
        """A report segment: a presigned URL on Apple's storage, so no token is sent."""
        r = self.http.get(url, timeout=120)
        r.raise_for_status()
        return gzip.decompress(r.content).decode("utf-8")
