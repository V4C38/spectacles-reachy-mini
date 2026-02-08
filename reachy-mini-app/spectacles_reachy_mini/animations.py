"""
Named animations for Reachy Mini.

Implemented with the SDK (goto_target / set_target). Used by the WebSocket API
and for lifecycle events (startup, WS connect, WS disconnect).
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import numpy as np
from reachy_mini.utils import create_head_pose

if TYPE_CHECKING:
    from reachy_mini import ReachyMini

# Canonical list of animation names (exposed via get_available_animations).
AVAILABLE_ANIMATIONS = [
    "greeting",
    "goodbye",
    "happy",
    "nod",
    "wave",
    "sway",
    "peekaboo",
    "sad",
    "excited",
    "thinking",
]


def get_available_animations() -> list[str]:
    """Return the list of playable animation names."""
    return list(AVAILABLE_ANIMATIONS)


def _has_goto_target(mini: ReachyMini) -> bool:
    return hasattr(mini, "goto_target")


def _goto_antennas(mini: ReachyMini, left: float, right: float, duration: float = 0.35) -> None:
    if _has_goto_target(mini):
        mini.goto_target(antennas=[left, right], duration=duration)
    else:
        mini.set_target(
            head=create_head_pose(degrees=False),
            antennas=np.array([left, right], dtype=np.float64),
        )
    time.sleep(duration + 0.05)


def _goto_head(mini: ReachyMini, pitch: float = 0.0, roll: float = 0.0, yaw: float = 0.0, duration: float = 0.25) -> None:
    head = create_head_pose(pitch=pitch, roll=roll, yaw=yaw, degrees=False)
    if _has_goto_target(mini):
        mini.goto_target(head=head, duration=duration)
    else:
        mini.set_target(head=head, antennas=np.array([0.0, 0.0], dtype=np.float64))
    time.sleep(duration + 0.05)


def play_animation(reachy_mini: ReachyMini, name: str) -> float:
    """
    Run a named animation on the robot. Blocking.

    Returns duration in seconds. Raises ValueError if name is unknown.
    """
    name_lower = name.strip().lower()
    if name_lower not in AVAILABLE_ANIMATIONS:
        raise ValueError(f"Unknown animation: {name}. Available: {AVAILABLE_ANIMATIONS}")

    mini = reachy_mini
    start = time.monotonic()

    if name_lower == "greeting":
        # Antenna wiggle + small nod (longer, more cycles)
        _goto_antennas(mini, 0.4, -0.4, 0.5)
        _goto_antennas(mini, -0.4, 0.4, 0.5)
        _goto_antennas(mini, 0.4, -0.4, 0.5)
        _goto_antennas(mini, -0.4, 0.4, 0.5)
        _goto_antennas(mini, 0.0, 0.0, 0.4)
        _goto_head(mini, pitch=0.15, duration=0.4)
        _goto_head(mini, pitch=0.0, duration=0.4)
        _goto_head(mini, pitch=0.12, duration=0.35)
        _goto_head(mini, pitch=0.0, duration=0.35)

    elif name_lower == "goodbye":
        # Wave-like antenna motion + slight head tilt (longer)
        _goto_head(mini, roll=0.1, duration=0.4)
        _goto_antennas(mini, 0.5, 0.5, 0.45)
        _goto_antennas(mini, -0.3, -0.3, 0.45)
        _goto_antennas(mini, 0.5, 0.5, 0.4)
        _goto_antennas(mini, -0.3, -0.3, 0.4)
        _goto_antennas(mini, 0.0, 0.0, 0.4)
        _goto_head(mini, roll=0.0, duration=0.4)

    elif name_lower == "happy":
        # Bouncy wiggle (more repeats, longer)
        _goto_head(mini, pitch=0.08, duration=0.4)
        _goto_antennas(mini, 0.35, -0.35, 0.4)
        _goto_antennas(mini, -0.35, 0.35, 0.4)
        _goto_head(mini, pitch=0.0, duration=0.35)
        _goto_antennas(mini, 0.35, -0.35, 0.4)
        _goto_antennas(mini, -0.35, 0.35, 0.4)
        _goto_head(mini, pitch=0.06, duration=0.35)
        _goto_antennas(mini, 0.25, -0.25, 0.35)
        _goto_antennas(mini, 0.0, 0.0, 0.35)

    elif name_lower == "nod":
        # Yes-nod (3–4 nods, longer holds)
        _goto_head(mini, pitch=0.2, duration=0.4)
        _goto_head(mini, pitch=0.0, duration=0.4)
        _goto_head(mini, pitch=0.18, duration=0.35)
        _goto_head(mini, pitch=0.0, duration=0.35)
        _goto_head(mini, pitch=0.15, duration=0.35)
        _goto_head(mini, pitch=0.0, duration=0.35)

    elif name_lower == "wave":
        # One-sided antenna wave (more waves)
        _goto_antennas(mini, 0.6, 0.0, 0.4)
        _goto_antennas(mini, -0.4, 0.0, 0.4)
        _goto_antennas(mini, 0.5, 0.0, 0.35)
        _goto_antennas(mini, -0.3, 0.0, 0.35)
        _goto_antennas(mini, 0.6, 0.0, 0.4)
        _goto_antennas(mini, 0.0, 0.0, 0.4)

    elif name_lower == "sway":
        # Gentle side-to-side head (more sways, longer)
        _goto_head(mini, yaw=0.15, duration=0.5)
        _goto_head(mini, yaw=-0.15, duration=0.5)
        _goto_head(mini, yaw=0.12, duration=0.45)
        _goto_head(mini, yaw=-0.12, duration=0.45)
        _goto_head(mini, yaw=0.1, duration=0.4)
        _goto_head(mini, yaw=0.0, duration=0.4)

    elif name_lower == "peekaboo":
        # Dip down then up (peek) with hold
        _goto_head(mini, pitch=-0.15, duration=0.45)
        time.sleep(0.3)
        _goto_head(mini, pitch=0.2, duration=0.5)
        _goto_head(mini, pitch=0.15, duration=0.4)
        _goto_head(mini, pitch=0.0, duration=0.4)

    elif name_lower == "sad":
        # Slight droop (longer hold)
        _goto_head(mini, pitch=-0.12, roll=0.05, duration=0.5)
        _goto_antennas(mini, -0.2, -0.2, 0.4)
        time.sleep(0.8)
        _goto_head(mini, pitch=0.0, roll=0.0, duration=0.5)
        _goto_antennas(mini, 0.0, 0.0, 0.4)

    elif name_lower == "excited":
        # Double wiggle (more cycles, longer)
        _goto_antennas(mini, 0.4, -0.4, 0.35)
        _goto_antennas(mini, -0.4, 0.4, 0.35)
        _goto_antennas(mini, 0.35, -0.35, 0.35)
        _goto_antennas(mini, -0.35, 0.35, 0.35)
        _goto_antennas(mini, 0.4, -0.4, 0.35)
        _goto_antennas(mini, -0.4, 0.4, 0.35)
        _goto_antennas(mini, 0.0, 0.0, 0.35)
        _goto_head(mini, pitch=0.1, duration=0.4)
        _goto_head(mini, pitch=0.0, duration=0.4)

    elif name_lower == "thinking":
        # Tilt + small antenna motion (longer)
        _goto_head(mini, roll=0.12, pitch=0.05, duration=0.45)
        _goto_antennas(mini, 0.25, 0.25, 0.4)
        time.sleep(0.5)
        _goto_antennas(mini, -0.2, -0.2, 0.4)
        time.sleep(0.3)
        _goto_antennas(mini, 0.2, 0.2, 0.35)
        _goto_head(mini, roll=0.0, pitch=0.0, duration=0.45)
        _goto_antennas(mini, 0.0, 0.0, 0.35)

    else:
        raise ValueError(f"Unknown animation: {name}")

    return time.monotonic() - start
