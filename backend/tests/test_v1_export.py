from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.app.config import ffmpeg_binary
from backend.app.v1 import export, media
from backend.app.v1.contracts import TaskConfig
from backend.app.v1.errors import ApiError
from backend.app.v1.steps import StageCancelled, StageContext


@pytest.fixture
def context(tmp_path):
    root = tmp_path / "中文 task's folder"
    work = root / "work"
    work.mkdir(parents=True)
    files = {name: work / f"{name}.json" for name in ("media_info", "transcript", "translation")}
    files["video"] = root / "source.mp4"
    files["video"].write_bytes(b"source-video")
    files["media_info"].write_text(json.dumps({"duration_ms": 1000, "width": 320, "height": 180}))
    files["transcript"].write_text(json.dumps({"detected_language": "en", "segments": [
        {"id": "first", "start_ms": 0, "end_ms": 400, "text": "  Hello,\nworld!  "},
        {"id": "last", "start_ms": 650, "end_ms": 1000, "text": "End of the clip."},
    ]}))
    # Deliberately reversed: joining translations must use IDs, not list order.
    files["translation"].write_text(json.dumps({"source_language": "en", "target_language": "zh", "segments": [
        {"segment_id": "last", "text": "结束了。"}, {"segment_id": "first", "text": "  你好，世界！  "},
    ]}))
    config = TaskConfig.model_validate({
        "source_language": "en", "target_language": "zh", "output_mode": "subtitles", "keep_background": False,
        "asr": {"adapter": "whisper", "model": "small", "device": "cpu"},
        "translation": {"adapter": "openai", "model": "test-model", "device": "remote"},
        "tts": None, "separation": None,
    })
    return StageContext(task_id="00000000-0000-0000-0000-000000000001", attempt=1,
                        stage="export", config=config, input_files=files, work_dir=work)


def test_srt_splits_display_only_preserves_inputs_and_joins_translation_by_id(monkeypatch, context):
    original = {name: path.read_bytes() for name, path in context.input_files.items()}
    commands = []

    def render(command, **kwargs):
        commands.append((command, kwargs))
        Path(command[-1]).write_bytes(b"rendered-video")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(media, "_run_media", render)
    result = export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    assert result.output_files["source_subtitles"].read_text(encoding="utf-8") == (
        "1\n00:00:00,000 --> 00:00:00,200\nHello\n\n"
        "2\n00:00:00,200 --> 00:00:00,400\nworld\n\n"
        "3\n00:00:00,650 --> 00:00:01,000\nEnd of the clip\n"
    )
    assert result.output_files["translated_subtitles"].read_text(encoding="utf-8") == (
        "1\n00:00:00,000 --> 00:00:00,400\n你好，世界\n\n"
        "2\n00:00:00,650 --> 00:00:01,000\n结束了\n"
    )
    assert {name: path.read_bytes() for name, path in context.input_files.items()} == original
    command, options = commands[0]
    assert [command[index + 1] for index, value in enumerate(command) if value == "-map"] == ["0:v:0", "0:a:0"]
    assert "-shortest" not in command
    assert options["cwd"] == (context.work_dir / "output").resolve()
    assert "filename=translated.srt" in command[command.index("-vf") + 1]
    assert all(path.parent == context.work_dir / "output" for path in result.output_files.values())


@pytest.mark.parametrize("change", [
    lambda data: data["segments"].pop(),
    lambda data: data["segments"].append(data["segments"][0].copy()),
    lambda data: data["segments"][0].update(segment_id="unknown"),
    lambda data: data["segments"][0].update(text=" "),
    lambda data: data.update(target_language="en"),
])
def test_invalid_translation_is_rejected_before_rendering(monkeypatch, context, change):
    path = context.input_files["translation"]
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data))
    monkeypatch.setattr(media, "_run_media", lambda *args, **kwargs: pytest.fail("invalid input reached FFmpeg"))
    with pytest.raises(ApiError) as error:
        export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    assert error.value.content["error"]["code"] == "INVALID_PROVIDER_RESULT"


