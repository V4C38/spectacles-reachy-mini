"""
App entry point and FastAPI setup for the Spectacles–Reachy Mini bridge.

Defines the ReachyMiniApp subclass that runs a WebSocket server on port 8765, wires handlers (movement, audio, camera), and serves the info/status and static info page. Send rate for movement is read from REACHY_SPECTACLES_SEND_RATE_HZ.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
from typing import TYPE_CHECKING

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from reachy_mini import ReachyMini, ReachyMiniApp

# A newer Spectacles connection replaces the previous one. Code 4000 is
# "another client took the robot" — not a network failure.
REPLACED_CODE = 4000

from spectacles_reachy_mini.ip_relay import IP_RELAY_URL, IpRelayPublisher

if TYPE_CHECKING:
    from spectacles_reachy_mini.movement_handler import MovementHandler
    from spectacles_reachy_mini.ws_handler import WebSocketHandler

logger = logging.getLogger(__name__)

WS_PORT = 8765

# Movement send rate (Hz): how often we send set_target to the daemon. Configurable via env.
ENV_SEND_RATE_HZ = "REACHY_SPECTACLES_SEND_RATE_HZ"
DEFAULT_SEND_RATE_HZ = 20.0
SEND_RATE_HZ_MIN = 5.0
SEND_RATE_HZ_MAX = 50.0


def _get_send_rate_hz() -> float:
    """Read send rate from env, clamped to valid range. Default 20 Hz."""
    raw = os.environ.get(ENV_SEND_RATE_HZ)
    if raw is None or raw.strip() == "":
        return DEFAULT_SEND_RATE_HZ
    try:
        value = float(raw.strip())
        return max(SEND_RATE_HZ_MIN, min(SEND_RATE_HZ_MAX, value))
    except ValueError:
        logger.warning(
            "Invalid %s=%r, using default %.1f Hz",
            ENV_SEND_RATE_HZ,
            raw,
            DEFAULT_SEND_RATE_HZ,
        )
        return DEFAULT_SEND_RATE_HZ


def get_local_ips() -> list[str]:
    """Return all non-loopback IPv4 addresses of this machine, default-route address first."""
    ips: list[str] = []
    try:
        # A UDP connect sends nothing; it only makes the OS pick the outbound interface.
        # Needed because gethostname() often does not resolve (macOS) or maps to 127.0.1.1 (Debian).
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
    except OSError as e:
        logger.debug("Could not find default-route IP: %s", e)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError as e:
        logger.debug("Could not resolve local IPs: %s", e)
    return [ip for ip in dict.fromkeys(ips) if not ip.startswith("127.")]


class ActiveSocket:
    """The one client allowed to drive the robot. Newest connection wins."""

    def __init__(self) -> None:
        self.ws: WebSocket | None = None

    async def claim(self, websocket: WebSocket) -> None:
        previous = self.ws
        self.ws = websocket
        if previous is None:
            return
        try:
            await previous.close(code=REPLACED_CODE)
        except Exception as exc:
            logger.info("Replaced client already gone: %s", exc)

    def release(self, websocket: WebSocket) -> bool:
        """True only for the client that still owns the robot."""
        if self.ws is not websocket:
            return False
        self.ws = None
        return True


async def handle_socket(
    websocket: WebSocket,
    *,
    handler: WebSocketHandler,
    movement: MovementHandler,
    stop_event: threading.Event,
    active: ActiveSocket,
) -> None:
    """Serve one client. A replaced client's exit does not stop the motion loop."""
    await websocket.accept()
    await active.claim(websocket)
    logger.info("Spectacles client connected")
    movement.start()
    try:
        while not stop_event.is_set():
            raw = await websocket.receive_text()
            await handler.handle_message(websocket, raw)
    except WebSocketDisconnect:
        logger.info("Spectacles client disconnected")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
    finally:
        if active.release(websocket):
            handler.cleanup()


def _load_media(reachy_mini: ReachyMini) -> None:
    """Swap the no_media manager for the real one. Blocks for as long as GStreamer init takes."""
    try:
        reachy_mini._media_backend = "default"
        reachy_mini.acquire_media()
        reachy_mini.media.start_playing()
        logger.info("Robot audio output initialized")
    except Exception as exc:
        logger.warning("Could not initialize robot media: %s", exc)


