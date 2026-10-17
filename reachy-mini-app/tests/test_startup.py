"""Startup: the settings page must come up before the heavy native imports."""

from __future__ import annotations

import subprocess
import sys

from spectacles_reachy_mini.main import get_local_ips


def test_importing_main_skips_cv2_and_onnxruntime() -> None:
    probe = (
        "import sys, spectacles_reachy_mini.main; "
        "print(','.join(m for m in ('cv2', 'onnxruntime') if m in sys.modules))"
    )
    out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == ""


def test_local_ips_exclude_loopback() -> None:
    assert not any(ip.startswith("127.") for ip in get_local_ips())