def test_cue_past_video_end_fails_instead_of_silently_truncating_tail(context):
    path = context.input_files["transcript"]
    data = json.loads(path.read_text(encoding="utf-8"))
    data["segments"][-1]["end_ms"] = 1500
    path.write_text(json.dumps(data))
    with pytest.raises(ApiError, match="extend beyond"):
        export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")


@pytest.mark.parametrize("mode", ["dubbing", "both"])
def test_dubbing_requires_mix_artifacts(context, mode):
    context = replace(context, config=context.config.model_copy(update={"output_mode": mode}))
    with pytest.raises(ApiError) as error:
        export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    assert error.value.content["error"]["code"] == "INPUT_MISSING"


@pytest.mark.parametrize("returncode,code", [(1, "INTERNAL_ERROR"), (0, "STAGE_OUTPUT_MISSING")])
def test_render_failure_is_not_reported_as_completion(monkeypatch, context, returncode, code):
    monkeypatch.setattr(media, "_run_media", lambda command, **kwargs:
                        subprocess.CompletedProcess(command, returncode, "", "private/path/source.mp4"))
    with pytest.raises(ApiError) as error:
        export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    assert error.value.content["error"]["code"] == code
    assert error.value.content["error"]["stage"] == "export"
    assert "private/path" not in str(error.value)


def test_cancelling_export_reaps_child_before_returning(monkeypatch, context):
    real_popen = subprocess.Popen
    processes = []
    running_checks = 0

    def slow_process(command, **kwargs):
        process = real_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        processes.append(process)
        return process

    def check_cancel():
        nonlocal running_checks
        if processes and processes[0].poll() is None:
            running_checks += 1
            if running_checks == 2:
                raise StageCancelled()

    monkeypatch.setattr(media.subprocess, "Popen", slow_process)
    with pytest.raises(StageCancelled):
        export.run(replace(context, check_cancel=check_cancel), lambda value, message: None, output_dir=context.work_dir / "output")
    assert processes[0].returncode is not None
    assert processes[0].wait(timeout=0) != 0


@pytest.mark.parametrize("system,font", [
    ("Windows", "Microsoft YaHei"), ("Darwin", "Hiragino Sans GB"), ("Linux", "Noto Sans CJK SC"),
])
def test_font_family_is_platform_specific_and_configurable(monkeypatch, system, font):
    monkeypatch.setattr(export.platform, "system", lambda: system)
    monkeypatch.delenv("YOUDUB_SUBTITLE_FONT", raising=False)
    assert export._font("zh") == font
    monkeypatch.setenv("YOUDUB_SUBTITLE_FONT", "A Custom Font")
    assert export._font("zh") == "A Custom Font"


def add_dubbing(context: StageContext, mode: str) -> StageContext:
    audio = np.zeros((48000, 2))
    for start, end, frequency in ((0, 320, 660), (720, 980, 880)):
        tone = 0.2 * np.sin(2 * np.pi * frequency * np.arange((end - start) * 48) / 48000)
        audio[start * 48:end * 48] = tone[:, None]
    context.input_files["mixed_audio"] = context.work_dir / "mixed.wav"
    sf.write(context.input_files["mixed_audio"], audio, 48000, subtype="PCM_16")
    context.input_files["alignment"] = context.work_dir / "alignment.json"
    context.input_files["alignment"].write_text(json.dumps({"segments": [
        {"segment_id": "first", "source_start_ms": 0, "source_end_ms": 400,
         "dubbed_start_ms": 0, "dubbed_end_ms": 320},
        {"segment_id": "last", "source_start_ms": 650, "source_end_ms": 1000,
         "dubbed_start_ms": 720, "dubbed_end_ms": 980},
    ]}))
    return replace(context, config=context.config.model_copy(update={"output_mode": mode}))


