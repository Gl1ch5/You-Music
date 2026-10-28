"""
HTTP backend of the web player and the desktop app: serves the built UI and /api/* (catalog, audio, lyrics, import…),
and forwards /server/* to the You Music account server. Python stdlib + yt-dlp only.

    python -m youmusic.app --ui ../web/dist-web --port 8741
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import extras, net, streams, ytm

VERSION = "1.0"


class Config:
    ui: Path = Path(".")
    upstream: str = "https://grzxk.ru/youmusic"
    platform: str = "web"
    downloads: streams.Downloads | None = None
    features: extras.Features = extras.Features(None)
    data_dir: Path | None = None


cfg = Config()
_events: list[dict] = []
_events_lock = threading.Condition()


def push_event(name: str, data: dict) -> None:
    """Native-like events for the UI (download progress); read by long polling /api/events."""
    with _events_lock:
        _events.append({"seq": (_events[-1]["seq"] + 1) if _events else 1, "name": name, "data": data})
        del _events[:-200]
        _events_lock.notify_all()


def _video_id(track_id: str) -> str:
    vid = track_id[3:] if track_id.startswith("yt:") else track_id
    if not re.fullmatch(r"[\w-]{6,20}", vid):
        raise extras.ApiError("bad_request", "Неверный id трека")
    return vid


def _storage() -> dict:
    d = cfg.downloads
    free = 0
    if d:
        try:
            st = os.statvfs(d.folder) if hasattr(os, "statvfs") else None
            free = st.f_bavail * st.f_frsize if st else 0
        except OSError:
            pass
    return {"downloadsBytes": d.total_bytes() if d else 0, "cacheBytes": 0, "freeBytes": free, "cacheLimitBytes": 0}


GET_ROUTES = {
    "search": lambda q: ytm.search(q["q"], q.get("filter", "all"), q.get("page") or None),
    "suggest": lambda q: ytm.suggestions(q.get("q", "")),
    "track": lambda q: ytm.track_details(_video_id(q["id"])),
    "collection": lambda q: ytm.collection(q["url"]),
    "artist": lambda q: ytm.artist(q["url"]),
    "trackinfo": lambda q: streams.track_info(_video_id(q["id"]), cfg.downloads),
    "import": lambda q: extras.import_fetch(q["url"]),
    "chart": lambda q: extras.chart(q.get("source", "yandex")),
    "downloads": lambda q: cfg.downloads.list() if cfg.downloads else [],
    "storage": lambda q: _storage(),
    "config": lambda q: {"platform": cfg.platform, "version": VERSION, "downloads": cfg.downloads is not None, "proxy": net.proxy is not None},
}


def _download(body: dict):
    if not cfg.downloads:
        raise extras.ApiError("unavailable", "Скачивание доступно в приложении для компьютера и телефона")
    cfg.downloads.add(body.get("tracks") or [], body.get("quality"))


def _download_remove(body: dict):
    if cfg.downloads:
        cfg.downloads.remove(body["id"])


def _set_proxy(body: dict):
    url = (body.get("url") or "").strip() or None
    if url and not re.match(r"^(https?|socks5h?)://", url):
        raise extras.ApiError("bad_request", "Нужна ссылка вида http://host:port или socks5://host:port")
    if cfg.platform != "desktop":
        raise extras.ApiError("unavailable", "Прокси настраивается только в приложении")
    net.proxy = url
    streams._cache.clear()


POST_ROUTES = {
    "lyrics": lambda b: extras.lyrics(b.get("artist", ""), b.get("title", ""), int(b.get("durationMs") or 0)),
    "translate": lambda b: extras.translate(list(b.get("lines") or []), b.get("to") or "ru"),
    "features": lambda b: cfg.features.features(list(b.get("tracks") or [])),
    "download": _download,
    "download-remove": _download_remove,
    "proxy": _set_proxy,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "YouMusic"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: no request logs (no analytics, nothing to keep)
        pass

    # ---- helpers ----

    def _json(self, code: int, data) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, e: Exception) -> None:
        if isinstance(e, (extras.ApiError, streams.StreamError)):
            code, msg = e.code, str(e)
        elif isinstance(e, ytm.YtmError):
            code, msg = "extraction", str(e)
        elif isinstance(e, KeyError):
            code, msg = "bad_request", f"Не хватает параметра {e}"
        elif isinstance(e, (OSError, urllib.error.URLError)):
            code, msg = "network", "Нет связи с сервисом. Попробуйте ещё раз."
        else:
            traceback.print_exc()
            code, msg = "internal", "Внутренняя ошибка"
        status = {"bad_request": 400, "not_found": 404, "unavailable": 451}.get(code, 502 if code in ("network", "extraction") else 500)
        try:
            self._json(status, {"error": {"code": code, "message": msg}})
        except OSError:
            pass

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20 << 20:
            raise extras.ApiError("bad_request", "Слишком большой запрос")
        return self.rfile.read(n) if n else b""

    def _same_origin(self) -> bool:
        """POSTs only from our own pages (or tools without Origin): other sites cannot drive the backend."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
        return urllib.parse.urlparse(origin).netloc == host

    # ---- routing ----

    def do_GET(self):  # noqa: N802
        self._route("GET")

    def do_HEAD(self):  # noqa: N802
        self._route("HEAD")

    def do_POST(self):  # noqa: N802
        self._route("POST")

    def do_PUT(self):  # noqa: N802
        self._route("PUT")

    def do_DELETE(self):  # noqa: N802
        self._route("DELETE")

    def _route(self, method: str) -> None:
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        try:
            if path.startswith("/server/"):
                return self._upstream(method, path[len("/server") :] + (f"?{url.query}" if url.query else ""))
            if path.startswith("/api/"):
                if method in ("POST", "PUT", "DELETE") and not self._same_origin():
                    return self._json(403, {"error": {"code": "forbidden", "message": "Чужой сайт"}})
                return self._api(method, path[5:], dict(urllib.parse.parse_qsl(url.query)))
            if method not in ("GET", "HEAD"):
                return self._json(405, {"error": {"code": "bad_request", "message": "Метод не поддерживается"}})
            self._static(path)
        except Exception as e:  # noqa: BLE001
            self._error(e)

    def _api(self, method: str, name: str, query: dict) -> None:
        if name.startswith("stream/"):
            return streams.serve(self, _video_id(name[7:]), cfg.downloads)
        if name == "img":
            data, ctype = extras.image(query.get("url", ""))
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
            return
        if name == "events":
            return self._events(int(query.get("after") or 0))
        if method == "GET" and name in GET_ROUTES:
            return self._json(200, {"result": GET_ROUTES[name](query)})
        if method == "POST" and name in POST_ROUTES:
            body = json.loads(self._body() or b"{}")
            return self._json(200, {"result": POST_ROUTES[name](body)})
        self._json(404, {"error": {"code": "not_found", "message": "Нет такого метода"}})

    def _events(self, after: int) -> None:
        deadline = time.time() + 25
        with _events_lock:
            while not any(e["seq"] > after for e in _events) and time.time() < deadline:
                _events_lock.wait(deadline - time.time())
            items = [e for e in _events if e["seq"] > after]
            last = _events[-1]["seq"] if _events else 0
        self._json(200, {"result": {"events": items, "last": last}})

    def _upstream(self, method: str, path: str) -> None:
        """Account server (sync, AI, Telegram): forwarded as is, the token stays in the Authorization header."""
        body = self._body() if method in ("POST", "PUT", "DELETE") else None
        headers = {"User-Agent": "YouMusic-" + cfg.platform}
        for h in ("Authorization", "Content-Type"):
            if self.headers.get(h):
                headers[h] = self.headers[h]
        req = urllib.request.Request(cfg.upstream.rstrip("/") + path, data=body, method=method, headers=headers)
        try:
            # The account server is reached directly: the user's proxy is for YouTube.
            with urllib.request.urlopen(req, timeout=120) as r:
                code, data, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            code, data, ctype = e.code, e.read(), e.headers.get("Content-Type", "application/json")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(data)

    def _static(self, path: str) -> None:
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        root = cfg.ui.resolve()
        file = (root / rel).resolve()
        if root not in file.parents and file != root or not file.is_file():
            # Client-side routes and unknown paths get the app shell.
            file = root / "index.html"
        if not file.is_file():
            return self._json(404, {"error": {"code": "not_found", "message": "Интерфейс не собран"}})
        ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        hashed = "/assets/" in path
        streams.serve_file(self, file, ctype, "public, max-age=31536000, immutable" if hashed else "no-cache")


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    ThreadingHTTPServer.daemon_threads = True
    return ThreadingHTTPServer((host, port), Handler)


