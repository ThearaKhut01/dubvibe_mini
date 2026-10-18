"""Local translation providers: dispatch, cancellation and pure-fake inference."""

from __future__ import annotations

import json
import sys
from contextlib import nullcontext
from dataclasses import replace
from types import SimpleNamespace

import pytest

from backend.app.v1 import local_translate, translate
from backend.app.v1.contracts import TaskConfig
from backend.app.v1.errors import ApiError
from backend.app.v1.segments import Transcript, read_translation
from backend.app.v1.steps import StageCancelled, StageContext


def make_config(adapter=None, model=None, device=None, target=None, source=None):
    payload = {"source_language": source or "en", "target_language": "zh", "output_mode": "subtitles",
               "keep_background": False,
               "asr": {"adapter": "whisper", "model": "test-whisper", "device": "cpu"},
               "translation": {"adapter": "openai", "model": "saved-model", "device": "remote"},
               "tts": None, "separation": None}
    if adapter:
        payload["translation"].update(adapter=adapter)
    if model:
        payload["translation"].update(model=model)
    if device:
        payload["translation"].update(device=device)
    if target:
        payload["target_language"] = target
    return TaskConfig.model_validate(payload)


@pytest.fixture
def context(tmp_path):
    def build(config, *, language="en", count=3):
        transcript = tmp_path / "transcript.json"
        transcript.write_text(json.dumps({"detected_language": language, "segments": [
            {"id": f"segment-{index:06d}", "start_ms": index * 100, "end_ms": index * 100 + 90,
             "text": f" Original {index}. "} for index in range(count)]}, ensure_ascii=False))
        (tmp_path / "work").mkdir()
        return StageContext(task_id="00000000-0000-0000-0000-000000000001", attempt=1,
                            stage="translate", config=config, input_files={"transcript": transcript},
                            work_dir=tmp_path / "work")
    return build


class QuietTokenizerBase:
    def convert_tokens_to_ids(self, code):
        return 424242


@pytest.fixture
def nllb(monkeypatch, tmp_path):
    root = tmp_path / "nllb-models" / "NLLB-200-distilled-600M"
    root.mkdir(parents=True)
    for name in local_translate.NLLB_FILES:
        (root / name).write_bytes(b"fixture weights")
    monkeypatch.setenv("YOUDUB_NLLB_MODEL_DIR", str(root))
    state = SimpleNamespace(devices=[], load=[], decode=["译文 一", "译文 二", "译文 三"],
                            generate=[], requests=[], tokenizer_sources=[])
    state.root = root

    class Model:
        def to(self, device):
            state.devices.append(device)
            return self

        def eval(self):
            return self

        def generate(self, **kwargs):
            state.generate.append(kwargs)
            return object()

    class Tokenizer(QuietTokenizerBase):
        def __call__(self, texts, **kwargs):
            state.requests.append(list(texts))
            return dict(kwargs)

        def batch_decode(self, output, **kwargs):
            return list(state.decode)

    def load_seq2seq(path, dtype=None):
        state.load.append(path)
        assert dtype == "float32-fake"
        return Model()

    def load_tokenizer(path, src_lang=None):
        state.tokenizer_sources.append((path, src_lang))
        return Tokenizer()

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(__spec__=SimpleNamespace(name="torch"),
                                                              inference_mode=nullcontext, float32="float32-fake"))
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        __spec__=SimpleNamespace(name="transformers"),
        AutoModelForSeq2SeqLM=SimpleNamespace(from_pretrained=load_seq2seq),
        AutoTokenizer=SimpleNamespace(from_pretrained=load_tokenizer)))
    return state


