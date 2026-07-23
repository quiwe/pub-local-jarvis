from __future__ import annotations

import tomllib
from pathlib import Path

from jarvis_backend.packaged_launcher import build_runtime_config
from jarvis_backend.settings import Settings


def test_packaged_runtime_config_uses_writable_data_paths(tmp_path: Path) -> None:
    data_root = tmp_path / "user data"
    worker = tmp_path / "runtime" / "jarvis-native-worker.exe"
    models = data_root / "models" / "MiniCPM-o-4_5-gguf"

    document = tomllib.loads(build_runtime_config(data_root, worker, models))
    settings = Settings.model_validate(
        {**document.pop("app"), **document}
    )

    assert settings.environment == "production"
    assert settings.server.host == "127.0.0.1"
    assert settings.native.mode == "process"
    assert settings.native.pipe_name == r"\\.\pipe\AIJarvis.Worker.v1"
    assert settings.native.worker_path == worker.resolve()
    assert settings.native.model_path == models.resolve()
    assert settings.memory.root == (data_root / "memory").resolve()
    assert settings.courses.sessions_root == (data_root / "courses" / "sessions").resolve()
