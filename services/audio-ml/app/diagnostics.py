import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


FRESH_CUDA_SCRIPT = r"""
import ctypes
import json

import torch

result = {
    "cudaAvailable": False,
    "deviceCount": 0,
    "nvmlCode": None,
    "nvmlMessage": "NVML nebylo inicializováno.",
    "gpuOperation": False,
    "error": None,
}
try:
    nvml = ctypes.CDLL("libnvidia-ml.so.1")
    nvml.nvmlErrorString.restype = ctypes.c_char_p
    nvml_code = int(nvml.nvmlInit_v2())
    result["nvmlCode"] = nvml_code
    result["nvmlMessage"] = nvml.nvmlErrorString(nvml_code).decode(
        "utf-8", errors="replace"
    )
    result["cudaAvailable"] = bool(torch.cuda.is_available())
    result["deviceCount"] = int(torch.cuda.device_count())
    if nvml_code == 0 and result["cudaAvailable"] and result["deviceCount"] > 0:
        left = torch.ones((16, 16), device="cuda")
        right = torch.ones((16, 16), device="cuda")
        value = float((left @ right).sum().item())
        torch.cuda.synchronize()
        result["gpuOperation"] = value == 4096.0
        nvml.nvmlShutdown()
except Exception as exc:
    result["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"

print(json.dumps(result))
"""


def _check(name: str, ok: bool, message: str) -> dict[str, object]:
    return {"name": name, "ok": ok, "message": message}


def run_fresh_cuda_check(timeout_seconds: float = 30.0) -> dict[str, object]:
    try:
        completed = subprocess.run(
            [sys.executable, "-c", FRESH_CUDA_SCRIPT],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return _check(
            "fresh_cuda",
            False,
            "Čerstvý CUDA/NVML canary překročil časový limit.",
        )
    except (OSError, RuntimeError) as exc:
        return _check(
            "fresh_cuda",
            False,
            f"Čerstvý CUDA/NVML canary nelze spustit: {type(exc).__name__}.",
        )

    try:
        line = next(
            item for item in reversed(completed.stdout.splitlines()) if item.strip()
        )
        result = json.loads(line)
    except (StopIteration, json.JSONDecodeError):
        detail = completed.stderr.strip()[-300:] or "bez diagnostického výstupu"
        return _check(
            "fresh_cuda",
            False,
            f"Čerstvý CUDA/NVML canary vrátil neplatný výstup: {detail}",
        )

    ok = (
        completed.returncode == 0
        and result.get("nvmlCode") == 0
        and result.get("cudaAvailable") is True
        and isinstance(result.get("deviceCount"), int)
        and result["deviceCount"] > 0
        and result.get("gpuOperation") is True
    )
    if ok:
        return _check(
            "fresh_cuda",
            True,
            f"NVML i CUDA operace jsou funkční; GPU zařízení: {result['deviceCount']}.",
        )
    error = result.get("error") or "bez dalšího detailu"
    return _check(
        "fresh_cuda",
        False,
        "Čerstvý proces neprošel CUDA/NVML kontrolou: "
        f"NVML {result.get('nvmlCode')} ({result.get('nvmlMessage')}), "
        f"CUDA {result.get('cudaAvailable')}, zařízení {result.get('deviceCount')}, "
        f"GPU operace {result.get('gpuOperation')}, chyba {error}.",
    )


def collect_audio_ml_diagnostics(
    *,
    shared_root: Path,
    models: dict[str, Any],
) -> dict[str, object]:
    model_names = sorted(models)
    missing_models = [name for name in model_names if models[name] is None]
    model_check = _check(
        "models",
        not missing_models,
        "Všechny produkční modely jsou načtené."
        if not missing_models
        else f"Nejsou načtené modely: {', '.join(missing_models)}.",
    )
    storage_ok = shared_root.is_dir() and os.access(shared_root, os.R_OK | os.X_OK)
    storage_check = _check(
        "shared_storage",
        storage_ok,
        f"Sdílené úložiště {shared_root} je dostupné."
        if storage_ok
        else f"Sdílené úložiště {shared_root} není čitelné.",
    )
    checks = [run_fresh_cuda_check(), model_check, storage_check]
    return {
        "status": "ok" if all(bool(check["ok"]) for check in checks) else "critical",
        "checks": checks,
    }
