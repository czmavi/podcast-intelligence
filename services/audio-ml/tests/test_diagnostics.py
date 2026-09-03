import json
from pathlib import Path
import subprocess

from app import diagnostics


def test_fresh_cuda_check_reports_healthy_gpu(monkeypatch) -> None:
    payload = {
        "cudaAvailable": True,
        "deviceCount": 1,
        "nvmlCode": 0,
        "nvmlMessage": "Success",
        "gpuOperation": True,
        "error": None,
    }
    monkeypatch.setattr(
        diagnostics.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args[0], returncode=0, stdout=json.dumps(payload), stderr=""
        ),
    )
    assert diagnostics.run_fresh_cuda_check()["ok"] is True


def test_fresh_cuda_check_reports_nvml_failure(monkeypatch) -> None:
    payload = {
        "cudaAvailable": False,
        "deviceCount": 0,
        "nvmlCode": 999,
        "nvmlMessage": "Unknown Error",
        "gpuOperation": False,
        "error": None,
    }
    monkeypatch.setattr(
        diagnostics.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args[0], returncode=0, stdout=json.dumps(payload), stderr=""
        ),
    )
    result = diagnostics.run_fresh_cuda_check()
    assert result["ok"] is False
    assert "999" in str(result["message"])


def test_diagnostics_combines_cuda_models_and_storage(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        diagnostics,
        "run_fresh_cuda_check",
        lambda: {"name": "fresh_cuda", "ok": True, "message": "ok"},
    )
    healthy = diagnostics.collect_audio_ml_diagnostics(
        shared_root=tmp_path,
        models={"one": object(), "two": object()},
    )
    assert healthy["status"] == "ok"

    critical = diagnostics.collect_audio_ml_diagnostics(
        shared_root=tmp_path / "missing",
        models={"one": object(), "two": None},
    )
    assert critical["status"] == "critical"
