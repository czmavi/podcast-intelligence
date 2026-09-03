from hmac import compare_digest

from fastapi import Request

from .config import Settings
from .errors import MlServiceError


def require_api_token(request: Request, settings: Settings) -> None:
    expected = settings.audio_ml_api_token
    if not expected:
        return
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not compare_digest(token, expected):
        raise MlServiceError(
            "UNAUTHORIZED",
            "ML API vyžaduje platný přístupový token.",
            status_code=401,
        )
