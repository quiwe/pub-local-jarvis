from datetime import UTC, datetime, timedelta

from jarvis_backend.barrage import BarrageDecision, BarrageItem, BarragePolicy
from jarvis_backend.orchestrator.scene import SceneHysteresis


def test_scene_hysteresis_debounces_entry_and_exit() -> None:
    scene = SceneHysteresis(0.7, 0.4, enter_samples=2, exit_samples=2)
    assert scene.observe(0.8) is None
    assert scene.observe(0.8).active is True
    assert scene.observe(0.5) is None
    assert scene.observe(0.3) is None
    assert scene.observe(0.3).active is False


def test_barrage_rejects_stale_and_duplicate_items() -> None:
    policy = BarragePolicy(max_age_seconds=5, max_queue_size=2)
    now = datetime.now(UTC)
    stale = BarrageItem("old", "old", now - timedelta(seconds=6))
    fresh = BarrageItem("new", "hello", now)
    assert policy.offer(stale, now) == BarrageDecision.DROP_STALE
    assert policy.offer(fresh, now) == BarrageDecision.ACCEPT
    assert policy.offer(fresh, now) == BarrageDecision.DROP_DUPLICATE
