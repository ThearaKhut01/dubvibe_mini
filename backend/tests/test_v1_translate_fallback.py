from __future__ import annotations

import json
from dataclasses import replace

import pytest

from backend.app.v1 import translate
from backend.app.v1.errors import ApiError
from backend.app.v1.segments import read_translation
from backend.tests.test_v1_translate import context, provider  # noqa: F401  (shared fixtures)


def two_providers(context):
    connections = {
        "openai": {"base_url": "https://primary.example/v1", "api_key": "primary-key"},
        "gemini": {"base_url": "https://backup.example/v1", "api_key": "backup-key"},
    }
    config = context.config.model_copy(update={
        "translation_providers": ["openai", "gemini"],
        "translation_models": {"gemini": "gemini-2.5-flash"},
    })
    return replace(context, connections=connections, config=config)


def test_rejected_primary_falls_back_to_next_provider(context, provider):
    provider.error = provider.StatusError(401)
    ctx = two_providers(context)
    progress = []
    provider.fail_only_base_url = "https://primary.example/v1"
    translate.run(ctx, lambda fraction, message: progress.append(message))
    assert any("Falling back" in message for message in progress)
    hosts = [options["base_url"] for options in provider.options]
    assert hosts[0] == "https://primary.example/v1" and hosts[-1] == "https://backup.example/v1"


def test_timeout_never_falls_back_to_avoid_duplicate_processing(context, provider):
    provider.error = provider.TimeoutError()
    ctx = two_providers(context)
    with pytest.raises(ApiError) as error:
        translate.run(ctx, lambda *args: None)
    assert error.value.content["error"]["code"] == "REMOTE_TIMEOUT"
    assert all(options["base_url"] == "https://primary.example/v1" for options in provider.options)


def test_invalid_provider_reply_never_falls_back(context, provider):
    provider.mutate = lambda result: result["segments"].append(result["segments"][0])
    ctx = two_providers(context)
    with pytest.raises(ApiError) as error:
        translate.run(ctx, lambda *args: None)
    assert error.value.content["error"]["code"] == "INVALID_PROVIDER_RESULT"
    assert len(provider.options) == 1


def test_single_provider_behaviour_is_unchanged(context, provider):
    result = translate.run(context, lambda *args: None)
    assert result.output_files["translation"].exists()
    assert len(provider.options) >= 1


def test_fallback_provider_uses_its_own_model(context, provider):
    provider.error = provider.StatusError(401)
    provider.fail_only_base_url = "https://primary.example/v1"
    translate.run(two_providers(context), lambda *args: None)
    assert [call["model"] for call in provider.calls][-1] == "gemini-2.5-flash"


def test_fallback_without_configured_model_is_rejected_not_guessed(context, provider):
    provider.error = provider.StatusError(401)
    provider.fail_only_base_url = "https://primary.example/v1"
    connections = {"openai": {"base_url": "https://primary.example/v1", "api_key": "k"},
                   "gemini": {"base_url": "https://backup.example/v1", "api_key": "k"}}
    ctx = replace(context, connections=connections,
                  config=context.config.model_copy(update={"translation_providers": ["openai", "gemini"]}))
    with pytest.raises(ApiError) as error:
        translate.run(ctx, lambda *args: None)
    assert error.value.content["error"]["code"] == "INVALID_CONFIG"
    assert len(provider.calls) == 1


def test_automatic_fallback_tries_other_configured_services(context, provider):
    provider.error = provider.StatusError(401)
    provider.fail_only_base_url = "https://pinned.example/v1"
    connections = {"openai": {"base_url": "https://pinned.example/v1", "api_key": "k"},
                   "codecraft": {"base_url": "https://craft.example/v1", "api_key": "k"}}
    progress = []
    result = translate.run(replace(context, connections=connections),
                           lambda fraction, message: progress.append(message))
    assert any("Falling back to translation provider codecraft" in message for message in progress)
    assert [options["base_url"] for options in provider.options][-1] == "https://craft.example/v1"
    # The secondary has no explicit model entry, so the chain uses the
    # adapter's configured default model.
    assert [call["model"] for call in provider.calls][-1] == "gpt-5.6-luna"
    assert result.output_files["translation"].exists()


def test_automatic_fallback_skips_services_without_connection(context, provider):
    provider.error = provider.StatusError(401)
    progress = []
    with pytest.raises(ApiError) as error:
        translate.run(context, lambda fraction, message: progress.append(message))
    # Only the primary is configured; unconfigured adapters must not enter
    # the chain and mask the primary provider's real error.
    assert error.value.content["error"]["code"] == "PROVIDER_REJECTED"
    assert len(provider.options) == 1
    assert not any("Falling back" in message for message in progress)
