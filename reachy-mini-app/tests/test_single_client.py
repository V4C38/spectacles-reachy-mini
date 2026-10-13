"""A newer client replaces the previous one. The old disconnect must not stop motion."""

from __future__ import annotations

import asyncio
import threading

from fastapi import WebSocketDisconnect

from spectacles_reachy_mini.main import REPLACED_CODE, ActiveSocket, handle_socket


class _Move:
    def __init__(self) -> None:
        self.running = False
        self.starts = 0
        self.stops = 0

    def start(self) -> None:
        self.running = True
        self.starts += 1

    def stop(self) -> None:
        self.running = False
        self.stops += 1


class _Handler:
    def __init__(self, movement: _Move) -> None:
        self.movement = movement
        self.cleanups = 0

    def cleanup(self) -> None:
        self.cleanups += 1
        self.movement.stop()


class _Socket:
    def __init__(self) -> None:
        self.closed: int | None = None
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.receiving = asyncio.Event()

    async def accept(self) -> None:
        return None

    async def close(self, code: int = 1000) -> None:
        self.closed = code
        await self._queue.put(None)

    async def receive_text(self) -> str:
        self.receiving.set()
        item = await self._queue.get()
        if item is None:
            raise WebSocketDisconnect()
        return item


def test_replaced_client_does_not_stop_the_new_one() -> None:
    async def run() -> None:
        active = ActiveSocket()
        movement = _Move()
        handler = _Handler(movement)
        stop = threading.Event()
        first = _Socket()
        second = _Socket()
        task_first = asyncio.create_task(handle_socket(
            first, handler=handler, movement=movement, stop_event=stop, active=active,  # type: ignore[arg-type]
        ))
        await first.receiving.wait()
        assert movement.running and movement.starts == 1

        task_second = asyncio.create_task(handle_socket(
            second, handler=handler, movement=movement, stop_event=stop, active=active,  # type: ignore[arg-type]
        ))
        await task_first
        await second.receiving.wait()

        assert first.closed == REPLACED_CODE
        assert active.ws is second
        assert movement.running
        assert movement.stops == 0
        assert handler.cleanups == 0
        assert movement.starts == 2

        await second._queue.put(None)
        await task_second
        assert movement.running is False
        assert movement.stops == 1
        assert handler.cleanups == 1
        assert active.ws is None

    asyncio.run(run())
