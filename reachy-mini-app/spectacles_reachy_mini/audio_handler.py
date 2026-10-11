"""
Audio playback on the Reachy Mini robot: raw PCM via base64.

Handles play_audio (base64 float32 PCM decode and push to robot).
A newer play_audio cancels the buffer already on the speaker and the
new samples start as soon as they are decoded (last-wins).
Uses the robot's media API; sample rate and format are fixed for the hardware.
"""

from __future__ import annotations

import base64
import logging
import threading
import time

import numpy as np
from reachy_mini import ReachyMini

logger = logging.getLogger(__name__)

# Target sample rate for Reachy Mini speaker output
ROBOT_SAMPLE_RATE = 16000
_POLL_SEC = 0.05


class AudioHandler:
    """Handles audio playback on the Reachy Mini robot speaker."""

    def __init__(self, reachy_mini: ReachyMini) -> None:
        self.mini = reachy_mini
        self._lock = threading.Lock()
        self.playGen = 0

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
    ) -> bool:
        """Decode base64 PCM float32 and push if this playGen is still current."""
        raw_bytes = base64.b64decode(data_b64)
        samples = np.frombuffer(raw_bytes, dtype=np.float32)

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
