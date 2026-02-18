"""
WebSocket message router: parse JSON, dispatch by type, correlate request/response.

Receives text frames from the Spectacles client, parses JSON, and routes
set_target, goto, stop_move, play_audio, status, and get_robot_camera_frame.
Animations are handled on the Lens side (RobotDriver / RobotAnimationConfig).
to the appropriate handler (movement, audio, camera). Slow handlers run in
background tasks so the receive loop is never blocked. Sends JSON responses
back with _id for request correlation.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

from spectacles_reachy_mini.audio_handler import AudioHandler
from spectacles_reachy_mini.camera_handler import CameraHandler
from spectacles_reachy_mini.movement_handler import MovementHandler

logger = logging.getLogger(__name__)

# Message types that are slow (blocking) and must run as background tasks
# so the receive loop is never stalled.
_SLOW_TYPES = frozenset({"play_audio", "get_robot_camera_frame"})


class WebSocketHandler:
    """Routes incoming WebSocket messages to the appropriate handler."""

    def __init__(
        self,
        movement: MovementHandler,
        audio: AudioHandler,
        camera: CameraHandler,
    ) -> None:
        self.movement = movement
        self.audio = audio
        self.camera = camera
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
            "play_audio": self._handle_play_audio,
            "status": self._handle_status,
            "get_robot_camera_frame": self._handle_get_robot_camera_frame,
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

    async def _handle_get_robot_camera_frame(self, _msg: dict[str, Any]) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        image_base64 = await loop.run_in_executor(None, self.camera.get_frame)
        return {"type": "get_robot_camera_frame_result", "image_base64": image_base64}

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
