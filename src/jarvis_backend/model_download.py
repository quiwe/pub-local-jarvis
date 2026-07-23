from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from huggingface_hub import snapshot_download as huggingface_snapshot_download

MODEL_REPO_ID = "openbmb/MiniCPM-o-4_5-gguf"
MODEL_REVISION = "502eec5b03eaee9d0d2ce17a176e3490103c9a63"
MODEL_FILES = (
    (
        "MiniCPM-o-4_5-Q4_K_M.gguf",
        5_026_714_400,
        "1237a97ee081b8abebc47aa7dad565701e8f5f904cdc92f6723ac4281bbc0932",
    ),
    (
        "vision/MiniCPM-o-4_5-vision-F16.gguf",
        1_095_113_184,
        "1453678cc4e4fe18de241952962e234f265cb8dda780773526103ab8ba82f421",
    ),
    (
        "audio/MiniCPM-o-4_5-audio-F16.gguf",
        660_167_904,
        "d5b188ac7feaf98e17175c3f9bd14bf269301bfd187439fdaa3e3a494fc32ef7",
    ),
)
MODEL_PATTERNS = tuple(item[0] for item in MODEL_FILES)
MODEL_MARKER = ".aijarvis-model.json"
OFFICIAL_ENDPOINT = "https://huggingface.co"
DEFAULT_MIRROR_ENDPOINT = "https://hf-mirror.com"

SnapshotDownload = Callable[..., Any]


def model_files_are_valid(local_dir: Path, *, verify_hashes: bool = False) -> bool:
    for relative_path, expected_size, expected_hash in MODEL_FILES:
        path = local_dir / Path(relative_path)
        if not path.is_file() or path.stat().st_size != expected_size:
            return False
        if verify_hashes:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != expected_hash:
                return False
    return True


def model_marker_is_valid(local_dir: Path) -> bool:
    try:
        marker = json.loads((local_dir / MODEL_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return marker == {
        "revision": MODEL_REVISION,
        "files": {path: digest for path, _size, digest in MODEL_FILES},
    }


def write_model_marker(local_dir: Path) -> None:
    marker = {
        "revision": MODEL_REVISION,
        "files": {path: digest for path, _size, digest in MODEL_FILES},
    }
    destination = local_dir / MODEL_MARKER
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(marker, ensure_ascii=True, indent=2), encoding="utf-8")
    temporary.replace(destination)


def _normalize_endpoint(endpoint: str) -> str:
    return endpoint.strip().rstrip("/")


def endpoint_candidates(primary: str, mirror: str | None) -> tuple[str, ...]:
    candidates: list[str] = []
    for endpoint in (primary, mirror):
        normalized = _normalize_endpoint(endpoint or "")
        if normalized and normalized not in candidates:
            candidates.append(normalized)
    if not candidates:
        raise ValueError("at least one model download endpoint is required")
    return tuple(candidates)


def _redact(message: str, secret: str | None) -> str:
    return message.replace(secret, "[redacted]") if secret else message


def _mirror_disabled(value: str | None) -> bool:
    return (value or "").casefold() in {"1", "true", "yes", "on"}


def download_models(
    local_dir: Path,
    revision: str,
    *,
    token: str | None = None,
    primary_endpoint: str = OFFICIAL_ENDPOINT,
    mirror_endpoint: str | None = DEFAULT_MIRROR_ENDPOINT,
    snapshot_download: SnapshotDownload | None = None,
    log: Callable[[str], None] = print,
) -> str:
    if snapshot_download is None:
        snapshot_download = huggingface_snapshot_download

    endpoints = endpoint_candidates(primary_endpoint, mirror_endpoint)
    failures: list[str] = []
    for index, endpoint in enumerate(endpoints):
        source_name = "official source" if index == 0 else "mainland China mirror"
        log(f"Downloading pinned model files from {source_name}: {endpoint}")
        try:
            snapshot_download(
                repo_id=MODEL_REPO_ID,
                revision=revision,
                local_dir=str(local_dir),
                allow_patterns=list(MODEL_PATTERNS),
                token=token or None,
                endpoint=endpoint,
            )
            return endpoint
        except Exception as error:
            detail = _redact(str(error), token)
            failures.append(detail)
            if index + 1 < len(endpoints):
                log(f"Official model source failed ({detail}); retrying with the mirror.")

    raise RuntimeError(
        f"model download failed from all configured endpoints: {failures[-1]}"
    ) from None


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the pinned AI Jarvis model files")
    parser.add_argument("--local-dir", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")
    mirror = (
        None
        if _mirror_disabled(os.getenv("JARVIS_DISABLE_DOWNLOAD_MIRROR"))
        else os.getenv("JARVIS_HF_MIRROR", DEFAULT_MIRROR_ENDPOINT)
    )
    download_models(
        args.local_dir,
        args.revision,
        token=os.getenv("HF_TOKEN"),
        primary_endpoint=os.getenv("JARVIS_HF_PRIMARY_ENDPOINT", OFFICIAL_ENDPOINT),
        mirror_endpoint=mirror,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
