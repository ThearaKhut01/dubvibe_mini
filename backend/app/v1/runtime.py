"""Model metadata and cached, model-free accelerator probes for local providers."""
from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import platform
import shutil
from collections.abc import Mapping, Sequence
from copy import deepcopy
from importlib.machinery import PathFinder
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..config import ffmpeg_binary, ffprobe_binary, env
from ..accelerators import detect_devices
from .segments import LANGUAGES


INSTANCE_ID = str(uuid4())


def _max_video_duration_ms() -> int:
    """Long videos are allowed; the ceiling only stops runaway multi-hour jobs.

    Override with DUBVIBE_MINI_MAX_VIDEO_MINUTES (or YOUDUB_...). Invalid or
    non-positive values fall back to the 60-minute default.
    """
    try:
        minutes = float(env("MAX_VIDEO_MINUTES", "60"))
    except ValueError:
        return 60 * 60_000
    if minutes <= 0:
        return 60 * 60_000
    return min(int(minutes * 60_000), 24 * 60 * 60_000)


# Media admission limits shared by the official prepare operation and Host.
RUNTIME_LIMITS: dict[str, Any] = {
    "max_file_bytes": 4 * 1024 * 1024 * 1024,
    "max_video_duration_ms": _max_video_duration_ms(),
    "max_video_width": 1920,
    "max_video_height": 1920,
    "max_frame_rate": 60,
    "video_suffixes": [".mp4", ".mov", ".mkv", ".webm"],
    "video_codecs": ["h264", "hevc", "vp8", "vp9", "av1"],
    "audio_codecs": ["aac", "mp3", "pcm_s16le", "pcm_s24le", "pcm_f32le", "opus", "vorbis", "flac"],
}


def _detect_devices() -> list[dict[str, Any]]:
    return deepcopy(detect_devices())


def _model(
    model_id: str, devices: list[str], source_languages: list[str], target_languages: list[str],
    *, max_audio_duration_ms: int | None = None, max_text_chars: int | None = None,
    max_reference_duration_ms: int | None = None,
) -> dict[str, Any]:
    return {
        "id": model_id, "devices": devices, "source_languages": source_languages,
        "target_languages": target_languages, "voice_modes": [], "voices": [],
        "input_limits": {"max_audio_duration_ms": max_audio_duration_ms,
                         "max_text_chars": max_text_chars, "max_reference_duration_ms": max_reference_duration_ms},
    }


