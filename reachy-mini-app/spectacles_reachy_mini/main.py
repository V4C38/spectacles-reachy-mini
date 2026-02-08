"""
Reachy Mini Spectacles App
Exposes a WebSocket server on port 8765 that bridges Snap Spectacles
AR glasses to the Reachy Mini robot via the Python SDK.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import threading
from pathlib import Path

import uvicorn

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from reachy_mini import ReachyMini, ReachyMiniApp

from spectacles_reachy_mini.animations import play_animation
from spectacles_reachy_mini.audio_handler import AudioHandler
from spectacles_reachy_mini.movement_handler import MovementHandler
from spectacles_reachy_mini.ws_handler import WebSocketHandler

logger = logging.getLogger(__name__)

WS_PORT = 8765
STATIC_DIR = Path(__file__).parent / "static"


def get_local_ips() -> list[str]:
    """Return all non-loopback IPv4 addresses of this machine."""
    ips: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            if not addr.startswith("127."):
                ips.append(addr)
    except Exception:
        pass
    # Deduplicate while preserving order
    return list(dict.fromkeys(ips))


def create_app(reachy_mini: ReachyMini, stop_event: threading.Event) -> FastAPI:
    """Build the FastAPI application with WebSocket and info endpoints."""

    app = FastAPI(title="Reachy Mini Spectacles Bridge")
    audio_handler = AudioHandler(reachy_mini)
    movement_handler = MovementHandler(reachy_mini)
    ws_handler = WebSocketHandler(movement_handler, audio_handler)

    # ----------------------------------------------------------------
    # WebSocket endpoint
    # ----------------------------------------------------------------
    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        logger.info("Spectacles client connected")
        movement_handler.start()
        # Play happy animation when client connects (non-blocking)
        asyncio.create_task(ws_handler.play_lifecycle_animation("happy"))
        try:
            while not stop_event.is_set():
                raw = await websocket.receive_text()
                await ws_handler.handle_message(websocket, raw)
        except WebSocketDisconnect:
            logger.info("Spectacles client disconnected")
        except Exception as exc:
            logger.error("WebSocket error: %s", exc)
        finally:
            await ws_handler.play_lifecycle_animation("goodbye")
            ws_handler.cleanup()

    # ----------------------------------------------------------------
    # REST endpoints
    # ----------------------------------------------------------------
    @app.get("/api/info")
    async def info() -> JSONResponse:
        ips = get_local_ips()
        return JSONResponse(
            {
                "ips": ips,
                "port": WS_PORT,
                "ws_url": f"ws://{ips[0]}:{WS_PORT}/ws" if ips else None,
            }
        )

    @app.get("/api/status")
    async def status() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @app.get("/")
    async def root() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    # Serve remaining static assets (CSS, etc.)
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    return app


class SpectaclesReachyMini(ReachyMiniApp):
    """Reachy Mini App that exposes a WebSocket bridge for Snap Spectacles."""

    name = "Spectacles AR controller"
    emoji = "😎"
    custom_app_url: str | None = None  # We run our own server on port 8765

    def run(self, reachy_mini: ReachyMini, stop_event: threading.Event) -> None:
        # Print local IPs for easy discovery
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

        # Initialize audio output on the robot
        try:
            reachy_mini.media.start_playing()
            logger.info("Robot audio output initialized")
        except Exception as exc:
            logger.warning("Could not initialize robot audio: %s", exc)

        # Play greeting animation once at startup
        try:
            play_animation(reachy_mini, "greeting")
            logger.info("Startup greeting animation played")
        except Exception as exc:
            logger.warning("Startup greeting animation failed: %s", exc)

        # Build FastAPI app
        app = create_app(reachy_mini, stop_event)

        # Run uvicorn in a background thread
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=WS_PORT,
            log_level="info",
        )
        server = uvicorn.Server(config)

        server_thread = threading.Thread(target=server.run, daemon=True)
        server_thread.start()

        # Block until the daemon signals us to stop
        stop_event.wait()

        # Shutdown
        server.should_exit = True
        server_thread.join(timeout=5)

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
