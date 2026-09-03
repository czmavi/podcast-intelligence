import json

from fastapi.testclient import TestClient

from app import main


class FakeResult:
    def model_dump(self, **_: object) -> dict[str, object]:
        return {"episodeId": "00000000-0000-4000-8000-000000000001"}


def test_audio_pipeline_streams_progress_before_result(monkeypatch) -> None:
    def fake_pipeline(payload, progress, should_cancel):
        assert not should_cancel()
        progress("transcription", 1, 2, "Přepisuji audio.")
        return FakeResult()

    monkeypatch.setattr(main, "run_audio_pipeline", fake_pipeline)
    response = TestClient(main.app).post(
        "/v1/process-audio-stream",
        json={
            "episodeId": "00000000-0000-4000-8000-000000000001",
            "audioPath": "/data/podcast/audio.wav",
        },
    )
    events = [json.loads(line) for line in response.text.splitlines()]
    assert response.status_code == 200
    assert events[0]["type"] == "progress"
    assert events[0]["current"] == 1
    assert events[1]["type"] == "result"
