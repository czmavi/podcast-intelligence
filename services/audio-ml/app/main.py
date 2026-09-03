import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, nullcontext
import json
from queue import Empty, Queue
from threading import Event, Lock, Thread
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .auth import require_api_token
from .audio_utils import inspect_audio, resolve_audio_path
from .config import get_settings
from .diarization import (
    DiarizationResult,
    Diarizer,
    SpeakerTurn,
    assign_speakers,
    group_assigned_segments,
    overlapping_speech_intervals,
    smooth_speaker_turns,
)
from .diagnostics import collect_audio_ml_diagnostics
from .errors import MlServiceError
from .inference_scheduler import AudioInferenceScheduler, InferenceCancelled
from .schemas import (
    ModelInfo,
    ModelsInfo,
    ProcessAudioRequest,
    ProcessAudioResponse,
    RepresentativeSegment,
    SpeakerResult,
    TextEmbeddingRequest,
    TextEmbeddingResponse,
    TextRerankRequest,
    TextRerankResponse,
    UtteranceResult,
)
from .speaker_embeddings import SpeakerEmbedder, select_quality_segments
from .transcription import proportional_word_segments
from .text_embeddings import TextEmbedder, TextReranker
from .transcription import Transcriber

settings = get_settings()
transcriber = Transcriber(settings)
diarizer = Diarizer(settings)
speaker_embedder = SpeakerEmbedder(settings)
text_embedder = TextEmbedder(settings)
text_reranker = TextReranker(settings)
inference_scheduler = AudioInferenceScheduler(settings.audio_pipeline_max_concurrency)

ProgressCallback = Callable[[str, int | None, int | None, str], None]


def authorize(request: Request) -> None:
    require_api_token(request, settings)


def gpu_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except ImportError:
        return False


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.warm_transcription_model:
        transcriber.load()
    if settings.warm_diarization_model:
        diarizer.load()
    if settings.warm_speaker_embedding_model:
        speaker_embedder.load()
    if settings.warm_text_embedding_model:
        text_embedder.load()
    if settings.warm_text_reranker_model:
        text_reranker.load()
    yield


app = FastAPI(
    title="Podcast Audio ML",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.exception_handler(MlServiceError)
async def ml_error_handler(_: Request, exc: MlServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "details": exc.details,
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "code": "INVALID_REQUEST",
            "message": "Požadavek neodpovídá ML API kontraktu.",
            "retryable": False,
            "details": {
                "errors": [
                    {
                        "location": [str(part) for part in error["loc"]],
                        "message": error["msg"],
                        "type": error["type"],
                    }
                    for error in exc.errors()
                ]
            },
        },
    )


@app.get("/health/live")
def live() -> dict[str, object]:
    return {"status": "live"}


@app.get("/health/ready")
def ready(request: Request) -> JSONResponse:
    authorize(request)
    token_available = bool(settings.hf_token)
    pipeline_slots = inference_scheduler.pipeline.snapshot()
    body = {
        "status": "ready",
        "gpuAvailable": gpu_available(),
        "models": {
            "transcriptionLoaded": transcriber._model is not None,
            "diarizationLoaded": diarizer._pipeline is not None,
            "speakerEmbeddingLoaded": speaker_embedder._inference is not None,
            "textEmbeddingLoaded": text_embedder._model is not None,
            "textRerankerLoaded": text_reranker._model is not None,
        },
        "hfTokenAvailable": token_available,
        "audioPipelineConcurrency": {
            "capacity": pipeline_slots.capacity,
            "active": pipeline_slots.active,
            "waiting": pipeline_slots.waiting,
        },
        "warnings": [] if token_available else ["HF_TOKEN chybí; diarizace není dostupná."],
    }
    return JSONResponse(status_code=200, content=body)


@app.post("/health/diagnostics")
def diagnostics(request: Request) -> dict[str, object]:
    authorize(request)
    result = collect_audio_ml_diagnostics(
        shared_root=settings.audio_ml_shared_root,
        models={
            "transcription": transcriber._model,
            "diarization": diarizer._pipeline,
            "speaker_embedding": speaker_embedder._inference,
            "text_embedding": text_embedder._model,
            "text_reranker": text_reranker._model,
        },
    )
    pipeline_slots = inference_scheduler.pipeline.snapshot()
    result["audioPipelineConcurrency"] = {
        "capacity": pipeline_slots.capacity,
        "active": pipeline_slots.active,
        "waiting": pipeline_slots.waiting,
    }
    return result


@app.get("/v1/models")
def models(request: Request) -> dict[str, object]:
    authorize(request)
    return {
        "transcription": settings.whisper_model,
        "diarization": settings.diarization_model,
        "speakerEmbedding": settings.speaker_embedding_model,
        "textEmbedding": settings.text_embedding_model,
        "textReranker": settings.text_reranker_model,
        "device": transcriber.device,
    }


