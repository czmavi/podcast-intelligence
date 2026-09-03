from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from .audio_utils import load_audio_tensor
from .config import Settings
from .errors import MlServiceError
from .transcription import TranscriptSegment


@dataclass(frozen=True)
class SpeakerTurn:
    start: float
    end: float
    speaker: str


@dataclass(frozen=True)
class TimeInterval:
    start: float
    end: float


@dataclass(frozen=True)
class DiarizationResult:
    regular_turns: list[SpeakerTurn]
    exclusive_turns: list[SpeakerTurn]


@dataclass(frozen=True)
class AssignedTranscriptSegment:
    segment: TranscriptSegment
    speaker: str
    confidence: float
    overlap_detected: bool


class Diarizer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._pipeline = None
        self._lock = Lock()

    def load(self):
        if not self.settings.hf_token:
            raise MlServiceError(
                "HF_TOKEN_REQUIRED",
                "Diarizace vyžaduje HF_TOKEN a přístup k pyannote modelu.",
                status_code=503,
            )
        if self._pipeline is not None:
            return self._pipeline
        with self._lock:
            if self._pipeline is None:
                try:
                    import torch
                    from pyannote.audio import Pipeline

                    self._pipeline = Pipeline.from_pretrained(
                        self.settings.diarization_model,
                        token=self.settings.hf_token,
                    )
                    if torch.cuda.is_available():
                        self._pipeline.to(torch.device("cuda"))
                except Exception as exc:
                    raise MlServiceError(
                        "MODEL_NOT_AVAILABLE",
                        "Diarizační model nelze načíst: "
                        f"{type(exc).__name__}: {str(exc)[:300]}",
                        status_code=503,
                    ) from exc
        return self._pipeline

    def diarize(
        self, path: Path, min_speakers: int, max_speakers: int
    ) -> DiarizationResult:
        try:
            waveform, sample_rate = load_audio_tensor(path)
            output = self.load()(
                {"waveform": waveform, "sample_rate": sample_rate},
                min_speakers=min_speakers,
                max_speakers=max_speakers,
            )
            regular_annotation = getattr(output, "speaker_diarization", output)
            exclusive_annotation = getattr(
                output, "exclusive_speaker_diarization", regular_annotation
            )
            regular_turns = [
                SpeakerTurn(float(turn.start), float(turn.end), str(label))
                for turn, _, label in regular_annotation.itertracks(yield_label=True)
            ]
            exclusive_turns = [
                SpeakerTurn(float(turn.start), float(turn.end), str(label))
                for turn, _, label in exclusive_annotation.itertracks(yield_label=True)
            ]
            return DiarizationResult(
                regular_turns=regular_turns,
                exclusive_turns=exclusive_turns,
            )
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
                "DIARIZATION_FAILED",
                f"Diarizace selhala: {type(exc).__name__}",
                status_code=422,
            ) from exc


def overlapping_speech_intervals(turns: list[SpeakerTurn]) -> list[TimeInterval]:
    events: dict[float, list[tuple[str, int]]] = {}
    for turn in turns:
        if turn.end <= turn.start:
            continue
        events.setdefault(turn.start, []).append((turn.speaker, 1))
        events.setdefault(turn.end, []).append((turn.speaker, -1))
    active: dict[str, int] = {}
    intervals: list[TimeInterval] = []
    previous_time: float | None = None
    for current_time in sorted(events):
        if previous_time is not None and current_time > previous_time and len(active) >= 2:
            if intervals and abs(intervals[-1].end - previous_time) < 1e-6:
                intervals[-1] = TimeInterval(intervals[-1].start, current_time)
            else:
                intervals.append(TimeInterval(previous_time, current_time))
        for speaker, delta in events[current_time]:
            count = active.get(speaker, 0) + delta
            if count > 0:
                active[speaker] = count
            else:
                active.pop(speaker, None)
        previous_time = current_time
    return intervals


def interval_overlap_duration(
    start: float, end: float, intervals: list[TimeInterval]
) -> float:
    return sum(
        max(0.0, min(end, interval.end) - max(start, interval.start))
        for interval in intervals
    )


def _merge_adjacent_turns(
    turns: list[SpeakerTurn], max_gap_seconds: float
) -> list[SpeakerTurn]:
    merged: list[SpeakerTurn] = []
    for turn in sorted(
        (turn for turn in turns if turn.end > turn.start),
        key=lambda item: (item.start, item.end),
    ):
        if (
            merged
            and merged[-1].speaker == turn.speaker
            and turn.start - merged[-1].end <= max_gap_seconds
        ):
            previous = merged[-1]
            merged[-1] = SpeakerTurn(
                previous.start,
                max(previous.end, turn.end),
                previous.speaker,
            )
        else:
            merged.append(turn)
    return merged