@pytest.mark.parametrize("mode", ["dubbing", "both"])
def test_dubbing_outputs_use_the_final_wav_and_separate_subtitle_timelines(monkeypatch, context, mode):
    context = add_dubbing(context, mode)
    commands = []

    def render(command, **kwargs):
        commands.append(command)
        Path(command[-1]).write_bytes(b"rendered-video")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(media, "_run_media", render)
    result = export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    expected = {"video", "audio"} | ({"source_subtitles", "translated_subtitles"} if mode == "both" else set())
    assert set(result.output_files) == expected
    assert result.output_files["audio"].read_bytes() == context.input_files["mixed_audio"].read_bytes()
    command = commands[0]
    assert [command[index + 1] for index, value in enumerate(command) if value == "-map"] == ["0:v:0", "1:a:0"]
    assert str(result.output_files["audio"].resolve()) in command
    if mode == "both":
        assert "00:00:00,650 --> 00:00:01,000" in result.output_files["source_subtitles"].read_text(encoding="utf-8")
        translated = result.output_files["translated_subtitles"].read_text(encoding="utf-8")
        assert "00:00:00,000 --> 00:00:00,320\n你好，世界" in translated
        assert "00:00:00,720 --> 00:00:00,980\n结束了" in translated
        assert "-vf" in command
    else:
        assert "-vf" not in command
        assert not (result.output_files["video"].parent / "translated.srt").exists()


@pytest.mark.parametrize("bad_input", ["timeline", "audio_length"])
def test_dubbing_rejects_inconsistent_timeline_or_audio(context, bad_input):
    context = add_dubbing(context, "both")
    if bad_input == "timeline":
        path = context.input_files["alignment"]
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["segments"][0]["source_end_ms"] = 401
        path.write_text(json.dumps(payload))
    else:
        sf.write(context.input_files["mixed_audio"], np.zeros((47000, 2)), 48000)
    with pytest.raises(ApiError) as error:
        export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    assert error.value.content["error"]["code"] == "INVALID_PROVIDER_RESULT"


@pytest.mark.parametrize("text,expected", [
    ("欢迎来到dubvibe_mini，今天测试视频翻译，保留完整连续配音。",
     ["欢迎来到dubvibe_mini，", "今天测试视频翻译，", "保留完整连续配音。"]),
    ("这里介绍《第一章，第二章》，然后继续说明流程。",
     ["这里介绍《第一章，第二章》，", "然后继续说明流程。"]),
    ('这是一个完整句子！”接着说明另一个句子。',
     ['这是一个完整句子！”', "接着说明另一个句子。"]),
    ("Use v1.2 with example.com. Then continue talking.",
     ["Use v1.2 with example.com.", " Then continue talking."]),
    ("好的，欢迎来到这里。结束。", ["好的，欢迎来到这里。结束。"]),
    ("全球前三模型中有两个——Claude和Gemini——是在这里训练的。",
     ["全球前三模型中有两个——", "Claude和Gemini——", "是在这里训练的。"]),
    ("这里介绍《第一章——第二章》，然后继续说明流程。",
     ["这里介绍《第一章——第二章》，", "然后继续说明流程。"]),
    ("Use state-of-the-art tools with v1.2.", ["Use state-of-the-art tools with v1.2."]),
])
def test_subtitle_display_parts_preserve_content_and_protected_punctuation(text, expected):
    assert export._display_parts(text) == expected
    assert "".join(expected) == text


