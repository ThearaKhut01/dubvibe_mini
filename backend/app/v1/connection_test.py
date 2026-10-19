"""Explicit, bounded connection test. Never persist or echo submitted secrets."""
from __future__ import annotations

from pydantic import Field, SecretStr, ValidationError

from ..config import env
from .contracts import BaseUrl, Contract, NonEmptyString

MAX_COMPLETION_TOKENS = 65_535


class ConnectionTest(Contract):
    base_url: BaseUrl
    model: NonEmptyString | None = None
    api_key: SecretStr | None = Field(default=None)


def default_model() -> str:
    """First configured translation candidate, for tests the user runs without typing a model name."""
    configured = env("TRANSLATION_MODELS", "gpt-4.1-mini")
    return next((name.strip() for name in configured.split(",") if name.strip()), "gpt-4.1-mini")


def check_connection(payload: dict, bridge) -> dict:
    from backend.workers.protocol import WorkerError
    try:
        config = ConnectionTest.model_validate(payload)
    except ValidationError:
        raise WorkerError('INVALID_CONFIG', 'Enter a valid service URL and API key.') from None
    model = (config.model or default_model()).strip()
    key = config.api_key.get_secret_value().strip() if config.api_key else ''
    if not key:
        from .runtime import TRANSLATION_ADAPTERS
        current = next((item for item in bridge.store.settings_values().get('connections', [])
                        if item['adapter'] in TRANSLATION_ADAPTERS and item['base_url'] == config.base_url), None)
        key = bridge.credentials.get(current['credential_ref']) if current and current.get('credential_ref') else None
    if not key:
        raise WorkerError('INVALID_CONFIG', 'Enter an API key; no saved key exists for this base URL.')
    import httpx
    from openai import OpenAI, APIStatusError, APIConnectionError, APITimeoutError
    if not isinstance(MAX_COMPLETION_TOKENS, int) or MAX_COMPLETION_TOKENS < 65_535:
        raise WorkerError('INVALID_CONFIG', 'The connection test requires a maximum output of at least 65535 tokens.')
    try:
        with OpenAI(base_url=config.base_url, api_key=key, max_retries=0,
                    timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            response = client.chat.completions.create(model=model, max_completion_tokens=MAX_COMPLETION_TOKENS,
                messages=[{'role': 'user', 'content': 'Connection test. Reply with the word OK.'}])
            if not response.choices or not response.choices[0].message.content:
                raise WorkerError('INVALID_CONFIG', 'The service returned no usable text; check that the model supports the chat API.')
    except APIStatusError as exc:
        limit = ' The request used a 65535-token output cap; confirm the service supports this limit.' if exc.status_code == 400 else ''
        raise WorkerError('INVALID_CONFIG', f'Connection test failed (HTTP {exc.status_code}); check the service URL, model, and key.{limit}') from exc
    except (APIConnectionError, APITimeoutError):
        raise WorkerError('INVALID_CONFIG', 'Connection test failed: the connection was unavailable or timed out; check the URL and network.') from None
    except WorkerError:
        raise
    except Exception:
        raise WorkerError('INVALID_CONFIG', 'The connection test received no valid response; check that the service is OpenAI chat-compatible.') from None
    return {'ok': True}