def _whisper_models(devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    if importlib.util.find_spec("whisper") is None or importlib.util.find_spec("torch") is None:
        return [], "Local Whisper requires the openai-whisper and torch packages."
    if importlib.util.find_spec("nltk") is None:
        return [], "Whisper English sentence splitting requires nltk==3.10.3 and the punkt_tab data."
    from nltk.data import find

    try:
        punkt = Path(str(find("tokenizers/punkt_tab/english/")))
    except LookupError:
        return [], "Whisper English sentence data is missing; run .venv/Scripts/python -m nltk.downloader punkt_tab."
    if any(not (punkt / name).is_file() or (punkt / name).stat().st_size == 0 for name in (
        "collocations.tab", "sent_starters.txt", "abbrev_types.txt", "ortho_context.tab",
    )):
        return [], "The Whisper English punkt_tab data is incomplete; reinstall punkt_tab."
    if shutil.which(ffmpeg_binary()) is None or shutil.which(ffprobe_binary()) is None:
        return [], "Local media processing requires executable FFmpeg and FFprobe."
    # Whisper's own load_audio invokes `ffmpeg` by name, independently of the
    # application's configured binary paths used by prepare/export.
    if shutil.which("ffmpeg") is None:
        return [], "Whisper ASR also needs an ffmpeg executable on PATH; configuring FFMPEG_PATH alone is not enough to read audio."
    from .asr import available_models

    # OpenAI Whisper stores sparse alignment heads; MPS cannot move these
    # buffers. Keep its ASR on CPU while other providers can use Apple MPS.
    available_devices = [device["id"] for device in devices if device["available"] and device["id"] != "mps"]
    if not available_devices:
        return [], "No CPU/CUDA/ROCm device can run Whisper."
    models = [_model(
        name, available_devices.copy(), ["auto", "en"] if name.endswith(".en") else ["auto", *LANGUAGES], [],
        max_audio_duration_ms=RUNTIME_LIMITS["max_video_duration_ms"],
    ) for name in available_models()]
    return models, None if models else "No non-empty local Whisper .pt checkpoints found; install them into the Whisper models directory."


# OpenAI-compatible remote translation adapters. Gemini and CodeCraft expose
# OpenAI-compatible endpoints, so they use the same client with their own
# base_url and key; `custom` is any other OpenAI-compatible service
# (OpenRouter, OneAPI, LM Studio, self-hosted gateways…). The order below is
# also the automatic fallback order when a task's primary provider fails.
TRANSLATION_ADAPTERS = ("openai", "gemini", "codecraft", "custom")

# Per-adapter translation model fallbacks: tests and fallback runs use these
# unless the user configures a model for the adapter. Envs are the usual
# DUBVIBE_MINI_* (legacy YOUDUB_* aliases accepted).
TRANSLATION_MODEL_DEFAULTS = {
    "openai": ("TRANSLATION_MODELS", "gpt-4.1-mini"),
    "gemini": ("GEMINI_MODELS", "gemini-2.5-flash, gemini-2.5-flash-lite"),
    "codecraft": ("CODECRAFT_MODELS", "gpt-5.6-luna, gpt-4.1-mini"),
    "custom": ("TRANSLATION_MODELS", "gpt-4.1-mini"),
}


def default_translation_model(adapter: str) -> str:
    env_name, fallback = TRANSLATION_MODEL_DEFAULTS.get(adapter, ("TRANSLATION_MODELS", "gpt-4.1-mini"))
    configured = env(env_name, fallback)
    return next((name.strip() for name in configured.split(",") if name.strip()), fallback)


def _translation_models(
    connections: Sequence[Mapping[str, Any]], translation_model: str | None, adapter: str,
) -> tuple[list[dict[str, Any]], str | None]:
    if importlib.util.find_spec("openai") is None:
        return [], "OpenAI-compatible translation requires the openai SDK."
    from .contracts import _valid_base_url
    # Availability is judged per probed adapter: the openai probe must not
    # report a gemini connection ready, and vice versa.
    connection = next((item for item in connections if item["adapter"] == adapter), None)
    if connection is None:
        return [], "Provider connection is not configured."
    try:
        _valid_base_url(str(connection.get("base_url", "")))
    except ValueError:
        return [], "Provider base URL is invalid."
    if not connection.get("has_api_key", False):
        return [], "Provider API key is not configured."
    # These are configured candidates, not a discovery/health response from the
    # provider. No client is constructed and no remote request is made here.
    env_name, env_default = TRANSLATION_MODEL_DEFAULTS.get(adapter, ("TRANSLATION_MODELS", "gpt-4.1-mini"))
    candidates = [name.strip() for name in env(env_name, env_default).split(",") if name.strip()]
    if translation_model and translation_model.strip():
        candidates.append(translation_model.strip())
    from .translate import MAX_TEXT_CHARS
    models = [_model(name, ["remote"], list(LANGUAGES), list(LANGUAGES), max_text_chars=MAX_TEXT_CHARS)
              for name in dict.fromkeys(candidates)]
    return models, None if models else f"No translation models configured; set DUBVIBE_MINI_{env_name}."


# Local translation models report subsections of the pipeline languages; a
# provider outside its own language table stays out of the fallback chain.
def _local_translation_models(devices: list[dict[str, Any]], adapter: str) -> tuple[list[dict[str, Any]], str | None]:
    from .local_translate import available_models, inference_dependencies, supported_languages, variant

    dependencies = [name for name in inference_dependencies(adapter) if importlib.util.find_spec(name) is None]
    if dependencies:
        return [], f"Local translation model {variant(adapter)} is missing runtime dependencies: {', '.join(dependencies)}."
    available_devices = [device["id"] for device in devices if device["available"]]
    if not available_devices:
        return [], "No CPU/CUDA/ROCm/MPS device can run local translation models."
    languages = [code for code in LANGUAGES if code in supported_languages(adapter)]
    models = [_model(name, available_devices.copy(), languages, languages, max_text_chars=2000)
              for name in available_models(adapter)]
    return models, None if models else f"No complete local {variant(adapter)} checkpoint files found."


def _nllb_models(devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    return _local_translation_models(devices, "nllb")


def _hy_mt_models(devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    return _local_translation_models(devices, "hy_mt")


def _voxcpm_models(devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    dependencies = ("voxcpm", "torch", "torchaudio", "numpy", "soundfile", "transformers", "librosa",
                    "einops", "huggingface_hub", "safetensors", "tqdm", "packaging")
    missing = [name for name in dependencies if importlib.util.find_spec(name) is None]
    if missing:
        return [], f"Local VoxCPM2 is missing runtime dependencies: {', '.join(missing)}."
    # Check installed distribution metadata, never import VoxCPM during a GET.
    from packaging.version import InvalidVersion, Version
    try:
        supported = Version(importlib.metadata.version("voxcpm")) >= Version("2.0.3")
    except (importlib.metadata.PackageNotFoundError, InvalidVersion):
        supported = False
    if not supported:
        return [], "Local VoxCPM2 requires voxcpm>=2.0.3 for explicit CPU/CUDA/ROCm/MPS device selection."
    if shutil.which(ffmpeg_binary()) is None or shutil.which(ffprobe_binary()) is None:
        return [], "Local media processing requires executable FFmpeg and FFprobe."
    from .tts import MAX_REFERENCE_DURATION_MS, available_models

    available_devices = [device["id"] for device in devices if device["available"]]
    if not available_devices:
        return [], "No CPU/CUDA/ROCm/MPS device can run VoxCPM2."
    models = [_model(name, available_devices.copy(), list(LANGUAGES), list(LANGUAGES),
                     max_reference_duration_ms=MAX_REFERENCE_DURATION_MS)
              for name in available_models()]
    for model in models:
        model["voice_modes"] = ["source_clone"]
    return models, None if models else "Local VoxCPM2 checkpoints or tokenizer assets are incomplete."


# Edge TTS synthesizes on Microsoft's public speech endpoint with preset voices;
# it sends only text and needs no subscription key or local model.
EDGE_MODEL = "Edge TTS"

# Curated offline voice list; the service itself validates new voices at run time.
EDGE_VOICES = (
    ("en", "en-US-AriaNeural", "Aria (US English)"), ("en", "en-US-GuyNeural", "Guy (US English)"),
    ("en", "en-US-AndrewNeural", "Andrew (US English)"), ("en", "en-US-EmmaNeural", "Emma (US English)"),
    ("en", "en-GB-SoniaNeural", "Sonia (British English)"), ("en", "en-GB-RyanNeural", "Ryan (British English)"),
    ("zh", "zh-CN-XiaoxiaoNeural", "Xiaoxiao (Simplified Chinese)"), ("zh", "zh-CN-YunxiNeural", "Yunxi (Simplified Chinese)"),
    ("zh", "zh-CN-XiaoyiNeural", "Xiaoyi (Simplified Chinese)"), ("zh", "zh-CN-YunjianNeural", "Yunjian (Simplified Chinese)"),
    ("zh", "zh-HK-HiuMaanNeural", "Hiu Maan (Cantonese)"), ("zh", "zh-TW-HsiaoChenNeural", "Hsiao Chen (Taiwanese Mandarin)"),
    ("ja", "ja-JP-NanamiNeural", "Nanami (Japanese)"), ("ja", "ja-JP-KeitaNeural", "Keita (Japanese)"),
    ("km", "km-KH-SreymomNeural", "Srey Mom (Khmer)"), ("km", "km-KH-PisethNeural", "Piseth (Khmer)"),
)


def _edge_models(_devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    if importlib.util.find_spec("edge_tts") is None:
        return [], "Edge TTS requires the edge-tts package."
    if shutil.which(ffmpeg_binary()) is None or shutil.which(ffprobe_binary()) is None:
        return [], "Local media processing requires executable FFmpeg and FFprobe."
    model = _model(EDGE_MODEL, ["remote"], [], list(LANGUAGES))
    model["voice_modes"] = ["preset"]
    model["voices"] = [{"id": voice_id, "name": name, "languages": [language]}
                       for language, voice_id, name in EDGE_VOICES]
    return [model], None


def _demucs_models(devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    # The child selects this vendored module path, independently of site-packages.
    source = Path(__file__).resolve().parents[3] / "submodule" / "demucs"
    if PathFinder.find_spec("demucs", [str(source)]) is None:
        return [], "The Demucs submodule source is missing from the repository."
    dependencies = ("torch", "torchaudio", "numpy", "soundfile", "julius", "dora", "omegaconf",
                    "einops", "openunmix", "tqdm")
    missing = [name for name in dependencies if importlib.util.find_spec(name) is None]
    if missing:
        return [], f"Local Demucs is missing runtime dependencies: {', '.join(missing)}."
    if shutil.which(ffmpeg_binary()) is None or shutil.which(ffprobe_binary()) is None:
        return [], "Local media processing requires executable FFmpeg and FFprobe."
    from .separate import available_models

    available_devices = [device["id"] for device in devices if device["available"]]
    if not available_devices:
        return [], "No CPU/CUDA/ROCm/MPS device can run Demucs."
    models = [_model(name, available_devices.copy(), [], [],
                     max_audio_duration_ms=RUNTIME_LIMITS["max_video_duration_ms"])
              for name in available_models()]
    return models, None if models else "No non-empty local htdemucs checkpoints found."


def _subtitle_alignment_models(devices: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    dependencies = ("transformers", "torch", "numpy", "soundfile", "librosa", "packaging")
    missing = [name for name in dependencies if importlib.util.find_spec(name) is None]
    if missing:
        return [], f"Local Qwen subtitle alignment is missing runtime dependencies: {', '.join(missing)}."
    from packaging.version import InvalidVersion, Version
    try:
        version = Version(importlib.metadata.version("transformers"))
        supported = Version("5.17") <= version < Version("6")
    except (importlib.metadata.PackageNotFoundError, InvalidVersion):
        supported = False
    if not supported:
        return [], "Local Qwen subtitle alignment requires transformers>=5.17,<6."
    from .forced_alignment import available_models

    available_devices = [device["id"] for device in devices if device["available"]]
    if not available_devices:
        return [], "No CPU/CUDA/ROCm/MPS device can run Qwen subtitle alignment."
    models = [_model(name, available_devices.copy(), [], ["en", "zh"], max_audio_duration_ms=300_000)
              for name in available_models()]
    return models, None if models else "Local Qwen3-ForcedAligner-0.6B-hf checkpoints or tokenizer assets are incomplete."


def runtime_info() -> dict[str, Any]:
    """Environment metadata without probing model assets or credentials."""
    limits = deepcopy(RUNTIME_LIMITS)
    limits["max_file_bytes"] = int(os.getenv("LOCAL_UPLOAD_MAX_BYTES", str(limits["max_file_bytes"])))
    if limits["max_file_bytes"] <= 0:
        raise ValueError("LOCAL_UPLOAD_MAX_BYTES must be a positive integer.")
    system = platform.system()
    platforms = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}
    if system not in platforms:
        raise RuntimeError(f"Unsupported operating system: {system}")
    return {"instance_id": INSTANCE_ID, "platform": platforms[system], "arch": platform.machine(),
            "devices": _detect_devices(), "limits": limits}


def probe_capability(adapter: str, *, connections: Sequence[Mapping[str, Any]] = (),
                     translation_model: str | None = None) -> dict[str, Any]:
    """Inspect exactly one installed provider; no inference or network access."""
    remote_kinds = {"openai": "translation", "gemini": "translation", "codecraft": "translation", "custom": "translation", "edge": "tts"}
    kind = remote_kinds.get(adapter)
    execution = "remote" if adapter in remote_kinds else "local"
    if kind == "translation":
        models, reason = _translation_models(connections, translation_model, adapter)
    elif kind == "tts":
        models, reason = _edge_models(_detect_devices())
    else:
        probes = {"whisper": ("asr", _whisper_models), "voxcpm": ("tts", _voxcpm_models),
                  "demucs": ("separation", _demucs_models),
                  "qwen_forced_aligner": ("subtitle_alignment", _subtitle_alignment_models),
                  "nllb": ("translation", _nllb_models), "hy_mt": ("translation", _hy_mt_models)}
        if adapter not in probes:
            raise ValueError(f"Unknown Python provider: {adapter}")
        kind, probe = probes[adapter]
        models, reason = probe(_detect_devices())
    return {"adapter": adapter, "capability": kind, "execution": execution,
            "available": bool(models), "unavailable_reason": reason,
            "requires_api_key": kind == "translation" and execution == "remote",
            "models": models, "data_sent": ["text"] if execution == "remote" else [],
            "remote_operations": {"submit_mode": "sync", "can_poll": False, "can_cancel": False,
                                  "can_lookup_request_key": False} if execution == "remote" else None}
