"""
Onboard camera capture: single frame from the Reachy Mini robot as base64 JPEG.

Uses the SDK’s media.get_frame() (numpy BGR), encodes to JPEG, and returns
base64 for transmission over the WebSocket to the Spectacles client.
"""

from __future__ import annotations

import base64
import logging
from typing import TYPE_CHECKING

import cv2

if TYPE_CHECKING:
    from reachy_mini import ReachyMini

logger = logging.getLogger(__name__)


class CameraHandler:
    """Captures frames from the Reachy Mini robot's onboard camera."""

    def __init__(self, reachy_mini: "ReachyMini") -> None:
        self.mini = reachy_mini

    def get_frame(self) -> str:
        """
        Capture a frame from the robot's camera and return as base64-encoded JPEG.

        Uses mini.media.get_frame() from the Reachy Mini SDK.
        """
        frame = self.mini.media.get_frame()
        if frame is None or frame.size == 0:
            raise RuntimeError("Failed to capture frame from robot camera")

        # frame is (H, W, 3) uint8, BGR from OpenCV/camera
        # cv2.imencode expects BGR
        ret, buf = cv2.imencode(".jpg", frame)
        if not ret:
            raise RuntimeError("Failed to encode frame as JPEG")

        return base64.b64encode(buf.tobytes()).decode("ascii")