def test_subtitle_hides_trailing_separators_after_alignment_without_changing_cues(tmp_path):
    cues = [(index * 100, (index + 1) * 100, text) for index, text in enumerate([
        "第一段文字，", "第二段文字、", "第三段文字——", "第四段文字？！", "仍保留内部，标点。",
        "Use v1.2.", "保留《第一章，第二章》。", "……",
    ])]
    original = list(cues)
    path = tmp_path / "translated.srt"
    # Punctuation-only cues cannot silently become empty SRT entries.
    with pytest.raises(ApiError, match="contains no text"):
        export._write_srt(path, [], translated=True, aligned_cues=cues)
    export._write_srt(path, [], translated=True, aligned_cues=cues[:-1])
    assert [block.splitlines()[2] for block in path.read_text(encoding="utf-8").strip().split("\n\n")] == [
        "第一段文字", "第二段文字", "第三段文字", "第四段文字", "仍保留内部，标点", "Use v1.2", "保留《第一章，第二章》",
    ]
    assert cues == original


def test_complete_utterance_produces_multiple_cues_inside_its_final_dubbed_span(monkeypatch, context):
    context = add_dubbing(context, "both")
    path = context.input_files["translation"]
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["segments"][1]["text"] = "欢迎来到dubvibe_mini，今天测试视频翻译，保留完整连续配音。"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    original = {name: path.read_bytes() for name, path in context.input_files.items()}

    def render(command, **kwargs):
        Path(command[-1]).write_bytes(b"rendered-video")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(media, "_run_media", render)
    result = export.run(context, lambda *args: None, output_dir=context.work_dir / "output")
    blocks = result.output_files["translated_subtitles"].read_text(encoding="utf-8").strip().split("\n\n")
    assert [block.splitlines()[2] for block in blocks] == [
        "欢迎来到dubvibe_mini", "今天测试视频翻译", "保留完整连续配音", "结束了",
    ]
    times = [block.splitlines()[1].split(" --> ") for block in blocks]
    assert times[0][0] == "00:00:00,000"
    assert times[2][1] == "00:00:00,320"
    assert times[3] == ["00:00:00,720", "00:00:00,980"]
    assert all(start < end for start, end in times)
    assert times[0][1] == times[1][0] and times[1][1] == times[2][0]
    assert {name: path.read_bytes() for name, path in context.input_files.items()} == original


