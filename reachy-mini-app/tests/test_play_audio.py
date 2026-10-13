"""play_audio: a newer buffer cancels the one already on the speaker."""

from __future__ import annotations

import asyncio
import base64
import struct
import threading

import numpy as np

from spectacles_reachy_mini.audio_handler import AudioHandler
from spectacles_reachy_mini.ws_handler import WebSocketHandler

_PCM = base64.b64encode(struct.pack("<16f", *([0.0] * 16))).decode()
_MSG_1 = '{"type":"play_audio","data":"%s","sample_rate":16000,"channels":1,"_id":1}' % _PCM
_MSG_2 = '{"type":"play_audio","data":"%s","sample_rate":16000,"channels":1,"_id":2}' % _PCM


class _FakeAudioBackend:
    def __init__(self) -> None:
        self.clears = 0

    def clear_player(self) -> None:
        self.clears += 1


class _FakeMedia:
    def __init__(self) -> None:
        self.audio = _FakeAudioBackend()
        self.pushes: list[int] = []
        self.samples: list = []
        self.hold_decode = threading.Event()
        self.hold_decode.set()
        self.decode_started = threading.Event()

    def push_audio_sample(self, samples) -> None:
        self.pushes.append(len(samples))
        self.samples.append(np.array(samples, copy=True))

    def get_output_audio_samplerate(self) -> int:
        self.decode_started.set()
        self.hold_decode.wait()
        return 16000


class _FakeMini:
    def __init__(self) -> None:
        self.media = _FakeMedia()


class _FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


def test_later_play_cancels_earlier() -> None:
    mini = _FakeMini()
    audio = AudioHandler(mini)  # type: ignore[arg-type]
    gen1 = audio.accept_play()
    gen2 = audio.accept_play()
    assert gen1 == 1 and gen2 == 2
    assert mini.media.audio.clears == 2
    assert audio.play_raw_audio(_PCM, 16000, 1, gen1) is False
    assert audio.play_raw_audio(_PCM, 16000, 1, gen2) is True
    assert mini.media.pushes == [16]


def test_no_barge_in_does_not_push() -> None:
    class _NoClear:
        def get_output_audio_samplerate(self) -> int:
            return 16000

        def push_audio_sample(self, samples) -> None:
            raise AssertionError("must not push")

    class _Mini:
        def __init__(self) -> None:
            self.media = _NoClear()

    audio = AudioHandler(_Mini())  # type: ignore[arg-type]
    assert audio.accept_play() is None


def test_ws_second_clears_before_first_pushes() -> None:
    mini = _FakeMini()
    mini.media.hold_decode.clear()
    handler = WebSocketHandler(None, AudioHandler(mini), None)  # type: ignore[arg-type]
    ws = _FakeSocket()

    async def run() -> None:
        await handler.handle_message(ws, _MSG_1)
        while not mini.media.decode_started.is_set():
            await asyncio.sleep(0.01)
        await handler.handle_message(ws, _MSG_2)
        await asyncio.sleep(0)
        mini.media.hold_decode.set()
        await asyncio.gather(*list(handler._background_tasks))

    asyncio.run(run())
    assert mini.media.audio.clears == 2
    assert mini.media.pushes == [16]
    by_id = {row["_id"]: row for row in ws.sent}
    assert by_id[1] == {"type": "play_audio_result", "success": False, "message": "superseded", "_id": 1}
    assert by_id[2] == {"type": "play_audio_result", "success": True, "_id": 2}


# 0, 0.5, -0.5, 0.25 are exact in int16 when full scale is 32768.
_EXACT = np.array([0.0, 0.5, -0.5, 0.25], dtype=np.float32)


def test_s16_decodes_to_the_same_samples_as_f32() -> None:
    mini = _FakeMini()
    audio = AudioHandler(mini)  # type: ignore[arg-type]
    gen = audio.accept_play()
    f32 = base64.b64encode(_EXACT.tobytes()).decode()
    s16 = base64.b64encode((_EXACT * 32768).astype(np.int16).tobytes()).decode()
    assert audio.play_raw_audio(f32, 16000, 1, gen, "f32") is True
    gen = audio.accept_play()
    assert audio.play_raw_audio(s16, 16000, 1, gen, "s16") is True
    assert len(mini.media.samples) == 2
    np.testing.assert_allclose(mini.media.samples[0].reshape(-1), _EXACT)
    np.testing.assert_allclose(mini.media.samples[1].reshape(-1), _EXACT)


def test_unknown_format_is_rejected() -> None:
    mini = _FakeMini()
    audio = AudioHandler(mini)  # type: ignore[arg-type]
    gen = audio.accept_play()
    try:
        audio.play_raw_audio(_PCM, 16000, 1, gen, "mp3")
    except ValueError as exc:
        assert "mp3" in str(exc)
    else:
        raise AssertionError("unknown format must raise")
    assert mini.media.pushes == []


def test_ws_rejects_unknown_format_without_clearing() -> None:
    mini = _FakeMini()
    handler = WebSocketHandler(None, AudioHandler(mini), None)  # type: ignore[arg-type]
    ws = _FakeSocket()

    async def run() -> None:
        await handler.handle_message(
            ws,
            '{"type":"play_audio","data":"%s","format":"mp3","_id":7}' % _PCM,
        )
        await asyncio.gather(*list(handler._background_tasks))

    asyncio.run(run())
    assert mini.media.audio.clears == 0
    assert ws.sent == [{
        "type": "play_audio_result", "success": False,
        "message": "Unknown audio format: mp3", "_id": 7,
    }]


def test_status_advertises_audio_formats() -> None:
    handler = WebSocketHandler(None, None, None)  # type: ignore[arg-type]
    ws = _FakeSocket()

    async def run() -> None:
        await handler.handle_message(ws, '{"type":"status","_id":1}')

    asyncio.run(run())
    assert ws.sent == [{
        "type": "status_result", "connected": True,
        "audio_formats": ["f32", "s16"], "_id": 1,
    }]
