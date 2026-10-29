"""
Audio of YouTube tracks: yt-dlp finds the stream, this module serves it to the player over HTTP with Range support.
Stream URLs are bound to the IP that asked for them, so the browser never gets them directly — bytes go through
here, fetched in short range requests (long ones are throttled by YouTube). Downloaded files are served first.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

from . import net

CHUNK = 512 << 10  # YouTube refuses (403) larger ranges for some formats
FORMAT = "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio"


class StreamError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class _Quiet:
    def debug(self, msg):
        pass

    warning = info = error = debug


# yt-dlp's player clients, tried in turn: YouTube regularly starts refusing the streams of one of them
# (in autumn 2026 — TVHTML5, the default with a JS runtime). The one that worked last is tried first.
CLIENTS: list[list[str] | None] = [None, ["visionos"], ["android_vr"], ["web_safari"], ["ios"], ["mweb"]]
_client = 0

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _js_runtime() -> tuple[str, dict] | None:
    """YouTube's player challenges need a JS runtime (yt-dlp-ejs); without one some formats are refused.
    The desktop build ships deno next to the app (bin/), otherwise the one from the `deno` package or PATH."""
    exe = "deno.exe" if sys.platform == "win32" else "deno"
    bundled = Path(getattr(sys, "_MEIPASS", "")) / "bin" / exe
    if getattr(sys, "frozen", False) and bundled.is_file():
        return "deno", {"path": str(bundled)}
    try:
        import deno  # type: ignore[import-not-found]

        return "deno", {"path": deno.find_deno_bin()}
    except Exception:  # noqa: BLE001
        pass
    for name in ("deno", "node", "bun"):
        if shutil.which(name):
            return name, {}
    return None


def resolve(video_id: str, fresh: bool = False) -> dict:
    """{url, headers, size, mime, ext, codec, abr, asr, channels}; cached until shortly before the URL expires."""
    if not re.fullmatch(r"[\w-]{6,20}", video_id):
        raise StreamError("bad_request", "Неверный id")
    now = time.time()
    with _cache_lock:
        hit = _cache.get(video_id)
        if hit and not fresh and hit[0] > now:
            return hit[1]
    import yt_dlp  # heavy import, only when the first track plays

    global _client
    runtime = _js_runtime()
    order = [_client] + [i for i in range(len(CLIENTS)) if i != _client]
    refused = None
    for i in order:
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "format": FORMAT, "noplaylist": True, "logger": _Quiet()}
        if runtime:
            opts["js_runtimes"] = {runtime[0]: runtime[1]}
        if CLIENTS[i]:
            opts["extractor_args"] = {"youtube": {"player_client": CLIENTS[i]}}
        if net.proxy:
            opts["proxy"] = net.proxy
        try:
            with yt_dlp.YoutubeDL(opts) as y:
                info = y.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "Sign in" in msg or "confirm your age" in msg.lower():
                raise StreamError("unavailable", "YouTube требует вход для этого видео") from e
            if "unavailable" in msg.lower() or "private" in msg.lower():
                raise StreamError("unavailable", "Видео недоступно") from e
            refused = StreamError("extraction", f"Не удалось получить поток: {msg[:200]}")
            continue
        data = _stream_data(info, now)
        # YouTube hands out URLs it then refuses (403) for some clients: check one byte before trusting a client.
        try:
            _fetch(data[1], 0, 0)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                refused = StreamError("network", "YouTube не отдал поток. Попробуйте ещё раз.")
                continue
            raise StreamError("network", "YouTube не отдал поток. Попробуйте ещё раз.") from e
        except (urllib.error.URLError, OSError) as e:
            raise StreamError("network", "Нет связи с YouTube") from e
        _client = i
        with _cache_lock:
            if len(_cache) > 300:
                _cache.clear()
            _cache[video_id] = data
        return data[1]
    raise refused or StreamError("extraction", "У видео нет аудиопотока")


def _stream_data(info: dict, now: float) -> tuple[float, dict]:
    fmt = info if info.get("url") else (info.get("requested_formats") or [{}])[0]
    url = fmt.get("url")
    if not url:
        raise StreamError("extraction", "У видео нет аудиопотока")
    m = re.search(r"[?&]expire=(\d+)", url)
    expires = int(m.group(1)) - 600 if m else now + 3 * 3600
    ext = fmt.get("ext") or "webm"
    data = {
        "url": url,
        "headers": {k: v for k, v in (fmt.get("http_headers") or {}).items() if k.lower() in ("user-agent", "accept", "accept-language", "referer", "origin")},
        "size": fmt.get("filesize") or fmt.get("filesize_approx") or 0,
        "ext": ext,
        "mime": "audio/webm" if ext == "webm" else "audio/mp4" if ext in ("m4a", "mp4") else f"audio/{ext}",
        "codec": fmt.get("acodec"),
        "abr": fmt.get("abr"),
        "asr": fmt.get("asr"),
        "channels": fmt.get("audio_channels"),
        "duration": info.get("duration"),
    }
    return min(expires, now + 5 * 3600), data


def _fetch(info: dict, start: int, end: int) -> bytes:
    req = urllib.request.Request(info["url"], headers={"User-Agent": net.UA, **info["headers"], "Range": f"bytes={start}-{end}"})
    with net.opener().open(req, timeout=20) as r:
        return r.read()


def _size(info: dict) -> int:
    if info["size"]:
        return int(info["size"])
    req = urllib.request.Request(info["url"], headers={"User-Agent": net.UA, **info["headers"], "Range": "bytes=0-0"})
    with net.opener().open(req, timeout=15) as r:
        cr = r.headers.get("Content-Range", "")
    m = re.search(r"/(\d+)$", cr)
    info["size"] = int(m.group(1)) if m else 0
    return info["size"]


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    m = re.match(r"bytes=(\d*)-(\d*)", header or "")
    if not m:
        return None
    a, b = m.group(1), m.group(2)
    if a == "" and b:
        start, end = max(0, size - int(b)), size - 1
    else:
        start = int(a or 0)
        end = min(int(b), size - 1) if b else size - 1
    if start >= size or start > end:
        return None
    return start, end


def serve(handler, video_id: str, downloads: "Downloads | None" = None) -> None:
    """Writes the audio of a track to an http.server handler, honouring the Range header."""
    local = downloads.file_for(f"yt:{video_id}") if downloads else None
    if local:
        serve_file(handler, local, _mime(local))
        return
    info = resolve(video_id)
    # The first piece is fetched before any header is sent, so a refused URL can still be replaced quietly.
    for attempt in range(3):
        try:
            size = _size(info)
            rng = parse_range(handler.headers.get("Range"), size) if size else None
            start, end = rng if rng else (0, size - 1)
            first = _fetch(info, start, min(end, start + CHUNK - 1))
            break
        except urllib.error.HTTPError as e:
            if e.code not in (403, 404, 410) or attempt == 2:
                raise StreamError("network", "YouTube не отдал поток. Попробуйте ещё раз.") from e
            info = resolve(video_id, fresh=True)
    handler.send_response(206 if rng else 200)
    handler.send_header("Content-Type", info["mime"])
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(end - start + 1))
    if rng:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    pos = start
    data = first
    try:
        while data:
            handler.wfile.write(data)
            pos += len(data)
            if pos > end:
                break
            info, data = _piece(info, video_id, pos, end)
    except (BrokenPipeError, ConnectionResetError):
        return  # the player seeked or moved on
    except (urllib.error.URLError, OSError, StreamError):
        pass
    if pos <= end:
        # Headers are gone already: drop the connection, the player re-requests from where it stopped.
        handler.close_connection = True


def _piece(info: dict, video_id: str, pos: int, end: int) -> tuple[dict, bytes]:
    """Next chunk; a refused URL (403) is replaced by a fresh one, network hiccups are retried."""
    for attempt in range(3):
        try:
            return info, _fetch(info, pos, min(end, pos + CHUNK - 1))
        except urllib.error.HTTPError as e:
            if e.code != 403 or attempt == 2:
                raise
            info = resolve(video_id, fresh=True)
        except (urllib.error.URLError, OSError):
            if attempt == 2:
                raise
    return info, b""


def serve_file(handler, path: Path, mime: str, cache: str = "no-store") -> None:
    size = path.stat().st_size
    rng = parse_range(handler.headers.get("Range"), size)
    start, end = rng if rng else (0, size - 1)
    handler.send_response(206 if rng else 200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(end - start + 1))
    if rng:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.send_header("Cache-Control", cache)
    handler.end_headers()
    with path.open("rb") as f:
        f.seek(start)
        left = end - start + 1
        while left > 0:
            data = f.read(min(CHUNK, left))
            if not data:
                break
            try:
                handler.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                return
            left -= len(data)


def _mime(path: Path) -> str:
    return {".webm": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg"}.get(path.suffix.lower(), "application/octet-stream")


def track_info(video_id: str, downloads: "Downloads | None" = None) -> dict:
    local = downloads.file_for(f"yt:{video_id}") if downloads else None
    info = resolve(video_id) if not local or not downloads else downloads.info_for(f"yt:{video_id}")
    out = {
        "source": "download" if local else "stream",
        "container": (info.get("ext") or "").upper() or None,
        "codec": {"opus": "Opus", "mp4a.40.2": "AAC", "mp4a.40.5": "HE-AAC"}.get(info.get("codec") or "", info.get("codec")),
        "bitrateKbps": round(info["abr"]) if info.get("abr") else None,
        "sampleRateHz": info.get("asr"),
        "channels": info.get("channels"),
        "sizeBytes": local.stat().st_size if local else (info.get("size") or None),
    }
    return out


class Downloads:
    """Desktop only: saves tracks to a folder and keeps a small index next to them."""

    def __init__(self, folder: Path, on_change: Callable[[dict], None] | None = None):
        self.folder = folder
        self.folder.mkdir(parents=True, exist_ok=True)
        self.index_path = folder / ".youmusic-downloads.json"
        self.lock = threading.Lock()
        self.on_change = on_change or (lambda d: None)
        try:
            self.items: dict[str, dict] = json.loads(self.index_path.read_text("utf-8"))
        except (OSError, ValueError):
            self.items = {}
        for d in self.items.values():
            if d.get("status") in ("queued", "running"):
                d["status"] = "queued"
        self.queue: list[str] = [k for k, d in self.items.items() if d["status"] == "queued"]
        self.wake = threading.Event()
        threading.Thread(target=self._worker, daemon=True).start()
        if self.queue:
            self.wake.set()

    def _save(self) -> None:
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, ensure_ascii=False), "utf-8")
        os.replace(tmp, self.index_path)

    def list(self) -> list[dict]:
        with self.lock:
            return [{k: v for k, v in d.items() if k not in ("file", "meta")} for d in self.items.values()]

    def add(self, tracks: list[dict], quality: str | None) -> None:
        with self.lock:
            for t in tracks:
                if t.get("source") != "yt" or not str(t.get("id", "")).startswith("yt:"):
                    continue
                old = self.items.get(t["id"])
                if old and old["status"] in ("done", "queued", "running"):
                    continue
                self.items[t["id"]] = {"trackId": t["id"], "track": t, "status": "queued", "progress": 0, "bytes": 0, "quality": quality or "high"}
                self.queue.append(t["id"])
            self._save()
        self.wake.set()

    def remove(self, track_id: str) -> None:
        with self.lock:
            d = self.items.pop(track_id, None)
            if track_id in self.queue:
                self.queue.remove(track_id)
            self._save()
        if d and d.get("file"):
            try:
                (self.folder / d["file"]).unlink()
            except OSError:
                pass
        self.on_change({"trackId": track_id, "status": "removed", "progress": 0, "bytes": 0, "quality": ""})

    def file_for(self, track_id: str) -> Path | None:
        d = self.items.get(track_id)
        if not d or d.get("status") != "done" or not d.get("file"):
            return None
        p = self.folder / d["file"]
        return p if p.exists() else None

    def info_for(self, track_id: str) -> dict:
        return (self.items.get(track_id) or {}).get("meta") or {}

    def total_bytes(self) -> int:
        return sum(d.get("bytes", 0) for d in self.items.values() if d.get("status") == "done")

    def _worker(self) -> None:
        while True:
            self.wake.wait()
            with self.lock:
                track_id = self.queue.pop(0) if self.queue else None
                if track_id is None:
                    self.wake.clear()
                    continue
                d = self.items.get(track_id)
            if d:
                self._download(d)

    def _emit(self, d: dict) -> None:
        self.on_change({k: v for k, v in d.items() if k not in ("file", "meta")})

    def _download(self, d: dict) -> None:
        vid = d["trackId"][3:]
        d["status"] = "running"
        self._emit(d)
        try:
            info = resolve(vid)
            size = _size(info)
            t = d["track"]
            name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", f"{t.get('artist', '')} - {t.get('title', '')}").strip(" .-")[:120] or vid
            fname = f"{name} [{vid}].{info['ext']}"
            tmp = self.folder / (fname + ".part")
            pos = 0
            with tmp.open("wb") as f:
                while not size or pos < size:
                    stop = pos + CHUNK - 1 if not size else min(size - 1, pos + CHUNK - 1)
                    try:
                        info, data = _piece(info, vid, pos, stop)
                    except urllib.error.HTTPError as e:
                        if e.code == 416:
                            break
                        raise
                    if not data:
                        break
                    f.write(data)
                    pos += len(data)
                    d["bytes"] = pos
                    d["progress"] = pos / size if size else 0
                    self._emit(d)
                    if d["trackId"] not in self.items:
                        break
            if d["trackId"] not in self.items:
                tmp.unlink(missing_ok=True)
                return
            shutil.move(str(tmp), str(self.folder / fname))
            d.update(status="done", progress=1, bytes=pos, file=fname, meta={k: info.get(k) for k in ("ext", "codec", "abr", "asr", "channels")})
        except Exception as e:  # noqa: BLE001
            d.update(status="failed", error=str(e)[:200])
        with self.lock:
            if d["trackId"] in self.items:
                self._save()
        self._emit(d)