@pytest.mark.parametrize("earlier_dubbed_start", [False, True])
def test_qwen_export_changes_only_translated_cue_times_and_preserves_final_audio(monkeypatch, context, earlier_dubbed_start):
    from backend.app.v1 import forced_alignment
    from backend.app.v1.contracts import ModelSelection

    context = add_dubbing(context, "both")
    if earlier_dubbed_start:
        # Tail scheduling may place this complete clip before its source ASR
        # start. Its subtitle must use that actual placement, including when
        # it falls before 650ms on the unchanged source subtitle timeline.
        path = context.input_files["alignment"]
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["segments"][1].update(dubbed_start_ms=500, dubbed_end_ms=760)
        path.write_text(json.dumps(payload))
        audio, rate = sf.read(context.input_files["mixed_audio"], always_2d=True)
        shifted = np.zeros_like(audio)
        shifted[:320 * 48] = audio[:320 * 48]
        shifted[500 * 48:760 * 48] = audio[720 * 48:980 * 48]
        sf.write(context.input_files["mixed_audio"], shifted, rate, subtype="PCM_16")
    context = replace(context, config=context.config.model_copy(update={
        "subtitle_alignment": ModelSelection(adapter="qwen_forced_aligner", model=forced_alignment.MODEL_NAME, device="cpu"),
    }))
    adjusted = context.work_dir / "adjusted"
    adjusted.mkdir()
    for index in (1, 2):
        (adjusted / f"{index:04d}.wav").write_bytes(f"complete-adjusted-speech-{index}".encode())
    original = {name: path.read_bytes() for name, path in context.input_files.items()}
    commands = []

    def infer_and_render(command, **kwargs):
        commands.append(command)
        if "--request-path" in command:
            request = json.loads(Path(command[command.index("--request-path") + 1]).read_text(encoding="utf-8"))
            assert [item["segment_id"] for item in request["clips"]] == ["first", "last"]
            assert [item["text"].strip() for item in request["clips"]] == ["你好，世界！", "结束了。"]
            assert [Path(item["audio_path"]) for item in request["clips"]] == [
                (adjusted / "0001.wav").resolve(), (adjusted / "0002.wav").resolve(),
            ]
            Path(command[command.index("--output-path") + 1]).write_text(json.dumps({"clips": [
                {"segment_id": "first", "words": [{"text": "你好世界", "start_time": 0.08, "end_time": 0.24}]},
                {"segment_id": "last", "words": [{"text": "结束了", "start_time": 0.08, "end_time": 0.16}]},
            ]}, ensure_ascii=False), encoding="utf-8")
        else:
            Path(command[-1]).write_bytes(b"rendered-video")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(forced_alignment, "available_models", lambda: [forced_alignment.MODEL_NAME])
    monkeypatch.setattr(media, "_run_media", infer_and_render)
    from backend.app.v1.segments import Transcript, Translation
    transcript = Transcript.model_validate_json(context.input_files["transcript"].read_text(encoding="utf-8"))
    translation = Translation.model_validate_json(context.input_files["translation"].read_text(encoding="utf-8")).match(transcript)
    timeline = {item["segment_id"]: item for item in json.loads(context.input_files["alignment"].read_text(encoding="utf-8"))["segments"]}
    rows = [(segment.model_copy(update={"start_ms": timeline[segment.id]["dubbed_start_ms"],
                                       "end_ms": timeline[segment.id]["dubbed_end_ms"]}), translation[segment.id])
            for segment in transcript.segments]
    cues = forced_alignment.align(context, rows, export._display_parts, lambda *_: None,
                                  audio_paths=[adjusted / "0001.wav", adjusted / "0002.wav"])
    result = export.run(context, lambda *args: None, output_dir=context.work_dir / "output", prepared_cues=cues)

    assert len(commands) == 2
    second_time = "00:00:00,580 --> 00:00:00,660" if earlier_dubbed_start else "00:00:00,800 --> 00:00:00,880"
    assert result.output_files["translated_subtitles"].read_text(encoding="utf-8") == (
        "1\n00:00:00,080 --> 00:00:00,240\n你好，世界\n\n"
        f"2\n{second_time}\n结束了\n"
    )
    assert result.output_files["source_subtitles"].read_text(encoding="utf-8") == (
        "1\n00:00:00,000 --> 00:00:00,200\nHello\n\n"
        "2\n00:00:00,200 --> 00:00:00,400\nworld\n\n"
        "3\n00:00:00,650 --> 00:00:01,000\nEnd of the clip\n"
    )
    assert result.output_files["audio"].read_bytes() == original["mixed_audio"]
    assert {name: path.read_bytes() for name, path in context.input_files.items()} == original
    render = commands[-1]
    assert [render[index + 1] for index, value in enumerate(render) if value == "-map"] == ["0:v:0", "1:a:0"]
    assert str(result.output_files["audio"].resolve()) in render