def smooth_speaker_turns(
    turns: list[SpeakerTurn],
    *,
    bridge_max_seconds: float = 1.2,
    orphan_max_seconds: float = 0.65,
    max_gap_seconds: float = 0.2,
) -> list[SpeakerTurn]:
    """Debounce short exclusive-diarization speaker islands before text alignment."""
    smoothed = _merge_adjacent_turns(turns, max_gap_seconds)
    for _ in range(len(smoothed)):
        replacements: list[str] = []
        changed = False
        for index, turn in enumerate(smoothed):
            previous = smoothed[index - 1] if index > 0 else None
            following = smoothed[index + 1] if index + 1 < len(smoothed) else None
            previous_is_adjacent = (
                previous is not None
                and turn.start - previous.end <= max_gap_seconds
            )
            following_is_adjacent = (
                following is not None
                and following.start - turn.end <= max_gap_seconds
            )
            duration = turn.end - turn.start
            replacement = turn.speaker
            if (
                duration <= bridge_max_seconds
                and previous_is_adjacent
                and following_is_adjacent
                and previous is not None
                and following is not None
                and previous.speaker == following.speaker
            ):
                replacement = previous.speaker
            elif duration <= orphan_max_seconds:
                neighbors = [
                    neighbor
                    for neighbor, adjacent in (
                        (previous, previous_is_adjacent),
                        (following, following_is_adjacent),
                    )
                    if neighbor is not None and adjacent
                ]
                if neighbors:
                    replacement = max(
                        neighbors,
                        key=lambda neighbor: neighbor.end - neighbor.start,
                    ).speaker
            replacements.append(replacement)
            changed = changed or replacement != turn.speaker
        if not changed:
            break
        smoothed = _merge_adjacent_turns(
            [
                SpeakerTurn(turn.start, turn.end, replacement)
                for turn, replacement in zip(smoothed, replacements, strict=True)
            ],
            max_gap_seconds,
        )
    return smoothed


def assign_speakers(
    transcript: list[TranscriptSegment],
    turns: list[SpeakerTurn],
    overlap_intervals: list[TimeInterval] | None = None,
) -> list[AssignedTranscriptSegment]:
    assigned: list[AssignedTranscriptSegment] = []
    detected_overlaps = overlap_intervals or []
    for segment in transcript:
        overlaps: dict[str, float] = {}
        for turn in turns:
            overlap = max(0.0, min(segment.end, turn.end) - max(segment.start, turn.start))
            if overlap:
                overlaps[turn.speaker] = overlaps.get(turn.speaker, 0.0) + overlap
        if overlaps:
            speaker, overlap = max(overlaps.items(), key=lambda item: item[1])
            confidence = min(1.0, overlap / max(0.001, segment.end - segment.start))
        elif turns:
            nearest = min(
                turns,
                key=lambda turn: (
                    max(turn.start - segment.end, segment.start - turn.end, 0.0),
                    -(turn.end - turn.start),
                ),
            )
            speaker, confidence = nearest.speaker, 0.0
        else:
            speaker, confidence = "SPEAKER_00", 0.0
        overlap_duration = interval_overlap_duration(
            segment.start, segment.end, detected_overlaps
        )
        assigned.append(
            AssignedTranscriptSegment(
                segment=segment,
                speaker=speaker,
                confidence=confidence,
                overlap_detected=overlap_duration >= 0.05,
            )
        )
    return assigned


def _join_text(parts: list[str]) -> str:
    result = ""
    punctuation = (".", ",", ";", ":", "!", "?", ")", "]", "}")
    for part in parts:
        if not result:
            result = part.strip()
        elif part[:1].isspace() or part.lstrip().startswith(punctuation):
            result += part
        else:
            result += " " + part
    return result.strip()


def group_assigned_segments(
    assigned: list[AssignedTranscriptSegment],
    *,
    max_gap_seconds: float = 1.2,
    max_duration_seconds: float = 30.0,
    min_sentence_seconds: float = 2.0,
) -> list[AssignedTranscriptSegment]:
    grouped: list[AssignedTranscriptSegment] = []
    current: list[AssignedTranscriptSegment] = []
    ordered = sorted(
        (
            item
            for item in assigned
            if item.segment.end > item.segment.start and item.segment.text.strip()
        ),
        key=lambda item: (item.segment.start, item.segment.end),
    )

    def flush() -> None:
        if not current:
            return
        duration = sum(
            max(0.001, item.segment.end - item.segment.start) for item in current
        )
        confidence = sum(
            item.confidence * max(0.001, item.segment.end - item.segment.start)
            for item in current
        ) / duration
        start = min(item.segment.start for item in current)
        end = max(item.segment.end for item in current)
        source_start = min(
            item.segment.source_start
            if item.segment.source_start is not None
            else item.segment.start
            for item in current
        )
        source_end = max(
            item.segment.source_end
            if item.segment.source_end is not None
            else item.segment.end
            for item in current
        )
        grouped.append(
            AssignedTranscriptSegment(
                segment=TranscriptSegment(
                    start=start,
                    end=end,
                    text=_join_text([item.segment.text for item in current]),
                    confidence=None,
                    source_start=source_start,
                    source_end=source_end,
                ),
                speaker=current[0].speaker,
                confidence=min(1.0, confidence),
                overlap_detected=any(item.overlap_detected for item in current),
            )
        )
        current.clear()

    for item in ordered:
        if current:
            previous = current[-1]
            current_duration = previous.segment.end - current[0].segment.start
            sentence_ended = previous.segment.text.rstrip().endswith((".", "!", "?"))
            if (
                item.speaker != previous.speaker
                or item.segment.start - previous.segment.end > max_gap_seconds
                or current_duration >= max_duration_seconds
                or (sentence_ended and current_duration >= min_sentence_seconds)
            ):
                flush()
        current.append(item)
    flush()
    return grouped