@pytest.fixture
def hy_mt(monkeypatch, tmp_path):
    root = tmp_path / "hy-mt-models" / "HY-MT1.5-1.8B"
    root.mkdir(parents=True)
    for name in local_translate.HY_MT_FILES:
        (root / name).write_bytes(b"fixture weights")
    monkeypatch.setenv("YOUDUB_HY_MT_MODEL_DIR", str(root))
    state = SimpleNamespace(devices=[], load=[], generate=[], prompts=[], tokenizer_paths=[])
    state.root = root

    class PromptIds:
        shape = (1, 64)

        def to(self, device):
            state.devices.append(device)
            return self

    class Model:
        device = "cpu-fake"

        def to(self, device):
            state.devices.append(device)
            return self

        def eval(self):
            return self

        def generate(self, input_ids, **kwargs):
            state.generate.append(kwargs)
            return [[0] * input_ids.shape[1] + [1, 2, 3]]

    class Tokenizer(QuietTokenizerBase):
        def apply_chat_template(self, messages, **kwargs):
            assert kwargs["add_generation_prompt"] is True
            state.prompts.append(messages[0]["content"])
            return {"input_ids": PromptIds()}

        def decode(self, tail, **kwargs):
            assert kwargs["skip_special_tokens"] is True
            return " 译文 。"

    def load_causal(path, dtype=None):
        state.load.append(path)
        assert dtype == "bfloat16-fake"
        return Model()

    def load_tokenizer(path, src_lang=None):
        state.tokenizer_paths.append(path)
        return Tokenizer()

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(__spec__=SimpleNamespace(name="torch"),
                                                              inference_mode=nullcontext, bfloat16="bfloat16-fake"))
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        __spec__=SimpleNamespace(name="transformers"),
        AutoModelForCausalLM=SimpleNamespace(from_pretrained=load_causal),
        AutoTokenizer=SimpleNamespace(from_pretrained=load_tokenizer)))
    return state


def test_local_nllb_translates_every_segment_with_forced_target(context, nllb):
    stage = context(make_config(adapter="nllb", model=local_translate.NLLB_VARIANT, device="cpu"))
    result = translate.run(stage, lambda *args: None)
    original = Transcript.model_validate_json(stage.input_files["transcript"].read_bytes())
    translated = read_translation(result.output_files["translation"], original, stage="translate")
    mapping = translated.match(original)
    assert list(mapping.values()) == ["译文 一", "译文 二", "译文 三"]
    assert nllb.devices == ["cpu"]
    assert nllb.tokenizer_sources == [(str(nllb.root), "eng_Latn")]
    assert len(nllb.requests) == 1 and len(nllb.requests[0]) == 3
    assert nllb.generate[0]["forced_bos_token_id"] == 424242
    assert nllb.generate[0]["max_new_tokens"] == 512
    assert nllb.generate[0]["padding"] is True


def test_local_translation_run_writes_no_file_for_blank_output(context, nllb):
    nllb.decode = ["", "译文 二", "译文 三"]
    stage = context(make_config(adapter="nllb", model=local_translate.NLLB_VARIANT, device="cpu"))
    with pytest.raises(ApiError) as error:
        translate.run(stage, lambda *args: None)
    assert error.value.content["error"]["code"] == "INVALID_PROVIDER_RESULT"
    assert error.value.content["error"]["action"] == "retry"
    assert not (stage.work_dir / "translation.json").exists()


def test_local_nllb_cancellation_propagates_without_output(context, nllb):
    stage = context(make_config(adapter="nllb", model=local_translate.NLLB_VARIANT, device="cpu"))
    with pytest.raises(StageCancelled):
        translate.run(replace(stage, check_cancel=lambda: (_ for _ in ()).throw(StageCancelled())),
                      lambda *args: None)
    assert not (stage.work_dir / "translation.json").exists()


@pytest.mark.parametrize("mutate", [
    lambda root: (root / "pytorch_model.bin").unlink(),
    lambda root: (root / "tokenizer.json").write_bytes(b""),
])
def test_local_nllb_missing_or_incomplete_weights_block_translation(context, nllb, mutate):
    mutate(nllb.root)
    stage = context(make_config(adapter="nllb", model=local_translate.NLLB_VARIANT, device="cpu"))
    with pytest.raises(ApiError) as error:
        translate.run(stage, lambda *args: None)
    assert error.value.content["error"]["code"] == "MODEL_NOT_READY"
    assert not (stage.work_dir / "translation.json").exists()


