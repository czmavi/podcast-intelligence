from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from collections.abc import Callable
from math import ceil
import re
import time
from typing import Any

import soundfile as sf

from .config import Settings
from .errors import MlServiceError
from .transcription_checkpoints import (
    CheckpointSegment,
    ChunkCheckpoint,
    TranscriptionCheckpointStore,
)


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str
    confidence: float | None
    source_start: float | None = None
    source_end: float | None = None


def proportional_word_segments(
    segments: list[TranscriptSegment],
) -> list[TranscriptSegment]:
    words: list[TranscriptSegment] = []
    for segment in segments:
        if segment.end <= segment.start:
            continue
        parts = re.findall(r"\S+", segment.text)
        if not parts:
            continue
        step = (segment.end - segment.start) / len(parts)
        for index, text in enumerate(parts):
            words.append(
                TranscriptSegment(
                    start=segment.start + index * step,
                    end=(
                        segment.end
                        if index == len(parts) - 1
                        else segment.start + (index + 1) * step
                    ),
                    text=text,
                    confidence=segment.confidence,
                    source_start=(
                        segment.source_start
                        if segment.source_start is not None
                        else segment.start
                    ),
                    source_end=(
                        segment.source_end
                        if segment.source_end is not None
                        else segment.end
                    ),
                )
            )
    return words


