"""Local NLLB-200 and Tencent HY-MT translation models: metadata and inference.

The modules here never touch the network. Weights sit in the model directories
managed by the setup service; transformers loads them inside the translation
operation's child process, mirroring local Whisper ASR.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Callable
from pathlib import Path

from ..config import env
from ..paths import data_directory
from .errors import ApiError

NLLB_VARIANT = "NLLB-200-distilled-600M"
HY_MT_VARIANT = "HY-MT1.5-1.8B"

VARIANTS = {"nllb": NLLB_VARIANT, "hy_mt": HY_MT_VARIANT}

# Application language codes mapped to each model's own identifiers. New
# application LANGUAGES must be given codes for both tables to stay eligible.
NLLB_LANG_CODES: dict[str, str] = {
    "en": "eng_Latn", "zh": "zho_Hans", "ja": "jpn_Jpan", "km": "khm_Khmr",
}
HY_MT_NAMES: dict[str, tuple[str, str]] = {
    "en": ("English", "英语"), "zh": ("Chinese", "中文"), "ja": ("Japanese", "日语"), "km": ("Khmer", "高棉语"),
}

NLLB_FILES = ("config.json", "generation_config.json", "pytorch_model.bin", "sentencepiece.bpe.model",
              "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json")
HY_MT_FILES = ("chat_template.jinja", "config.json", "generation_config.json", "model.safetensors",
               "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json")


def variant(adapter: str) -> str:
    try:
        return VARIANTS[adapter]
    except KeyError as exc:
        raise ValueError(f"Unknown local translation adapter: {adapter}") from exc


def directory(adapter: str) -> Path:
    if adapter == "nllb":
        configured = env("NLLB_MODEL_DIR", "").strip()
        return Path(configured).expanduser().resolve() if configured else data_directory() / "models" / "nllb" / NLLB_VARIANT
    if adapter == "hy_mt":
        configured = env("HY_MT_MODEL_DIR", "").strip()
        return Path(configured).expanduser().resolve() if configured else data_directory() / "models" / "hy-mt" / HY_MT_VARIANT
    raise ValueError(f"Unknown local translation adapter: {adapter}")


def required_files(adapter: str) -> tuple[str, ...]:
    if adapter == "nllb":
        return NLLB_FILES
    if adapter == "hy_mt":
        return HY_MT_FILES
    raise ValueError(f"Unknown local translation adapter: {adapter}")


def supported_languages(adapter: str) -> tuple[str, ...]:
    if adapter == "nllb":
        return tuple(NLLB_LANG_CODES)
    if adapter == "hy_mt":
        return tuple(HY_MT_NAMES)
    raise ValueError(f"Unknown local translation adapter: {adapter}")


def available_models(adapter: str) -> list[str]:
    """Report complete checkpoint directories without importing transformers."""
    root = directory(adapter)
    if not root.is_dir():
        return []
    def ready(name: str) -> bool:
        path = root / name
        return path.is_file() and path.stat().st_size > 0
    return [variant(adapter)] if all(ready(name) for name in required_files(adapter)) else []


def inference_dependencies(adapter: str) -> tuple[str, ...]:
    return ("torch", "transformers", "sentencepiece") if adapter == "nllb" else ("torch", "transformers")


def _not_ready(adapter: str, message: str) -> ApiError:
    return ApiError(503, "MODEL_NOT_READY", message, stage="translate")


def run_translation(
    adapter: str, source_language: str, target_language: str, texts: list[str],
    device: str, check_cancel: Callable[[], None],
    progress: Callable[[float | None, str], None],
) -> list[str]:
    """Translate every text in order; runs on a worker thread and may cancel."""
    try:
        variant_char = variant(adapter)
    except ValueError as exc:
        raise ApiError(422, "INVALID_CONFIG", str(exc), stage="translate") from exc
    codes = NLLB_LANG_CODES if adapter == "nllb" else HY_MT_NAMES
    if source_language not in codes or target_language not in codes:
        raise _not_ready(adapter, f"{variant_char} does not support the detected source or target language.")
    missing = [name for name in inference_dependencies(adapter) if importlib.util.find_spec(name) is None]
    if missing:
        raise _not_ready(adapter, f"Install {', '.join(missing)} in the backend environment for {variant_char}.")
    if not available_models(adapter):
        raise _not_ready(adapter,
                         f"The local {variant_char} weights are incomplete; download the model in Local models settings.")

    try:
        import torch
        if adapter == "nllb":
            return _run_nllb(Path(directory(adapter)), source_language, target_language, texts, device,
                             check_cancel, progress)
        return _run_hy_mt(Path(directory(adapter)), source_language, target_language, texts, device,
                          check_cancel, progress)
    except (ImportError, AttributeError, OSError) as exc:
        # Broken torch/transformers installs or unreadable weight files are not
        # transient provider failures; keep them out of the fallback chain.
        raise ApiError(502, "INVALID_PROVIDER_RESULT",
                       f"Local {variant_char} inference could not start: {type(exc).__name__}.",
                       stage="translate", action="retry") from exc


def _batches(count: int, size: int) -> list[slice]:
    return [slice(start, min(start + size, count)) for start in range(0, count, size)]


def _run_nllb(path: Path, source_language: str, target_language: str, texts: list[str], device: str,
              check_cancel: Callable[[], None], progress: Callable[[float | None, str], None]) -> list[str]:
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    source_code, target_code = NLLB_LANG_CODES[source_language], NLLB_LANG_CODES[target_language]
    tokenizer = AutoTokenizer.from_pretrained(str(path), src_lang=source_code)
    model = AutoModelForSeq2SeqLM.from_pretrained(str(path), dtype=torch.float32).to(device).eval()
    forced_bos = tokenizer.convert_tokens_to_ids(target_code)
    translated: list[str] = []
    groups = _batches(len(texts), 8)
    for index, group in enumerate(groups):
        check_cancel()
        progress(index / len(groups), f"Translating batch {index + 1}/{len(groups)}")
        encoded = tokenizer([texts[position] for position in range(group.start, group.stop)], return_tensors="pt",
                            padding=True)
        with torch.inference_mode():
            output = model.generate(**encoded, forced_bos_token_id=forced_bos, max_new_tokens=512)
        translated.extend(tokenizer.batch_decode(output, skip_special_tokens=True))
    progress(1.0, f"Translated {len(translated)} segments")
    return [text.strip() for text in translated]


def _run_hy_mt(path: Path, source_language: str, target_language: str, texts: list[str], device: str,
               check_cancel: Callable[[], None], progress: Callable[[float | None, str], None]) -> list[str]:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(path))
    # The checkpoint is bf16; keeping half precision keeps a 2B model near 4 GB
    # of memory on CPU and GPU alike. CPU bf16 matmul is exact enough for MT.
    model = AutoModelForCausalLM.from_pretrained(str(path), dtype=torch.bfloat16).to(device).eval()
    english_name, chinese_name = HY_MT_NAMES[target_language]
    # The model card mandates the zh template for any ZH<=>XX pair.
    use_zh = "zh" in {source_language, target_language}
    target_name = chinese_name if use_zh else english_name
    translated: list[str] = []
    for index, text in enumerate(texts):
        check_cancel()
        progress(index / len(texts), f"Translating segment {index + 1}/{len(texts)}")
        if use_zh:
            content = f"将以下文本翻译为{target_name}，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}"
        else:
            content = f"Translate the following segment into {target_name}, without additional explanation.\n\n{text}"
        prompt = tokenizer.apply_chat_template([{"role": "user", "content": content}], tokenize=True,
                                               add_generation_prompt=True, return_tensors="pt")
        input_ids = prompt["input_ids"].to(model.device)
        with torch.inference_mode():
            # Subtitle cues stay far below 512 tokens in every supported script;
            # the cap also bounds repetition loops that sampling may start.
            output = model.generate(input_ids, max_new_tokens=512, do_sample=True,
                                    top_k=20, top_p=0.6, temperature=0.7, repetition_penalty=1.05)
        tail = output[0][input_ids.shape[1]:]
        translated.append(tokenizer.decode(tail, skip_special_tokens=True).strip())
    progress(1.0, f"Translated {len(translated)} segments")
    return translated
