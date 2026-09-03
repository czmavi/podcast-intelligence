from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from .audio_utils import load_audio_tensor
from .config import Settings
from .diarization import SpeakerTurn, TimeInterval, overlapping_speech_intervals
from .errors import MlServiceError


@dataclass(frozen=True)
class SelectedSegment:
    start: float
    end: float
    quality: float


def select_quality_segments(
    turns: list[SpeakerTurn],
    speaker: str,
    min_seconds: float,
    limit: int,
    overlap_intervals: list[TimeInterval] | None = None,
) -> list[SelectedSegment]:
    candidates: list[SelectedSegment] = []
    excluded = (
        overlap_intervals
        if overlap_intervals is not None
        else overlapping_speech_intervals(turns)
    )
    for turn in turns:
        if turn.speaker != speaker:
            continue
        clean_parts = [(turn.start, turn.end)]
        for overlap in excluded:
            next_parts: list[tuple[float, float]] = []
            for start, end in clean_parts:
                if overlap.end <= start or overlap.start >= end:
                    next_parts.append((start, end))
                    continue
                if overlap.start > start:
                    next_parts.append((start, min(end, overlap.start)))
                if overlap.end < end:
                    next_parts.append((max(start, overlap.end), end))
            clean_parts = next_parts
        for start, end in clean_parts:
            duration = end - start
            if duration < min_seconds:
                continue
            quality = min(1.0, duration / 10.0)
            candidates.append(SelectedSegment(start, end, quality))
    return sorted(candidates, key=lambda item: (-item.quality, item.start))[:limit]


class SpeakerEmbedder:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._inference = None
        self._lock = Lock()

    def load(self):
        if not self.settings.hf_token:
            raise MlServiceError(
                "HF_TOKEN_REQUIRED",
                "Speaker embedding model vyžaduje HF_TOKEN.",
                status_code=503,
            )
        if self._inference is not None:
            return self._inference
        with self._lock:
            if self._inference is None:
                try:
                    import torch
                    from pyannote.audio import Inference, Model

                    model = Model.from_pretrained(
                        self.settings.speaker_embedding_model,
                        token=self.settings.hf_token,
                    )
                    if torch.cuda.is_available():
                        model.to(torch.device("cuda"))
                    self._inference = Inference(model, window="whole")
                except Exception as exc:
                    raise MlServiceError(
                        "MODEL_NOT_AVAILABLE",
                        "Speaker embedding model nelze načíst: "
                        f"{type(exc).__name__}: {str(exc)[:300]}",
                        status_code=503,
                    ) from exc
        return self._inference

    def embed(
        self, path: Path, segments: list[SelectedSegment]
    ) -> list[float] | None:
        if not segments:
            return None
        import numpy as np
        import torch

        waveform, sample_rate = load_audio_tensor(path)
        inference = self.load()
        vectors: list[np.ndarray] = []
        for segment in segments:
            start = int(segment.start * sample_rate)
            end = int(segment.end * sample_rate)
            crop = waveform[:, start:end]
            if crop.numel() == 0:
                continue
            with torch.inference_mode():
                vector = inference({"waveform": crop, "sample_rate": sample_rate})
            vectors.append(np.asarray(vector, dtype=np.float32).reshape(-1))
        if not vectors:
            return None
        centroid = np.median(np.stack(vectors), axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid /= norm
        return centroid.astype(float).tolist()
