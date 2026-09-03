from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4


@dataclass(frozen=True)
class CheckpointSegment:
    start: float
    end: float
    text: str
    confidence: float | None


@dataclass(frozen=True)
class ChunkCheckpoint:
    detected_language: str
    segments: list[CheckpointSegment]


class TranscriptionCheckpointStore:
    """Persistent, atomic checkpoints scoped to one stable job ID."""

    def __init__(self, root: Path) -> None:
        self.root = root

    @staticmethod
    def signature(
        path: Path,
        *,
        audio_fingerprint: str | None,
        model: str,
        language: str | None,
        chunk_seconds: int,
        overlap_seconds: int,
        timestamp_mode: str,
    ) -> str:
        stat = path.stat()
        payload = {
            "schemaVersion": 2,
            "audioFingerprint": audio_fingerprint,
            "audioSize": stat.st_size,
            "audioModifiedNs": stat.st_mtime_ns,
            "model": model,
            "language": language,
            "chunkSeconds": chunk_seconds,
            "overlapSeconds": overlap_seconds,
            "timestampMode": timestamp_mode,
        }
        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
        return sha256(encoded).hexdigest()

    def _directory(self, checkpoint_id: str, signature: str) -> Path:
        safe_id = str(UUID(checkpoint_id))
        if len(signature) != 64 or any(char not in "0123456789abcdef" for char in signature):
            raise ValueError("Neplatný podpis checkpointu.")
        return self.root / safe_id / signature

    def _path(self, checkpoint_id: str, signature: str, index: int) -> Path:
        if index < 0:
            raise ValueError("Index chunku nesmí být záporný.")
        return self._directory(checkpoint_id, signature) / f"chunk-{index:06d}.json"

    def load(self, checkpoint_id: str, signature: str, index: int) -> ChunkCheckpoint | None:
        path = self._path(checkpoint_id, signature, index)
        try:
            raw: Any = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return None
        if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
            return None
        if raw.get("signature") != signature or raw.get("index") != index:
            return None
        language = raw.get("detectedLanguage")
        values = raw.get("segments")
        if not isinstance(language, str) or not isinstance(values, list):
            return None
        segments: list[CheckpointSegment] = []
        for value in values:
            if not isinstance(value, dict):
                return None
            start = value.get("start")
            end = value.get("end")
            text = value.get("text")
            confidence = value.get("confidence")
            if (
                not isinstance(start, (int, float))
                or not isinstance(end, (int, float))
                or not isinstance(text, str)
                or not text
                or end <= start
                or (confidence is not None and not isinstance(confidence, (int, float)))
            ):
                return None
            segments.append(
                CheckpointSegment(
                    start=float(start),
                    end=float(end),
                    text=text,
                    confidence=None if confidence is None else float(confidence),
                )
            )
        return ChunkCheckpoint(detected_language=language, segments=segments)

    def save(
        self,
        checkpoint_id: str,
        signature: str,
        index: int,
        checkpoint: ChunkCheckpoint,
    ) -> None:
        path = self._path(checkpoint_id, signature, index)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        payload = {
            "schemaVersion": 1,
            "signature": signature,
            "index": index,
            "detectedLanguage": checkpoint.detected_language,
            "segments": [
                {
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                    "confidence": segment.confidence,
                }
                for segment in checkpoint.segments
            ],
        }
        try:
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
