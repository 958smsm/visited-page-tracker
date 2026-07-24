"""Chrome Native Messaging length-prefixed JSON protocol."""
from __future__ import annotations

import json
import struct
import sys
from typing import Any, BinaryIO

MAX_MESSAGE_BYTES = 16 * 1024 * 1024


class ProtocolError(Exception):
    pass


def _read_exact(source: BinaryIO, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = source.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message(stream: BinaryIO | None = None) -> dict[str, Any] | None:
    source = stream or sys.stdin.buffer
    header = _read_exact(source, 4)
    if not header:
        return None
    if len(header) != 4:
        raise ProtocolError("Incomplete native-message length header.")
    (length,) = struct.unpack("<I", header)
    if length <= 0 or length > MAX_MESSAGE_BYTES:
        raise ProtocolError(f"Invalid native-message length: {length}.")
    payload = _read_exact(source, length)
    if len(payload) != length:
        raise ProtocolError("Incomplete native-message payload.")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"Invalid JSON payload: {exc}") from exc
    if not isinstance(value, dict):
        raise ProtocolError("Native-message payload must be a JSON object.")
    return value


def write_message(message: dict[str, Any], stream: BinaryIO | None = None) -> None:
    destination = stream or sys.stdout.buffer
    data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        raise ProtocolError("Native-message response exceeds the size limit.")
    destination.write(struct.pack("<I", len(data)))
    destination.write(data)
    destination.flush()
