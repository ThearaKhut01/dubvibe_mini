"""Khmer accuracy pass: the provider reviews its own draft before shipping."""

from __future__ import annotations

import json
from dataclasses import replace

from backend.app.v1 import translate
from backend.app.v1.segments import Transcript, read_translation
from backend.tests.test_v1_translate import context, provider  # noqa: F401


def _km_context(context):
    config = context.config.model_copy(update={"target_language": "km"})
    return replace(context, config=config)


def _original(context) -> Transcript:
    return Transcript.model_validate_json(context.input_files["transcript"].read_bytes())


def test_khmer_target_reviews_each_batch_and_ships_the_reviewed_text(context, provider):
    # The stub echoes "译文 " + the input text, so the shipped double prefix
    # proves the review response won over the first-pass draft.
    states: list[str] = []
    result = translate.run(
        replace(_km_context(context), set_external_state=states.append), lambda *args: None)
    kinds = ["review" if "draft" in json.loads(call["messages"][1]["content"])["segments"][0]
             else "draft" for call in provider.calls]
    assert kinds == ["draft", "review", "draft", "review"]
    for call in provider.calls:
        payload = json.loads(call["messages"][1]["content"])
        keys = set(payload["segments"][0])
        expected = {"segment_id", "source", "draft"} if "draft" in keys else {"segment_id", "text"}
        assert all(set(item) == expected for item in payload["segments"])
    translation = read_translation(result.output_files["translation"], _original(context),
                                   stage="translate")
    assert len(translation.segments) == 23
    assert all(segment.text.startswith("译文 译文 ") for segment in translation.segments)
    assert states == ["pending", "succeeded", "pending", "succeeded"] * 2


def test_khmer_review_failure_keeps_the_draft(context, provider):
    def fail_only_review_calls(result):
        if len(provider.calls) % 2 == 0:
            raise ValueError("synthetic review failure")

    provider.mutate = fail_only_review_calls
    states: list[str] = []
    result = translate.run(
        replace(_km_context(context), set_external_state=states.append), lambda *args: None)
    translation = read_translation(result.output_files["translation"], _original(context),
                                   stage="translate")
    assert len(translation.segments) == 23
    assert all(segment.text.startswith("译文 ") for segment in translation.segments)
    assert all(not segment.text.startswith("译文 译文 ") for segment in translation.segments)
    assert states == ["pending", "succeeded", "pending", "failed"] * 2


def test_non_khmer_targets_do_not_emit_review_calls(context, provider):
    states: list[str] = []
    result = translate.run(replace(context, set_external_state=states.append), lambda *args: None)
    assert len(provider.calls) == 2
    payloads = [json.loads(call["messages"][1]["content"]) for call in provider.calls]
    assert all("text" in item for payload in payloads for item in payload["segments"])
    translation = read_translation(result.output_files["translation"], _original(context),
                                   stage="translate")
    assert len(translation.segments) == 23
