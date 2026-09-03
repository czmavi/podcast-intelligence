from app.diarization import (
    AssignedTranscriptSegment,
    SpeakerTurn,
    assign_speakers,
    group_assigned_segments,
    overlapping_speech_intervals,
    smooth_speaker_turns,
)
from app.transcription import TranscriptSegment


def test_regular_diarization_detects_overlap_while_exclusive_assigns_speaker() -> None:
    regular = [
        SpeakerTurn(0.0, 4.0, "SPEAKER_00"),
        SpeakerTurn(2.0, 3.0, "SPEAKER_01"),
    ]
    exclusive = [
        SpeakerTurn(0.0, 2.5, "SPEAKER_00"),
        SpeakerTurn(2.5, 3.0, "SPEAKER_01"),
        SpeakerTurn(3.0, 4.0, "SPEAKER_00"),
    ]
    intervals = overlapping_speech_intervals(regular)

    assert [(item.start, item.end) for item in intervals] == [(2.0, 3.0)]
    assigned = assign_speakers(
        [TranscriptSegment(2.1, 2.4, " překryv", None)],
        exclusive,
        intervals,
    )
    assert assigned[0].speaker == "SPEAKER_00"
    assert assigned[0].overlap_detected is True


def test_segment_in_diarization_gap_uses_nearest_turn_instead_of_fixed_label() -> None:
    assigned = assign_speakers(
        [TranscriptSegment(5.0, 5.5, " mezera", None)],
        [
            SpeakerTurn(0.0, 2.0, "SPEAKER_00"),
            SpeakerTurn(6.0, 9.0, "SPEAKER_03"),
        ],
    )

    assert assigned[0].speaker == "SPEAKER_03"
    assert assigned[0].confidence == 0.0


def test_word_assignments_group_by_speaker_and_sentence() -> None:
    words = [
        AssignedTranscriptSegment(
            TranscriptSegment(0.0, 0.4, " Dobrý", None, 0.0, 1.5),
            "SPEAKER_00",
            1.0,
            False,
        ),
        AssignedTranscriptSegment(
            TranscriptSegment(0.4, 0.8, " den.", None, 0.0, 1.5),
            "SPEAKER_00",
            1.0,
            False,
        ),
        AssignedTranscriptSegment(
            TranscriptSegment(2.0, 2.4, " Ahoj", None),
            "SPEAKER_01",
            0.8,
            True,
        ),
    ]

    grouped = group_assigned_segments(words)

    assert [(item.speaker, item.segment.text) for item in grouped] == [
        ("SPEAKER_00", "Dobrý den."),
        ("SPEAKER_01", "Ahoj"),
    ]
    assert grouped[1].overlap_detected is True
    assert grouped[0].segment.source_start == 0.0
    assert grouped[0].segment.source_end == 1.5


def test_grouping_sorts_overlapping_whisper_segments_and_keeps_valid_range() -> None:
    assigned = [
        AssignedTranscriptSegment(
            TranscriptSegment(10.0, 11.0, " později", None),
            "SPEAKER_00",
            0.8,
            False,
        ),
        AssignedTranscriptSegment(
            TranscriptSegment(9.0, 9.5, " dříve", None),
            "SPEAKER_00",
            0.9,
            False,
        ),
    ]

    grouped = group_assigned_segments(assigned)

    assert len(grouped) == 1
    assert grouped[0].segment.start == 9.0
    assert grouped[0].segment.end == 11.0
    assert grouped[0].segment.text == "dříve později"


def test_smoothing_removes_short_speaker_islands_but_keeps_stable_turn() -> None:
    turns = [
        SpeakerTurn(0.0, 3.0, "SPEAKER_00"),
        SpeakerTurn(3.0, 3.3, "SPEAKER_01"),
        SpeakerTurn(3.3, 3.85, "SPEAKER_02"),
        SpeakerTurn(3.85, 5.0, "SPEAKER_00"),
        SpeakerTurn(5.0, 6.5, "SPEAKER_03"),
        SpeakerTurn(6.5, 8.0, "SPEAKER_00"),
    ]

    smoothed = smooth_speaker_turns(turns)

    assert smoothed == [
        SpeakerTurn(0.0, 5.0, "SPEAKER_00"),
        SpeakerTurn(5.0, 6.5, "SPEAKER_03"),
        SpeakerTurn(6.5, 8.0, "SPEAKER_00"),
    ]
