---
title: SPECS AR Controller
emoji: 😎
colorFrom: blue
colorTo: indigo
sdk: static
pinned: false
short_description: WebSocket bridge to control Reachy Mini from Snap SPECS
tags:
  - reachy_mini
  - reachy_mini_python_app
  - spectacles
  - websocket
---

# SPECS AR Controller

WebSocket bridge that lets **Snap SPECS** control a **Reachy Mini** robot. The app extends the Reachy Mini API with a WebSocket server on port 8765, used by the SPECS lens for movement, audio, and camera.

## What this app does

- Runs alongside the Reachy Mini Desktop App (or daemon).
- Exposes a WebSocket at `/ws` with JSON request/response.
- Serves a simple status page at the app URL (message types exposed by the bridge).

## WebSocket message types

The bridge accepts JSON messages with a `type` field. Supported types:

| Type | Description |
|------|-------------|
| `set_target` | Stream target head pose (full 6-DOF: x, y, z, roll, pitch, yaw), body yaw, antennas. Nonzero x/y are allowed and clamped to an 18 mm disk; tilt is projected onto the existing (roll, pitch, z) ellipsoid. Unreachable IK samples retry a shorter step from last-sent (0.5, then 0.25); if all fail, the last reachable pose is held. |
| `goto` | Move to a head pose / body yaw over a duration (with interpolation). Same clamps and IK gate as `set_target`. |
| `stop_move` | Cancel a move by UUID. |
| `play_audio` | Play raw audio (base64, sample rate, channels). A newer `play_audio` cancels the one already playing. |
| `status` | Connectivity check (returns `connected: true`). |
| `get_robot_camera_frame` | Capture one frame from the robot camera (base64 image). |

Animations are handled on the Spectacles Lens side; this app provides the low-level movement, audio, and camera APIs.

### Movement safety (`set_target` / `goto`)

Head pose is in the Reachy Mini base frame (x forward, y left, z up, meters; rpy in radians). `x` and `y` may be nonzero.

- **Tilt ellipsoid (unchanged):** `(roll/18°)² + (pitch/18°)² + (z/18mm)² ≤ 1`, with z pre-clamped to `[0, 25mm]`.
- **Slide disk (new):** `(x/18mm)² + (y/18mm)² ≤ 1`. Independent of tilt, so a large slide does not shrink requested roll/pitch/z.
- **Yaw:** body yaw ±160°, head yaw ±180°, head–body delta ±65°.
- **IK gate:** after smoothing and velocity clamping, the sample is re-projected onto the ellipsoid/disk, then `AnalyticalKinematics.ik` is run. If the full step is unreachable, a 0.5 then 0.25 step from last-sent is tried. Only IK-validated poses are sent; if all fail, the robot holds the last reachable pose.

Look-at from Spectacles still typically sends `x = 0`, `y = 0`. Direct pose control uses the same `set_target` message with a full 6-DOF head pose.

## Installation and running

1. Install the [Reachy Mini SDK](https://github.com/pollen-robotics/reachy_mini) and start the Desktop App (or daemon).
2. In the Reachy Mini Desktop App, install the **spectacles-reachy-mini** app (uncheck “official” if needed to find it) and start it.
3. The app publishes its LAN address to the IP relay and shows a six-digit PIN on the status page. Enter that PIN in the Spectacles Setup Wizard, or switch the wizard to IP entry. The relay URL is `IP_RELAY_URL` (`https://spectacles-ip-relay.johannestscharn.workers.dev`) at the top of `spectacles_reachy_mini/ip_relay.py`. The WebSocket stays on port 8765.

For full setup (Lens project, modes, simulation), see the main repo: [spectacles-reachy-mini](https://github.com/V4C38/spectacles-reachy-mini) (or the parent of this app).

## Development

```bash
cd reachy-mini-app
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -e .
```

Then start the app from the Reachy Mini Desktop App or run the entrypoint (see [Reachy Mini app docs](https://huggingface.co/docs/reachy_mini)).

## License

Same as the parent project (see repository LICENSE).
