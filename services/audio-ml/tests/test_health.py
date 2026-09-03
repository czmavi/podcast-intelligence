from fastapi.testclient import TestClient

from app import main
from app.main import app, settings


def test_live_health() -> None:
    response = TestClient(app).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "live"}


def test_ready_reports_token_and_gpu() -> None:
    response = TestClient(app).get("/health/ready")
    assert response.status_code == 200
    assert "gpuAvailable" in response.json()
    assert "hfTokenAvailable" in response.json()


def test_ready_requires_configured_api_token(monkeypatch) -> None:
    token = "a" * 32
    monkeypatch.setattr(settings, "audio_ml_api_token", token)
    client = TestClient(app)
    assert client.get("/health/ready").status_code == 401
    response = client.get(
        "/health/ready", headers={"authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200


def test_diagnostics_requires_auth_and_returns_checks(monkeypatch) -> None:
    token = "b" * 32
    monkeypatch.setattr(settings, "audio_ml_api_token", token)
    monkeypatch.setattr(
        main,
        "collect_audio_ml_diagnostics",
        lambda **kwargs: {
            "status": "critical",
            "checks": [
                {"name": "fresh_cuda", "ok": False, "message": "NVML 999"}
            ],
        },
    )
    client = TestClient(app)
    assert client.post("/health/diagnostics").status_code == 401
    response = client.post(
        "/health/diagnostics", headers={"authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "critical"
