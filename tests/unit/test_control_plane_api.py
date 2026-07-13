import base64
import time

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
        assert (tmp_path / "courses" / "lesson-1" / "README.md").is_file()
        assert (tmp_path / "courses" / "lesson-1" / "images").is_dir()
        assert client.get("/api/v1/courses/missing").status_code == 404

        topics = [event["topic"] for event in client.get("/api/v1/events").json()]
        assert "course.started" in topics
        assert "course.finished" in topics


def test_continuous_perception_generates_barrage_and_course_notes(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client

        client.portal.call(
            native.emit,
            {
                "type": "perception.completed",
                "request_id": 1 << 63,
                "text": '{"scene":"game","confidence":0.94,"barrage":"漂亮的反杀！",'
                '"course_note":"","course_title":""}',
            },
        )
        time.sleep(0.02)
        events = client.get("/api/v1/events").json()
        assert any(
            event["topic"] == "barrage.generated" and event["payload"]["text"] == "漂亮的反杀！"
            for event in events
        )

        client.portal.call(
            native.emit,
            {
                "type": "perception.completed",
                "request_id": (1 << 63) + 1,
                "text": '{"scene":"course","confidence":0.91,"barrage":"",'
                '"course_note":"牛顿第二定律是 F=ma。","course_title":"高中物理",'
                '"capture_keyframe":true,"assistant_message":""}',
            },
        )
        time.sleep(0.02)
        courses = client.get("/api/v1/courses").json()
        assert len(courses) == 1
        assert courses[0]["status"] == "recording"
        assert "牛顿第二定律" in courses[0]["summary"]
        transcript = tmp_path / "sessions" / courses[0]["id"] / "transcript.md"
        assert "F=ma" in transcript.read_text(encoding="utf-8")
        events = client.get("/api/v1/events").json()
        keyframe_request = next(
            event for event in events if event["topic"] == "course.keyframe.requested"
        )
        png = b"\x89PNG\r\n\x1a\nkeyframe"
        recorded = client.post(
            f"/api/v1/courses/{courses[0]['id']}/keyframes",
            json={
                "image_base64": base64.b64encode(png).decode("ascii"),
                "timestamp_ms": keyframe_request["payload"]["timestamp_ms"],
                "extension": "png",
                "metadata": {"source": "desktop"},
            },
        )
        assert recorded.status_code == 200
        assert len(recorded.json()["keyframes"]) == 1

        for offset in range(2, 5):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": (1 << 63) + offset,
                    "text": '{"scene":"other","confidence":0.8,"barrage":"",'
                    '"course_note":"","course_title":"",'
                    f'"assistant_message":"{"下载已经完成。" if offset == 2 else ""}"}}',
                },
            )
        time.sleep(0.03)
        completed = client.get("/api/v1/courses").json()[0]
        assert completed["status"] == "complete"
        assert completed["output_path"] is not None
        output = tmp_path / "courses" / completed["id"]
        assert (output / "README.md").is_file()
        assert list((output / "images").glob("*.png"))
        events = client.get("/api/v1/events").json()
        assert any(
            event["topic"] == "assistant.message" and event["payload"]["text"] == "下载已经完成。"
            for event in events
        )


def test_interaction_frequency_balances_bubbles_and_barrage(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        client.app.state.orchestrator.settings.interaction.game_barrage_output_ratio = 1.0

        def emit(request_id, scene, barrage="", message=""):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": request_id,
                    "text": (
                        f'{{"scene":"{scene}","confidence":0.9,'
                        f'"barrage":"{barrage}","assistant_message":"{message}"}}'
                    ),
                },
            )

        emit(1, "other", message="第一条提醒")
        emit(2, "game", barrage="漂亮操作！")
        time.sleep(0.03)
        emit(3, "other", message="冷却期内的第二条提醒")
        emit(4, "game", barrage="漂亮操作！")
        time.sleep(0.03)
        client.app.state.orchestrator._last_barrage_at -= 12.0
        emit(5, "game", barrage="漂亮操作！")
        time.sleep(0.03)
        events = client.get("/api/v1/events").json()
        bubbles = [event for event in events if event["topic"] == "assistant.message"]
        barrages = [event for event in events if event["topic"] == "barrage.generated"]
        assert [event["payload"]["text"] for event in bubbles] == ["第一条提醒"]
        assert [event["payload"]["text"] for event in barrages] == [
            "漂亮操作！",
            "漂亮操作！",
        ]


def test_course_interactions_are_low_frequency_and_process_notes_are_discarded(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client

        def emit(request_id, note, interaction):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": request_id,
                    "text": (
                        '{"scene":"course","confidence":0.9,"course_title":"Physics",'
                        f'"course_note":"{note}","course_interaction":"{interaction}"}}'
                    ),
                },
            )

        emit(100, "The screen shows a folder of course files.", "Notice why mass matters here.")
        emit(101, "Force equals mass multiplied by acceleration.", "Connect this to inertia.")
        time.sleep(0.03)

        courses = client.get("/api/v1/courses").json()
        assert len(courses) == 1
        assert "Force equals" in courses[0]["summary"]
        assert "folder" not in courses[0]["summary"]
        events = client.get("/api/v1/events").json()
        interactions = [event for event in events if event["topic"] == "course.interaction"]
        assert [event["payload"]["text"] for event in interactions] == [
            "Notice why mass matters here."
        ]

        client.app.state.orchestrator._last_course_interaction_at -= 90.0
        emit(
            102, "Acceleration describes how quickly velocity changes.", "Now link force to motion."
        )
        time.sleep(0.03)
        events = client.get("/api/v1/events").json()
        interactions = [event for event in events if event["topic"] == "course.interaction"]
        assert [event["payload"]["text"] for event in interactions] == [
            "Notice why mass matters here.",
            "Now link force to motion.",
        ]


def test_game_barrage_output_ratio_emits_two_of_every_three_candidates(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        for offset in range(6):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": 200 + offset,
                    "text": (
                        '{"scene":"game","confidence":1.0,'
                        f'"barrage":"弹幕{offset}","assistant_message":""}}'
                    ),
                },
            )
        time.sleep(0.05)
        events = client.get("/api/v1/events").json()
        generated = [event for event in events if event["topic"] == "barrage.generated"]
        assert len(generated) == 4


def test_game_advice_falls_back_to_barrage_when_model_uses_wrong_field(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        client.portal.call(
            native.emit,
            {
                "type": "perception.completed",
                "request_id": 99,
                "text": (
                    '{"scene":"game","confidence":1.0,"barrage":"",'
                    '"course_note":"","assistant_message":"先补向日葵，经济别断"}'
                ),
            },
        )
        time.sleep(0.02)
        events = client.get("/api/v1/events").json()
        generated = [event for event in events if event["topic"] == "barrage.generated"]
        assert generated[-1]["payload"]["text"] == "先补向日葵，经济别断"
