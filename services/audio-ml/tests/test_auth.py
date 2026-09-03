from unittest.mock import Mock

import pytest

from app.auth import require_api_token
from app.config import Settings
from app.errors import MlServiceError


def request_with_authorization(value: str | None) -> Mock:
    request = Mock()
    request.headers = {} if value is None else {"authorization": value}
    return request


def test_api_token_is_optional() -> None:
    require_api_token(request_with_authorization(None), Settings())


def test_valid_bearer_token_is_accepted() -> None:
    token = "a" * 32
    require_api_token(
        request_with_authorization(f"Bearer {token}"),
        Settings(audio_ml_api_token=token),
    )


def test_invalid_bearer_token_is_rejected() -> None:
    with pytest.raises(MlServiceError) as error:
        require_api_token(
            request_with_authorization("Bearer wrong"),
            Settings(audio_ml_api_token="a" * 32),
        )
    assert error.value.status_code == 401
