from threading import Event, Thread

from app.inference_scheduler import InferenceCancelled, InferenceLimiter


def test_limiter_allows_only_configured_number_of_active_slots() -> None:
    limiter = InferenceLimiter(2)
    release = Event()
    first_two_active = Event()

    def work() -> None:
        with limiter.slot():
            if limiter.snapshot().active == 2:
                first_two_active.set()
            release.wait(timeout=2)

    threads = [Thread(target=work) for _ in range(3)]
    for thread in threads:
        thread.start()

    assert first_two_active.wait(timeout=1)
    snapshot = limiter.snapshot()
    assert snapshot.capacity == 2
    assert snapshot.active == 2
    assert snapshot.waiting == 1

    release.set()
    for thread in threads:
        thread.join(timeout=2)
        assert not thread.is_alive()

    final = limiter.snapshot()
    assert final.active == 0
    assert final.waiting == 0


def test_waiting_slot_can_be_cancelled() -> None:
    limiter = InferenceLimiter(1)
    cancel = Event()
    cancelled = Event()

    def wait_for_slot() -> None:
        try:
            with limiter.slot(cancel.is_set):
                raise AssertionError("Zrušené čekání nesmí získat slot.")
        except InferenceCancelled:
            cancelled.set()

    with limiter.slot():
        thread = Thread(target=wait_for_slot)
        thread.start()
        cancel.set()
        assert cancelled.wait(timeout=2)
        thread.join(timeout=2)

    assert limiter.snapshot().waiting == 0
