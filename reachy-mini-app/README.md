---
title: Spectacles AR controller
emoji: 😎
colorFrom: red
colorTo: blue
sdk: static
pinned: false
short_description: WebSocket bridge for Snap Spectacles AR glasses to control Reachy Mini (move, TTS, audio).
tags:
 - reachy_mini
 - reachy_mini_python_app
---

# Spectacles AR controller

Reachy Mini app that exposes a WebSocket server (port 8765) for Snap Spectacles AR glasses: real-time movement (`set_target`, `goto`, `stop_move`), robot speaker audio (`play_tts`, `play_audio`), and an IP display page for easy connection.

Install with `pip install -e .` in the same Python env as the daemon, then run the daemon and start the app from the dashboard.