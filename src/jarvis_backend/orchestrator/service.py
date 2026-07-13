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
from jarvis_backend.orchestrator.scene import SceneHysteresis
from jarvis_backend.settings import Settings


def _normalize_barrage(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.casefold())


def _barrages_are_similar(left: str, right: str) -> bool:
    left_normalized = _normalize_barrage(left)
    right_normalized = _normalize_barrage(right)
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
        self._auto_course_id: str | None = None
        self._non_course_streak = 0
        self._non_course_started_at: float | None = None
        self._last_course_note = ""
        self._recent_barrages: deque[tuple[str, float]] = deque(maxlen=12)
        self._last_assistant_message = ""
        self._last_assistant_message_at = float("-inf")
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
        if self._auto_course_id:
            await self._finish_auto_course()
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
        await self.events.publish(Event("course.started", state.as_dict()))
        return state

    async def finish_course(self, session_id: str) -> CourseState:
        session = self.courses.open(session_id)
        output_root = self.settings.courses.output_root or (desktop_path() / "Jarvis-Courses")
        session.finalize(output_root)
        state = session.state
        if session_id == self._auto_course_id:
            self._auto_course_id = None
            self._non_course_streak = 0
            self._non_course_started_at = None
            self._last_course_note = ""
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
        return {
            "scene": scene,
            "confidence": confidence,
            "observation": observation[:300],
            "barrage": barrage[:30] if scene == "game" else "",
            "barrage_candidates": barrage_candidates[:4] if scene == "game" else [],
            "course_note": course_note[:2000],
            "course_title": str(value.get("course_title", "")).strip()[:128],
            "course_interaction": course_interaction[:100],
            "capture_keyframe": value.get("capture_keyframe") is True,
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
                normalized_candidate = _normalize_barrage(candidate)
                if any(
                    (
                        normalized_candidate == _normalize_barrage(previous)
                        and now - emitted_at
                        < self.settings.interaction.game_barrage_repeat_seconds
                    )
                    or (
                        _barrages_are_similar(candidate, previous)
                        and now - emitted_at
                        < self.settings.interaction.game_barrage_similar_seconds
                    )
                    for previous, emitted_at in self._recent_barrages
                ):
                    continue
                recent_similarity = max(
                    (
                        SequenceMatcher(
                            None, normalized_candidate, _normalize_barrage(previous)
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
        if scene == "game" and result["barrage"]:
            self._recent_barrages.append((result["barrage"], now))
            await self.events.publish(
                Event(
                    "barrage.generated",
                    {"text": result["barrage"], "confidence": result["confidence"]},
                )
            )

        if scene == "other" and result["assistant_message"]:
            message = str(result["assistant_message"])
            cooldown_elapsed = (
                now - self._last_assistant_message_at
                >= self.settings.interaction.ordinary_bubble_cooldown_seconds
            )
            if message != self._last_assistant_message and cooldown_elapsed:
                self._last_assistant_message = message
                self._last_assistant_message_at = now
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
            message = str(result["course_interaction"])
            cooldown_elapsed = (
                now - self._last_course_interaction_at
                >= self.settings.interaction.course_bubble_cooldown_seconds
            )
            if message and message != self._last_course_interaction and cooldown_elapsed:
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
        note = self._clean_course_note(str(result["course_note"]))
        if not note or note == self._last_course_note:
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

        def summarize(previous: str, current: str) -> str:
            line = current.strip()
            existing = [item.removeprefix("- ").strip() for item in previous.splitlines()]
            points = list(filter(None, existing))
            for index, item in enumerate(points):
                if self._notes_overlap(item, line):
                    if self._course_note_score(line) > self._course_note_score(item):
                        points[index] = line
                    return "\n".join(f"- {point}" for point in points)
            points = [*points, line][-24:]
            return "\n".join(f"- {point}" for point in points)

        state = session.append_transcript(note, summarizer=summarize)
        self._last_course_note = note
        await self.events.publish(
            Event("course.note.recorded", {"id": state.id, "note": note, "summary": state.summary})
        )
        if result["capture_keyframe"] or (
            not state.keyframes and state.id not in self._last_keyframe_requested_at
        ):
            await self._request_course_keyframe(state)

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
    def _notes_overlap(left: str, right: str) -> bool:
        def normalize(value: str) -> str:
            return re.sub(r"[^\w]", "", value.casefold())

        first, second = normalize(left), normalize(right)
        if not first or not second:
            return False
        shorter, longer = sorted((first, second), key=len)
        if len(shorter) >= 8 and shorter in longer:
            return True
        if len(shorter) < 10:
            return False
        first_pairs = {first[index : index + 2] for index in range(len(first) - 1)}
        second_pairs = {second[index : index + 2] for index in range(len(second) - 1)}
        return len(first_pairs & second_pairs) / min(len(first_pairs), len(second_pairs)) >= 0.68

    @staticmethod
    def _course_note_score(note: str) -> int:
        detail_markers = (
            "因为",
            "因此",
            "所以",
            "条件",
            "适用",
            "例如",
            "即",
            "表示",
            "作用",
            "区别",
        )
        return len(note) + 12 * sum(marker in note for marker in detail_markers)

    async def _request_course_keyframe(self, state: CourseState) -> None:
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
                {"id": state.id, "timestamp_ms": timestamp_ms, "note": self._last_course_note},
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
