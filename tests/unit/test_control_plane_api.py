import base64
import json
import time

from fastapi.testclient import TestClient

import jarvis_backend.orchestrator.service as service_module
from jarvis_backend.app import create_app
from jarvis_backend.courses import CourseStatus
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
                '"course_transcript":"牛顿第二定律是 F=ma。",'
                '"course_note":"牛顿第二定律是 F=ma。","course_title":"高中物理",'
                '"capture_keyframe":true,"keyframe_note":"牛顿第二定律公式。",'
                '"assistant_message":""}',
            },
        )
        time.sleep(0.02)
        courses = client.get("/api/v1/courses").json()
        assert len(courses) == 1
        assert courses[0]["status"] == "recording"
        assert courses[0]["summary"] == ""
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

        client.app.state.orchestrator.settings.courses.exit_grace_seconds = 0
        client.app.state.orchestrator.settings.courses.exit_samples = 3
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
        assert not any(
            event["topic"] == "assistant.message" for event in events
        )

        client.app.state.orchestrator.display_scene.force("other")
        client.portal.call(
            native.emit,
            {
                "type": "perception.completed",
                "request_id": (1 << 63) + 5,
                "text": (
                    '{"scene":"other","confidence":0.9,'
                    '"assistant_message":"新场景已经稳定，可以按刚才的目标继续推进。"}'
                ),
            },
        )
        time.sleep(0.02)
        events = client.get("/api/v1/events").json()
        assert any(
            event["topic"] == "assistant.message"
            and event["payload"]["text"] == "新场景已经稳定，可以按刚才的目标继续推进。"
            for event in events
        )


async def test_auto_course_survives_transient_scene_misclassification(
    tmp_path, monkeypatch
):
    settings = Settings(
        memory=MemorySettings(root=tmp_path / "memory"),
        courses=CourseSettings(
            sessions_root=tmp_path / "sessions",
            output_root=tmp_path / "courses",
            exit_grace_seconds=30,
            exit_samples=4,
        ),
    )
    orchestrator = create_app(settings=settings).state.orchestrator
    clock = [0.0]
    monkeypatch.setattr(service_module.time, "monotonic", lambda: clock[0])

    async def perceive(scene, *, note=""):
        await orchestrator._handle_perception(
            {
                "type": "perception.completed",
                "text": json.dumps(
                    {
                        "scene": scene,
                        "confidence": 0.9,
                        "course_title": "高中物理：牛顿第二定律",
                        "course_note": note,
                    },
                    ensure_ascii=False,
                ),
            }
        )

    await perceive("course", note="牛顿第二定律说明合外力等于质量与加速度的乘积。")
    session_id = orchestrator._auto_course_id
    assert session_id is not None
    clock[0] = 1.0
    await perceive("course", note="牛顿第二定律说明合外力等于质量与加速度的乘积。")

    for now in (3.0, 6.0):
        clock[0] = now
        await perceive("other")
    assert orchestrator.courses.open(session_id).state.status == CourseStatus.RECORDING
    assert orchestrator.events.history("perception.completed")[-1].payload["scene"] == "course"

    clock[0] = 7.0
    await perceive(
        "course",
        note=(
            "牛顿第二定律说明合外力等于质量与加速度的乘积，即 F=ma；"
            "它表示力是改变物体运动状态的原因。"
        ),
    )
    state = orchestrator.courses.open(session_id).state
    assert orchestrator._auto_course_id == session_id
    assert state.summary == ""

    for now in (10.0, 20.0, 30.0):
        clock[0] = now
        await perceive("other")
    assert orchestrator.courses.open(session_id).state.status == CourseStatus.RECORDING
    assert orchestrator.events.history("perception.completed")[-1].payload["scene"] == "other"

    clock[0] = 40.0
    await perceive("other")
    assert orchestrator.courses.open(session_id).state.status == CourseStatus.COMPLETE
    assert len(orchestrator.courses.sessions()) == 1


