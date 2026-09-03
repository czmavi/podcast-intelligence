import pytest
from pydantic import ValidationError

from app.schemas import ProcessAudioRequest
from app.transcription import Transcriber


def test_speaker_bounds_are_validated() -> None:
    with pytest.raises(ValidationError):
        ProcessAudioRequest.model_validate(
            {
                "episodeId": "200065d7-a95c-45f8-872c-bb16fd455c9f",
                "audioPath": "/data/audio.wav",
                "minSpeakers": 5,
                "maxSpeakers": 2,
            }
        )


def test_transformers_segments_are_validated_and_normalized() -> None:
    segments = Transcriber._segments(
        {
            "text": "celý přepis",
            "chunks": [
                {"timestamp": (0.0, 1.5), "text": " První věta. "},
                {"timestamp": (1.5, None), "text": " Druhá věta. "},
                {"timestamp": (3.0, 2.0), "text": "neplatný segment"},
            ],
        },
        4.0,
    )
    assert [(segment.start, segment.end, segment.text) for segment in segments] == [
        (0.0, 1.5, "První věta."),
        (1.5, 4.0, "Druhá věta."),
    ]
