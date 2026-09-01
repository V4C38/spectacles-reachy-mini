"""
Movement state and robot commands: target/current LERP and set_target rate limiting.

WebSocket messages update an in-memory *target* pose. A background loop (~30 Hz) LERPs *current* toward *target*, applies velocity clamping, then runs AnalyticalKinematics.ik. Unreachable samples retry a shorter step from last-sent (0.5, then 0.25); if all fail, last good pose is held. Reachable poses are sent via ReachyMini.set_target at ~30 Hz.
Timeout logic allows the next send if the previous one is slow, so the robot does not stay stuck. Also handles goto (interpolated moves) and lifecycle.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid as uuid_mod
from typing import Any

import numpy as np
from reachy_mini import ReachyMini
from reachy_mini.kinematics import AnalyticalKinematics
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
DEFAULT_SEND_RATE_HZ = 30.0  # 30 Hz — send every tick; daemon holds last target at its own 50 Hz
SEND_RATE_HZ_MIN = 5.0  # minimum send rate (avoids overload)
SEND_RATE_HZ_MAX = 50.0  # maximum send rate (daemon control loop ~50 Hz)
SEND_TIMEOUT_SEC = 0.12  # If previous send not done after this, allow next send (avoids robot stuck)
MAX_DT_FOR_VEL_CLAMP = 0.06  # Cap dt used for velocity clamp (prevents fast snap after IK recovery)

# --- Daemon IK / Reachy Mini safety limits (radians) ------------------------------------------
LIMIT_BODY_YAW_RAD = 160.0 * math.pi / 180.0  # ±160°
LIMIT_HEAD_YAW_RAD = math.pi  # ±180°
LIMIT_HEAD_BODY_YAW_DELTA_RAD = 65.0 * math.pi / 180.0  # ±65°

# --- Head position (Stewart platform workspace, meters) ---------------------------------------
# Reachy Mini head frame: x forward, y left, z up.
LIMIT_HEAD_Z_MIN = 0.0
LIMIT_HEAD_Z_MAX = 0.025  # 25 mm up; conservative after daemon adds head_z_offset
XY_DISK_RADIUS = 0.018  # 18 mm independent xy slide disk

# --- Coupled Stewart platform workspace ellipsoid (roll, pitch, z) ----------------------------
# The Stewart platform has a COUPLED workspace: individual axis limits are ±30° roll, ±30°
# pitch, 30mm z — but combinations of these (e.g. 25° pitch + 10° roll + 20mm z) can push
# branch points outside the geometric reach of the arm+rod mechanism, causing NaN in the
# Rust IK (discriminant < 0 → sqrt(negative) → NaN).
#
# We model the safe workspace as an ellipsoid: (roll/R)^2 + (pitch/P)^2 + (z/Z)^2 <= 1.0
# and project any pose outside the ellipsoid back onto its surface. This prevents the
# "corner" combinations that fail IK while preserving full range on individual axes.
ELLIPSOID_ROLL_MAX_RAD = 18.0 * math.pi / 180.0  # ±18° roll radius
ELLIPSOID_PITCH_MAX_RAD = 18.0 * math.pi / 180.0  # ±18° pitch radius
ELLIPSOID_Z_MAX = 0.018  # 18 mm z radius

# IK failure recovery: how fast to retract toward neutral on consecutive failures
IK_FAIL_RETRACT_TARGET_ALPHA = 0.06  # retract target 6% toward neutral per tick
IK_FAIL_RETRACT_PREV_ALPHA = 0.15  # retract prev_sent 15% toward neutral per tick
IK_FAIL_CONSECUTIVE_THRESHOLD = 3  # start retracting after this many consecutive failures


def _zero_pose() -> dict[str, float]:
    return {k: 0.0 for k in POSE_AXES}


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _parse_send_rate_hz(value: float | None) -> float:
    """Clamp send rate to allowed range. Returns interval in seconds."""
    if value is None:
        return 1.0 / DEFAULT_SEND_RATE_HZ
    rate = max(SEND_RATE_HZ_MIN, min(SEND_RATE_HZ_MAX, value))
    return 1.0 / rate


def _clamp_stewart_ellipsoid(
    roll: float, pitch: float, z: float,
) -> tuple[float, float, float]:
    """Project (roll, pitch, z) onto the Stewart platform workspace ellipsoid if outside.

    The Stewart platform's reachable set is a coupled, non-rectangular region in
    (roll, pitch, z) space.  An ellipsoid is a conservative inner approximation
    that prevents the "corner" combinations (e.g. large pitch + large roll + z)
    that produce NaN in the Rust analytical IK (discriminant < 0 under sqrt).

    Points inside the ellipsoid are returned unchanged.  Points outside are
    scaled proportionally toward the origin (0, 0, 0) so they lie on the surface.
    """
    # z is clamped to [0, max] first — the ellipsoid applies to the positive range
    z_clamped = _clamp(z, LIMIT_HEAD_Z_MIN, LIMIT_HEAD_Z_MAX)

    # Normalised coordinates
    nr = roll / ELLIPSOID_ROLL_MAX_RAD if ELLIPSOID_ROLL_MAX_RAD > 0 else 0.0
    np_ = pitch / ELLIPSOID_PITCH_MAX_RAD if ELLIPSOID_PITCH_MAX_RAD > 0 else 0.0
    nz = z_clamped / ELLIPSOID_Z_MAX if ELLIPSOID_Z_MAX > 0 else 0.0

    dist_sq = nr * nr + np_ * np_ + nz * nz
    if dist_sq <= 1.0:
        return (roll, pitch, z_clamped)

    # Scale toward origin so the point lies on the ellipsoid surface
    scale = 1.0 / math.sqrt(dist_sq)
    return (
        roll * scale,
        pitch * scale,
        z_clamped * scale,
    )


def _clamp_xy_disk(x: float, y: float) -> tuple[float, float]:
    """Project (x, y) onto an independent 18 mm disk if outside.

    Slide is limited separately from the tilt ellipsoid so a large xy offset
    does not shrink the requested roll/pitch/z (and vice versa).
    """
    if XY_DISK_RADIUS <= 0:
        return (0.0, 0.0)
    nx = x / XY_DISK_RADIUS
    ny = y / XY_DISK_RADIUS
    dist_sq = nx * nx + ny * ny
    if dist_sq <= 1.0:
        return (x, y)
    scale = 1.0 / math.sqrt(dist_sq)
    return (x * scale, y * scale)


def _clamp_pose_to_daemon_limits(
    pose: dict[str, float], body_yaw: float
) -> tuple[dict[str, float], float]:
    """Clamp pose and body_yaw to Reachy Mini daemon IK / safety limits.

    Uses a coupled ellipsoidal constraint for (roll, pitch, z), an independent
    xy disk for slide, plus independent limits for yaw / body_yaw / head-body
    delta. Combinations inside these clips can still be unreachable; the apply
    loop IK gate refuses those samples.
    """
    out_pose = dict(pose)
    out_pose["x"], out_pose["y"] = _clamp_xy_disk(pose["x"], pose["y"])

    # Coupled ellipsoidal clamp for (roll, pitch, z)
    clamped_roll, clamped_pitch, clamped_z = _clamp_stewart_ellipsoid(
        pose["roll"], pose["pitch"], pose["z"],
    )
    out_pose["roll"] = clamped_roll
    out_pose["pitch"] = clamped_pitch
    out_pose["z"] = clamped_z

    body_yaw_clamped = _clamp(body_yaw, -LIMIT_BODY_YAW_RAD, LIMIT_BODY_YAW_RAD)
    out_pose["yaw"] = _clamp(
        pose["yaw"], -LIMIT_HEAD_YAW_RAD, LIMIT_HEAD_YAW_RAD
    )
    # Enforce head–body yaw delta ≤ 65°
    delta = out_pose["yaw"] - body_yaw_clamped
    if delta > LIMIT_HEAD_BODY_YAW_DELTA_RAD:
        out_pose["yaw"] = body_yaw_clamped + LIMIT_HEAD_BODY_YAW_DELTA_RAD
    elif delta < -LIMIT_HEAD_BODY_YAW_DELTA_RAD:
        out_pose["yaw"] = body_yaw_clamped - LIMIT_HEAD_BODY_YAW_DELTA_RAD
    return (out_pose, body_yaw_clamped)


class MovementHandler:
    """Owns all movement state and SDK interaction."""

    def __init__(
        self,
        reachy_mini: ReachyMini,
        send_rate_hz: float | None = None,
    ) -> None:
        self.mini = reachy_mini
        self._send_min_interval = _parse_send_rate_hz(send_rate_hz)
        logger.info(
            "MovementHandler send rate: %.1f Hz (interval %.3f s)",
            1.0 / self._send_min_interval,
            self._send_min_interval,
        )

        # Same analytical IK the daemon uses by default (adds head_z_offset internally).
        # Matches daemon automatic_body_yaw=True: inverse_kinematics_safe with ±65°/±160°.
        self._ik = AnalyticalKinematics(automatic_body_yaw=True)

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

        # Non-blocking send: at most two set_target in flight (normal + one timeout send)
        self._send_future: asyncio.Future[Any] | None = None
        self._last_send_time: float = 0.0  # when we last submitted; 0 = never
        self._timeout_send_pending: bool = False  # True after sending on timeout until that future completes
        self._send_count: int = 0  # for periodic debug logging of sent pose

        # IK failure recovery (Strategy 3) — real SDK exceptions only
        self._consecutive_ik_failures: int = 0
        self._ik_gate_rejects: int = 0

    # ------------------------------------------------------------------
    # Public API (called from ws_handler)
    # ------------------------------------------------------------------

    def set_target(
        self,
        pose: dict[str, float],
        body_yaw: float | None = None,
        antennas: list[float] | None = None,
    ) -> None:
        """Store a new target. Non-blocking, no SDK call. Sanitizes and clamps to daemon limits."""
        # Merge with finite check: only accept numbers so we never store NaN/Inf
        merged = {}
        for k in POSE_AXES:
            v = pose.get(k, self._target_pose[k])
            merged[k] = (
                v
                if isinstance(v, (int, float)) and math.isfinite(v)
                else self._target_pose[k]
            )
        by = (
            body_yaw
            if body_yaw is not None
            and isinstance(body_yaw, (int, float))
            and math.isfinite(body_yaw)
            else self._target_body_yaw
        )
        self._target_pose, self._target_body_yaw = _clamp_pose_to_daemon_limits(
            merged, by
        )
        if antennas is not None:
            self._target_antennas = [
                a if isinstance(a, (int, float)) and math.isfinite(a) else (self._target_antennas[i] if i < len(self._target_antennas) else 0.0)
                for i, a in enumerate(antennas)
            ]
            self._target_antennas = (self._target_antennas + [0.0, 0.0])[:2]

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
    # IK gate (analytical, same path as daemon)
    # ------------------------------------------------------------------

    def _ik_reachable(self, head: Any, body_yaw: float) -> bool:
        """True if AnalyticalKinematics.ik returns 7 finite joints for this pose."""
        try:
            joints = self._ik.ik(head, body_yaw=body_yaw)
        except Exception as exc:
            logger.warning("IK gate error: %s", exc)
            return False
        if joints is None:
            return False
        arr = np.asarray(joints, dtype=np.float64).reshape(-1)
        return arr.size == 7 and bool(np.all(np.isfinite(arr)))

    def _reject_unreachable(
        self, send_pose: dict[str, float], send_body_yaw: float
    ) -> None:
        """Log a gate reject. Do not rewind current — last sent is held until a shorter step passes."""
        self._ik_gate_rejects += 1
        if self._ik_gate_rejects == 1 or self._ik_gate_rejects % 30 == 0:
            logger.warning(
                "IK gate rejected pose x=%.4f y=%.4f z=%.4f roll=%.4f pitch=%.4f "
                "yaw=%.4f body_yaw=%.4f (count=%d); trying shorter step",
                send_pose["x"], send_pose["y"], send_pose["z"],
                send_pose["roll"], send_pose["pitch"], send_pose["yaw"],
                send_body_yaw, self._ik_gate_rejects,
            )

    def _pose_along(
        self,
        prev_pose: dict[str, float],
        prev_yaw: float,
        want_pose: dict[str, float],
        want_yaw: float,
        frac: float,
    ) -> tuple[dict[str, float], float]:
        pose = {
            k: prev_pose[k] + frac * (want_pose[k] - prev_pose[k]) for k in POSE_AXES
        }
        yaw = prev_yaw + frac * (want_yaw - prev_yaw)
        return _clamp_pose_to_daemon_limits(pose, yaw)

    def _head_from_pose(self, pose: dict[str, float], body_yaw: float) -> Any:
        return create_head_pose(
            x=pose["x"],
            y=pose["y"],
            z=pose["z"],
            roll=pose["roll"],
            pitch=pose["pitch"],
            yaw=pose["yaw"],
            degrees=False,
        )

    def _submit_set_target(
        self,
        loop: asyncio.AbstractEventLoop,
        now: float,
        allow_send_because_stale: bool,
        head: Any,
        send_pose: dict[str, float],
        send_body_yaw: float,
    ) -> None:
        """Send a reachable pose to the SDK without blocking the apply loop."""
        self._send_count += 1
        if self._send_count % 100 == 0:
            logger.debug(
                "sent pose x=%.4f y=%.4f z=%.4f roll=%.4f pitch=%.4f yaw=%.4f body_yaw=%.4f",
                send_pose["x"], send_pose["y"], send_pose["z"],
                send_pose["roll"], send_pose["pitch"], send_pose["yaw"],
                send_body_yaw,
            )

        antennas_arr = np.array(self._current_antennas, dtype=np.float64)
        _sp, _sb = send_pose, send_body_yaw

        def _do_set_target(
            h=head,
            b=send_body_yaw,
            a=antennas_arr.copy(),
        ) -> None:
            try:
                self.mini.set_target(head=h, body_yaw=b, antennas=a)
            except Exception as exc:
                logger.warning(
                    "set_target failed: %s; sent pose x=%.4f y=%.4f z=%.4f "
                    "roll=%.4f pitch=%.4f yaw=%.4f body_yaw=%.4f",
                    exc,
                    _sp["x"], _sp["y"], _sp["z"],
                    _sp["roll"], _sp["pitch"], _sp["yaw"],
                    _sb,
                )
                raise

        self._send_future = loop.run_in_executor(None, _do_set_target)
        sent_pose = dict(send_pose)
        sent_body_yaw = send_body_yaw

        def _on_send_done(fut: asyncio.Future[Any]) -> None:
            if fut.exception() is None:
                self._prev_sent_pose = sent_pose
                self._prev_sent_body_yaw = sent_body_yaw
                self._consecutive_ik_failures = 0
                self._ik_gate_rejects = 0
            else:
                self._consecutive_ik_failures += 1
                if self._consecutive_ik_failures >= IK_FAIL_CONSECUTIVE_THRESHOLD:
                    alpha_p = IK_FAIL_RETRACT_PREV_ALPHA
                    for ax in POSE_AXES:
                        self._prev_sent_pose[ax] *= (1.0 - alpha_p)
                    self._prev_sent_body_yaw *= (1.0 - alpha_p)
                    alpha_t = IK_FAIL_RETRACT_TARGET_ALPHA
                    for ax in POSE_AXES:
                        self._target_pose[ax] *= (1.0 - alpha_t)
                    self._target_body_yaw *= (1.0 - alpha_t)
                    if self._consecutive_ik_failures % 20 == 0:
                        logger.warning(
                            "IK failed %d consecutive times; retracting toward neutral",
                            self._consecutive_ik_failures,
                        )

        self._send_future.add_done_callback(_on_send_done)
        self._last_send_time = now
        self._timeout_send_pending = bool(allow_send_because_stale)

    # ------------------------------------------------------------------
    # Background apply loop
    # ------------------------------------------------------------------

    async def _apply_loop(self) -> None:
        """LERP current toward target each tick; send current to robot."""
        loop = asyncio.get_running_loop()

        try:
            while True:
                now = time.monotonic()

                # Clear timeout flag when the referenced send completes
                if self._send_future is not None and self._send_future.done():
                    self._timeout_send_pending = False

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

                # Send when: interval has passed AND (previous send done OR timeout elapsed).
                # Timeout path avoids robot stuck when one SDK call blocks; cap at 2 in flight.
                interval_ok = (
                    self._last_send_time == 0
                    or (now - self._last_send_time) >= self._send_min_interval
                )
                previous_done = (
                    self._send_future is None or self._send_future.done()
                )
                timeout_elapsed = (
                    self._last_send_time > 0
                    and (now - self._last_send_time) >= SEND_TIMEOUT_SEC
                )
                allow_send_because_stale = (
                    timeout_elapsed and not previous_done and not self._timeout_send_pending
                )
                can_send = interval_ok and (previous_done or allow_send_because_stale)

                if can_send:
                    if allow_send_because_stale:
                        logger.debug(
                            "set_target send on timeout (previous send still in flight)"
                        )
                    # Velocity clamp: use time since last send, but CAP it so the
                    # robot doesn't snap to a far-away pose after IK recovery.
                    dt_since_send = (
                        now - self._last_send_time
                        if self._last_send_time > 0
                        else LOOP_INTERVAL
                    )
                    dt_clamped = min(dt_since_send, MAX_DT_FOR_VEL_CLAMP)
                    max_d_ang = MAX_ANGULAR_VEL * dt_clamped
                    max_d_pos = MAX_POS_VEL * dt_clamped

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
                    # Per-axis velocity clamp can leave the coupled ellipsoid / xy disk;
                    # project back before IK and send.
                    send_pose, send_body_yaw = _clamp_pose_to_daemon_limits(
                        send_pose, send_body_yaw
                    )

                    head = self._head_from_pose(send_pose, send_body_yaw)
                    chosen_head = None
                    chosen_pose = None
                    chosen_yaw = None
                    if self._ik_reachable(head, send_body_yaw):
                        chosen_head, chosen_pose, chosen_yaw = (
                            head, send_pose, send_body_yaw
                        )
                    else:
                        self._reject_unreachable(send_pose, send_body_yaw)
                        for frac in (0.5, 0.25):
                            cand_pose, cand_yaw = self._pose_along(
                                self._prev_sent_pose,
                                self._prev_sent_body_yaw,
                                send_pose,
                                send_body_yaw,
                                frac,
                            )
                            cand_head = self._head_from_pose(cand_pose, cand_yaw)
                            if self._ik_reachable(cand_head, cand_yaw):
                                chosen_head, chosen_pose, chosen_yaw = (
                                    cand_head, cand_pose, cand_yaw
                                )
                                break
                    if chosen_head is not None and chosen_pose is not None and chosen_yaw is not None:
                        self._submit_set_target(
                            loop, now, allow_send_because_stale,
                            chosen_head, chosen_pose, chosen_yaw,
                        )

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

            # Update target (the apply loop will LERP toward it); clamp to daemon limits
            lerped = {k: _lerp(start_pose[k], end_pose[k], s) for k in POSE_AXES}
            by = _lerp(start_body_yaw, end_body_yaw, s)
            self._target_pose, self._target_body_yaw = _clamp_pose_to_daemon_limits(
                lerped, by
            )
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