async def test_course_transcript_drives_summary_keyframes_and_specific_interactions(
    tmp_path, monkeypatch
):
    settings = Settings(
        memory=MemorySettings(root=tmp_path / "memory"),
        courses=CourseSettings(
            sessions_root=tmp_path / "sessions",
            output_root=tmp_path / "courses",
        ),
    )
    orchestrator = create_app(settings=settings).state.orchestrator
    summary_prompts = []

    async def summarize(method, payload):
        assert method == "ask"
        summary_prompts.append(payload["text"])
        return {
            "text": (
                "### 课程概览\n本节课比较速度与加速度。\n\n"
                "### 核心内容\n"
                "- 速度描述位置随时间的变化率；加速度描述速度随时间的变化率。\n"
                "- 解题时应先区分研究对象及两个物理量的定义。"
            )
        }

    monkeypatch.setattr(orchestrator.native_client, "request", summarize)

    async def perceive(request_id, transcript, interaction, *, capture=False):
        await orchestrator._handle_perception(
            {
                "request_id": request_id,
                "text": json.dumps(
                    {
                        "scene": "course",
                        "confidence": 0.95,
                        "course_title": "运动学：速度与加速度",
                        "course_transcript": transcript,
                        "course_note": "",
                        "course_interaction": interaction,
                        "capture_keyframe": capture,
                        "keyframe_note": "速度与加速度的定义及对比公式。",
                    },
                    ensure_ascii=False,
                ),
            }
        )

    await perceive(
        1,
        "速度表示位置变化快慢，加速度表示速度变化快慢",
        "这课很枯燥，但基础很重要。",
    )
    await perceive(
        2,
        "加速度表示速度变化快慢，二者不要混淆",
        "这里要区分速度和加速度的定义对象。",
        capture=True,
    )

    session = orchestrator.courses.sessions()[0]
    transcript = session.transcript_path.read_text(encoding="utf-8")
    assert transcript.count("加速度表示速度变化快慢") == 1
    assert "二者不要混淆" in transcript
    assert session.state.summary == ""
    assert summary_prompts == []

    events = orchestrator.events.history()
    interactions = [
        event.payload["text"] for event in events if event.topic == "course.interaction"
    ]
    assert interactions == ["这里要区分速度和加速度的定义对象。"]
    keyframes = [event for event in events if event.topic == "course.keyframe.requested"]
    assert len(keyframes) == 1
    assert keyframes[0].payload["note"] == "速度与加速度的定义及对比公式。"

    state = await orchestrator.finish_course(session.state.id)
    assert state.status == CourseStatus.COMPLETE
    assert "位置随时间的变化率" in state.summary
    assert len(summary_prompts) == 1
    assert summary_prompts[0].startswith("[[JARVIS_TEXT_ONLY]]")
    assert "速度表示位置变化快慢" in summary_prompts[0]
    assert "二者不要混淆" in summary_prompts[0]


async def test_recording_course_resumes_after_backend_restart(tmp_path):
    settings = Settings(
        memory=MemorySettings(root=tmp_path / "memory"),
        courses=CourseSettings(
            sessions_root=tmp_path / "sessions",
            output_root=tmp_path / "courses",
        ),
    )
    first = create_app(settings=settings).state.orchestrator
    await first._handle_perception(
        {
            "text": json.dumps(
                {
                    "scene": "course",
                    "course_title": "高等数学：映射",
                    "course_transcript": "映射要求定义域中的每个元素有唯一对应。",
                },
                ensure_ascii=False,
            )
        }
    )
    session_id = first._auto_course_id
    assert session_id is not None

    restarted = create_app(settings=settings).state.orchestrator
    assert restarted._auto_course_id == session_id
    await restarted._handle_perception(
        {
            "text": json.dumps(
                {
                    "scene": "course",
                    "course_transcript": "陪域中的元素可以没有原像。",
                },
                ensure_ascii=False,
            )
        }
    )

    sessions = restarted.courses.sessions()
    assert len(sessions) == 1
    transcript = sessions[0].transcript_path.read_text(encoding="utf-8")
    assert "每个元素有唯一对应" in transcript
    assert "可以没有原像" in transcript


