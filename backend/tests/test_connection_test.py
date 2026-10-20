from types import SimpleNamespace as NS
from unittest.mock import Mock

import httpx
import pytest
import openai

from backend.app.v1.connection_test import check_connection
from backend.workers.protocol import WorkerError


@pytest.fixture
def bridge():
    return NS(store=NS(settings_values=lambda: {'connections': []}), credentials=Mock())


def test_missing_key_never_contacts_provider(bridge, monkeypatch):
    monkeypatch.setattr(openai, 'OpenAI', lambda **kwargs: pytest.fail('must not contact provider'))
    with pytest.raises(WorkerError, match='API key'):
        check_connection({'base_url': 'https://example.test/v1', 'model': 'test'}, bridge)


def test_failed_connection_never_echoes_key_or_provider_response(bridge, monkeypatch):
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    client.chat.completions.create.side_effect = openai.AuthenticationError('secret-example',
        response=httpx.Response(401, request=httpx.Request('POST', 'https://example.test/v1')), body={'key': 'secret-example'})
    monkeypatch.setattr(openai, 'OpenAI', lambda **kwargs: client)
    with pytest.raises(WorkerError, match='HTTP 401') as result:
        check_connection({'base_url': 'https://example.test/v1', 'model': 'test', 'api_key': 'secret-example'}, bridge)
    assert 'secret-example' not in str(result.value)
    bridge.credentials.set.assert_not_called()


def test_saved_key_can_be_tested_without_returning_it(bridge, monkeypatch):
    bridge.store.settings_values = lambda: {'connections': [{'adapter': 'openai', 'base_url': 'https://example.test/v1', 'credential_ref': 'ref'}]}
    bridge.credentials.get.return_value = 'saved-secret'
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    client.chat.completions.create.return_value = NS(choices=[NS(message=NS(content='OK'))])
    factory = Mock(return_value=client)
    monkeypatch.setattr(openai, 'OpenAI', factory)
    assert check_connection({'base_url': 'https://example.test/v1', 'model': 'test'}, bridge) == {'ok': True}
    assert factory.call_args.kwargs['api_key'] == 'saved-secret'
    assert factory.call_args.kwargs['max_retries'] == 0
    assert client.chat.completions.create.call_args.kwargs['max_completion_tokens'] >= 65_535
    bridge.credentials.set.assert_not_called()


def test_saved_key_from_a_custom_connection_can_be_tested_without_returning_it(bridge, monkeypatch):
    bridge.store.settings_values = lambda: {'connections': [{'adapter': 'custom', 'base_url': 'https://gateway.example/v1', 'credential_ref': 'ref'}]}
    bridge.credentials.get.return_value = 'saved-secret'
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    client.chat.completions.create.return_value = NS(choices=[NS(message=NS(content='OK'))])
    factory = Mock(return_value=client)
    monkeypatch.setattr(openai, 'OpenAI', factory)
    assert check_connection({'base_url': 'https://gateway.example/v1', 'model': 'test'}, bridge) == {'ok': True}
    assert factory.call_args.kwargs['api_key'] == 'saved-secret'
    bridge.credentials.set.assert_not_called()


def test_invalid_output_limit_stops_before_call(bridge, monkeypatch):
    monkeypatch.setattr('backend.app.v1.connection_test.MAX_COMPLETION_TOKENS', 128)
    monkeypatch.setattr(openai, 'OpenAI', lambda **kwargs: pytest.fail('must not contact provider'))
    with pytest.raises(WorkerError, match='65535'):
        check_connection({'base_url': 'https://example.test/v1', 'model': 'test', 'api_key': 'secret'}, bridge)


