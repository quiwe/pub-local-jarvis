from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SceneChange:
    active: bool
    score: float


class SceneHysteresis:
    """Debounces noisy scene scores with asymmetric thresholds and sample counts."""

    def __init__(
        self,
        enter_threshold: float,
        exit_threshold: float,
        enter_samples: int,
        exit_samples: int,
    ) -> None:
        if exit_threshold >= enter_threshold:
            raise ValueError("exit threshold must be below enter threshold")
        self.enter_threshold = enter_threshold
        self.exit_threshold = exit_threshold
        self.enter_samples = enter_samples
        self.exit_samples = exit_samples
        self.active = False
        self._streak = 0

    def observe(self, score: float) -> SceneChange | None:
        qualifies = score <= self.exit_threshold if self.active else score >= self.enter_threshold
        self._streak = self._streak + 1 if qualifies else 0
        needed = self.exit_samples if self.active else self.enter_samples
        if self._streak < needed:
            return None
        self._streak = 0
        self.active = not self.active
        return SceneChange(active=self.active, score=score)


class CourseSceneStabilizer:
    """Keeps brief non-course classifications from interrupting an active course."""

    def __init__(self, enter_samples: int = 1, exit_samples: int = 3) -> None:
        if enter_samples < 1 or exit_samples < 1:
            raise ValueError("sample counts must be positive")
        self.enter_samples = enter_samples
        self.exit_samples = exit_samples
        self.current = "other"
        self._candidate: str | None = None
        self._streak = 0

    def force(self, scene: str) -> None:
        self.current = scene
        self._candidate = None
        self._streak = 0

    def observe(self, scene: str) -> str:
        if self.current == "course":
            if scene == "course":
                self.force(scene)
            else:
                self._streak += 1
                self._candidate = scene
                if self._streak >= self.exit_samples:
                    self.force(scene)
        elif scene == "course":
            self._streak = self._streak + 1 if self._candidate == scene else 1
            self._candidate = scene
            if self._streak >= self.enter_samples:
                self.force(scene)
        else:
            self.force(scene)
        return self.current
