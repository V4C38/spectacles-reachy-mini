"""
Spectacles Reachy Mini bridge package.

Exposes the Reachy Mini app that runs a WebSocket server (port 8765) to connect Snap Spectacles AR glasses with a Reachy Mini robot via the Python SDK.
"""

from .main import SpectaclesReachyMini

__all__ = ["SpectaclesReachyMini"]
