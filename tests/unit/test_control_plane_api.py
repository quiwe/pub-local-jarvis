from fastapi.testclient import TestClient

from jarvis_backend.app import create_app
from jarvis_backend.settings import CourseSettings, MemorySettings, Settings


def make_client(tmp_path):
    settings = Settings(
        memory=MemorySettings(root=tmp_path / "memory"),
        courses=CourseSettings(
            sessions_root=tmp_path / "sessions", output_root=tmp_path / "courses"
        ),
    )
    return TestClient(create_app(settings=settings))


def test_memory_status_summarize_and_confirmed_clear(tmp_path):
    with make_client(tmp_path) as client:
        store = client.app.state.orchestrator.memory
        store.append("note", "Remember the blue bicycle")

        assert client.get("/api/v1/memory/status").json()["event_count"] == 1
        summary = client.post("/api/v1/memory/summarize")
        assert summary.status_code == 200
        assert summary.json() == {"summary": "Remember the blue bicycle"}
        assert client.post("/api/v1/memory/clear", json={"confirm": False}).status_code == 409
        assert client.get("/api/v1/memory/status").json()["event_count"] == 1
        assert client.post("/api/v1/memory/clear", json={"confirm": True}).json() == {
            "cleared": True
        }
        assert client.get("/api/v1/memory/status").json()["event_count"] == 0

        topics = [event["topic"] for event in client.get("/api/v1/events").json()]
        assert "memory.summarized" in topics
        assert "memory.cleared" in topics


def test_course_start_finish_and_query(tmp_path):
    with make_client(tmp_path) as client:
        started = client.post(
            "/api/v1/courses/start", json={"title": "Python Lesson", "session_id": "lesson-1"}
        )
        assert started.status_code == 201
        assert started.json()["status"] == "recording"

        listed = client.get("/api/v1/courses")
        assert [item["id"] for item in listed.json()] == ["lesson-1"]
        assert client.get("/api/v1/courses/lesson-1").json()["title"] == "Python Lesson"

        finished = client.post("/api/v1/courses/lesson-1/finish")
        assert finished.status_code == 200
        assert finished.json()["status"] == "complete"
        assert (tmp_path / "courses" / "lesson-1.md").is_file()
        assert client.get("/api/v1/courses/missing").status_code == 404

        topics = [event["topic"] for event in client.get("/api/v1/events").json()]
        assert "course.started" in topics
        assert "course.finished" in topics
