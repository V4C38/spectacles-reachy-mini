"""IP relay: the PIN must recover from a late network, a failed relay, and an IP change."""

from __future__ import annotations

from spectacles_reachy_mini.ip_relay import IpRelayPublisher


def test_pin_retries_until_relay_answers_and_follows_ip_change() -> None:
    ip: list[str | None] = [None]
    relay_up = [False]
    calls: list[tuple[str, str]] = []

    pub = IpRelayPublisher("https://relay.test", lambda: ip[0], 8765)

    def fake_request(method, path, payload=None, key=None):
        calls.append((method, path))
        if not relay_up[0]:
            return None
        if method == "POST":
            return {"pin": "123456" if payload["ip"] == "10.0.0.2" else "654321", "key": "k"}
        return {}

    pub._request = fake_request

    pub._cycle()
    assert pub.pin is None and calls == []

    ip[0] = "10.0.0.2"
    pub._cycle()
    assert pub.pin is None

    relay_up[0] = True
    pub._cycle()
    assert pub.pin == "123456" and pub.ip == "10.0.0.2"

    ip[0] = "10.0.0.3"
    pub._cycle()
    assert pub.pin == "654321" and pub.ip == "10.0.0.3"
    assert ("DELETE", "/v1/pins/123456") in calls
