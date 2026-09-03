from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from threading import BoundedSemaphore, Lock


@dataclass(frozen=True)
class LimiterSnapshot:
    capacity: int
    active: int
    waiting: int


class InferenceCancelled(Exception):
    pass


class InferenceLimiter:
    """Thread-safe limiter with state exposed for operational diagnostics."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._semaphore = BoundedSemaphore(capacity)
        self._state_lock = Lock()
        self._active = 0
        self._waiting = 0

    @contextmanager
    def slot(self, should_cancel: Callable[[], bool] | None = None) -> Iterator[None]:
        with self._state_lock:
            self._waiting += 1
        while not self._semaphore.acquire(timeout=0.5):
            if should_cancel and should_cancel():
                with self._state_lock:
                    self._waiting -= 1
                raise InferenceCancelled
        with self._state_lock:
            self._waiting -= 1
            self._active += 1
        try:
            yield
        finally:
            with self._state_lock:
                self._active -= 1
            self._semaphore.release()

    def snapshot(self) -> LimiterSnapshot:
        with self._state_lock:
            return LimiterSnapshot(
                capacity=self._capacity,
                active=self._active,
                waiting=self._waiting,
            )


class AudioInferenceScheduler:
    def __init__(self, pipeline_capacity: int) -> None:
        self.pipeline = InferenceLimiter(pipeline_capacity)
        # Pyannote pipelines share mutable model objects. Keep these stages serial
        # while allowing two Whisper transcriptions or different stages to overlap.
        self.diarization = InferenceLimiter(1)
        self.speaker_embedding = InferenceLimiter(1)
