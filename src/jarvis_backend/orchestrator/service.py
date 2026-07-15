from __future__ import annotations

import base64
import binascii
import json
import re
import time
from collections import deque
from collections.abc import Sequence
from datetime import UTC, datetime
from difflib import SequenceMatcher
from typing import Any

from jarvis_backend.barrage import BarrageItem, BarragePolicy
from jarvis_backend.courses import CourseRepository, CourseState, CourseStatus, desktop_path
from jarvis_backend.memory import MemoryEvent, MemoryStore
from jarvis_backend.native import NativeClient, WorkerSupervisor
from jarvis_backend.orchestrator.events import Event, EventBus
from jarvis_backend.orchestrator.lifecycle import Lifecycle, LifecycleState
from jarvis_backend.orchestrator.scene import CourseSceneStabilizer, SceneHysteresis
from jarvis_backend.settings import Settings


def _normalize_text(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.casefold())


def _texts_are_similar(left: str, right: str) -> bool:
    left_normalized = _normalize_text(left)
    right_normalized = _normalize_text(right)
    if not left_normalized or not right_normalized:
        return False
    if left_normalized == right_normalized:
        return True
    if min(len(left_normalized), len(right_normalized)) < 4:
        return False
    sequence_ratio = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    shorter = min(len(left_normalized), len(right_normalized))
    shared_characters = sum(
        min(left_normalized.count(character), right_normalized.count(character))
        for character in set(left_normalized)
    )
    character_coverage = shared_characters / shorter
    length_ratio = shorter / max(len(left_normalized), len(right_normalized))
    return sequence_ratio >= 0.78 or (character_coverage >= 0.9 and length_ratio >= 0.65)


def _barrage_quality_penalty(text: str) -> int:
    penalty = 0
    if re.search(r"[？?]|是.{0,10}还是|是不是|难道|莫非", text):
        penalty += 6
    if re.search(r"看起来|似乎|可能|大概|也许|不知道", text):
        penalty += 3
    if re.search(r"根据画面|当前画面|画面中|屏幕上", text):
        penalty += 5
    if len(text) < 6:
        penalty += 2
    return penalty


