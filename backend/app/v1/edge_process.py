"""Generate a Task's speech clips with the remote Microsoft Edge TTS service.

Each clip sends its subtitle text to Microsoft's public speech endpoint and
returns an MP3 stream, which is converted to a mono PCM WAV clip locally.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path

SAMPLE_RATE = 24_000


def _fail(code: str, message: str) -> int:
    print(json.dumps({"code": code, "message": message}), file=sys.stderr)
    return 1


def _clips(request_path: Path):
    clips = json.loads(request_path.read_text(encoding="utf-8"))["clips"]
    if not isinstance(clips, list) or not clips:
        raise ValueError("Speech clips are required")
    ids = set()
    for clip in clips:
        if not isinstance(clip["text"], str) or not clip["text"].strip():
            raise ValueError("Speech clip text is required")
        if not isinstance(clip["voice"], str) or not clip["voice"].strip():
            raise ValueError("Speech clip voice is required")
        if clip["segment_id"] in ids:
            raise ValueError(f"Duplicate speech clip for segment {clip['segment_id']}")
        ids.add(clip["segment_id"])
    return clips


async def _synthesize(clips):
    import edge_tts

    for clip in clips:
        communicate = edge_tts.Communicate(clip["text"], clip["voice"])
        compressed = Path(clip["output_path"] + ".mp3")
        await communicate.save(compressed)
        clip["_compressed"] = compressed


def _convert(ffmpeg: str, clips) -> None:
    import soundfile as sf

    for clip in clips:
        compressed: Path = clip["_compressed"]
        if not compressed.is_file() or compressed.stat().st_size == 0:
            raise RuntimeError("Edge TTS returned no audio")
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror",
                   "-i", str(compressed.resolve()), "-map", "0:a:0", "-vn",
                   "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le",
                   str(Path(clip["output_path"]).resolve())]
        try:
            result = subprocess.run(command, capture_output=True, text=True)
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg is unavailable.") from exc
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg could not convert Edge TTS audio (exit {result.returncode}).")
        try:
            info = sf.info(clip["output_path"])
        except (OSError, RuntimeError) as exc:
            raise RuntimeError(f"Edge TTS audio is not valid WAV: {exc}") from exc
        if (info.format not in {"WAV", "WAVEX"} or info.frames <= 0 or info.samplerate != SAMPLE_RATE
                or info.channels != 1):
            compressed.unlink(missing_ok=True)
            raise RuntimeError("Edge TTS audio has unexpected WAV metadata.")
        compressed.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-path", type=Path, required=True)
    parser.add_argument("--ffmpeg", required=True)
    options = parser.parse_args(argv)
    # Edge synthesis reads no models; keep the local tokenizer stack offline.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        clips = _clips(options.request_path)
    except (OSError, ValueError, KeyError, TypeError):
        return _fail("INPUT_MISSING", "The speech generation request is invalid.")
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        return _fail("MODEL_NOT_READY", "Install edge-tts in the backend environment.")
    try:
        asyncio.run(_synthesize(clips))
        _convert(options.ffmpeg, clips)
        for clip in clips:
            Path(clip["output_path"]).with_suffix(".mp3").unlink(missing_ok=True)
    except Exception as exc:
        traceback.print_exc()
        return _fail("INVALID_PROVIDER_RESULT", f"Edge TTS speech generation failed ({type(exc).__name__}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
