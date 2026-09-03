from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", env_ignore_empty=True
    )

    audio_ml_shared_root: Path = Path("/data")
    audio_ml_api_token: str | None = Field(default=None, min_length=32)
    hf_token: str | None = None
    whisper_model: str = "openai/whisper-large-v3"
    warm_transcription_model: bool = False
    warm_diarization_model: bool = False
    warm_speaker_embedding_model: bool = False
    warm_text_embedding_model: bool = False
    warm_text_reranker_model: bool = False
    diarization_model: str = "pyannote/speaker-diarization-community-1"
    speaker_embedding_model: str = "pyannote/wespeaker-voxceleb-resnet34-LM"
    text_embedding_model: str = "BAAI/bge-m3"
    text_reranker_model: str = "BAAI/bge-reranker-v2-m3"
    transcription_chunk_seconds: int = Field(default=300, ge=60, le=1800)
    transcription_overlap_seconds: int = Field(default=5, ge=0, le=30)
    transcription_timestamp_mode: Literal["segment", "word"] = "segment"
    transcription_checkpoint_root: Path = Path("/checkpoints")
    transcription_chunk_max_attempts: int = Field(default=3, ge=1, le=10)
    transcription_chunk_retry_base_seconds: float = Field(default=2.0, ge=0, le=60)
    diarization_bridge_max_seconds: float = Field(default=1.2, ge=0, le=5)
    diarization_orphan_max_seconds: float = Field(default=0.65, ge=0, le=2)
    audio_pipeline_max_concurrency: int = Field(default=1, ge=1, le=4)
    min_speaker_sample_seconds: float = 2.0
    max_representative_segments: int = 3
    model_device: str = "auto"


@lru_cache
def get_settings() -> Settings:
    return Settings()
