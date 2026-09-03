from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.config import Settings
from app.errors import MlServiceError
from app.transcription import TranscriptSegment, Transcriber, proportional_word_segments


CHECKPOINT_ID = "200065d7-a95c-45f8-872c-bb16fd455c9f"


def test_segment_text_gets_fast_proportional_word_timestamps() -> None:
    words = proportional_word_segments(
        [TranscriptSegment(2.0, 5.0, "Jedna dvě tři", None)]
    )
    assert [(item.start, item.end, item.text) for item in words] == [
        (2.0, 3.0, "Jedna"),
        (3.0, 4.0, "dvě"),
        (4.0, 5.0, "tři"),
    ]
    assert [(item.source_start, item.source_end) for item in words] == [
        (2.0, 5.0),
        (2.0, 5.0),
        (2.0, 5.0),
    ]


def test_proportional_word_timestamps_skip_invalid_source_range() -> None:
    assert proportional_word_segments(
        [TranscriptSegment(5.0, 5.0, "bez platného času", None)]
    ) == []


class FlakyPipeline:
    def __init__(self, fail_call: int | None = None) -> None:
        self.calls = 0
        self.fail_call = fail_call

    def __call__(self, *_: object, **__: object) -> dict[str, object]:
        self.calls += 1
        if self.calls == self.fail_call:
            raise RuntimeError("temporary")
        return {
            "language": "cs",
            "chunks": [{"timestamp": (0.0, 1.0), "text": f"chunk {self.calls}"}],
        }


def audio_file(path: Path) -> None:
    sf.write(path, np.zeros(1300, dtype=np.float32), 10)


def settings(tmp_path: Path) -> Settings:
    return Settings(
        transcription_checkpoint_root=tmp_path / "checkpoints",
        transcription_chunk_seconds=60,
        transcription_overlap_seconds=0,
        transcription_chunk_max_attempts=3,
        transcription_chunk_retry_base_seconds=0,
    )


def test_transcription_retries_only_failed_chunk_and_resumes_checkpoint(
    tmp_path: Path,
) -> None:
    path = tmp_path / "audio.wav"
    audio_file(path)
    first_pipeline = FlakyPipeline(fail_call=2)
    first = Transcriber(settings(tmp_path))
    first._model = first_pipeline

    segments, language = first.transcribe(
        path,
        "cs",
        checkpoint_id=CHECKPOINT_ID,
        audio_fingerprint="audio-fingerprint-v1",
    )

    assert language == "cs"
    assert len(segments) == 3
    assert first_pipeline.calls == 4

    resumed_pipeline = FlakyPipeline()
    resumed = Transcriber(settings(tmp_path))
    resumed._model = resumed_pipeline
    resumed_segments, _ = resumed.transcribe(
        path,
        "cs",
        checkpoint_id=CHECKPOINT_ID,
        audio_fingerprint="audio-fingerprint-v1",
    )

    assert resumed_segments == segments
    assert resumed_pipeline.calls == 0


def test_transcription_stops_when_client_cancelled(tmp_path: Path) -> None:
    path = tmp_path / "audio.wav"
    audio_file(path)
    transcriber = Transcriber(settings(tmp_path))
    transcriber._model = FlakyPipeline()

    with pytest.raises(MlServiceError, match="zrušeno") as error:
        transcriber.transcribe(path, "cs", should_cancel=lambda: True)

    assert error.value.code == "PROCESSING_CANCELLED"