def setup(ui: Path, upstream: str, platform: str, data_dir: Path | None, downloads_dir: Path | None) -> None:
    cfg.ui = ui
    cfg.upstream = upstream
    cfg.platform = platform
    cfg.data_dir = data_dir
    if data_dir:
        data_dir.mkdir(parents=True, exist_ok=True)
        cfg.features = extras.Features(data_dir / "features.json")
    if downloads_dir:
        cfg.downloads = streams.Downloads(downloads_dir, lambda d: push_event("downloadProgress", d))
    net.proxy = os.environ.get("YOUMUSIC_PROXY") or None
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("image/webp", ".webp")
    mimetypes.add_type("application/manifest+json", ".webmanifest")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="You Music: веб-плеер")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8741)
    p.add_argument("--ui", type=Path, default=Path(__file__).resolve().parent.parent.parent / "web" / "dist-web")
    p.add_argument("--upstream", default="https://grzxk.ru/youmusic")
    p.add_argument("--data", type=Path, default=None, help="папка для кэша данных треков")
    p.add_argument("--downloads", type=Path, default=None, help="папка для скачанной музыки (только на своём компьютере)")
    a = p.parse_args(argv)
    setup(a.ui, a.upstream, "web", a.data, a.downloads)
    srv = make_server(a.host, a.port)
    print(f"You Music: http://{a.host}:{a.port}/", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
