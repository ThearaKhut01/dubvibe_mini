"""Explicit, bounded connection test. Never persist or echo submitted secrets."""
from __future__ import annotations

from pydantic import Field, SecretStr, ValidationError

from .contracts import BaseUrl, Contract, NonEmptyString

MAX_COMPLETION_TOKENS = 65_535


class ConnectionTest(Contract):
    base_url: BaseUrl
    model: NonEmptyString | None = None
    api_key: SecretStr | None = Field(default=None)


def default_models(base_url: str) -> list[str]:
    """Per-service defaults for tests the user runs without typing a model name.

    The generic OpenAI default sent to Google or an aggregator answers HTTP 404
    ("model not found") when the endpoint does not offer that id, so each known
    service gets its own candidate list and the test walks down it on 404.
    """
    from urllib.parse import urlsplit
    from .runtime import TRANSLATION_MODEL_DEFAULTS
    host = (urlsplit(str(base_url)).hostname or '').lower()
    if host.endswith('generativelanguage.googleapis.com'):
        env_name, fallback = TRANSLATION_MODEL_DEFAULTS['gemini']
    elif host in ('codecraftapi.com', 'www.codecraftapi.com'):
        env_name, fallback = TRANSLATION_MODEL_DEFAULTS['codecraft']
    else:
        env_name, fallback = TRANSLATION_MODEL_DEFAULTS['openai']
    from ..config import env
    configured = env(env_name, fallback)
    names = [name.strip() for name in configured.split(",") if name.strip()]
    return names or [fallback]


def check_connection(payload: dict, bridge) -> dict:
    from backend.workers.protocol import WorkerError
    try:
        config = ConnectionTest.model_validate(payload)
    except ValidationError:
        raise WorkerError('INVALID_CONFIG', 'Enter a valid service URL and API key.') from None
    model = (config.model or default_models(config.base_url)[0]).strip()
    candidates = [model] if config.model else default_models(config.base_url)
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
    tried: list[str] = []
    try:
        with OpenAI(base_url=config.base_url, api_key=key, max_retries=0,
                    timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            for candidate in candidates:
                try:
                    response = client.chat.completions.create(model=candidate, max_completion_tokens=MAX_COMPLETION_TOKENS,
                        messages=[{'role': 'user', 'content': 'Connection test. Reply with the word OK.'}])
                    model = candidate
                    break
                except APIStatusError as exc:
                    # A 404 means this service does not offer the model id, not
                    # that the URL or key are wrong: try the service's next
                    # default before blaming the user's input.
                    if exc.status_code == 404 and len(candidates) > 1:
                        tried.append(candidate)
                        continue
                    raise
            else:
                tried = ', '.join(f'"{name}"' for name in tried) or f'"{model}"'
                raise WorkerError('INVALID_CONFIG', f'Connection test failed (HTTP 404); check the service URL, model, and key. '
                    f'Models tried: {tried}. Enter a model name this service provides under "Model for the test".')
            if not response.choices or not response.choices[0].message.content:
                raise WorkerError('INVALID_CONFIG', 'The service returned no usable text; check that the model supports the chat API.')
    except APIStatusError as exc:
        limit = ' The request used a 65535-token output cap; confirm the service supports this limit.' if exc.status_code == 400 else ''
        missing_model = (f' A 404 usually means the model id does not exist on this service (requested model "{model}"); '
                         'enter a model name this service provides.' if exc.status_code == 404 else '')
        raise WorkerError('INVALID_CONFIG', f'Connection test failed (HTTP {exc.status_code}); check the service URL, model, and key.{limit}{missing_model}') from exc
    except (APIConnectionError, APITimeoutError):
        raise WorkerError('INVALID_CONFIG', 'Connection test failed: the connection was unavailable or timed out; check the URL and network.') from None
    except WorkerError:
        raise
    except Exception:
        raise WorkerError('INVALID_CONFIG', 'The connection test received no valid response; check that the service is OpenAI chat-compatible.') from None
    return {'ok': True}