def test_local_device_must_not_be_remote(context, nllb):
    stage = context(make_config(adapter="nllb", model=local_translate.NLLB_VARIANT, device="remote"))
    with pytest.raises(ApiError) as error:
        translate.run(stage, lambda *args: None)
    assert error.value.content["error"]["code"] == "INVALID_CONFIG"


def test_local_model_must_match_the_installed_variant(context, nllb):
    stage = context(make_config(adapter="nllb", model="foreign-variant", device="cpu"))
    with pytest.raises(ApiError) as error:
        translate.run(stage, lambda *args: None)
    assert error.value.content["error"]["code"] == "MODEL_NOT_READY"
    assert nllb.load == []
    assert not (stage.work_dir / "translation.json").exists()


def test_local_hy_mt_uses_the_card_prompt_for_khmer_target(context, hy_mt):
    stage = context(make_config(adapter="hy_mt", model=local_translate.HY_MT_VARIANT, device="cpu", target="km"))
    result = translate.run(stage, lambda *args: None)
    original = Transcript.model_validate_json(stage.input_files["transcript"].read_bytes())
    translated = read_translation(result.output_files["translation"], original, stage="translate")
    assert len(translated.match(original)) == 3
    assert len(hy_mt.generate) == 3
    assert all(options["max_new_tokens"] == 512 and options["top_k"] == 20
               for options in hy_mt.generate)
    assert all(prompt.startswith("Translate the following segment into Khmer,")
               for prompt in hy_mt.prompts)
    assert hy_mt.devices == ["cpu", "cpu-fake", "cpu-fake", "cpu-fake"]
    assert (stage.work_dir / "translation.json").exists()


@pytest.mark.parametrize("language,target", [("zh", "en"), ("en", "zh")])
def test_local_hy_mt_uses_the_chinese_template_for_zh_pairs(context, hy_mt, language, target):
    stage = context(make_config(adapter="hy_mt", model=local_translate.HY_MT_VARIANT, device="cpu", target=target,
                                source=language), language=language, count=1)
    translate.run(stage, lambda *args: None)
    assert hy_mt.prompts[0].startswith("将以下文本翻译为")
    assert "不要额外解释" in hy_mt.prompts[0]


def test_run_translation_rejects_unsupported_language_pairs_without_imports(monkeypatch, tmp_path):
    arguments = []

    def forbidden(name):
        arguments.append(name)
        return None

    root = tmp_path / "empty"
    monkeypatch.setenv("YOUDUB_NLLB_MODEL_DIR", str(root))
    monkeypatch.setattr(local_translate.importlib.util, "find_spec", forbidden)
    with pytest.raises(ApiError) as error:
        local_translate.run_translation("nllb", "de", "zh", ["text"], "cpu", lambda: None, lambda *args: None)
    assert error.value.content["error"]["code"] == "MODEL_NOT_READY"
    assert error.value.content["error"]["stage"] == "translate"
    assert arguments == []


def test_run_translation_reports_missing_dependencies(monkeypatch, tmp_path):
    import importlib.util

    root = tmp_path / "nllb" / "NLLB-200-distilled-600M"
    root.mkdir(parents=True)
    for name in local_translate.NLLB_FILES:
        (root / name).write_bytes(b"fixture weights")
    monkeypatch.setenv("YOUDUB_NLLB_MODEL_DIR", str(root))
    original = importlib.util.find_spec

    def missing_transformers(name):
        if name == "transformers":
            return None
        return original(name)

    monkeypatch.setattr(importlib.util, "find_spec", missing_transformers)
    with pytest.raises(ApiError) as error:
        local_translate.run_translation("nllb", "en", "zh", ["text"], "cpu", lambda: None, lambda *args: None)
    assert error.value.content["error"]["code"] == "MODEL_NOT_READY"
    assert "Install transformers" in error.value.content["error"]["message"]
