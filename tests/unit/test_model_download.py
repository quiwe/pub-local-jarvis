from __future__ import annotations

import traceback
from pathlib import Path
from typing import Any

import pytest

from jarvis_backend.model_download import download_models, endpoint_candidates


def test_endpoint_candidates_normalize_and_deduplicate() -> None:
    assert endpoint_candidates("https://huggingface.co/", "https://huggingface.co") == (
        "https://huggingface.co",
    )


def test_model_download_uses_official_source_first(tmp_path: Path) -> None:
    calls: list[dict[str, Any]] = []

    def snapshot_download(**kwargs: Any) -> None:
        calls.append(kwargs)

    endpoint = download_models(
        tmp_path,
        "revision",
        snapshot_download=snapshot_download,
        log=lambda _message: None,
    )

    assert endpoint == "https://huggingface.co"
    assert [call["endpoint"] for call in calls] == ["https://huggingface.co"]
    assert calls[0]["revision"] == "revision"
    assert calls[0]["local_dir"] == str(tmp_path)


def test_model_download_retries_with_mirror(tmp_path: Path) -> None:
    endpoints: list[str] = []

    def snapshot_download(**kwargs: Any) -> None:
        endpoints.append(kwargs["endpoint"])
        if len(endpoints) == 1:
            raise TimeoutError("official source timed out")

    endpoint = download_models(
        tmp_path,
        "revision",
        mirror_endpoint="https://mirror.example/",
        snapshot_download=snapshot_download,
        log=lambda _message: None,
    )

    assert endpoint == "https://mirror.example"
    assert endpoints == ["https://huggingface.co", "https://mirror.example"]


def test_model_download_redacts_token_from_final_error(tmp_path: Path) -> None:
    token = "private-token"

    def snapshot_download(**_kwargs: Any) -> None:
        raise RuntimeError(f"request rejected for {token}")

    with pytest.raises(RuntimeError) as error:
        download_models(
            tmp_path,
            "revision",
            token=token,
            mirror_endpoint=None,
            snapshot_download=snapshot_download,
            log=lambda _message: None,
        )

    assert token not in str(error.value)
    assert "[redacted]" in str(error.value)
    rendered = "".join(traceback.format_exception(error.value))
    assert token not in rendered