@pytest.mark.parametrize("mode", ["dubbing", "both"])
def test_real_dubbing_export_uses_downloadable_final_wav_as_video_audio(context, mode):
    if not shutil.which(ffmpeg_binary()) or not shutil.which(media.ffprobe_binary()):
        pytest.skip("Local ffmpeg and ffprobe are required for the real export check")
    context = add_dubbing(context, mode)
    source = context.input_files["video"]
    subprocess.run([
        ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ], check=True, capture_output=True)
    result = export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    assert result.output_files["audio"].read_bytes() == context.input_files["mixed_audio"].read_bytes()
    decoded = subprocess.run([
        ffmpeg_binary(), "-v", "error", "-i", str(result.output_files["video"]), "-map", "0:a:0",
        "-ar", "48000", "-ac", "1", "-f", "f32le", "-",
    ], check=True, capture_output=True).stdout
    decoded_samples = np.frombuffer(decoded, dtype="<f4")
    samples = decoded_samples[3840:13440]
    expected, rate = sf.read(result.output_files["audio"], always_2d=True)
    assert len(decoded_samples) >= len(expected)
    assert np.corrcoef(decoded_samples[:len(expected)], expected[:, 0])[0, 1] > 0.95
    assert np.corrcoef(samples, expected[3840:13440, 0])[0, 1] > 0.95
    spectrum = np.abs(np.fft.rfft(samples))
    frequency = np.fft.rfftfreq(len(samples), 1 / rate)[np.argmax(spectrum)]
    assert frequency == pytest.approx(660, abs=2)
    assert media._duration_ms(media._probe(result.output_files["video"])) == pytest.approx(1000, abs=40)
    frame = subprocess.run([
        ffmpeg_binary(), "-v", "error", "-ss", "0.92", "-i", str(result.output_files["video"]),
        "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-",
    ], check=True, capture_output=True).stdout
    assert len(frame) == 320 * 180
    if mode == "both":
        assert sum(frame) > 200
    else:
        assert sum(frame) == 0


def test_real_export_preserves_video_tail_and_first_audio_and_burns_tail_subtitle(context):
    if not shutil.which(ffmpeg_binary()) or not shutil.which(media.ffprobe_binary()):
        pytest.skip("Local ffmpeg and ffprobe are required for the real export check")
    source = context.input_files["video"]
    subprocess.run([
        ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ], check=True, capture_output=True)
    digest = hashlib.sha256(source.read_bytes()).digest()
    result = export.run(context, lambda value, message: None, output_dir=context.work_dir / "output")
    video = result.output_files["video"]
    output_info = json.loads(subprocess.run([
        media.ffprobe_binary(), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video),
    ], check=True, capture_output=True, text=True).stdout)
    assert [stream["codec_name"] for stream in output_info["streams"]] == ["h264", "aac"]
    assert float(output_info["streams"][0]["duration"]) == pytest.approx(1.0, abs=0.04)
    assert hashlib.sha256(source.read_bytes()).digest() == digest

    def audio_samples(path):
        raw = subprocess.run([
            ffmpeg_binary(), "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1",
            "-ar", "16000", "-f", "f32le", "-",
        ], check=True, capture_output=True).stdout
        return np.frombuffer(raw, dtype="<f4")

    for path in (source, video):
        samples = audio_samples(path)[1600:14400]
        spectrum = np.abs(np.fft.rfft(samples))
        frequency = np.fft.rfftfreq(len(samples), d=1 / 16000)[np.argmax(spectrum)]
        assert frequency == pytest.approx(440, abs=2)

    def final_frame(path):
        return subprocess.run([
            ffmpeg_binary(), "-v", "error", "-ss", "0.92", "-i", str(path), "-frames:v", "1",
            "-pix_fmt", "gray", "-f", "rawvideo", "-",
        ], check=True, capture_output=True).stdout

    source_frame, output_frame = final_frame(source), final_frame(video)
    assert len(source_frame) == len(output_frame) == 320 * 180
    # A nonempty last frame with changed pixels proves the last cue was burned
    # through the end of the clip, beyond merely writing a valid SRT file.
    assert sum(output_frame) > sum(source_frame) + 200
    assert "00:00:01,000\n结束了" in result.output_files["translated_subtitles"].read_text(encoding="utf-8")


@pytest.mark.parametrize("cues", [
    [(80, 240, "你好，世界！"), (800, 1100, "结束了。")],
    [(240, 80, "你好，世界！"), (800, 880, "结束了。")],
    [(80, 840, "你好，世界！"), (800, 880, "结束了。")],
    [(80, 240, "你好，世界！")],
    [(80, 240, "替换了内容。"), (800, 880, "结束了。")],
])
def test_external_aligned_cues_must_preserve_full_translation_and_video_timeline(monkeypatch, context, cues):
    context = add_dubbing(context, "both")
    monkeypatch.setattr(media, "_run_media", lambda *_args, **_kwargs: pytest.fail("invalid cues must not render"))
    with pytest.raises(ApiError) as error:
        export.run(context, lambda *_: None, output_dir=context.work_dir / "output", prepared_cues=cues)
    assert error.value.content["error"]["code"] == "INVALID_PROVIDER_RESULT"
    assert not (context.work_dir / "output" / "video.mp4").exists()