def _run_audio_pipeline(
    payload: ProcessAudioRequest,
    progress: ProgressCallback | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> ProcessAudioResponse:
    def ensure_active() -> None:
        if should_cancel and should_cancel():
            raise MlServiceError(
                "PROCESSING_CANCELLED",
                "Audio zpracování bylo zrušeno po odpojení klienta.",
                retryable=True,
                status_code=499,
            )

    def report(
        phase: str,
        current: int | None,
        total: int | None,
        message: str,
    ) -> None:
        if progress:
            progress(phase, current, total, message)

    path = resolve_audio_path(payload.audio_path, settings.audio_ml_shared_root)
    duration, _, _ = inspect_audio(path)
    transcript, detected_language = transcriber.transcribe(
        path,
        payload.language,
        lambda current, total: report(
            "transcription", current, total, "Přepisuji audio pomocí Whisperu."
        ),
        checkpoint_id=str(payload.checkpoint_id) if payload.checkpoint_id else None,
        audio_fingerprint=payload.audio_fingerprint,
        should_cancel=should_cancel,
    )
    warnings: list[str] = []
    if payload.enable_diarization:
        ensure_active()
        report("diarization_wait", None, None, "Čekám na diarizační model.")
        with inference_scheduler.diarization.slot(should_cancel):
            ensure_active()
            report("diarization", 0, 1, "Rozlišuji jednotlivé mluvčí.")
            diarization = diarizer.diarize(
                path, payload.min_speakers, payload.max_speakers
            )
            report("diarization", 1, 1, "Rozlišení mluvčích je hotové.")
    else:
        fallback_turns = [SpeakerTurn(0.0, duration, "SPEAKER_00")]
        diarization = DiarizationResult(
            regular_turns=fallback_turns,
            exclusive_turns=fallback_turns,
        )
        warnings.append("Diarizace byla vypnutá; celé audio je SPEAKER_00.")
    overlap_intervals = overlapping_speech_intervals(diarization.regular_turns)
    if payload.transcript_alignment_mode == "overlap":
        alignment_turns = smooth_speaker_turns(
            diarization.exclusive_turns,
            bridge_max_seconds=settings.diarization_bridge_max_seconds,
            orphan_max_seconds=settings.diarization_orphan_max_seconds,
        )
        alignment_segments = (
            transcript
            if settings.transcription_timestamp_mode == "word"
            else proportional_word_segments(transcript)
        )
        assigned = group_assigned_segments(
            assign_speakers(
                alignment_segments,
                alignment_turns,
                overlap_intervals,
            )
        )
    else:
        assigned = assign_speakers(
            transcript,
            diarization.exclusive_turns,
            overlap_intervals,
        )
    labels = sorted(
        {turn.speaker for turn in diarization.exclusive_turns}
        | {item.speaker for item in assigned}
    )
    grouped: dict[str, list[SpeakerTurn]] = defaultdict(list)
    for turn in diarization.exclusive_turns:
        grouped[turn.speaker].append(turn)

    speakers: list[SpeakerResult] = []
    speaker_embedding_slot = (
        inference_scheduler.speaker_embedding.slot(should_cancel)
        if payload.return_speaker_embeddings
        else nullcontext()
    )
    with speaker_embedding_slot:
        for index, label in enumerate(labels):
            ensure_active()
            report(
                "speaker_embeddings",
                index,
                max(1, len(labels)),
                "Vytvářím hlasové otisky mluvčích.",
            )
            selected = select_quality_segments(
                diarization.regular_turns,
                label,
                settings.min_speaker_sample_seconds,
                settings.max_representative_segments,
                overlap_intervals,
            )
            embedding = (
                speaker_embedder.embed(path, selected)
                if payload.return_speaker_embeddings
                else None
            )
            speakers.append(
                SpeakerResult(
                    label=label,
                    speechSeconds=sum(turn.end - turn.start for turn in grouped[label]),
                    segmentCount=len(grouped[label]),
                    representativeSegments=[
                        RepresentativeSegment(
                            start=item.start, end=item.end, quality=item.quality
                        )
                        for item in selected
                    ],
                    embedding=embedding,
                )
            )
    report(
        "speaker_embeddings",
        len(labels),
        max(1, len(labels)),
        "Hlasové otisky jsou hotové.",
    )

    utterances = [
        UtteranceResult(
            sequence=index,
            start=item.segment.start,
            end=item.segment.end,
            playbackStart=(
                item.segment.source_start
                if item.segment.source_start is not None
                else item.segment.start
            ),
            speaker=item.speaker,
            text=item.segment.text,
            transcriptionConfidence=item.segment.confidence,
            speakerConfidence=item.confidence,
            overlapDetected=item.overlap_detected,
        )
        for index, item in enumerate(assigned)
        if item.segment.text
    ]
    return ProcessAudioResponse(
        transcriptAlignmentMode=payload.transcript_alignment_mode,
        episodeId=payload.episode_id,
        durationSeconds=duration,
        detectedLanguage=detected_language,
        models=ModelsInfo(
            transcription=ModelInfo(
                name=settings.whisper_model,
                version=(
                    f"transformers-pytorch-{payload.transcript_alignment_mode}"
                    "-alignment-v3"
                ),
            ),
            diarization=ModelInfo(name=settings.diarization_model, version="pyannote-4")
            if payload.enable_diarization
            else None,
            speakerEmbedding=ModelInfo(
                name=settings.speaker_embedding_model, version="pyannote-4"
            )
            if payload.return_speaker_embeddings
            else None,
        ),
        speakers=speakers,
        utterances=utterances,
        warnings=warnings,
    )


def run_audio_pipeline(
    payload: ProcessAudioRequest,
    progress: ProgressCallback | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> ProcessAudioResponse:
    if progress:
        progress(
            "waiting_for_slot",
            None,
            None,
            "Čekám na volnou kapacitu audio ML.",
        )
    try:
        with inference_scheduler.pipeline.slot(should_cancel):
            return _run_audio_pipeline(payload, progress, should_cancel)
    except InferenceCancelled as exc:
        raise MlServiceError(
            "PROCESSING_CANCELLED",
            "Audio zpracování bylo zrušeno během čekání na kapacitu.",
            retryable=True,
            status_code=499,
        ) from exc


@app.post("/v1/process-audio", response_model=ProcessAudioResponse)
def process_audio(payload: ProcessAudioRequest, request: Request) -> ProcessAudioResponse:
    authorize(request)
    return run_audio_pipeline(payload)


async def stream_audio_pipeline(
    payload: ProcessAudioRequest, request: Request
) -> AsyncIterator[str]:
    messages: Queue[dict[str, object] | None] = Queue()
    cancelled = Event()
    phase_lock = Lock()
    current_phase: str | None = None

    def progress(
        phase: str,
        current: int | None,
        total: int | None,
        message: str,
    ) -> None:
        nonlocal current_phase
        with phase_lock:
            current_phase = phase
        messages.put(
            {
                "type": "progress",
                "phase": phase,
                "current": current,
                "total": total,
                "message": message,
            }
        )

    def work() -> None:
        try:
            result = run_audio_pipeline(payload, progress, cancelled.is_set)
            messages.put(
                {
                    "type": "result",
                    "data": result.model_dump(mode="json", by_alias=True),
                }
            )
        except MlServiceError as exc:
            messages.put(
                {
                    "type": "error",
                    "error": {
                        "code": exc.code,
                        "message": exc.message,
                        "retryable": exc.retryable,
                        "details": exc.details,
                    },
                }
            )
        except Exception as exc:
            messages.put(
                {
                    "type": "error",
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": f"ML zpracování selhalo: {type(exc).__name__}",
                        "retryable": True,
                    },
                }
            )
        finally:
            messages.put(None)

    Thread(target=work, daemon=True).start()
    last_waiting_heartbeat = time.monotonic()
    try:
        while True:
            if await request.is_disconnected():
                cancelled.set()
                break
            try:
                item = await asyncio.to_thread(messages.get, True, 1.0)
            except Empty:
                with phase_lock:
                    waiting = current_phase == "waiting_for_slot"
                if waiting and time.monotonic() - last_waiting_heartbeat >= 15:
                    last_waiting_heartbeat = time.monotonic()
                    yield json.dumps(
                        {
                            "type": "progress",
                            "phase": "waiting_for_slot",
                            "current": None,
                            "total": None,
                            "message": "Čekám na volnou kapacitu audio ML.",
                        },
                        ensure_ascii=False,
                    ) + "\n"
                continue
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"
    finally:
        cancelled.set()


@app.post("/v1/process-audio-stream")
def process_audio_stream(
    payload: ProcessAudioRequest, request: Request
) -> StreamingResponse:
    authorize(request)
    return StreamingResponse(
        stream_audio_pipeline(payload, request), media_type="application/x-ndjson"
    )


@app.post("/v1/embed-text", response_model=TextEmbeddingResponse)
def embed_text(payload: TextEmbeddingRequest, request: Request) -> TextEmbeddingResponse:
    authorize(request)
    embeddings = text_embedder.embed(payload.texts)
    return TextEmbeddingResponse(
        modelName=settings.text_embedding_model,
        dimensions=len(embeddings[0]),
        embeddings=embeddings,
    )


@app.post("/v1/rerank-text", response_model=TextRerankResponse)
def rerank_text(payload: TextRerankRequest, request: Request) -> TextRerankResponse:
    authorize(request)
    return TextRerankResponse(
        modelName=settings.text_reranker_model,
        scores=text_reranker.rerank(payload.query, payload.documents),
    )
