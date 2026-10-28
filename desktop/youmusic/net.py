"""Shared HTTP settings: user agent and an optional proxy (HTTP or SOCKS via yt-dlp only) for every request."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"

# "http://user:pass@host:port" or None. Set by the app from its settings (or YOUMUSIC_PROXY).
proxy: str | None = None


def opener() -> urllib.request.OpenerDirector:
    handlers: list = []
    if proxy and proxy.startswith("http"):
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener(*handlers)


def get(url: str, headers: dict[str, str] | None = None, timeout: float = 15) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with opener().open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b""


def get_json(url: str, headers: dict[str, str] | None = None, timeout: float = 15):
    code, body = get(url, headers, timeout)
    if code != 200:
        raise OSError(f"HTTP {code}")
    return json.loads(body.decode("utf-8", "replace"))


def post_json(url: str, data, headers: dict[str, str] | None = None, timeout: float = 30):
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers={"User-Agent": UA, "Content-Type": "application/json", **(headers or {})})
    with opener().open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
