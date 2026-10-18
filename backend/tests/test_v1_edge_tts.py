from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.app.v1 import edge_process, media, tts
from backend.app.v1.audio_segments import read_speech_clips
from backend.app.v1.contracts import TaskConfig
from backend.app.v1.errors import ApiError
from backend.app.v1.segments import Transcript
from backend.app.v1.steps import StageContext


@pytest.fixture
def context(tmp_path, monkeypatch):
    transcript = {"detected_language": "en", "segments": [
        {"id": "one", "start_ms": 0, "end_ms": 1000, "text": "Original A1"},
        {"id": "two", "start_ms": 1000, "end_ms": 2000, "text": "Original B"},
    ]}
    transcript_path, translation_path = tmp_path / "transcript.json", tmp_path / "translation.json"
    transcript_path.write_text(json.dumps(transcript), encoding="utf-8")
    translation_path.write_text(json.dumps({"source_language": "en", "target_language": "zh", "segments": [
        {"segment_id": "two", "text": "第二段。"}, {"segment_id": "one", "text": " 第一段。\n"},
    ]}, ensure_ascii=False), encoding="utf-8")
    config = TaskConfig.model_validate({
        "source_language": "en", "target_language": "zh", "output_mode": "dubbing", "keep_background": False,
        "asr": {"adapter": "whisper", "model": "tiny", "device": "cpu"},
        "translation": {"adapter": "openai", "model": "test-model", "device": "remote"},
        "tts": {"adapter": "edge", "model": "Edge TTS", "device": "remote",
                "voice": {"mode": "preset", "id": "zh-CN-XiaoxiaoNeural"}},
        "separation": None,
    })
    return StageContext(task_id="00000000-0000-0000-0000-000000000002", attempt=1, stage="tts", config=config,
                        input_files={"transcript": transcript_path, "translation": translation_path},
                        work_dir=tmp_path / "work")


@pytest.fixture
def edge_process_run(monkeypatch):
    real_run = media._run_media
    state = SimpleNamespace(commands=[], clips=[])

    def run(command, **kwargs):
        if not command[1].endswith("edge_process.py"):
            return real_run(command, **kwargs)
        kwargs["check_cancel"]()
        state.commands.append(command)
        request_path = Path(command[command.index("--request-path") + 1])
        state.clips = json.loads(request_path.read_text(encoding="utf-8"))["clips"]
        for clip in state.clips:
            sf.write(clip["output_path"], np.full(24_000 // 4, 0.1), 24_000, subtype="PCM_16")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(media, "_run_media", run)
    return state


def test_edge_uses_preset_voices_and_needs_no_source_references(context, edge_process_run):
    before = {name: context.input_files[name].read_bytes() for name in ("transcript", "translation")}
    result = tts.run(context, lambda *_: None, prepared_references={"unrelated": "must be ignored"})
    assert {name: context.input_files[name].read_bytes() for name in before} == before
    clips = edge_process_run.clips
    assert [clip["segment_id"] for clip in clips] == ["one", "two"]
    assert [clip["text"] for clip in clips] == [" 第一段。\n", "第二段。"]
    assert all(clip["voice"] == "zh-CN-XiaoxiaoNeural" for clip in clips)
    assert all("reference" not in clip for clip in clips)
    transcript = Transcript.model_validate_json(before["transcript"])
    payload = read_speech_clips(result.output_files["speech_clips"], transcript)
    assert [clip.path for clip in payload.clips] == ["tts/000001.wav", "tts/000002.wav"]
    assert all(clip.sample_rate_hz == 24_000 and clip.channels == 1 and clip.duration_ms == 250
               for clip in payload.clips)
    command = edge_process_run.commands[0]
    from backend.app.config import ffmpeg_binary
    assert command[command.index("--ffmpeg") + 1] == ffmpeg_binary()


def test_edge_reports_that_subtitles_are_sent_to_microsoft(context, edge_process_run):
    messages = []
    tts.run(context, lambda value, message: messages.append((value, message)))
    assert edge_process_run.commands
    assert any("sent to Microsoft" in message for _, message in messages)


@pytest.mark.parametrize("invalid,want", [
    ("model", ("INVALID_CONFIG", 422)), ("device", ("INVALID_CONFIG", 422)),
    ("voice-mode", ("INVALID_CONFIG", 422)), ("voice-id", ("INVALID_CONFIG", 422)),
    ("edge-package", ("MODEL_NOT_READY", 503)), ("ffmpeg", ("RUNTIME_UNAVAILABLE", 503)),
])
def test_edge_rejects_invalid_configurations_before_any_child_process(context, edge_process_run, monkeypatch, invalid, want):
    raw = context.config.model_dump(mode="json")
    if invalid == "model":
        raw["tts"]["model"] = "VoxCPM2"
    elif invalid == "device":
        raw["tts"]["device"] = "cpu"
    elif invalid == "voice-mode":
        raw["tts"]["voice"] = {"mode": "source_clone"}
        raw["separation"] = {"adapter": "demucs", "model": "htdemucs", "device": "cpu"}
    elif invalid == "voice-id":
        raw["tts"]["voice"] = {"mode": "preset", "id": "NotAnEdgeVoice"}
    elif invalid == "edge-package":
        real_find_spec = importlib.util.find_spec
        monkeypatch.setattr(importlib.util, "find_spec",
                            lambda name: None if name == "edge_tts" else real_find_spec(name))
    else:
        monkeypatch.setattr(tts.shutil, "which", lambda name: None)
    config = TaskConfig.model_validate(raw)
    context = replace(context, config=config)
    with pytest.raises(ApiError) as error:
        tts.run(context, lambda *_: None)
    assert (error.value.content["error"]["code"], error.value.status_code) == want
    assert not edge_process_run.commands
    assert not (context.work_dir / "speech_clips.json").exists()


def test_unsupported_language_message_names_the_provider(context, edge_process_run):
    payload = json.loads(context.input_files["translation"].read_text())
    payload["target_language"] = "es"
    for segment in payload["segments"]:
        segment["text"] = "译文"
    context.input_files["translation"].write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    raw = context.config.model_dump(mode="json")
    raw["target_language"] = "es"
    context = replace(context, config=TaskConfig.model_validate(raw))
    with pytest.raises(ApiError, match="Edge TTS supports"):
        tts.run(context, lambda *_: None)
    assert not edge_process_run.commands
    assert not (context.work_dir / "speech_clips.json").exists()


@pytest.mark.parametrize("stderr,json_code,status,action", [
    ('{"code": "INVALID_PROVIDER_RESULT", "message": "Connection reset"}', "INVALID_PROVIDER_RESULT", 502, "retry"),
    ('{"code": "MODEL_NOT_READY", "message": "Install edge-tts."}', "MODEL_NOT_READY", 503, "adjust_settings"),
    ("Traceback", "WORKER_EXITED", 502, "retry"),
])
def test_edge_child_failures_map_to_api_errors(context, monkeypatch, capsys, stderr, json_code, status, action):
    def run(command, **kwargs):
        assert command[1].endswith("edge_process.py")
        return subprocess.CompletedProcess(command, 1, "", stderr)

    monkeypatch.setattr(media, "_run_media", run)
    with pytest.raises(ApiError) as error:
        tts.run(context, lambda *_: None)
    assert error.value.content["error"]["code"] == json_code
    assert error.value.content["error"]["action"] == action
    assert error.value.content["error"]["stage"] == "tts"
    assert not (context.work_dir / "speech_clips.json").exists()


def test_missing_translation_input_fails_before_edge_children(context, edge_process_run):
    context.input_files["translation"].unlink()
    with pytest.raises(ApiError) as error:
        tts.run(context, lambda *_: None)
    assert error.value.content["error"]["code"] == "INPUT_MISSING"
    assert not edge_process_run.commands


# ---- edge_process child -----------------------------------------------------


def child_request(tmp_path):
    clips = [{"segment_id": f"seg-{index}", "text": text, "voice": "zh-CN-XiaoxiaoNeural",
              "output_path": str(tmp_path / f"child-{index}.wav")}
             for index, text in enumerate([" 精确译文。", "第二段译文。"])]
    path = tmp_path / "request.json"
    path.write_text(json.dumps({"clips": clips}, ensure_ascii=False), encoding="utf-8")
    arguments = ["--request-path", str(path), "--ffmpeg", "ffmpeg"]
    return clips, arguments


class FakeCommunicate:
    instantiated = []

    def __init__(self, text, voice, **kwargs):
        FakeCommunicate.instantiated.append({"text": text, "voice": voice})

    async def save(self, path):
        Path(path).write_bytes(b"edge mp3 bytes")


@pytest.fixture
def fake_edge(monkeypatch):
    FakeCommunicate.instantiated.clear()
    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=FakeCommunicate))
    converted = []

    def fake_run(command, capture_output=True, text=True):
        sf.write(command[-1], np.full(24_000, 0.1), 24_000, subtype="PCM_16")
        converted.append(command)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(edge_process.subprocess, "run", fake_run)
    return SimpleNamespace(converted=converted)