class OrchestrationService:
    def __init__(
        self,
        settings: Settings,
        native_client: NativeClient,
        event_bus: EventBus | None = None,
    ) -> None:
        self.settings = settings
        self.native_client = native_client
        self.events = event_bus or EventBus()
        self.lifecycle = Lifecycle()
        self.scene = SceneHysteresis(
            settings.scene.enter_threshold,
            settings.scene.exit_threshold,
            settings.scene.enter_samples,
            settings.scene.exit_samples,
        )
        self.barrage = BarragePolicy(
            settings.barrage.max_age_seconds, settings.barrage.max_queue_size
        )
        self.memory = MemoryStore(settings.memory.root)
        self.courses = CourseRepository(settings.courses.sessions_root)
        self.supervisor = WorkerSupervisor(native_client)
        recording = [
            session
            for session in self.courses.sessions()
            if session.state.status == CourseStatus.RECORDING
        ]
        active_course = recording[-1] if recording else None
        self._auto_course_id = active_course.state.id if active_course else None
        self._non_course_streak = 0
        self._non_course_started_at: float | None = None
        self._last_course_transcript = (
            active_course.transcript_path.read_text(encoding="utf-8")[-2000:].strip()
            if active_course
            else ""
        )
        self.display_scene = CourseSceneStabilizer()
        self._recent_barrages: deque[tuple[str, float]] = deque(maxlen=12)
        self._recent_assistant_messages: deque[tuple[str, float]] = deque(maxlen=6)
        self._last_course_interaction = ""
        self._last_course_interaction_at = float("-inf")
        self._last_keyframe_requested_at: dict[str, float] = {}

    async def start(self) -> None:
        await self.lifecycle.transition(LifecycleState.STARTING)
        try:
            await self.supervisor.start(self._on_native_event)
        except Exception as exc:
            await self.lifecycle.transition(LifecycleState.FAILED, str(exc))
            raise
        await self.lifecycle.transition(LifecycleState.READY)
        await self.events.publish(Event("lifecycle.changed", {"state": "ready"}))

    async def stop(self) -> None:
        if self.lifecycle.snapshot.state == LifecycleState.STOPPED:
            return
        await self.lifecycle.transition(LifecycleState.STOPPING)
        await self.supervisor.stop()
        await self.lifecycle.transition(LifecycleState.STOPPED)
        await self.events.publish(Event("lifecycle.changed", {"state": "stopped"}))

    async def command(self, method: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self.native_client.request(method, arguments)
        await self.events.publish(Event("command.completed", {"command": method, "result": result}))
        return result

    async def observe_scene(self, score: float) -> bool:
        change = self.scene.observe(score)
        if change:
            await self.events.publish(
                Event("scene.changed", {"active": change.active, "score": change.score})
            )
        return change is not None

    async def submit_barrage(
        self, item_id: str, text: str, created_at: datetime, priority: int
    ) -> str:
        decision = self.barrage.offer(BarrageItem(item_id, text, created_at, priority))
        await self.events.publish(
            Event("barrage.decision", {"id": item_id, "decision": decision.value})
        )
        return decision.value

    async def memory_status(self) -> dict[str, Any]:
        events = self.memory.events()
        return {
            "event_count": len(events),
            "summary": self.memory.read_summary(),
            "fact_count": len(self.memory.read_facts()),
        }

    async def summarize_memory(self) -> str:
        def summarize(events: Sequence[MemoryEvent], previous: str | None) -> str:
            lines = [event.text.strip() for event in events if event.text.strip()]
            return "\n".join(lines) if lines else (previous or "")

        summary = self.memory.summarize(summarize)
        await self.events.publish(Event("memory.summarized", {"summary": summary}))
        return summary

    async def clear_memory(self) -> None:
        self.memory.clear()
        await self.events.publish(Event("memory.cleared", {}))

    async def start_course(self, title: str, session_id: str | None = None) -> CourseState:
        state = self.courses.create(title, session_id=session_id).state
        self.display_scene.force("course")
        await self.events.publish(Event("course.started", state.as_dict()))
        return state

    async def finish_course(self, session_id: str) -> CourseState:
        session = self.courses.open(session_id)
        if session.state.status == CourseStatus.RECORDING:
            await self._generate_final_course_summary(session)
        output_root = self.settings.courses.output_root or (desktop_path() / "Jarvis-Courses")
        session.finalize(output_root)
        state = session.state
        if session_id == self._auto_course_id:
            self._auto_course_id = None
            self._non_course_streak = 0
            self._non_course_started_at = None
            self._last_course_transcript = ""
        self._last_course_interaction = ""
        self._last_course_interaction_at = float("-inf")
        await self.events.publish(Event("course.finished", state.as_dict()))
        return state

    async def add_course_keyframe(
        self,
        session_id: str,
        image_base64: str,
        timestamp_ms: int,
        extension: str,
        metadata: dict[str, Any],
    ) -> CourseState:
        try:
            frame = base64.b64decode(image_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("keyframe is not valid base64") from exc
        if not frame or len(frame) > 4 * 1024 * 1024:
            raise ValueError("keyframe must be between 1 byte and 4 MiB")
        normalized = extension.casefold()
        signatures = {
            "png": frame.startswith(b"\x89PNG\r\n\x1a\n"),
            "jpg": frame.startswith(b"\xff\xd8\xff"),
            "jpeg": frame.startswith(b"\xff\xd8\xff"),
            "webp": frame.startswith(b"RIFF") and frame[8:12] == b"WEBP",
        }
        if not signatures.get(normalized, False):
            raise ValueError(f"keyframe bytes do not match .{normalized}")
        session = self.courses.open(session_id)
        session.add_keyframe(
            frame,
            timestamp_ms=timestamp_ms,
            extension=normalized,
            metadata=metadata,
        )
        state = session.state
        await self.events.publish(
            Event(
                "course.keyframe.recorded",
                {"id": session_id, "timestamp_ms": timestamp_ms, "count": len(state.keyframes)},
            )
        )
        return state

    async def get_course(self, session_id: str) -> CourseState:
        return self.courses.open(session_id).state

    async def list_courses(self) -> list[CourseState]:
        return [session.state for session in self.courses.sessions()]

    async def _on_native_event(self, payload: dict[str, Any]) -> None:
        topic = str(payload.get("type", "native.event"))
        if topic == "perception.completed":
            await self._handle_perception(payload)
            return
        await self.events.publish(Event(topic, payload))

    @staticmethod
    def _parse_perception(text: str) -> dict[str, Any]:
        start = text.find("{")
        if start < 0:
            raise ValueError("perception response contains no JSON object")
        value, _ = json.JSONDecoder().raw_decode(text[start:])
        if not isinstance(value, dict):
            raise ValueError("perception response is not an object")
        scene = str(value.get("scene", "other")).casefold()
        if scene not in {"game", "course", "other"}:
            scene = "other"
        try:
            confidence = max(0.0, min(1.0, float(value.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        barrage = str(value.get("barrage", "")).strip()
        observation = str(value.get("observation", "")).strip()
        course_transcript = str(value.get("course_transcript", "")).strip()
        course_note = str(value.get("course_note", "")).strip()
        course_interaction = str(value.get("course_interaction", "")).strip()
        assistant_message = str(value.get("assistant_message", "")).strip()
        if scene == "game" and not barrage:
            barrage = assistant_message or course_note
        raw_barrage_candidates = value.get("barrage_candidates", [])
        barrage_candidates: list[str] = []
        candidates = [
            barrage,
            *(raw_barrage_candidates if isinstance(raw_barrage_candidates, list) else []),
        ]
        for candidate in candidates:
            candidate_text = str(candidate).strip()[:30]
            if candidate_text and candidate_text not in barrage_candidates:
                barrage_candidates.append(candidate_text)
        raw_assistant_candidates = value.get("assistant_candidates", [])
        assistant_candidates: list[str] = []
        candidates = [
            *(raw_assistant_candidates if isinstance(raw_assistant_candidates, list) else []),
            assistant_message,
        ]
        for candidate in candidates:
            candidate_text = str(candidate).strip()[:80]
            if candidate_text and candidate_text not in assistant_candidates:
                assistant_candidates.append(candidate_text)
        return {
            "scene": scene,
            "confidence": confidence,
            "observation": observation[:300],
            "barrage": barrage[:30] if scene == "game" else "",
            "barrage_candidates": barrage_candidates[:4] if scene == "game" else [],
            "course_transcript": course_transcript[:2000],
            "course_note": course_note[:2000],
            "course_title": str(value.get("course_title", "")).strip()[:128],
            "course_interaction": course_interaction[:100],
            "capture_keyframe": value.get("capture_keyframe") is True,
            "keyframe_note": str(value.get("keyframe_note", "")).strip()[:300],
            "assistant_candidates": assistant_candidates[:4] if scene == "other" else [],
            "assistant_message": assistant_message[:500],
        }

    async def _handle_perception(self, payload: dict[str, Any]) -> None:
        try:
            result = self._parse_perception(str(payload.get("text", "")))
        except (ValueError, json.JSONDecodeError) as exc:
            await self.events.publish(
                Event(
                    "perception.failed",
                    {"error": str(exc), "request_id": payload.get("request_id")},
                )
            )
            return

        scene = result["scene"]
        now = time.monotonic()
        display_scene = self.display_scene.observe(scene)
        result["observed_scene"] = scene
        result["scene"] = display_scene
        barrage_history_seconds = max(
            self.settings.interaction.game_barrage_repeat_seconds,
            self.settings.interaction.game_barrage_similar_seconds,
        )
        barrage_cutoff = now - barrage_history_seconds
        while self._recent_barrages and self._recent_barrages[0][1] < barrage_cutoff:
            self._recent_barrages.popleft()
        if scene == "game":
            available_candidates: list[tuple[int, float, int, str]] = []
            for index, candidate in enumerate(result["barrage_candidates"]):
                normalized_candidate = _normalize_text(candidate)
                if any(
                    (
                        normalized_candidate == _normalize_text(previous)
                        and now - emitted_at
                        < self.settings.interaction.game_barrage_repeat_seconds
                    )
                    or (
                        _texts_are_similar(candidate, previous)
                        and now - emitted_at
                        < self.settings.interaction.game_barrage_similar_seconds
                    )
                    for previous, emitted_at in self._recent_barrages
                ):
                    continue
                recent_similarity = max(
                    (
                        SequenceMatcher(
                            None, normalized_candidate, _normalize_text(previous)
                        ).ratio()
                        for previous, _ in self._recent_barrages
                    ),
                    default=0.0,
                )
                available_candidates.append(
                    (_barrage_quality_penalty(candidate), recent_similarity, index, candidate)
                )
            result["barrage"] = min(available_candidates, default=(0, 0.0, 0, ""))[-1]

        await self.events.publish(Event("perception.completed", result))
        if scene == "game" and display_scene == "game" and result["barrage"]:
            self._recent_barrages.append((result["barrage"], now))
            await self.events.publish(
                Event(
                    "barrage.generated",
                    {"text": result["barrage"], "confidence": result["confidence"]},
                )
            )

        if scene == "other" and display_scene == "other":
            repeat_window = max(
                60.0, self.settings.interaction.ordinary_bubble_cooldown_seconds * 3
            )
            while (
                self._recent_assistant_messages
                and now - self._recent_assistant_messages[0][1] >= repeat_window
            ):
                self._recent_assistant_messages.popleft()
            cooldown_elapsed = (
                not self._recent_assistant_messages
                or now - self._recent_assistant_messages[-1][1]
                >= self.settings.interaction.ordinary_bubble_cooldown_seconds
            )
            message = next(
                (
                    cleaned
                    for candidate in result["assistant_candidates"]
                    if (cleaned := self._clean_assistant_message(str(candidate)))
                    and all(
                        not _texts_are_similar(cleaned, previous)
                        for previous, _ in self._recent_assistant_messages
                    )
                ),
                "",
            )
            if message and cooldown_elapsed:
                self._recent_assistant_messages.append((message, now))
                await self.events.publish(
                    Event(
                        "assistant.message",
                        {"text": message, "confidence": result["confidence"]},
                    )
                )

        if scene == "course":
            self._non_course_streak = 0
            self._non_course_started_at = None
            await self._record_course_perception(result)
            valid_note = self._clean_course_note(str(result["course_note"]))
            valid_transcript = self._clean_course_transcript(
                str(result["course_transcript"])
            )
            knowledge_source = valid_note or valid_transcript
            raw_interaction = str(result["course_interaction"])
            message = (
                self._clean_course_interaction(raw_interaction)
                if knowledge_source
                else ""
            )
            if not message and knowledge_source and not raw_interaction.strip():
                message = self._course_note_interaction(knowledge_source)
            cooldown_elapsed = (
                now - self._last_course_interaction_at
                >= self.settings.interaction.course_bubble_cooldown_seconds
            )
            if (
                display_scene == "course"
                and message
                and message != self._last_course_interaction
                and cooldown_elapsed
            ):
                self._last_course_interaction = message
                self._last_course_interaction_at = now
                await self.events.publish(
                    Event(
                        "course.interaction",
                        {"text": message, "confidence": result["confidence"]},
                    )
                )
        elif self._auto_course_id:
            if self._non_course_started_at is None:
                self._non_course_started_at = now
            self._non_course_streak += 1
            outside_course_long_enough = (
                now - self._non_course_started_at
                >= self.settings.courses.exit_grace_seconds
            )
            if (
                self._non_course_streak >= self.settings.courses.exit_samples
                and outside_course_long_enough
            ):
                await self._finish_auto_course()

    async def _record_course_perception(self, result: dict[str, Any]) -> None:
        transcript = self._clean_course_transcript(str(result["course_transcript"]))
        note = self._clean_course_note(str(result["course_note"]))
        capture_keyframe = bool(result["capture_keyframe"])
        if not transcript and not note and not capture_keyframe:
            return
        if not self._auto_course_id:
            recording = [
                session
                for session in self.courses.sessions()
                if session.state.status == CourseStatus.RECORDING
            ]
            if recording:
                session = recording[-1]
            else:
                stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
                title = str(result["course_title"]) or f"自动网课记录 {stamp}"
                session = self.courses.create(title, session_id=f"auto-{stamp}")
                await self.events.publish(Event("course.started", session.state.as_dict()))
            self._auto_course_id = session.state.id

        session = self.courses.open(self._auto_course_id)

        transcript_delta = self._transcript_delta(self._last_course_transcript, transcript)
        if transcript_delta:
            state = session.append_transcript(transcript_delta)
            self._last_course_transcript = transcript
            await self.events.publish(
                Event(
                    "course.transcript.recorded",
                    {"id": state.id, "transcript": transcript_delta},
                )
            )

        state = session.state
        if capture_keyframe:
            await self._request_course_keyframe(state, str(result["keyframe_note"]))

    async def _generate_final_course_summary(self, session: Any) -> None:
        transcript = session.transcript_path.read_text(encoding="utf-8").strip()
        session.update_summary("")
        if not transcript:
            return

        try:
            chunks = self._split_transcript(transcript)
            if len(chunks) == 1:
                source = chunks[0]
            else:
                extracted = []
                for chunk in chunks:
                    extracted.append(
                        await self._ask_course_summarizer(
                            "从下面一段授课语音转写中提取最多 6 条明确、可复习的事实或知识结论。"
                            "删除寒暄、口头禅、课程宣传、讲师行为和无依据推测；"
                            "只输出 Markdown 项目符号。\n\n"
                            + chunk
                        )
                    )
                source = "\n".join(filter(None, extracted))

            summary = await self._ask_course_summarizer(
                "根据下面整节课的授课语音内容生成最终课程总结。严格以材料为准，不补充材料中没有的定义、公式、例题或结论。"
                "合并重复内容，删除寒暄、课程宣传、版本闲聊、讲师动作和泛泛的学习鼓励。"
                "只输出简体中文 Markdown，不要代码围栏；信息少时宁可简短，绝不凑字数。"
                "先判断材料是否出现明确的定义、命题、公式、推导、例题、操作步骤或因果解释。"
                "若全部没有，只能输出“### 课程概览”和 2 至 4 句事实，"
                "并明确写出“本段尚未进入具体知识讲解”；"
                "禁止输出其他标题或项目符号。"
                "若存在实质知识，再按实际内容选用“### 课程概览、### 核心内容、### 关键方法与联系、"
                "### 易错点与复习提醒”，空小节省略，核心内容使用可独立复习的完整项目符号。"
                "课程重要性、适用人群、授课安排、授课风格和学习鼓励都不属于实质知识，"
                "不能列为核心内容、方法、联系、易错点或复习提醒。\n\n"
                + source
            )
            headings = re.findall(r"^###\s+(.+)$", summary, flags=re.MULTILINE)
            if headings == ["课程概览"] and "尚未进入具体知识讲解" not in summary:
                summary += "\n\n本段尚未进入具体知识讲解。"
            state = session.update_summary(summary[:6000])
        except (RuntimeError, TimeoutError, ValueError) as exc:
            await self.events.publish(
                Event("course.summary.failed", {"id": session.state.id, "error": str(exc)})
            )
            return

        await self.events.publish(
            Event("course.summary.updated", {"id": state.id, "summary": state.summary})
        )

    async def _ask_course_summarizer(self, instruction: str) -> str:
        response = await self.native_client.request(
            "ask", {"text": "[[JARVIS_TEXT_ONLY]]\n" + instruction}
        )
        text = str(response.get("text", "")).strip()
        text = re.sub(r"^```(?:markdown)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
        if not text:
            raise ValueError("course summary response is empty")
        return text

    @staticmethod
    def _split_transcript(transcript: str, limit: int = 3200) -> list[str]:
        chunks: list[str] = []
        current: list[str] = []
        length = 0
        for line in filter(None, map(str.strip, transcript.splitlines())):
            if current and length + len(line) + 1 > limit:
                chunks.append("\n".join(current))
                current, length = [], 0
            current.append(line)
            length += len(line) + 1
        if current:
            chunks.append("\n".join(current))
        return chunks

    @staticmethod
    def _clean_course_transcript(transcript: str) -> str:
        return re.sub(r"\s+", " ", transcript).strip()[:2000]

    @staticmethod
    def _transcript_delta(previous: str, current: str) -> str:
        if not current or current == previous or current in previous:
            return ""
        max_overlap = min(len(previous), len(current))
        for size in range(max_overlap, 3, -1):
            if previous.endswith(current[:size]):
                return current[size:].lstrip(" ，。！？；：,.!?;:")
        return current

    @staticmethod
    def _clean_course_note(note: str) -> str:
        cleaned = re.sub(r"\s+", " ", note).strip().removeprefix("- ")
        lowered = cleaned.casefold()
        process_markers = (
            "metadata:",
            "electron-desktop",
            "正在查看",
            "当前界面",
            "界面显示",
            "当前屏幕",
            "屏幕显示",
            "文件夹",
            "文件列表",
            "用户可能",
            "视频播放器",
            "老师在黑板",
            "教师在黑板",
            "i can see",
            "the screen shows",
            "currently viewing",
        )
        if any(marker in lowered for marker in process_markers):
            return ""
        return cleaned[:2000]

    @staticmethod
    def _clean_course_interaction(message: str) -> str:
        cleaned = re.sub(r"\s+", " ", message).strip()
        generic_markers = (
            "这课很枯燥",
            "课程很枯燥",
            "内容很枯燥",
            "基础很重要",
            "内容很重要",
            "知识很重要",
            "认真听",
            "坚持一下",
            "继续坚持",
            "加油",
            "慢慢来",
            "别走神",
            "不要走神",
            "打好基础",
            "老师讲得",
        )
        process_comment = re.search(
            r"(?:主讲人|讲师|老师).{0,10}(?:提到|提醒|正在)|"
            r"课程(?:内容|结构|安排|版本)|干货|拓展内容|做好笔记",
            cleaned,
        )
        if (
            len(cleaned) < 8
            or process_comment
            or any(marker in cleaned for marker in generic_markers)
        ):
            return ""
        return cleaned[:100]

    @staticmethod
    def _clean_assistant_message(message: str) -> str:
        cleaned = re.sub(r"\s+", " ", message).strip()
        if len(cleaned) < 6:
            return ""
        narration = re.search(
            r"检测到|根据(?:当前)?(?:画面|屏幕)|(?:画面|屏幕|界面)(?:中|上|显示)|"
            r"(?:你|您|主人|用户)(?:正在|在)(?:观看|查看|浏览|打开|处理|整理)|"
            r"可能涉及|"
            r"用户可能|推测|猜测|(?:教师|老师)(?:通过|正在)|"
            r"(?:桌面|文件夹)(?:上|里)(?:有|的)|桌面(?:图标|背景)|文件夹名称|"
            r"整体环境|无明显(?:游戏|课程)|主要为",
            cleaned,
        )
        generic = re.search(
            r"看起来|看着|似乎|像是|可能在|是不是|"
            r"喝口水|慢慢来|开始搬砖|思路卡住|换个对象|加油|坚持一下",
            cleaned,
        )
        unsupported_offer = re.search(
            r"我|需要|要不要|帮你|帮忙|一起(?:分析|整理|处理|查看|看看)|"
            r"随时(?:叫|找)|交给",
            cleaned,
        )
        if narration or generic or unsupported_offer:
            return ""
        if len(cleaned) > 32:
            first_sentence = re.match(r"^(.{6,32}?[。！？!?])", cleaned)
            return first_sentence.group(1) if first_sentence else ""
        return cleaned

    @classmethod
    def _course_note_interaction(cls, note: str) -> str:
        cleaned = cls._clean_course_note(note)
        if not cleaned:
            return ""
        sentences = [
            sentence.strip(" ，。！？；：,.!?;:")
            for sentence in re.split(r"[。！？；\n]+", cleaned)
            if sentence.strip(" ，。！？；：,.!?;:")
        ]
        candidate = next((sentence for sentence in sentences if len(sentence) >= 10), "")
        return candidate[:80] + ("。" if candidate else "")

    async def _request_course_keyframe(self, state: CourseState, note: str) -> None:
        if len(state.keyframes) >= self.settings.courses.max_keyframes:
            return
        now = time.monotonic()
        previous = self._last_keyframe_requested_at.get(state.id)
        if previous is not None and (
            now - previous < self.settings.courses.keyframe_min_interval_seconds
        ):
            return
        self._last_keyframe_requested_at[state.id] = now
        created_at = datetime.fromisoformat(state.created_at.replace("Z", "+00:00"))
        timestamp_ms = max(0, int((datetime.now(UTC) - created_at).total_seconds() * 1000))
        await self.events.publish(
            Event(
                "course.keyframe.requested",
                {"id": state.id, "timestamp_ms": timestamp_ms, "note": note.strip()[:300]},
            )
        )

    async def _finish_auto_course(self) -> None:
        session_id = self._auto_course_id
        if not session_id:
            return
        await self.finish_course(session_id)

    @property
    def native_connected(self) -> bool:
        return bool(getattr(self.native_client, "running", False))
