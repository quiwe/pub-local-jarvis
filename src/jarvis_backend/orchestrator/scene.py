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
