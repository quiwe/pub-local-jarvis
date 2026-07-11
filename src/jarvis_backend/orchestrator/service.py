from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from jarvis_backend.barrage import BarrageItem, BarragePolicy
from jarvis_backend.courses import CourseRepository, CourseState, CourseStatus, desktop_path
from jarvis_backend.memory import MemoryEvent, MemoryStore
from jarvis_backend.native import NativeClient, WorkerSupervisor
from jarvis_backend.orchestrator.events import Event, EventBus
from jarvis_backend.orchestrator.lifecycle import Lifecycle, LifecycleState
from jarvis_backend.orchestrator.scene import SceneHysteresis
from jarvis_backend.settings import Settings


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
        self._last_course_note = ""
        self._last_barrage = ""

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
            self._last_course_note = ""
        await self.events.publish(Event("course.finished", state.as_dict()))
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
        return {
            "scene": scene,
            "confidence": confidence,
            "barrage": str(value.get("barrage", "")).strip()[:120],
            "course_note": str(value.get("course_note", "")).strip()[:2000],
            "course_title": str(value.get("course_title", "")).strip()[:128],
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

        await self.events.publish(Event("perception.completed", result))
        scene = result["scene"]
        if scene == "game" and result["barrage"] and result["barrage"] != self._last_barrage:
            self._last_barrage = result["barrage"]
            await self.events.publish(
                Event(
                    "barrage.generated",
                    {"text": result["barrage"], "confidence": result["confidence"]},
                )
            )

        if scene == "course":
            self._non_course_streak = 0
            await self._record_course_perception(result)
        elif self._auto_course_id:
            self._non_course_streak += 1
            if self._non_course_streak >= 3:
                await self._finish_auto_course()

    async def _record_course_perception(self, result: dict[str, Any]) -> None:
        note = str(result["course_note"])
        if not note or note == self._last_course_note:
            return
        if not self._auto_course_id:
            recording = [
                session for session in self.courses.sessions()
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
            combined = f"{previous.rstrip()}\n- {line}" if previous.strip() else f"- {line}"
            return combined[-8000:]

        state = session.append_transcript(note, summarizer=summarize)
        self._last_course_note = note
        await self.events.publish(
            Event("course.note.recorded", {"id": state.id, "note": note, "summary": state.summary})
        )

    async def _finish_auto_course(self) -> None:
        session_id = self._auto_course_id
        if not session_id:
            return
        await self.finish_course(session_id)

    @property
    def native_connected(self) -> bool:
        return bool(getattr(self.native_client, "running", False))
