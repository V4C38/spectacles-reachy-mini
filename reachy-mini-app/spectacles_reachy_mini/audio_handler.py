"""
Audio handling: base64 PCM decode, OpenAI TTS generation, and robot speaker playback.
"""

from __future__ import annotations

import base64
import logging
import time

import numpy as np
from reachy_mini import ReachyMini

logger = logging.getLogger(__name__)

# Target sample rate for Reachy Mini speaker output
ROBOT_SAMPLE_RATE = 16000


class AudioHandler:
    """Handles audio playback on the Reachy Mini robot speaker."""

    def __init__(self, reachy_mini: ReachyMini) -> None:
        self.mini = reachy_mini

    def play_tts(self, text: str, voice: str = "alloy") -> None:
        """Generate TTS via OpenAI and play on the robot speaker."""
        try:
            from openai import OpenAI
        except ImportError:
            raise RuntimeError("openai package is required for play_tts. Install with: pip install openai")

        client = OpenAI()

        logger.info("Generating TTS for: %.60s...", text)
        response = client.audio.speech.create(
            model="tts-1",
            voice=voice,
            input=text,
            response_format="pcm",  # Raw PCM s16le at 24kHz
        )

        # OpenAI PCM output is signed 16-bit little-endian at 24kHz mono
        pcm_bytes = response.content
        samples_s16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        samples_f32 = samples_s16.astype(np.float32) / 32768.0

        # Resample from 24kHz to robot's rate (16kHz)
        source_rate = 24000
        target_rate = self._get_output_sample_rate()
        if source_rate != target_rate:
            samples_f32 = self._resample(samples_f32, source_rate, target_rate)

        # Reshape to (samples, 1) for mono
        if samples_f32.ndim == 1:
            samples_f32 = samples_f32.reshape(-1, 1)

        self._push_and_wait(samples_f32, target_rate)
        logger.info("TTS playback complete")

    def play_raw_audio(self, data_b64: str, sample_rate: int = 16000, channels: int = 1) -> None:
        """Decode base64 PCM float32 audio and play on the robot speaker."""
        raw_bytes = base64.b64decode(data_b64)
        samples = np.frombuffer(raw_bytes, dtype=np.float32)

        # Reshape to (samples, channels)
        if channels > 1:
            samples = samples.reshape(-1, channels)
        else:
            samples = samples.reshape(-1, 1)

        # Resample if needed
        target_rate = self._get_output_sample_rate()
        if sample_rate != target_rate:
            # Resample each channel
            resampled_channels = []
            for ch in range(samples.shape[1]):
                resampled_channels.append(self._resample(samples[:, ch], sample_rate, target_rate))
            samples = np.column_stack(resampled_channels)

        self._push_and_wait(samples, target_rate)
        logger.info("Raw audio playback complete (%d samples)", len(samples))

    def _push_and_wait(self, samples: np.ndarray, sample_rate: int) -> None:
        """Push audio samples and wait for playback to finish."""
        self.mini.media.push_audio_sample(samples)
        duration = len(samples) / sample_rate
        time.sleep(duration)

    def _get_output_sample_rate(self) -> int:
        """Get the robot's output sample rate, defaulting to 16kHz."""
        try:
            return self.mini.media.get_output_audio_samplerate()
        except Exception:
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
