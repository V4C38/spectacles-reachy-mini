"""
Movement handler: decoupled target/current model with LERP smoothing.

WS calls set the *target* (can jump at any rate).  A background loop LERPs
*current* toward *target* each tick and sends only *current* to the robot.
The robot never sees raw input -- movement is always smooth.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid as uuid_mod
from typing import Any

import numpy as np
from reachy_mini import ReachyMini
from reachy_mini.utils import create_head_pose

logger = logging.getLogger(__name__)

# --- Axis names -----------------------------------------------------------
POSE_AXES = ("x", "y", "z", "roll", "pitch", "yaw")
ANGULAR_AXES = ("roll", "pitch", "yaw")
POSITIONAL_AXES = ("x", "y", "z")

# --- Smoothing / safety constants -----------------------------------------
POSE_ALPHA = 0.12  # 12% of error per tick (head + body yaw)
ANTENNA_ALPHA = 0.08  # antennas need heavier smoothing
MAX_ANGULAR_VEL = 1.5  # rad/s hard safety limit for roll/pitch/yaw
MAX_POS_VEL = 0.05  # m/s hard safety limit for x/y/z
LOOP_INTERVAL = 0.033  # ~30 Hz
SEND_MIN_INTERVAL = 0.05  # 20 Hz max send rate; prevents daemon buffer overflow


def _zero_pose() -> dict[str, float]:
    return {k: 0.0 for k in POSE_AXES}


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


class MovementHandler:
    """Owns all movement state and SDK interaction."""

    def __init__(self, reachy_mini: ReachyMini) -> None:
        self.mini = reachy_mini

        # Target -- written by WS, can change at any time
        self._target_pose: dict[str, float] = _zero_pose()
        self._target_body_yaw: float = 0.0
        self._target_antennas: list[float] = [0.0, 0.0]

        # Current -- lerped toward target each tick; what the robot sees
        self._current_pose: dict[str, float] = _zero_pose()
        self._current_body_yaw: float = 0.0
        self._current_antennas: list[float] = [0.0, 0.0]

        # Previously sent to SDK (for velocity clamping)
        self._prev_sent_pose: dict[str, float] = _zero_pose()
        self._prev_sent_body_yaw: float = 0.0

        # Goto bookkeeping
        self._active_gotos: dict[str, bool] = {}

        # Background apply loop
        self._apply_task: asyncio.Task[None] | None = None

        # Non-blocking send: at most one set_target in flight; never block the apply loop
        self._send_future: asyncio.Future[Any] | None = None
        self._last_send_time: float = 0.0  # when we last submitted; 0 = never

    # ------------------------------------------------------------------
    # Public API (called from ws_handler)
    # ------------------------------------------------------------------

    def set_target(
        self,
        pose: dict[str, float],
        body_yaw: float | None = None,
        antennas: list[float] | None = None,
    ) -> None:
        """Store a new target. Non-blocking, no SDK call."""
        self._target_pose = {k: pose.get(k, self._target_pose[k]) for k in POSE_AXES}
        if body_yaw is not None:
            self._target_body_yaw = body_yaw
        if antennas is not None:
            self._target_antennas = list(antennas)

    def goto(
        self,
        pose: dict[str, float],
        body_yaw: float = 0.0,
        antennas: list[float] | None = None,
        duration: float = 0.5,
        interpolation: str = "minjerk",
    ) -> str:
        """Launch an interpolated move that writes to *target* over time.

        Returns a UUID that can be used to cancel the move.
        """
        move_uuid = str(uuid_mod.uuid4())
        self._active_gotos[move_uuid] = True

        start_pose = dict(self._current_pose)
        start_body_yaw = self._current_body_yaw
        start_antennas = list(self._current_antennas)

        end_pose = {k: pose.get(k, 0.0) for k in POSE_AXES}
        end_antennas = list(antennas) if antennas else [0.0, 0.0]

        asyncio.create_task(
            self._run_goto(
                move_uuid,
                start_pose, end_pose,
                start_body_yaw, body_yaw,
                start_antennas, end_antennas,
                duration, interpolation,
            )
        )
        return move_uuid

    def stop_move(self, move_uuid: str) -> bool:
        """Cancel a running goto. Returns True if found."""
        if move_uuid in self._active_gotos:
            self._active_gotos[move_uuid] = False
            return True
        return False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the background apply loop."""
        if self._apply_task is None or self._apply_task.done():
            self._apply_task = asyncio.ensure_future(self._apply_loop())

    def stop(self) -> None:
        """Stop the apply loop and cancel all gotos."""
        if self._apply_task is not None and not self._apply_task.done():
            self._apply_task.cancel()
            self._apply_task = None
        for uid in list(self._active_gotos):
            self._active_gotos[uid] = False
        self._active_gotos.clear()

    # ------------------------------------------------------------------
    # Background apply loop
    # ------------------------------------------------------------------

    async def _apply_loop(self) -> None:
        """LERP current toward target each tick; send current to robot."""
        loop = asyncio.get_running_loop()

        try:
            while True:
                now = time.monotonic()

                # Stage 1: LERP current toward target
                for axis in POSE_AXES:
                    self._current_pose[axis] += POSE_ALPHA * (
                        self._target_pose[axis] - self._current_pose[axis]
                    )
                self._current_body_yaw += POSE_ALPHA * (
                    self._target_body_yaw - self._current_body_yaw
                )
                for i in range(min(len(self._current_antennas), len(self._target_antennas))):
                    self._current_antennas[i] += ANTENNA_ALPHA * (
                        self._target_antennas[i] - self._current_antennas[i]
                    )

                # Non-blocking send: only submit when previous send is done and
                # throttle interval has passed (prevents daemon buffer overflow).
                can_send = (
                    (self._send_future is None or self._send_future.done())
                    and (
                        self._last_send_time == 0
                        or (now - self._last_send_time) >= SEND_MIN_INTERVAL
                    )
                )
                if can_send:
                    # Velocity clamp uses time since last *actual* send, so we
                    # allow larger steps when we've been unable to send (catch up).
                    dt_since_send = (
                        now - self._last_send_time
                        if self._last_send_time > 0
                        else LOOP_INTERVAL
                    )
                    max_d_ang = MAX_ANGULAR_VEL * dt_since_send
                    max_d_pos = MAX_POS_VEL * dt_since_send

                    send_pose: dict[str, float] = {}
                    for axis in ANGULAR_AXES:
                        delta = (
                            self._current_pose[axis] - self._prev_sent_pose[axis]
                        )
                        send_pose[axis] = self._prev_sent_pose[axis] + _clamp(
                            delta, -max_d_ang, max_d_ang
                        )
                    for axis in POSITIONAL_AXES:
                        delta = (
                            self._current_pose[axis] - self._prev_sent_pose[axis]
                        )
                        send_pose[axis] = self._prev_sent_pose[axis] + _clamp(
                            delta, -max_d_pos, max_d_pos
                        )
                    body_yaw_delta = (
                        self._current_body_yaw - self._prev_sent_body_yaw
                    )
                    send_body_yaw = self._prev_sent_body_yaw + _clamp(
                        body_yaw_delta, -max_d_ang, max_d_ang
                    )

                    head = create_head_pose(
                        x=send_pose["x"],
                        y=send_pose["y"],
                        z=send_pose["z"],
                        roll=send_pose["roll"],
                        pitch=send_pose["pitch"],
                        yaw=send_pose["yaw"],
                        degrees=False,
                    )
                    antennas_arr = np.array(
                        self._current_antennas, dtype=np.float64
                    )

                    def _do_set_target(
                        h=head,
                        b=send_body_yaw,
                        a=antennas_arr.copy(),
                    ) -> None:
                        try:
                            self.mini.set_target(head=h, body_yaw=b, antennas=a)
                        except Exception as exc:
                            logger.warning("set_target failed: %s", exc)

                    self._send_future = loop.run_in_executor(
                        None, _do_set_target
                    )
                    self._prev_sent_pose = send_pose
                    self._prev_sent_body_yaw = send_body_yaw
                    self._last_send_time = now

                await asyncio.sleep(LOOP_INTERVAL)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Goto interpolation (writes to target over time)
    # ------------------------------------------------------------------

    async def _run_goto(
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
        """Ease from start to end, writing to target each tick."""
        t0 = time.monotonic()

        while self._active_gotos.get(move_uuid, False):
            elapsed = time.monotonic() - t0
            t = min(elapsed / max(duration, 0.001), 1.0)
            s = self._ease(t, interpolation)

            # Update target (the apply loop will LERP toward it)
            self._target_pose = {
                k: _lerp(start_pose[k], end_pose[k], s) for k in POSE_AXES
            }
            self._target_body_yaw = _lerp(start_body_yaw, end_body_yaw, s)
            self._target_antennas = [
                _lerp(start_antennas[i], end_antennas[i], s)
                for i in range(min(len(start_antennas), len(end_antennas)))
            ]

            if t >= 1.0:
                break

            await asyncio.sleep(LOOP_INTERVAL)

        self._active_gotos.pop(move_uuid, None)

    # ------------------------------------------------------------------
    # Easing helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _ease(t: float, mode: str) -> float:
        """Apply easing curve. t in [0, 1]."""
        if mode == "minjerk":
            return t * t * t * (10 + t * (-15 + t * 6))
        if mode == "ease":
            if t < 0.5:
                return 4 * t * t * t
            return 1 - ((-2 * t + 2) ** 3) / 2
        if mode == "cartoon":
            c = 1.70158
            c3 = c + 1
            return 1 + c3 * ((t - 1) ** 3) + c * ((t - 1) ** 2)
        return t  # linear


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t
