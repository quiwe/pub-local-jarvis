import json
import zlib

import pytest

from jarvis_backend.native.protocol import (
    HEADER,
    MAGIC,
    Frame,
    MessageType,
    ProtocolError,
    decode_frame,
    encode_frame,
    json_payload,
)


def test_protocol_round_trip_matches_native_header() -> None:
    frame = Frame(MessageType.SUBMIT, request_id=42, payload="你好".encode())
    encoded = encode_frame(frame)
    assert len(encoded) == 32 + len(frame.payload)
    magic, version, kind, flags, request_id, length, checksum, reserved = HEADER.unpack_from(
        encoded
    )
    assert (magic, version, kind, flags, request_id, length, reserved) == (
        MAGIC,
        1,
        int(MessageType.SUBMIT),
        0,
        42,
        len(frame.payload),
        0,
    )
    assert checksum == zlib.crc32(frame.payload) & 0xFFFFFFFF
    assert decode_frame(encoded) == frame


def test_json_payload_is_utf8_and_compact() -> None:
    payload = json_payload({"text": "你好", "enabled": True})
    assert json.loads(payload) == {"text": "你好", "enabled": True}
    assert b" " not in payload


def test_protocol_rejects_wrong_version_and_corruption() -> None:
    encoded = encode_frame(Frame(MessageType.STATUS, payload=b"ok", version=2))
    with pytest.raises(ProtocolError, match="unsupported protocol version"):
        decode_frame(encoded)

    valid = bytearray(encode_frame(Frame(MessageType.RESULT, payload=b"answer")))
    valid[-1] ^= 1
    with pytest.raises(ProtocolError, match="checksum"):
        decode_frame(bytes(valid))
