"""
WebSocket message router.

Thin layer that parses JSON, routes commands to MovementHandler or
AudioHandler, and manages request/response correlation.  Contains no
movement state or smoothing logic.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

from spectacles_reachy_mini.animations import get_available_animations, play_animation
from spectacles_reachy_mini.audio_handler import AudioHandler
from spectacles_reachy_mini.movement_handler import MovementHandler

logger = logging.getLogger(__name__)

# Message types that are slow (blocking) and must run as background tasks
# so the receive loop is never stalled.
_SLOW_TYPES = frozenset({"play_tts", "play_audio", "play_animation"})


class WebSocketHandler:
    """Routes incoming WebSocket messages to the appropriate handler."""

    def __init__(
        self,
        movement: MovementHandler,
        audio: AudioHandler,
    ) -> None:
        self.movement = movement
        self.audio = audio
        self._background_tasks: set[asyncio.Task[None]] = set()

    async def handle_message(self, websocket: WebSocket, raw: str) -> None:
        """Parse a JSON message and route to the appropriate handler."""
        try:
            msg: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError as exc:
            await self._send_error(websocket, "parse", f"Invalid JSON: {exc}")
            return

        msg_type = msg.get("type")
        request_id = msg.get("_id")

        handler = {
            "set_target": self._handle_set_target,
            "goto": self._handle_goto,
            "stop_move": self._handle_stop_move,
            "play_tts": self._handle_play_tts,
            "play_audio": self._handle_play_audio,
            "status": self._handle_status,
            "get_available_animations": self._handle_get_available_animations,
            "play_animation": self._handle_play_animation,
        }.get(msg_type)

        if handler is None:
            await self._send_error(
                websocket, msg_type or "unknown",
                f"Unknown message type: {msg_type}", request_id,
            )
            return

        # Slow handlers (audio) run as background tasks so the receive loop
        # keeps draining set_target messages.  The response is sent over the
        # WebSocket when the task completes (preserving sendAndWait on the TS side).
        if msg_type in _SLOW_TYPES:
            task = asyncio.create_task(
                self._run_and_respond(handler, msg, request_id, websocket)
            )
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)
            return

        # Fast handlers run inline
        try:
            response = await handler(msg)
        except Exception as exc:
            logger.error("Handler %s failed: %s", msg_type, exc)
            await self._send_error(websocket, msg_type, str(exc), request_id)
            return

        if request_id is None:
            return

        response["_id"] = request_id
        await websocket.send_json(response)

    async def play_lifecycle_animation(self, name: str) -> None:
        """
        Run a named animation for lifecycle events (connect/disconnect).
        Stops the movement loop, plays the animation, then restarts the loop.
        """
        self.movement.stop()
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                lambda: play_animation(self.movement.mini, name),
            )
        except ValueError as exc:
            logger.warning("Lifecycle animation %s failed: %s", name, exc)
        finally:
            self.movement.start()

    def cleanup(self) -> None:
        """Stop movement loop and cancel background tasks."""
        self.movement.stop()
        for task in self._background_tasks:
            task.cancel()
        self._background_tasks.clear()

    # ------------------------------------------------------------------
    # Handlers
    # ------------------------------------------------------------------

    async def _handle_set_target(self, msg: dict[str, Any]) -> dict[str, Any]:
        pose = msg.get("target_head_pose", {})
        body_yaw = msg.get("target_body_yaw")
        antennas = msg.get("target_antennas")
        self.movement.set_target(pose, body_yaw, antennas)
        return {"type": "set_target_result", "success": True}

    async def _handle_goto(self, msg: dict[str, Any]) -> dict[str, Any]:
        pose = msg.get("head_pose", {})
        body_yaw = msg.get("body_yaw", 0.0)
        duration = msg.get("duration", 0.5)
        interpolation = msg.get("interpolation", "minjerk")
        antennas = msg.get("antennas")
        move_uuid = self.movement.goto(pose, body_yaw, antennas, duration, interpolation)
        return {"type": "goto_result", "uuid": move_uuid}

    async def _handle_stop_move(self, msg: dict[str, Any]) -> dict[str, Any]:
        move_uuid = msg.get("uuid", "")
        found = self.movement.stop_move(move_uuid)
        result: dict[str, Any] = {"type": "stop_move_result", "success": found, "uuid": move_uuid}
        if not found:
            result["message"] = "Move not found"
        return result

    async def _handle_play_tts(self, msg: dict[str, Any]) -> dict[str, Any]:
        text = msg.get("text", "")
        voice = msg.get("voice", "alloy")
        if not text.strip():
            return {"type": "play_tts_result", "success": False, "message": "Empty text"}
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: self.audio.play_tts(text, voice))
        return {"type": "play_tts_result", "success": True}

    async def _handle_play_audio(self, msg: dict[str, Any]) -> dict[str, Any]:
        data_b64 = msg.get("data", "")
        sample_rate = msg.get("sample_rate", 16000)
        channels = msg.get("channels", 1)
        if not data_b64:
            return {"type": "play_audio_result", "success": False, "message": "No audio data"}
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, lambda: self.audio.play_raw_audio(data_b64, sample_rate, channels)
        )
        return {"type": "play_audio_result", "success": True}

    async def _handle_status(self, _msg: dict[str, Any]) -> dict[str, Any]:
        return {"type": "status_result", "connected": True}

    async def _handle_get_available_animations(self, _msg: dict[str, Any]) -> dict[str, Any]:
        names = get_available_animations()
        return {"type": "get_available_animations_result", "names": names}

    async def _handle_play_animation(self, msg: dict[str, Any]) -> dict[str, Any]:
        name = (msg.get("name") or "").strip()
        if not name:
            raise ValueError("play_animation requires a non-empty 'name'")
        loop = asyncio.get_running_loop()
        # Run animation and audio in parallel
        anim_task = loop.run_in_executor(
            None,
            lambda: play_animation(self.movement.mini, name),
        )
        audio_task = loop.run_in_executor(
            None,
            lambda: self.audio.play_animation_audio(name),
        )
        duration_sec, _ = await asyncio.gather(anim_task, audio_task)
        return {"type": "play_animation_result", "duration_sec": duration_sec, "success": True}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _run_and_respond(
        self,
        handler: Any,
        msg: dict[str, Any],
        request_id: Any,
        websocket: WebSocket,
    ) -> None:
        """Run a slow handler in the background, send response when done."""
        msg_type = msg.get("type", "unknown")
        try:
            response = await handler(msg)
        except Exception as exc:
            logger.error("Background handler %s failed: %s", msg_type, exc)
            await self._send_error(websocket, msg_type, str(exc), request_id)
            return

        if request_id is None:
            return
        response["_id"] = request_id
        await websocket.send_json(response)

    async def _send_error(
        self,
        websocket: WebSocket,
        request_type: str,
        message: str,
        request_id: Any = None,
    ) -> None:
        response: dict[str, Any] = {
            "type": "error",
            "request_type": request_type,
            "message": message,
        }
        if request_id is not None:
            response["_id"] = request_id
        await websocket.send_json(response)
