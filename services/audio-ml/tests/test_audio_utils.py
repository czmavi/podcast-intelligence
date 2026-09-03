from pathlib import Path

import pytest

from app.audio_utils import resolve_audio_path
from app.errors import MlServiceError


def test_resolve_audio_path_accepts_file_inside_root(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"fixture")
    assert resolve_audio_path(str(audio), tmp_path) == audio


def test_resolve_audio_path_rejects_file_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"fixture")
    with pytest.raises(MlServiceError, match="shared root"):
        resolve_audio_path(str(outside), root)
