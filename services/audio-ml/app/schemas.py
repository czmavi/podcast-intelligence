from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ProcessAudioRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    episode_id: UUID = Field(alias="episodeId")
    checkpoint_id: UUID | None = Field(default=None, alias="checkpointId")
    audio_path: str = Field(alias="audioPath", min_length=1, max_length=4096)
    audio_fingerprint: str | None = Field(
        default=None, alias="audioFingerprint", min_length=16, max_length=128
    )
    language: str | None = Field(default="cs", min_length=2, max_length=16)
    min_speakers: int = Field(default=1, alias="minSpeakers", ge=1, le=20)
    max_speakers: int = Field(default=5, alias="maxSpeakers", ge=1, le=20)
    enable_diarization: bool = Field(default=True, alias="enableDiarization")
    return_speaker_embeddings: bool = Field(
        default=True, alias="returnSpeakerEmbeddings"
    )
    transcript_alignment_mode: Literal["segment", "overlap"] = Field(
        default="segment", alias="transcriptAlignmentMode"
    )

    @model_validator(mode="after")
    def validate_speaker_bounds(self) -> "ProcessAudioRequest":
        if self.min_speakers > self.max_speakers:
            raise ValueError("minSpeakers nesmí být větší než maxSpeakers")
        return self


class ModelInfo(BaseModel):
    name: str
    version: str | None = None


class ModelsInfo(BaseModel):
    transcription: ModelInfo
    diarization: ModelInfo | None
    speaker_embedding: ModelInfo | None = Field(alias="speakerEmbedding")


class RepresentativeSegment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    quality: float = Field(ge=0, le=1)


class SpeakerResult(BaseModel):
    label: str
    speech_seconds: float = Field(alias="speechSeconds", ge=0)
    segment_count: int = Field(alias="segmentCount", ge=0)
    representative_segments: list[RepresentativeSegment] = Field(
        alias="representativeSegments"
    )
    embedding: list[float] | None


class UtteranceResult(BaseModel):
    sequence: int = Field(ge=0)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    playback_start: float = Field(alias="playbackStart", ge=0)
    speaker: str
    text: str
    transcription_confidence: float | None = Field(
        alias="transcriptionConfidence", ge=0, le=1
    )
    speaker_confidence: float | None = Field(
        alias="speakerConfidence", ge=0, le=1
    )
    overlap_detected: bool = Field(alias="overlapDetected")

    @model_validator(mode="after")
    def validate_time_range(self) -> "UtteranceResult":
        if self.end <= self.start:
            raise ValueError("end musí být větší než start")
        return self


class ProcessAudioResponse(BaseModel):
    schema_version: Literal["3"] = Field(default="3", alias="schemaVersion")
    episode_id: UUID = Field(alias="episodeId")
    transcript_alignment_mode: Literal["segment", "overlap"] = Field(
        alias="transcriptAlignmentMode"
    )
    duration_seconds: float = Field(alias="durationSeconds", gt=0)
    detected_language: str = Field(alias="detectedLanguage")
    models: ModelsInfo
    speakers: list[SpeakerResult]
    utterances: list[UtteranceResult]
    warnings: list[str]


class TextEmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_text_lengths(self) -> "TextEmbeddingRequest":
        if any(not text.strip() or len(text) > 20_000 for text in self.texts):
            raise ValueError("Text musí mít 1 až 20 000 znaků")
        return self


class TextEmbeddingResponse(BaseModel):
    model_name: str = Field(alias="modelName")
    dimensions: int
    embeddings: list[list[float]]


class TextRerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    documents: list[str] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def validate_documents(self) -> "TextRerankRequest":
        if any(not text.strip() or len(text) > 20_000 for text in self.documents):
            raise ValueError("Dokument musí mít 1 až 20 000 znaků")
        return self


class TextRerankResponse(BaseModel):
    model_name: str = Field(alias="modelName")
    scores: list[float]


class ApiError(BaseModel):
    code: str
    message: str
    retryable: bool
    details: dict[str, object] = Field(default_factory=dict)