class Transcriber:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = None
        self._lock = Lock()
        self._checkpoints = TranscriptionCheckpointStore(
            settings.transcription_checkpoint_root
        )

    @property
    def device(self) -> str:
        if self.settings.model_device != "auto":
            return self.settings.model_device
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"

    def load(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is None:
                try:
                    import torch
                    from transformers import (
                        AutoModelForSpeechSeq2Seq,
                        AutoProcessor,
                        pipeline,
                    )

                    dtype = torch.float16 if self.device == "cuda" else torch.float32
                    model = AutoModelForSpeechSeq2Seq.from_pretrained(
                        self.settings.whisper_model,
                        torch_dtype=dtype,
                        use_safetensors=True,
                    )
                    model.to(self.device)
                    processor = AutoProcessor.from_pretrained(
                        self.settings.whisper_model
                    )
                    self._model = pipeline(
                        "automatic-speech-recognition",
                        model=model,
                        tokenizer=processor.tokenizer,
                        feature_extractor=processor.feature_extractor,
                        torch_dtype=dtype,
                        device=0 if self.device == "cuda" else -1,
                    )
                except Exception as exc:
                    raise MlServiceError(
                        "MODEL_NOT_AVAILABLE",
                        "Whisper model nelze načíst: "
                        f"{type(exc).__name__}: {str(exc)[:300]}",
                        retryable=False,
                        status_code=503,
                    ) from exc
        return self._model

    @staticmethod
    def _segments(output: dict[str, Any], duration: float) -> list[TranscriptSegment]:
        segments: list[TranscriptSegment] = []
        chunks = output.get("chunks")
        if isinstance(chunks, list):
            for chunk in chunks:
                if not isinstance(chunk, dict):
                    continue
                timestamp = chunk.get("timestamp")
                text = chunk.get("text")
                if (
                    not isinstance(timestamp, (list, tuple))
                    or len(timestamp) != 2
                    or not isinstance(text, str)
                ):
                    continue
                start, end = timestamp
                if not isinstance(start, (int, float)):
                    continue
                if end is None:
                    end = duration
                if not isinstance(end, (int, float)) or end <= start:
                    continue
                normalized_start = max(0.0, float(start))
                normalized_end = min(duration, float(end))
                if normalized_end <= normalized_start:
                    continue
                normalized_text = text.strip()
                if normalized_text:
                    segments.append(
                        TranscriptSegment(
                            start=normalized_start,
                            end=normalized_end,
                            text=normalized_text,
                            confidence=None,
                        )
                    )
        if segments:
            return segments
        text = output.get("text")
        if isinstance(text, str) and text.strip():
            return [
                TranscriptSegment(
                    start=0.0,
                    end=duration,
                    text=text.strip(),
                    confidence=None,
                )
            ]
        return []

    @staticmethod
    def _ensure_active(should_cancel: Callable[[], bool] | None) -> None:
        if should_cancel and should_cancel():
            raise MlServiceError(
                "PROCESSING_CANCELLED",
                "Audio zpracování bylo zrušeno po odpojení klienta.",
                retryable=True,
                status_code=499,
            )

    @staticmethod
    def _clear_cuda_cache() -> None:
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            return

    def _wait_before_retry(
        self,
        attempt: int,
        should_cancel: Callable[[], bool] | None,
    ) -> None:
        delay = self.settings.transcription_chunk_retry_base_seconds * (2 ** (attempt - 1))
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            self._ensure_active(should_cancel)
            time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))

    def _transcribe_chunk(
        self,
        transcriber: Any,
        audio: Any,
        sample_rate: int,
        generate_kwargs: dict[str, object],
        index: int,
        should_cancel: Callable[[], bool] | None,
    ) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(1, self.settings.transcription_chunk_max_attempts + 1):
            self._ensure_active(should_cancel)
            try:
                output = transcriber(
                    {"array": audio, "sampling_rate": sample_rate},
                    return_timestamps=self.settings.transcription_timestamp_mode
                    if self.settings.transcription_timestamp_mode == "word"
                    else True,
                    generate_kwargs=generate_kwargs,
                )
                if not isinstance(output, dict):
                    raise TypeError("Transformers pipeline nevrátila objekt.")
                return output
            except MlServiceError:
                raise
            except Exception as exc:
                last_error = exc
                if attempt >= self.settings.transcription_chunk_max_attempts:
                    break
                self._clear_cuda_cache()
                self._wait_before_retry(attempt, should_cancel)
        assert last_error is not None
        is_oom = type(last_error).__name__ == "OutOfMemoryError"
        raise MlServiceError(
            "GPU_OUT_OF_MEMORY" if is_oom else "TRANSCRIPTION_CHUNK_FAILED",
            (
                "GPU nemá dostatek paměti."
                if is_oom
                else f"Přepis audio chunku {index + 1} selhal: {type(last_error).__name__}"
            ),
            retryable=True,
            status_code=503,
            details={
                "chunkIndex": index,
                "attempts": self.settings.transcription_chunk_max_attempts,
            },
        ) from last_error

    def transcribe(
        self,
        path: Path,
        language: str | None,
        progress: Callable[[int, int], None] | None = None,
        *,
        checkpoint_id: str | None = None,
        audio_fingerprint: str | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> tuple[list[TranscriptSegment], str]:
        transcriber = self.load()
        try:
            self._ensure_active(should_cancel)
            audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            duration = len(audio) / sample_rate
            generate_kwargs: dict[str, object] = {
                "task": "transcribe",
                "num_beams": 5,
                "condition_on_prev_tokens": True,
            }
            if language:
                generate_kwargs["language"] = language
            chunk_seconds = self.settings.transcription_chunk_seconds
            overlap_seconds = self.settings.transcription_overlap_seconds
            total = max(1, ceil(duration / chunk_seconds))
            checkpoint_signature = (
                self._checkpoints.signature(
                    path,
                    audio_fingerprint=audio_fingerprint,
                    model=self.settings.whisper_model,
                    language=language,
                    chunk_seconds=chunk_seconds,
                    overlap_seconds=overlap_seconds,
                    timestamp_mode=self.settings.transcription_timestamp_mode,
                )
                if checkpoint_id
                else None
            )
            if progress:
                progress(0, total)
            segments: list[TranscriptSegment] = []
            detected_language = language or "unknown"
            for index in range(total):
                self._ensure_active(should_cancel)
                core_start = index * chunk_seconds
                core_end = min(duration, (index + 1) * chunk_seconds)
                context_start = max(0.0, core_start - overlap_seconds)
                context_end = min(duration, core_end + overlap_seconds)
                start_sample = int(context_start * sample_rate)
                end_sample = int(context_end * sample_rate)
                checkpoint = (
                    self._checkpoints.load(checkpoint_id, checkpoint_signature, index)
                    if checkpoint_id and checkpoint_signature
                    else None
                )
                if checkpoint is None:
                    output = self._transcribe_chunk(
                        transcriber,
                        audio[start_sample:end_sample],
                        sample_rate,
                        generate_kwargs,
                        index,
                        should_cancel,
                    )
                    output_language = output.get("language")
                    if isinstance(output_language, str):
                        detected_language = output_language
                    local_duration = context_end - context_start
                    chunk_segments: list[TranscriptSegment] = []
                    for segment in self._segments(output, local_duration):
                        shifted = TranscriptSegment(
                            start=segment.start + context_start,
                            end=segment.end + context_start,
                            text=segment.text,
                            confidence=segment.confidence,
                            source_start=segment.start + context_start,
                            source_end=segment.end + context_start,
                        )
                        midpoint = (shifted.start + shifted.end) / 2
                        if midpoint < core_start or (
                            index < total - 1 and midpoint >= core_end
                        ):
                            continue
                        chunk_segments.append(shifted)
                    checkpoint = ChunkCheckpoint(
                        detected_language=detected_language,
                        segments=[
                            CheckpointSegment(
                                start=segment.start,
                                end=segment.end,
                                text=segment.text,
                                confidence=segment.confidence,
                            )
                            for segment in chunk_segments
                        ],
                    )
                    if checkpoint_id and checkpoint_signature:
                        self._checkpoints.save(
                            checkpoint_id, checkpoint_signature, index, checkpoint
                        )
                detected_language = checkpoint.detected_language
                segments.extend(
                    TranscriptSegment(
                        start=segment.start,
                        end=segment.end,
                        text=segment.text,
                        confidence=segment.confidence,
                        source_start=segment.start,
                        source_end=segment.end,
                    )
                    for segment in checkpoint.segments
                )
                if progress:
                    progress(index + 1, total)
            return segments, detected_language
        except MlServiceError:
            raise
        except Exception as exc:
            if type(exc).__name__ == "OutOfMemoryError":
                raise MlServiceError(
                    "GPU_OUT_OF_MEMORY",
                    "GPU nemá dostatek paměti.",
                    retryable=True,
                    status_code=503,
                ) from exc
            raise MlServiceError(
                "TRANSCRIPTION_FAILED",
                f"Přepis selhal: {type(exc).__name__}",
                retryable=False,
                status_code=422,
            ) from exc