def test_chunk_bounds_split_the_timeline_and_window_cues_rebase_for_each_part():
    assert export.chunk_bounds(150_000, 60_000) == [(0, 60_000), (60_000, 120_000), (120_000, 150_000)]
    assert export.chunk_bounds(60_000, 60_000) == [(0, 60_000)]
    with pytest.raises(ValueError):
        export.chunk_bounds(1000, 0)
    cues = [(0, 10_000, "A"), (59_000, 61_000, "B"), (70_000, 80_000, "C"), (70_000, 70_000, "empty")]
    assert export._window_cues(cues, 60_000, 65_000) == [(0, 1000, "B")]
    assert export._window_cues(cues, 5_000, 65_000) == [(0, 5_000, "A"), (54_000, 56_000, "B")]


def test_chunked_export_renders_parts_and_joins_the_complete_video(tmp_path):
    if not shutil.which(ffmpeg_binary()) or not shutil.which(media.ffprobe_binary()):
        pytest.skip("Local ffmpeg and ffprobe are required for the real export check")
    root = tmp_path / "parts task"
    work = root / "work"
    work.mkdir(parents=True)
    video = root / "source.mp4"
    subprocess.run([
        ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "65",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video),
    ], check=True, capture_output=True)
    files = {"video": video}
    files["media_info"] = work / "media_info.json"
    files["media_info"].write_text(json.dumps({"duration_ms": 65_000, "width": 320, "height": 180}))
    files["transcript"] = work / "transcript.json"
    files["transcript"].write_text(json.dumps({"detected_language": "en", "segments": [
        {"id": "whole", "start_ms": 0, "end_ms": 65_000, "text": "The whole video."},
    ]}))
    files["translation"] = work / "translation.json"
    files["translation"].write_text(json.dumps({"source_language": "en", "target_language": "zh", "segments": [
        {"segment_id": "whole", "text": "整段视频的字幕。"},
    ]}, ensure_ascii=False), encoding="utf-8")
    config = TaskConfig.model_validate({
        "source_language": "en", "target_language": "zh", "output_mode": "subtitles", "keep_background": False,
        "asr": {"adapter": "whisper", "model": "small", "device": "cpu"},
        "translation": {"adapter": "openai", "model": "test-model", "device": "remote"},
        "tts": None, "separation": None, "chunk_minutes": 1,
    })
    context = StageContext(task_id="00000000-0000-0000-0000-000000000002", attempt=1,
                           stage="export", config=config, input_files=files, work_dir=work)
    messages = []
    result = export.run(context, lambda value, message: messages.append(message), output_dir=work / "output")
    assert "Rendering part 1 of 2" in messages
    assert "Rendering part 2 of 2" in messages
    assert messages[-1] == "Output media is ready"
    output = result.output_files["video"]
    assert media._duration_ms(media._probe(output)) == pytest.approx(65_000, abs=300)
    assert "00:01:05,000" in result.output_files["translated_subtitles"].read_text(encoding="utf-8")
    assert not list(output.parent.glob("part-*.mp4"))

    def frame(path):
        return subprocess.run([
            ffmpeg_binary(), "-v", "error", "-ss", "64", "-i", str(path), "-frames:v", "1",
            "-pix_fmt", "gray", "-f", "rawvideo", "-",
        ], check=True, capture_output=True).stdout

    # The subtitle spanning the whole video is burned into the joined second part too.
    assert sum(frame(output)) > sum(frame(video)) + 200
