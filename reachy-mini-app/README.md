---
title: Spectacles AR — Reachy Mini Bridge
emoji: 😎
colorFrom: blue
colorTo: indigo
sdk: static
pinned: false
short_description: WebSocket bridge for the Spectacles AR headset
tags:
  - reachy_mini
  - reachy_mini_python_app
  - spectacles
  - websocket
---

# Spectacles AR controller — Reachy Mini

WebSocket bridge that lets **Snap Spectacles** (AR glasses) control a **Reachy Mini** robot. The app extends the Reachy Mini API with a WebSocket server on port 8765, used by the Spectacles Lens for movement, audio, and camera.

## What this app does

- Runs alongside the Reachy Mini Desktop App (or daemon).
- Exposes a WebSocket at `/ws` with JSON request/response.
- Serves a simple status page at the app URL (HTTP + WebSocket status, list of message types).

## WebSocket message types

The bridge accepts JSON messages with a `type` field. Supported types:

| Type | Description |
|------|-------------|
| `set_target` | Stream target head pose, body yaw, antennas (smooth following). |
| `goto` | Move to a head pose / body yaw over a duration (with interpolation). |
| `stop_move` | Cancel a move by UUID. |
| `play_audio` | Play raw audio (base64, sample rate, channels). |
| `status` | Connectivity check (returns `connected: true`). |
| `get_robot_camera_frame` | Capture one frame from the robot camera (base64 image). |

Animations are handled on the Spectacles Lens side; this app provides the low-level movement, audio, and camera APIs.

## Installation and running

1. Install the [Reachy Mini SDK](https://github.com/pollen-robotics/reachy_mini) and start the Desktop App (or daemon).
2. In the Reachy Mini Desktop App, install the **spectacles-reachy-mini** app (uncheck “official” if needed to find it) and start it.
3. On Spectacles, open the Lens, run the Setup Wizard, and enter your PC’s IP address (the app runs on port 8765).

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