def test_interaction_frequency_blocks_repeated_barrage_during_dedup_window(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client

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

        emit(1, "other", message="这一步已经理顺，接下来可以直接验证核心结果。")
        emit(2, "game", barrage="漂亮操作！")
        time.sleep(0.03)
        emit(3, "other", message="核心结果还没验证，先别急着扩展到旁支。")
        emit(4, "game", barrage="漂亮操作！")
        time.sleep(0.03)
        repeated_text, repeated_at = client.app.state.orchestrator._recent_barrages[0]
        client.app.state.orchestrator._recent_barrages[0] = (
            repeated_text,
            repeated_at - 90.0,
        )
        emit(5, "game", barrage="漂亮操作！")
        time.sleep(0.03)
        events = client.get("/api/v1/events").json()
        bubbles = [event for event in events if event["topic"] == "assistant.message"]
        barrages = [event for event in events if event["topic"] == "barrage.generated"]
        assert [event["payload"]["text"] for event in bubbles] == [
            "这一步已经理顺，接下来可以直接验证核心结果。"
        ]
        assert [event["payload"]["text"] for event in barrages] == [
            "漂亮操作！",
            "漂亮操作！",
        ]


def test_game_barrage_semantic_near_duplicates_are_suppressed(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client

        for request_id, barrage in enumerate(
            ["漂亮操作，完成反杀！", "反杀完成，这操作漂亮！", "资源够了，可以推进"],
            start=20,
        ):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": request_id,
                    "text": (
                        '{"scene":"game","confidence":1.0,'
                        f'"barrage":"{barrage}","assistant_message":""}}'
                    ),
                },
            )

        time.sleep(0.03)
        generated = [
            event["payload"]["text"]
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "barrage.generated"
        ]
        assert generated == ["漂亮操作，完成反杀！", "资源够了，可以推进"]


def test_game_barrage_prefers_declarative_candidate_over_speculative_question(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        payload = {
            "scene": "game",
            "confidence": 1.0,
            "observation": "玩家站在草原，附近有羊群",
            "barrage": "头顶方块是惊喜还是陷阱？",
            "barrage_candidates": [
                "头顶方块是惊喜还是陷阱？",
                "羊群把这片草原承包了",
                "视野开阔，先把落脚点定下来",
            ],
            "assistant_message": "",
        }
        client.portal.call(
            native.emit,
            {
                "type": "perception.completed",
                "request_id": 25,
                "text": json.dumps(payload, ensure_ascii=False),
            },
        )

        time.sleep(0.03)
        generated = [
            event["payload"]["text"]
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "barrage.generated"
        ]
        assert generated == ["羊群把这片草原承包了"]


def test_game_barrage_uses_fresh_alternative_when_primary_is_repeated(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client

        def emit(request_id, primary, candidates):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": request_id,
                    "text": json.dumps(
                        {
                            "scene": "game",
                            "confidence": 1.0,
                            "barrage": primary,
                            "barrage_candidates": candidates,
                            "assistant_message": "",
                        },
                        ensure_ascii=False,
                    ),
                },
            )

        emit(26, "草原这局面挺安稳", ["草原这局面挺安稳"])
        emit(
            27,
            "草原这局面挺安稳",
            ["草原这局面挺安稳", "羊群已经开始自由巡逻", "先沿高处看看地形"],
        )

        time.sleep(0.03)
        generated = [
            event["payload"]["text"]
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "barrage.generated"
        ]
        assert generated == ["草原这局面挺安稳", "羊群已经开始自由巡逻"]


def test_game_barrage_near_duplicate_recovers_before_exact_repeat(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        orchestrator = client.app.state.orchestrator

        def emit(request_id, barrage):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": request_id,
                    "text": (
                        '{"scene":"game","confidence":1.0,'
                        f'"barrage":"{barrage}","assistant_message":""}}'
                    ),
                },
            )

        emit(30, "漂亮操作，完成反杀！")
        time.sleep(0.02)
        original, emitted_at = orchestrator._recent_barrages[0]
        orchestrator._recent_barrages[0] = (original, emitted_at - 31.0)
        emit(31, "反杀完成，这操作漂亮！")
        emit(32, "漂亮操作，完成反杀！")

        time.sleep(0.03)
        generated = [
            event["payload"]["text"]
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "barrage.generated"
        ]
        assert generated == ["漂亮操作，完成反杀！", "反杀完成，这操作漂亮！"]