def test_child_synthesizes_each_text_with_ffmpeg_conversion(tmp_path, fake_edge):
    clips, arguments = child_request(tmp_path)
    assert edge_process.main(arguments) == 0
    assert FakeCommunicate.instantiated == [
        {"text": clip["text"], "voice": clip["voice"]} for clip in clips]
    for clip in clips:
        path = Path(clip["output_path"])
        info = sf.info(path)
        assert (info.format, info.samplerate, info.channels) == ("WAV", 24_000, 1)
        assert not path.with_suffix(".mp3").exists()
    assert [command[-1] for command in fake_edge.converted] == [clip["output_path"] for clip in clips]


def test_child_rejects_invalid_request_without_any_synth(tmp_path, fake_edge, capsys):
    path = tmp_path / "request.json"
    path.write_text(json.dumps({"clips": [{"segment_id": "one", "text": "  ", "voice": "v", "output_path": str(tmp_path / "o.wav")}]}))
    assert edge_process.main(["--request-path", str(path), "--ffmpeg", "ffmpeg"]) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "INPUT_MISSING"
    assert FakeCommunicate.instantiated == []


def test_child_missing_edge_package_is_explicit(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "edge_tts", None)
    _, arguments = child_request(tmp_path)
    assert edge_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "MODEL_NOT_READY"


def test_child_failed_synthesis_is_not_retried(tmp_path, monkeypatch, capsys):
    class BrokenCommunicate:
        def __init__(self, text, voice):
            pass

        async def save(self, path):
            raise RuntimeError("connection reset")

    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=BrokenCommunicate))
    clips, arguments = child_request(tmp_path)
    assert edge_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "INVALID_PROVIDER_RESULT"
    assert not any(Path(clip["output_path"]).exists() for clip in clips)


def test_child_empty_service_audio_fails(tmp_path, fake_edge, monkeypatch, capsys):
    monkeypatch.setattr(edge_process.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1))
    _, arguments = child_request(tmp_path)
    assert edge_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "INVALID_PROVIDER_RESULT"
