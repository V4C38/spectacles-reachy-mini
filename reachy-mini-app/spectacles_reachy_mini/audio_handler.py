"""
Audio playback on the Reachy Mini robot: raw PCM via base64.

Handles play_audio (base64 PCM decode and push to robot).
`format` is "f32" (float32 PCM, the original) or "s16" (int16 PCM).
A newer play_audio cancels the buffer already on the speaker and the
new samples start as soon as they are decoded (last-wins).
set_volume talks to the daemon REST API (ADR #99).
Uses the robot's media API; the speaker sample rate is fixed for the hardware.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
import urllib.request

import numpy as np
from reachy_mini import ReachyMini

logger = logging.getLogger(__name__)

# Target sample rate for Reachy Mini speaker output
ROBOT_SAMPLE_RATE = 16000
# f32: little-endian float32 PCM. s16: little-endian int16 PCM, full scale = 32768.
AUDIO_FORMATS = ("f32", "s16")
_POLL_SEC = 0.05

# The daemon's REST API (reachy-mini-daemon, same host as this bridge).
# POST /api/volume/set {"volume": 0..100} sets the robot speaker. Override
# with REACHY_DAEMON_URL when the daemon is elsewhere.
DAEMON_URL = os.environ.get("REACHY_DAEMON_URL", "http://localhost:8000").rstrip("/")


class AudioHandler:
    """Handles audio playback on the Reachy Mini robot speaker."""

    def __init__(self, reachy_mini: ReachyMini) -> None:
        self.mini = reachy_mini
        self._lock = threading.Lock()
        self.playGen = 0
        # Speaker volume from the lens (set_volume). Latest wins: presses can
        # arrive faster than the daemon answers, so one lock applies the
        # newest wanted value and skips stale ones.
        self._volume_lock = threading.Lock()
        self._volume_want: int | None = None
        self._volume_applied: int | None = None

    def set_volume(self, value: float) -> int | None:
        """Set the robot speaker from the lens mix (0..1 -> daemon 0..100).

        Returns the level now on the daemon, or None if the daemon refused
        or is unreachable (the lens keeps working either way).
        """
        level = max(0, min(100, int(round(float(value) * 100))))
        with self._volume_lock:
            self._volume_want = level
        with self._volume_lock:
            want = self._volume_want
            if want is None or want == self._volume_applied:
                return self._volume_applied
            try:
                body = json.dumps({"volume": want}).encode()
                req = urllib.request.Request(
                    DAEMON_URL + "/api/volume/set", data=body, method="POST",
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    resp.read()
            except Exception as exc:  # daemon down / older daemon: never break the lens
                logger.warning("set_volume %d failed: %s", want, exc)
                return None
            self._volume_applied = want
            logger.info("set_volume %d", want)
            return want

    def accept_play(self) -> int | None:
        """Drop the buffer on the speaker and issue a playGen. None if no barge-in."""
        with self._lock:
            backend = getattr(self.mini.media, "audio", None)
            clear = getattr(backend, "clear_player", None) if backend is not None else None
            if not callable(clear):
                return None
            self.playGen += 1
            clear()
            return self.playGen

    def play_raw_audio(
        self,
        data_b64: str,
        sample_rate: int = 16000,
        channels: int = 1,
        gen: int = 0,
        fmt: str = "f32",
    ) -> bool:
        """Decode base64 PCM and push if this playGen is still current.

        fmt "f32" is float32 PCM. fmt "s16" is int16 PCM (/ 32768). Anything else raises.
        """
        raw_bytes = base64.b64decode(data_b64)
        if fmt == "f32":
            samples = np.frombuffer(raw_bytes, dtype=np.float32)
        elif fmt == "s16":
            samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        else:
            raise ValueError(f"Unknown audio format: {fmt}")

        if channels > 1:
            samples = samples.reshape(-1, channels)
        else:
            samples = samples.reshape(-1, 1)

        target_rate = self._get_output_sample_rate()
        if sample_rate != target_rate:
            resampled_channels = []
            for ch in range(samples.shape[1]):
                resampled_channels.append(self._resample(samples[:, ch], sample_rate, target_rate))
            samples = np.column_stack(resampled_channels)

        with self._lock:
            if gen != self.playGen:
                return False
            self.mini.media.push_audio_sample(samples)

        duration = len(samples) / target_rate
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            with self._lock:
                if gen != self.playGen:
                    return False
            time.sleep(_POLL_SEC)
        logger.info("Raw audio playback complete (%d samples)", len(samples))
        return True

    def _get_output_sample_rate(self) -> int:
        """Get the robot's output sample rate, defaulting to 16 kHz."""
        try:
            return self.mini.media.get_output_audio_samplerate()
        except (AttributeError, TypeError):
            return ROBOT_SAMPLE_RATE

    @staticmethod
    def _resample(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
        """Simple linear interpolation resampling."""
        if source_rate == target_rate:
            return samples
        ratio = target_rate / source_rate
        target_len = int(len(samples) * ratio)
        indices = np.linspace(0, len(samples) - 1, target_len)
        return np.interp(indices, np.arange(len(samples)), samples).astype(np.float32)
