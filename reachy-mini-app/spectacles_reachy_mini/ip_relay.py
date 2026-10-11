"""Publish this machine's LAN address to the IP relay and hold a six-digit PIN."""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

# Worker URL. Replaced with the deployed *.workers.dev host after wrangler deploy.
IP_RELAY_URL = "https://spectacles-ip-relay.johannestscharn.workers.dev"

_REFRESH_SECONDS = 30


class IpRelayPublisher:
    """Register, refresh, and delete one PIN record. relay_url is IP_RELAY_URL."""

    def __init__(self, relay_url: str, ip: str, port: int) -> None:
        self.relay_url = relay_url.rstrip("/")
        self.ip = ip
        self.port = port
        self.pin: str | None = None
        self._key: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="ip-relay", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=6)
        self._delete()
        self.pin = None

    def _run(self) -> None:
        if not self._create():
            logger.warning("PIN unavailable, enter IP")
            return
        logger.info("PIN: %s", self.pin)
        while not self._stop.wait(_REFRESH_SECONDS):
            if self._refresh():
                continue
            self.pin = None
            if not self._create():
                logger.warning("PIN unavailable, enter IP")
                return
            logger.info("PIN: %s", self.pin)

    def _create(self) -> bool:
        body = self._request(
            "POST",
            "/v1/pins",
            {"ip": self.ip, "port": self.port},
        )
        if not body or "pin" not in body or "key" not in body:
            return False
        self.pin = str(body["pin"])
        self._key = str(body["key"])
        return True

    def _refresh(self) -> bool:
        if self.pin is None or self._key is None:
            return False
        body = self._request("PUT", f"/v1/pins/{self.pin}", key=self._key)
        return body is not None

    def _delete(self) -> None:
        if self.pin is None or self._key is None:
            return
        self._request("DELETE", f"/v1/pins/{self.pin}", key=self._key)
        self._key = None

    def _request(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
        key: str | None = None,
    ) -> dict | None:
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(self.relay_url + path, data=data, method=method)
        if payload is not None:
            req.add_header("Content-Type", "application/json")
        if key is not None:
            req.add_header("Authorization", "Bearer " + key)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read()
                if not raw:
                    return {}
                parsed = json.loads(raw.decode())
                return parsed if isinstance(parsed, dict) else None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            logger.warning("IP relay %s %s failed: %s", method, path, exc)
            return None
