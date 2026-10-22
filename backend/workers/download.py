"""Download one public video into the invocation's owned workspace."""
from __future__ import annotations

import re
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .protocol import WorkerError


def video_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise WorkerError("INVALID_VIDEO_URL", "Enter a valid video URL.")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.port:
        raise WorkerError("INVALID_VIDEO_URL", "The video URL must be a public HTTP(S) video address.")
    host, path, query = parsed.hostname, parsed.path, parse_qs(parsed.query)
    if host == "youtu.be":
        identity = path.strip("/")
    elif host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        identity = query.get("v", [""])[0] if path == "/watch" else path.removeprefix("/shorts/").strip("/") if path.startswith("/shorts/") else ""
    else:
        identity = ""
    if re.fullmatch(r"[\w-]{11}", identity, re.ASCII):
        return f"https://www.youtube.com/watch?v={identity}"
    if host in {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}:
        match = re.fullmatch(r"/video/(BV[\da-zA-Z]{10}|av\d+)/?", path)
        part = query.get("p", [""])[0]
        if match and (not part or re.fullmatch(r"[1-9]\d*", part)):
            return f"https://www.bilibili.com/video/{match[1]}/" + (f"?p={part}" if part else "")
    if host == "b23.tv" and re.fullmatch(r"/[\da-zA-Z]+/?", path):
        return f"https://b23.tv{path}"
    raise WorkerError("INVALID_VIDEO_URL", "Enter a single YouTube or Bilibili video URL.")


class VideoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        # Validate before following a short link; never fetch arbitrary targets.
        return super().redirect_request(request, response, code, message, headers, video_url(newurl))


class DownloadLog:
    def debug(self, message):
        print(message, file=sys.stderr)
    info = debug
    warning = debug
    error = debug


def download_video(url: str, work: Path, wire, max_bytes: int) -> tuple[Path, dict]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils.networking import std_headers
    from backend.app.config import ffmpeg_binary
    from backend.app.v1.media import inspect_video
    from backend.app.v1.runtime import RUNTIME_LIMITS

    url = video_url(url)
    wire.check_cancel()
    wire.progress(None, "Resolving the video URL")
    if urlparse(url).hostname == "b23.tv":
        with build_opener(VideoRedirect()).open(Request(url, headers=std_headers), timeout=20) as response:
            url = video_url(response.url)
        if urlparse(url).hostname == "b23.tv":
            raise WorkerError("INVALID_VIDEO_URL", "The Bilibili short link does not point to a video.")
    last_update = 0.0
    downloaded: dict[str, int] = {}

    def admission(info, *, incomplete=False):
        wire.check_cancel()
        if info.get("is_live") or info.get("live_status") == "is_upcoming":
            raise WorkerError("UNSUPPORTED_MEDIA", "Live or not-yet-published videos are not supported.")
        if (info.get("duration") or 0) * 1000 > RUNTIME_LIMITS["max_video_duration_ms"]:
            minutes = RUNTIME_LIMITS["max_video_duration_ms"] // 60_000
            raise WorkerError("MEDIA_LIMIT_EXCEEDED", f"The video exceeds the {minutes:g} minute limit.")
        if (info.get("filesize") or 0) > max_bytes:
            raise WorkerError("FILE_TOO_LARGE", "The video exceeds the file size limit.")

    def progress(event):
        nonlocal last_update
        wire.check_cancel()
        count = event.get("downloaded_bytes", 0)
        downloaded[event.get("filename", "video")] = count
        if sum(downloaded.values()) > max_bytes:
            raise WorkerError("FILE_TOO_LARGE", "The video exceeds the file size limit.")
        total = event.get("total_bytes") or event.get("total_bytes_estimate")
        stamp = time.monotonic()
        if stamp - last_update >= 0.4 or event.get("status") == "finished":
            last_update = stamp
            value = min(count / total, 1) if total else None
            wire.progress(value, "Downloading the video" if event.get("status") != "finished" else "Merging and verifying the video")

    ffmpeg = shutil.which(ffmpeg_binary())
    if not ffmpeg:
        raise WorkerError("MEDIA_TOOLS_UNAVAILABLE", "FFmpeg is unavailable; downloaded videos cannot be merged.")
    options = {
        "outtmpl": str(work / "source.%(ext)s"), "noplaylist": True,
        "allowed_extractors": ["youtube$", "bilibili$"],
        "format": "bv[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]",
        "merge_output_format": "mp4", "ffmpeg_location": ffmpeg,
        "js_runtimes": {"node": {"path": shutil.which("node") or "node"}},
        "retries": 0, "fragment_retries": 0, "extractor_retries": 0,
        "file_access_retries": 0, "socket_timeout": 20,
        "skip_unavailable_fragments": False, "ignoreerrors": False,
        "continuedl": False, "overwrites": False, "max_filesize": max_bytes,
        "match_filter": admission, "progress_hooks": [progress], "logger": DownloadLog(),
        "quiet": True, "noprogress": True,
    }
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
        wire.check_cancel()
        if not info or info.get("_type", "video") != "video":
            raise WorkerError("INVALID_MEDIA", "The URL did not return a single video.")
        path = Path(downloader.prepare_filename(info)).resolve()
    if not path.is_relative_to(work.resolve()) or not path.is_file() or not path.stat().st_size:
        raise WorkerError("DOWNLOAD_MISSING", "The download did not produce a complete video file.")
    if path.stat().st_size > max_bytes:
        raise WorkerError("FILE_TOO_LARGE", "The video exceeds the file size limit.")
    media = inspect_video(path, RUNTIME_LIMITS, wire.check_cancel)
    wire.progress(1, "Video download complete")
    return path, {"sourceUrl": url, "title": info.get("title"), "durationMs": media["duration_ms"]}
