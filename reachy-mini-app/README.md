---
title: Spectacles AR controller
emoji: 😎
colorFrom: purple
colorTo: blue
sdk: static
pinned: false
short_description: Control Reachy Mini from Snap Spectacles via WebSocket.
tags:
  - reachy_mini
  - reachy_mini_python_app
---

# Spectacles AR controller (Reachy Mini App)

Control **Reachy Mini** from **Snap Spectacles** with an AR interaction flow.

This Reachy Mini app runs a **WebSocket bridge** (FastAPI + Uvicorn) on port **8765** so a Spectacles Lens can stream targets (head pose, body yaw, antennas) to the robot with smoothing.

## Endpoints

- **WebSocket**: `ws://<robot-ip>:8765/ws`
- **Helper page (shows IP to enter on Spectacles)**: `http://<robot-ip>:8765/`
- **REST**: `GET /api/info`, `GET /api/status`

## Prerequisites

- Reachy Mini daemon running (required). See the official [Quickstart](https://huggingface.co/docs/reachy_mini/SDK/quickstart).
- Spectacles and the machine running the daemon on the **same local network**.
- Your firewall allows inbound TCP **8765**.

## Install & run

1. Start the Reachy Mini daemon (keep it running).
   - **USB (Lite)**: `uv run reachy-mini-daemon`
   - **Simulation**: `uv run reachy-mini-daemon --sim` (or `mjpython -m reachy_mini.daemon.app.main --sim` on macOS)
   - **Wireless**: the daemon runs when the robot is powered on
2. Verify the dashboard is up at `http://localhost:8000`.
3. Install this app into the **same Python environment** as the daemon:

```bash
cd reachy-mini-app
pip install -e .
```

4. In the Reachy dashboard / desktop app, start **Spectacles AR controller**.
5. Open `http://<robot-ip>:8765/` and enter the shown IP in the Spectacles setup wizard. The Lens connects to `ws://<robot-ip>:8765/ws`.

## Audio (optional): OpenAI TTS

This app supports a `play_tts` WebSocket message that uses the OpenAI API. If you use that feature, make sure your environment is configured with an OpenAI API key (e.g. `OPENAI_API_KEY`).

## Publishing to Hugging Face (so it shows up in the app store)

Reachy Mini apps are shared as **Hugging Face Spaces** (this Space is `sdk: static` so the page is lightweight; the robot installs/runs the Python code locally).

- **Community listing/discovery**: make the Space **public** and keep these Space tags (top of this README):
  - `reachy_mini`
  - `reachy_mini_python_app`
- **Publish** (from an environment where `reachy-mini` is installed):
  - `reachy-mini-app-assistant check`
  - `reachy-mini-app-assistant publish`
- **Request “official app store” inclusion** (curated list): `reachy-mini-app-assistant publish --official`

See the official guide: [Make and publish your Reachy Mini App](https://huggingface.co/blog/pollen-robotics/make-and-publish-your-reachy-mini-apps).

