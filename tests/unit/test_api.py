from fastapi.testclient import TestClient

from jarvis_backend.app import create_app
from jarvis_backend.native import InProcessNativeClient
from jarvis_backend.settings import Settings


def test_health_and_command_flow() -> None:
    app = create_app(Settings(), InProcessNativeClient())
    with TestClient(app) as client:
        health = client.get("/api/v1/health")
        assert health.status_code == 200
        assert health.json()["lifecycle"] == "ready"
        response = client.post("/api/v1/commands", json={"command": "ping", "arguments": {}})
        assert response.status_code == 200
        assert response.json()["result"]["result"] == "pong"


def test_scene_endpoint_reports_only_stable_change() -> None:
    app = create_app(Settings(), InProcessNativeClient())
    with TestClient(app) as client:
        assert (
            client.post("/api/v1/scene/observations", json={"score": 0.9}).json()["changed"]
            is False
        )
        assert (
            client.post("/api/v1/scene/observations", json={"score": 0.9}).json()["changed"]
            is False
        )
        result = client.post("/api/v1/scene/observations", json={"score": 0.9}).json()
        assert result == {"active": True, "changed": True}
