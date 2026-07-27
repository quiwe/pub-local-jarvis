import os

from .client import InProcessNativeClient, NamedPipeNativeClient, NativeClient
from .protocol import Frame, MessageType, ProtocolError, decode_frame, encode_frame, json_payload
from .supervisor import WorkerSupervisor

__all__ = [
    "Frame",
    "InProcessNativeClient",
    "MessageType",
    "NamedPipeNativeClient",
    "NativeClient",
    "ProtocolError",
    "WorkerSupervisor",
    "decode_frame",
    "encode_frame",
    "json_payload",
]

# Export UnixSocketNativeClient on non-Windows platforms
if os.name != "nt":
    from .unix_client import UnixSocketNativeClient

    __all__.append("UnixSocketNativeClient")
