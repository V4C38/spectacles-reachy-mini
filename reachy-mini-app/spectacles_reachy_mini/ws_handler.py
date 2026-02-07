"""
WebSocket message router and command handlers.
Processes JSON commands from Spectacles and dispatches to the Reachy Mini SDK.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import uuid as uuid_mod
from typing import Any

import numpy as np
from fastapi import WebSocket
from reachy_mini import ReachyMini
from reachy_mini.utils import create_head_pose

from spectacles_reachy_mini.audio_handler import AudioHandler

logger = logging.getLogger(__name__)


class WebSocketHandler:
    """Handles incoming WebSocket messages and dispatches to SDK/audio."""

    # Smoothing factors: higher = more responsive, lower = smoother (reduces jitter)
    SMOOTHING_ALPHA = 0.4  # Head and body
    ANTENNA_SMOOTHING_ALPHA = 0.25  # Antennas need more smoothing

    def __init__(self, reachy_mini: ReachyMini, audio_handler: AudioHandler) -> None:
        self.mini = reachy_mini
        self.audio = audio_handler
        # Active goto tasks keyed by UUID
        self._active_gotos: dict[str, bool] = {}
        # Current pose for goto interpolation start capture
        self._current_pose: dict[str, float] = {
            "x": 0, "y": 0, "z": 0,
            "roll": 0, "pitch": 0, "yaw": 0,
        }
        self._current_body_yaw: float = 0.0
        self._current_antennas: list[float] = [0.0, 0.0]
        # Pending target written by _handle_set_target, consumed by apply loop
        self._pending_pose: dict[str, float] = {**self._current_pose}
        self._pending_body_yaw: float = 0.0
        self._pending_antennas: list[float] = [0.0, 0.0]
        # Smoothed pose applied to robot (reduces jitter from network latency)
        self._displayed_pose: dict[str, float] = {**self._current_pose}
        self._displayed_body_yaw: float = 0.0
        self._displayed_antennas: list[float] = [0.0, 0.0]
        # Background apply task handle (set by start_apply_loop)
        self._apply_task: asyncio.Task[None] | None = None

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
        }.get(msg_type)

        if handler is None:
            await self._send_error(websocket, msg_type or "unknown", f"Unknown message type: {msg_type}", request_id)
            return

        try:
            response = await handler(msg)
        except Exception as exc:
            logger.error("Handler %s failed: %s", msg_type, exc)
            await self._send_error(websocket, msg_type, str(exc), request_id)
            return

        # Fire-and-forget: skip response when no _id (reduces overhead for set_target)
        if request_id is None:
            return

        response["_id"] = request_id
        await websocket.send_json(response)

    def cleanup(self) -> None:
        """Cancel all active goto tasks and stop the apply loop."""
        self.stop_apply_loop()
        for uid in list(self._active_gotos):
            self._active_gotos[uid] = False
        self._active_gotos.clear()

    # ================================================================
    # Command handlers
    # ================================================================

    def _lerp_pose(self, current: dict, target: dict, alpha: float) -> dict:
        return {k: current[k] + alpha * (target.get(k, current[k]) - current[k]) for k in current}

    async def _handle_set_target(self, msg: dict[str, Any]) -> dict[str, Any]:
        """Store latest target values. The background apply loop sends them to the SDK."""
        pose_data = msg.get("target_head_pose", {})
        body_yaw = msg.get("target_body_yaw")
        antennas = msg.get("target_antennas", [0.0, 0.0])

        target_pose = {k: pose_data.get(k, 0) for k in ("x", "y", "z", "roll", "pitch", "yaw")}
        target_body_yaw = body_yaw if body_yaw is not None else self._pending_body_yaw
        target_antennas = list(antennas) if antennas else [0.0, 0.0]

        # Just store -- no SDK call, no await
        self._pending_pose = target_pose
        self._pending_body_yaw = target_body_yaw
        self._pending_antennas = target_antennas

        # Also keep current pose in sync for goto start-capture
        self._current_pose = target_pose
        self._current_body_yaw = target_body_yaw
        self._current_antennas = target_antennas

        return {"type": "set_target_result", "success": True}

    # ================================================================
    # Background apply loop (decouples message rate from SDK rate)
    # ================================================================

    def start_apply_loop(self) -> None:
        """Launch the background apply loop as an asyncio task."""
        if self._apply_task is None or self._apply_task.done():
            self._apply_task = asyncio.ensure_future(self._run_apply_loop())

    def stop_apply_loop(self) -> None:
        """Cancel the background apply loop."""
        if self._apply_task is not None and not self._apply_task.done():
            self._apply_task.cancel()
            self._apply_task = None

    async def _run_apply_loop(self) -> None:
        """Apply the latest pending target to the robot at a fixed ~50Hz rate."""
        loop = asyncio.get_running_loop()
        alpha = self.SMOOTHING_ALPHA
        antenna_alpha = self.ANTENNA_SMOOTHING_ALPHA

        try:
            while True:
                # Exponential smoothing toward pending target
                self._displayed_pose = self._lerp_pose(
                    self._displayed_pose, self._pending_pose, alpha
                )
                self._displayed_body_yaw += alpha * (
                    self._pending_body_yaw - self._displayed_body_yaw
                )
                self._displayed_antennas = [
                    self._displayed_antennas[i]
                    + antenna_alpha * (self._pending_antennas[i] - self._displayed_antennas[i])
                    for i in range(min(len(self._displayed_antennas), len(self._pending_antennas)))
                ]

                head = create_head_pose(
                    x=self._displayed_pose["x"],
                    y=self._displayed_pose["y"],
                    z=self._displayed_pose["z"],
                    roll=self._displayed_pose["roll"],
                    pitch=self._displayed_pose["pitch"],
                    yaw=self._displayed_pose["yaw"],
                    degrees=False,
                )

                kwargs: dict[str, Any] = {
                    "head": head,
                    "body_yaw": self._displayed_body_yaw,
                    "antennas": np.array(self._displayed_antennas, dtype=np.float64),
                }

                try:
                    await loop.run_in_executor(None, lambda: self.mini.set_target(**kwargs))
                except Exception as exc:
                    logger.warning("apply loop set_target failed: %s", exc)

                await asyncio.sleep(0.02)  # ~50Hz
        except asyncio.CancelledError:
            pass

    async def _handle_goto(self, msg: dict[str, Any]) -> dict[str, Any]:
        """Start an interpolated movement in the background. Returns UUID immediately."""
        pose_data = msg.get("head_pose", {})
        body_yaw = msg.get("body_yaw", 0.0)
        duration = msg.get("duration", 0.5)
        interpolation = msg.get("interpolation", "minjerk")
        antennas = msg.get("antennas", [0.0, 0.0])

        move_uuid = str(uuid_mod.uuid4())
        self._active_gotos[move_uuid] = True

        # Capture start pose
        start_pose = dict(self._current_pose)
        start_body_yaw = self._current_body_yaw
        start_antennas = list(self._current_antennas)

        end_pose = {k: pose_data.get(k, 0) for k in ("x", "y", "z", "roll", "pitch", "yaw")}
        end_body_yaw = body_yaw
        end_antennas = list(antennas) if antennas else [0.0, 0.0]

        # Launch interpolation in background
        asyncio.create_task(
            self._run_goto_interpolation(
                move_uuid, start_pose, end_pose,
                start_body_yaw, end_body_yaw,
                start_antennas, end_antennas,
                duration, interpolation,
            )
        )

        return {"type": "goto_result", "uuid": move_uuid}

    async def _handle_stop_move(self, msg: dict[str, Any]) -> dict[str, Any]:
        """Cancel a running goto interpolation."""
        move_uuid = msg.get("uuid", "")
        if move_uuid in self._active_gotos:
            self._active_gotos[move_uuid] = False
            return {"type": "stop_move_result", "success": True, "uuid": move_uuid}
        return {"type": "stop_move_result", "success": False, "uuid": move_uuid, "message": "Move not found"}

    async def _handle_play_tts(self, msg: dict[str, Any]) -> dict[str, Any]:
        """Generate TTS on the server and play on robot speaker."""
        text = msg.get("text", "")
        voice = msg.get("voice", "alloy")
        if not text.strip():
            return {"type": "play_tts_result", "success": False, "message": "Empty text"}

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: self.audio.play_tts(text, voice))

        return {"type": "play_tts_result", "success": True}

    async def _handle_play_audio(self, msg: dict[str, Any]) -> dict[str, Any]:
        """Decode base64 audio and play on robot speaker."""
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
        """Return connection status."""
        return {"type": "status_result", "connected": True}

    # ================================================================
    # Goto interpolation
    # ================================================================

    async def _run_goto_interpolation(
        self,
        move_uuid: str,
        start_pose: dict[str, float],
        end_pose: dict[str, float],
        start_body_yaw: float,
        end_body_yaw: float,
        start_antennas: list[float],
        end_antennas: list[float],
        duration: float,
        interpolation: str,
    ) -> None:
        """Interpolate from start to end pose using set_target at ~50Hz."""
        t0 = time.monotonic()
        loop = asyncio.get_running_loop()

        while self._active_gotos.get(move_uuid, False):
            elapsed = time.monotonic() - t0
            t = min(elapsed / max(duration, 0.001), 1.0)
            s = self._ease(t, interpolation)

            # Lerp all fields
            pose = {k: self._lerp(start_pose[k], end_pose[k], s) for k in start_pose}
            body_yaw = self._lerp(start_body_yaw, end_body_yaw, s)
            antennas_interp = [
                self._lerp(start_antennas[i], end_antennas[i], s)
                for i in range(min(len(start_antennas), len(end_antennas)))
            ]

            head = create_head_pose(
                x=pose["x"], y=pose["y"], z=pose["z"],
                roll=pose["roll"], pitch=pose["pitch"], yaw=pose["yaw"],
                degrees=False,
            )

            try:
                await loop.run_in_executor(
                    None,
                    lambda: self.mini.set_target(
                        head=head,
                        body_yaw=body_yaw,
                        antennas=np.array(antennas_interp, dtype=np.float64),
                    ),
                )
            except Exception as exc:
                logger.warning("set_target in goto failed: %s", exc)

            # Update tracked state
            self._current_pose = pose
            self._current_body_yaw = body_yaw
            self._current_antennas = antennas_interp

            if t >= 1.0:
                break

            await asyncio.sleep(0.02)  # ~50Hz

        # Cleanup
        self._active_gotos.pop(move_uuid, None)

    # ================================================================
    # Easing functions (match SimulationAdapter.ease)
    # ================================================================

    @staticmethod
    def _ease(t: float, mode: str) -> float:
        """Apply easing curve. t is in [0, 1]."""
        if mode == "minjerk":
            # Minimum-jerk: 10t^3 - 15t^4 + 6t^5
            return t * t * t * (10 + t * (-15 + t * 6))
        elif mode == "ease":
            # Ease-in-out cubic
            if t < 0.5:
                return 4 * t * t * t
            return 1 - ((-2 * t + 2) ** 3) / 2
        elif mode == "cartoon":
            # Overshoot then settle
            c = 1.70158
            c3 = c + 1
            return 1 + c3 * ((t - 1) ** 3) + c * ((t - 1) ** 2)
        else:  # linear
            return t

    @staticmethod
    def _lerp(a: float, b: float, t: float) -> float:
        return a + (b - a) * t

    # ================================================================
    # Helpers
    # ================================================================

    async def _send_error(
        self, websocket: WebSocket, request_type: str, message: str, request_id: Any = None
    ) -> None:
        response: dict[str, Any] = {
            "type": "error",
            "request_type": request_type,
            "message": message,
        }
        if request_id is not None:
            response["_id"] = request_id
        await websocket.send_json(response)