def test_ordinary_bubble_default_cooldown_is_twenty_seconds(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        orchestrator = client.app.state.orchestrator

        def emit(request_id, message):
            client.portal.call(
                native.emit,
                {
                    "type": "perception.completed",
                    "request_id": request_id,
                    "text": (
                        '{"scene":"other","confidence":0.9,"barrage":"",'
                        f'"assistant_message":"{message}"}}'
                    ),
                },
            )

        assert orchestrator.settings.interaction.ordinary_bubble_cooldown_seconds == 20.0
        emit(10, "切到文档了，思路开始落地。")
        emit(11, "搜索结束，准备认真读了。")
        time.sleep(0.03)
        previous, emitted_at = orchestrator._recent_assistant_messages[-1]
        orchestrator._recent_assistant_messages[-1] = (previous, emitted_at - 20.0)
        emit(12, "资料已经看够了，现在可以把关键结论落到文档里。")
        time.sleep(0.03)

        messages = [
            event["payload"]["text"]
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "assistant.message"
        ]
        assert messages == [
            "切到文档了，思路开始落地。",
            "资料已经看够了，现在可以把关键结论落到文档里。",
        ]


def test_perception_keeps_internal_observation_separate_from_bubble_text():
    result = create_app().state.orchestrator._parse_perception(
        '{"scene":"other","confidence":0.9,'
        '"observation":"编辑器中打开了代码文件",'
        '"assistant_message":"又和代码较上劲了？"}'
    )

    assert result["observation"] == "编辑器中打开了代码文件"
    assert result["assistant_message"] == "又和代码较上劲了？"


def test_ordinary_bubble_uses_first_valid_model_candidate(tmp_path):
    with make_client(tmp_path) as client:
        native = client.app.state.orchestrator.native_client
        client.portal.call(
            native.emit,
            {
                "type": "perception.completed",
                "request_id": 88,
                "text": json.dumps(
                    {
                        "scene": "other",
                        "assistant_candidates": [
                            "您正在观看一段舞蹈视频。",
                            "需要我帮忙找类似视频吗？",
                            "表演开场，主人请就位！",
                        ],
                        "assistant_message": "",
                    },
                    ensure_ascii=False,
                ),
            },
        )
        time.sleep(0.03)
        messages = [
            event["payload"]["text"]
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "assistant.message"
        ]
        assert messages == ["表演开场，主人请就位！"]


def test_ordinary_bubbles_reject_narration_templates_and_near_duplicates(tmp_path):
    with make_client(tmp_path) as client:
        orchestrator = client.app.state.orchestrator
        assert orchestrator._clean_assistant_message(
            "检测到图像文件夹，可能涉及照片查看或素材整理任务。"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "教师通过屏幕文字辅助讲解导数概念，学生可能在同步笔记。"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "你在处理代码文件，需要我帮忙查看错误信息吗？"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "桌面上的截图和文档看起来挺多的，要不要现在整理一下呢？"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "桌面图标较多，主要为文件夹和快捷方式，文件夹名称多与图像或项目相关，"
            "桌面背景为地球星空主题，整体环境安静，无明显游戏或课程界面，"
            "推测用户可能在整理文件或准备相关素材工作。"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "您正在观看一个名为‘对对子战神4’的视频，弹幕中有许多互动和调侃。"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "您正在查看网易邮箱的私人消息页面，可选择回复或查看其他联系人信息。"
        ) == ""
        assert orchestrator._clean_assistant_message("思路卡住了？换个对象呗？") == ""
        assert orchestrator._clean_assistant_message(
            "这个报错已经把范围缩小了，先核对调用参数，再决定要不要改实现。"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "AI合租话题挺有意思，需要帮你找类似视频吗？"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "代码窗口有点挡视线，需要整理吗？"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "这部分交给我，随时叫我帮忙。"
        ) == ""
        assert orchestrator._clean_assistant_message(
            "这个报错已经把范围缩小了，先核对调用参数。"
            "后续所有相关改动都等完整验证结果出来以后再统一决定。"
        ) == "这个报错已经把范围缩小了，先核对调用参数。"
        assert orchestrator._clean_assistant_message("又看这种低俗视频？")
        assert orchestrator._clean_assistant_message("别急，喝口咖啡继续 coding！")
        assert orchestrator._clean_assistant_message("主人这代码写得也太漂亮了！")


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
        assert courses[0]["summary"] == ""
        events = client.get("/api/v1/events").json()
        interactions = [event for event in events if event["topic"] == "course.interaction"]
        assert [event["payload"]["text"] for event in interactions] == [
            "Connect this to inertia."
        ]

        client.app.state.orchestrator._last_course_interaction_at -= 90.0
        emit(
            102, "Acceleration describes how quickly velocity changes.", "Now link force to motion."
        )
        time.sleep(0.03)
        events = client.get("/api/v1/events").json()
        interactions = [event for event in events if event["topic"] == "course.interaction"]
        assert [event["payload"]["text"] for event in interactions] == [
            "Connect this to inertia.",
            "Now link force to motion.",
        ]

        client.app.state.orchestrator._last_course_interaction_at -= 30.0
        emit(103, "Velocity is displacement divided by elapsed time.", "")
        time.sleep(0.03)
        interactions = [
            event
            for event in client.get("/api/v1/events").json()
            if event["topic"] == "course.interaction"
        ]
        assert interactions[-1]["payload"]["text"] == (
            "Velocity is displacement divided by elapsed time。"
        )


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
