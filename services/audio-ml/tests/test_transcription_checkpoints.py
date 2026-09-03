from pathlib import Path

from app.transcription_checkpoints import (
    CheckpointSegment,
    ChunkCheckpoint,
    TranscriptionCheckpointStore,
)


CHECKPOINT_ID = "200065d7-a95c-45f8-872c-bb16fd455c9f"


def test_checkpoint_roundtrip_is_scoped_by_audio_and_model(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"audio-v1")
    store = TranscriptionCheckpointStore(tmp_path / "checkpoints")
    signature = store.signature(
        audio,
        audio_fingerprint="audio-sha-256-v1",
        model="whisper-v1",
        language="cs",
        chunk_seconds=300,
        overlap_seconds=5,
        timestamp_mode="word",
    )
    checkpoint = ChunkCheckpoint(
        detected_language="cs",
        segments=[CheckpointSegment(0.0, 1.5, "První věta.", None)],
    )

    store.save(CHECKPOINT_ID, signature, 0, checkpoint)

    assert store.load(CHECKPOINT_ID, signature, 0) == checkpoint
    changed_signature = store.signature(
        audio,
        audio_fingerprint="audio-sha-256-v1",
        model="whisper-v2",
        language="cs",
        chunk_seconds=300,
        overlap_seconds=5,
        timestamp_mode="word",
    )
    assert changed_signature != signature
    assert store.load(CHECKPOINT_ID, changed_signature, 0) is None


def test_corrupted_checkpoint_is_ignored(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"audio")
    store = TranscriptionCheckpointStore(tmp_path / "checkpoints")
    signature = store.signature(
        audio,
        audio_fingerprint=None,
        model="whisper",
        language=None,
        chunk_seconds=300,
        overlap_seconds=5,
        timestamp_mode="word",
    )
    path = store._path(CHECKPOINT_ID, signature, 0)
    path.parent.mkdir(parents=True)
    path.write_text("not-json", encoding="utf-8")

    assert store.load(CHECKPOINT_ID, signature, 0) is None