def test_default_models_match_the_service_behind_the_url(monkeypatch):
    for name in ("DUBVIBE_MINI_GEMINI_MODELS", "DUBVIBE_MINI_CODECRAFT_MODELS", "DUBVIBE_MINI_TRANSLATION_MODELS",
                 "YOUDUB_GEMINI_MODELS", "YOUDUB_CODECRAFT_MODELS", "YOUDUB_TRANSLATION_MODELS"):
        monkeypatch.delenv(name, raising=False)
    from backend.app.v1.connection_test import default_models
    # The generic OpenAI default answers HTTP 404 on Google and on aggregators:
    # each known service gets its own candidates and the test walks them on 404.
    assert default_models('https://api.openai.com/v1') == ['gpt-4.1-mini']
    assert default_models('https://generativelanguage.googleapis.com/v1beta/openai/') == ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
    assert default_models('https://codecraftapi.com/v1') == ['gpt-5.6-luna', 'gpt-4.1-mini']
    assert default_models('https://gateway.example/v1') == ['gpt-4.1-mini']


def test_default_model_candidates_respect_configured_env(monkeypatch):
    monkeypatch.setenv('DUBVIBE_MINI_GEMINI_MODELS', ' reduced-one , reduced-two , ')
    monkeypatch.delenv('DUBVIBE_MINI_TRANSLATION_MODELS', raising=False)
    monkeypatch.delenv('YOUDUB_GEMINI_MODELS', raising=False)
    monkeypatch.delenv('YOUDUB_TRANSLATION_MODELS', raising=False)
    from backend.app.v1.connection_test import default_models
    assert default_models('https://generativelanguage.googleapis.com/v1beta/openai/') == ['reduced-one', 'reduced-two']


def test_model_not_found_suggests_the_service_provides_other_ids(bridge, monkeypatch):
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    client.chat.completions.create.side_effect = openai.APIStatusError('no such model',
        response=httpx.Response(404, request=httpx.Request('POST', 'https://example.test/v1')), body=None)
    monkeypatch.setattr(openai, 'OpenAI', lambda **kwargs: client)
    with pytest.raises(WorkerError, match='HTTP 404') as result:
        check_connection({'base_url': 'https://example.test/v1', 'model': 'no-such-model', 'api_key': 'secret'}, bridge)
    assert 'does not exist on this service' in str(result.value)
    assert 'no-such-model' in str(result.value)
    assert 'secret' not in str(result.value)


def test_model_not_found_walks_the_service_default_candidates(bridge, monkeypatch):
    monkeypatch.delenv('DUBVIBE_MINI_GEMINI_MODELS', raising=False)
    monkeypatch.delenv('YOUDUB_GEMINI_MODELS', raising=False)
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    ok = NS(choices=[NS(message=NS(content='OK'))])
    responses = iter([openai.APIStatusError('gone', response=httpx.Response(404, request=httpx.Request('POST', 'u')), body=None), ok])
    def create(model=None, **kwargs):
        item = next(responses)
        if isinstance(item, BaseException): raise item
        return item
    client.chat.completions.create.side_effect = create
    monkeypatch.setattr(openai, 'OpenAI', lambda **kwargs: client)
    assert check_connection({'base_url': 'https://generativelanguage.googleapis.com/v1beta/openai', 'api_key': 'secret'}, bridge) == {'ok': True}
    models = [call.kwargs['model'] for call in client.chat.completions.create.call_args_list]
    assert models == ['gemini-2.5-flash', 'gemini-2.5-flash-lite']


def test_all_default_candidates_reported_when_every_model_404s(bridge, monkeypatch):
    monkeypatch.delenv('DUBVIBE_MINI_GEMINI_MODELS', raising=False)
    monkeypatch.delenv('YOUDUB_GEMINI_MODELS', raising=False)
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    client.chat.completions.create.side_effect = openai.APIStatusError('no such model',
        response=httpx.Response(404, request=httpx.Request('POST', 'u')), body=None)
    monkeypatch.setattr(openai, 'OpenAI', lambda **kwargs: client)
    with pytest.raises(WorkerError, match='HTTP 404') as result:
        check_connection({'base_url': 'https://generativelanguage.googleapis.com/v1beta/openai', 'api_key': 'secret'}, bridge)
    assert 'Models tried: "gemini-2.5-flash", "gemini-2.5-flash-lite"' in str(result.value)
