from pathlib import Path

import soundfile as sf

from .errors import MlServiceError


def resolve_audio_path(raw_path: str, shared_root: Path) -> Path:
    root = shared_root.resolve(strict=True)
    try:
        candidate = Path(raw_path).resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise MlServiceError("INVALID_AUDIO", "Audio soubor neexistuje.") from exc
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise MlServiceError(
            "INVALID_AUDIO_PATH",
            "Audio cesta leží mimo povolený shared root.",
            status_code=403,
        )
    return candidate


def inspect_audio(path: Path) -> tuple[float, int, int]:
    try:
        info = sf.info(path)
    except (RuntimeError, OSError) as exc:
        raise MlServiceError("INVALID_AUDIO", "Audio nelze načíst.") from exc
    if info.duration <= 0 or info.samplerate <= 0 or info.channels <= 0:
        raise MlServiceError("INVALID_AUDIO", "Audio nemá platné parametry.")
    return float(info.duration), int(info.samplerate), int(info.channels)


def load_audio_tensor(path: Path):
    """Load audio as a channel-first float32 tensor for pyannote."""
    import torch

    try:
        audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    except (RuntimeError, OSError) as exc:
        raise MlServiceError("INVALID_AUDIO", "Audio nelze načíst.") from exc
    return torch.from_numpy(audio.T.copy()), int(sample_rate)
