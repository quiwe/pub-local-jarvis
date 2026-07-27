"""Unix domain socket transport for macOS/Linux native worker IPC."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from collections.abc import AsyncIterator
from contextlib import suppress
from itertools import count
from typing import Any

from .protocol import (
    HEADER,
    Frame,
    MessageType,
    ProtocolError,
    StatusCode,
    decode_frame,
    encode_frame,
    json_payload,
)

logger = logging.getLogger(__name__)


class UnixSocketNativeClient:
    """Unix domain socket transport using the same binary protocol as the C++ worker."""

    _METHODS = {
        "start_monitoring": MessageType.START,
        "resume_monitoring": MessageType.START,
        "pause_monitoring": MessageType.STOP,
        "stop_monitoring": MessageType.STOP,
        "ask": MessageType.SUBMIT,
        "cancel": MessageType.CANCEL,
        "shutdown": MessageType.SHUTDOWN,
        "ping": MessageType.HELLO,
        "set_game_profile": MessageType.CONFIGURE_GAME,
        "start_duplex": MessageType.START_DUPLEX,
        "stop_duplex": MessageType.STOP_DUPLEX,
    }

    def __init__(self, socket_path: str, *, timeout: float = 5.0) -> None:
        self.socket_path = socket_path
        self.timeout = timeout
        self.running = False
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._ids = count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._result_requests: set[int] = set()
        self._events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()

    async def start(self) -> None:
        if self.running:
            return
        self._reader, self._writer = await asyncio.open_unix_connection(self.socket_path)
        self.running = True
        self._reader_task = asyncio.create_task(self._read_loop(), name="jarvis-native-socket-reader")
        await self.request("ping", {})

    async def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        if self._writer is not None:
            with suppress(Exception):
                self._writer.close()
                await self._writer.wait_closed()
            self._writer = None
            self._reader = None
        if self._reader_task:
            self._reader_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await self._reader_task
            self._reader_task = None
        error = RuntimeError("native socket closed")
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
        self._result_requests.clear()
        await self._events.put(None)

    async def request(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.running or self._writer is None:
            raise RuntimeError("native worker is not running")
        try:
            message_type = self._METHODS[method]
        except KeyError as exc:
            raise ValueError(f"unsupported native command: {method}") from exc
        request_id = next(self._ids)
        if message_type == MessageType.SUBMIT:
            body = payload.get("text", "")
        elif message_type == MessageType.CONFIGURE_GAME:
            name = str(payload.get("name", ""))[:80]
            prompt = str(payload.get("prompt", ""))[:8000]
            body = f"{name}\0{prompt}"
        elif message_type == MessageType.START_DUPLEX:
            session_id = str(payload.get("session_id", ""))[:128]
            instruction = str(payload.get("instruction", ""))[:2000]
            body = f"{session_id}\0{instruction}"
        else:
            body = payload
        raw = body.encode("utf-8") if isinstance(body, str) else json_payload(body)
        frame = encode_frame(Frame(message_type, request_id, raw))
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        if message_type == MessageType.SUBMIT:
            self._result_requests.add(request_id)
        async with self._write_lock:
            await asyncio.to_thread(self._write_exact, frame)
        try:
            request_timeout = max(
                0.1,
                min(600.0, float(payload.get("_timeout_seconds", self.timeout))),
            )
            return await asyncio.wait_for(future, request_timeout)
        finally:
            self._pending.pop(request_id, None)
            self._result_requests.discard(request_id)

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            item = await self._events.get()
            if item is None:
                break
            yield item

    async def _read_loop(self) -> None:
        try:
            while self.running and self._reader is not None:
                header = await self._reader.readexactly(HEADER.size)
                length = HEADER.unpack(header)[5]
                payload = await self._reader.readexactly(length)
                frame = decode_frame(header + payload)
                data = self._decode_payload(frame)
                pending = self._pending.get(frame.request_id)
                if frame.message_type == MessageType.ERROR and pending:
                    message = str(data.get("error", "native worker error"))
                    pending.set_exception(RuntimeError(message))
                elif frame.message_type == MessageType.STATUS and pending:
                    if (
                        frame.request_id in self._result_requests
                        and frame.flags == StatusCode.CANCELLED
                    ):
                        pending.set_exception(RuntimeError("native inference was cancelled"))
                    elif frame.request_id not in self._result_requests:
                        pending.set_result(data)
                elif frame.message_type == MessageType.RESULT and pending:
                    pending.set_result(data)
                    await self._events.put(
                        {
                            "type": "answer.completed",
                            "request_id": frame.request_id,
                            **data,
                        }
                    )
                elif frame.message_type == MessageType.RESULT:
                    native_event = self._parse_native_event(frame.request_id, data)
                    if native_event is not None:
                        await self._events.put(native_event)
                    else:
                        event_type = (
                            "perception.completed"
                            if frame.request_id >= (1 << 63)
                            else "answer.completed"
                        )
                        await self._events.put(
                            {"type": event_type, "request_id": frame.request_id, **data}
                        )
                else:
                    await self._events.put(
                        {"type": "native.event", "request_id": frame.request_id, **data}
                    )
        except asyncio.IncompleteReadError:
            if self.running:
                await self._events.put({"type": "worker.fatal", "error": "native socket closed"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.running:
                await self._events.put({"type": "worker.fatal", "error": str(exc)})
        finally:
            self.running = False

    def _write_exact(self, data: bytes) -> None:
        if self._writer is None:
            raise EOFError("native socket closed")
        self._writer.write(data)
        # Flush the transport
        transport = self._writer.transport
        if transport is not None:
            transport.get_write_buffer()

    @staticmethod
    def _decode_payload(frame: Frame) -> dict[str, Any]:
        if not frame.payload:
            return {"ok": True}
        if frame.message_type == MessageType.RESULT:
            try:
                text = frame.payload.decode("utf-8")
            except UnicodeDecodeError as exc:
                logger.warning(
                    "native result %s contained invalid UTF-8 at byte %s; "
                    "replacing malformed bytes",
                    frame.request_id,
                    exc.start,
                )
                text = frame.payload.decode("utf-8", errors="replace")
            return {
                "ok": True,
                "text": text,
            }
        try:
            value = json.loads(frame.payload.decode("utf-8"))
            return value if isinstance(value, dict) else {"value": value}
        except (UnicodeDecodeError, json.JSONDecodeError, ProtocolError):
            return {"ok": True, "text": frame.payload.decode("utf-8", errors="replace")}

    @staticmethod
    def _parse_native_event(
        request_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        if request_id != 0xFFFFFFFFFFFFFFFF:
            return None
        text = data.get("text")
        if not isinstance(text, str):
            return None
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(value, dict):
            return None
        topic = value.pop("native_event", None)
        if not isinstance(topic, str) or not topic:
            return None
        return {"type": topic, **value}