class SpectaclesReachyMini(ReachyMiniApp):
    """Reachy Mini App that exposes a WebSocket bridge for Snap Spectacles."""

    name = "SPECS AR Controller"
    emoji = "😎"
    custom_app_url: str | None = "http://0.0.0.0:8765"
    # Media loads in run() on a background thread. The first GStreamer init after a
    # dashboard update rebuilds its plugin registry (~2 min); inside ReachyMini() it
    # would hold back the robot connection, the WebSocket and the PIN for that long.
    request_media_backend = "no_media"

    def __init__(self, running_on_wireless: bool = False) -> None:
        super().__init__(running_on_wireless=running_on_wireless)
        self._ws_handler: WebSocketHandler | None = None
        self._movement: MovementHandler | None = None
        self._publisher: IpRelayPublisher | None = None
        self._bridge_stop: threading.Event | None = None
        self._active_ws = ActiveSocket()
        app = self.settings_app
        assert app is not None

        @app.websocket("/ws")
        async def websocket_endpoint(websocket: WebSocket) -> None:
            handler = self._ws_handler
            movement = self._movement
            stop_event = self._bridge_stop
            if handler is None or movement is None or stop_event is None:
                await websocket.close(code=1013)
                return
            await handle_socket(
                websocket,
                handler=handler,
                movement=movement,
                stop_event=stop_event,
                active=self._active_ws,
            )

        @app.get("/api/info")
        async def info() -> JSONResponse:
            ips = get_local_ips()
            publisher = self._publisher
            return JSONResponse(
                {
                    "ips": ips,
                    "port": WS_PORT,
                    "ws_url": f"ws://{ips[0]}:{WS_PORT}/ws" if ips else None,
                    "pin": publisher.pin if publisher else None,
                }
            )

        @app.get("/api/status")
        async def status() -> JSONResponse:
            return JSONResponse({"status": "ok"})

    def run(self, reachy_mini: ReachyMini, stop_event: threading.Event) -> None:
        # Imported here, after the settings server is already listening: these pull in
        # cv2 and onnxruntime, whose first load after a dashboard update (which
        # force-reinstalls every dependency) can exceed the dashboard's 60 s page timeout.
        from spectacles_reachy_mini.audio_handler import AudioHandler
        from spectacles_reachy_mini.camera_handler import CameraHandler
        from spectacles_reachy_mini.movement_handler import MovementHandler
        from spectacles_reachy_mini.ws_handler import WebSocketHandler

        ips = get_local_ips()
        logger.info("=" * 50)
        logger.info("Reachy Mini Spectacles WebSocket Bridge")
        logger.info("=" * 50)
        for ip in ips:
            logger.info("  WebSocket: ws://%s:%d/ws", ip, WS_PORT)
            logger.info("  Info page: http://%s:%d/", ip, WS_PORT)
        if not ips:
            logger.warning("  Could not detect local IP addresses")
        logger.info("=" * 50)

        media_thread = threading.Thread(
            target=_load_media, args=(reachy_mini,), name="media-load", daemon=True
        )
        media_thread.start()

        self._bridge_stop = stop_event
        audio_handler = AudioHandler(reachy_mini)
        self._movement = MovementHandler(reachy_mini, send_rate_hz=_get_send_rate_hz())
        camera_handler = CameraHandler(reachy_mini)
        self._ws_handler = WebSocketHandler(self._movement, audio_handler, camera_handler)

        self._publisher = IpRelayPublisher(
            IP_RELAY_URL, lambda: next(iter(get_local_ips()), None), WS_PORT
        )
        self._publisher.start()

        try:
            stop_event.wait()
        finally:
            if self._publisher is not None:
                self._publisher.stop()
                self._publisher = None
            if media_thread.is_alive():
                # Still inside GStreamer init. Give the daemon its camera/mic back here,
                # and keep ReachyMini.__exit__ from starting a second init that would block exit.
                try:
                    reachy_mini.client.acquire_media()
                except Exception as exc:
                    logger.warning("Could not hand media back to the daemon: %s", exc)
                reachy_mini._media_released = False
            else:
                try:
                    reachy_mini.media.stop_playing()
                except Exception:
                    pass
            logger.info("Reachy Mini Spectacles Bridge stopped")


if __name__ == "__main__":
    app_instance = SpectaclesReachyMini()
    try:
        app_instance.wrapped_run()
    except KeyboardInterrupt:
        app_instance.stop()
