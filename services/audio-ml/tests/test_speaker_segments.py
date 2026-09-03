from app.diarization import SpeakerTurn
from app.speaker_embeddings import select_quality_segments


def test_quality_segments_skip_short_and_overlapping() -> None:
    turns = [
        SpeakerTurn(0, 1, "SPEAKER_00"),
        SpeakerTurn(2, 7, "SPEAKER_00"),
        SpeakerTurn(3, 4, "SPEAKER_01"),
        SpeakerTurn(8, 14, "SPEAKER_00"),
    ]
    selected = select_quality_segments(turns, "SPEAKER_00", 2, 3)
    assert [(item.start, item.end) for item in selected] == [(8, 14), (4, 7)]
