"""
Everything around playback that the Android app does natively: lyrics (LRCLIB), translation (Google gtx),
track data for recommendations (Deezer), import from Spotify/Yandex Music and the Yandex chart, artwork proxy.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.parse
import urllib.request
from pathlib import Path

from . import net


class ApiError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------- lyrics ----------

_lyrics_cache: dict[str, dict] = {}


def clean_artist(a: str) -> str:
    return re.sub(r"VEVO$", "", re.sub(r"\s+-\s+Topic$", "", a, flags=re.I)).strip()


def clean_title(t: str) -> str:
    s = re.sub(r"\s*[(\[][^)\]]*[)\]]", "", t)
    s = re.sub(r"\s+(?:feat\.?|ft\.?)\s.*$", "", s, flags=re.I).strip()
    return s or t.strip()


def _has_text(x: dict) -> bool:
    return bool(x.get("instrumental") or (x.get("plainLyrics") or "").strip() or (x.get("syncedLyrics") or "").strip())


def _lrclib(path: str, params: dict):
    code, body = net.get("https://lrclib.net/api/" + path + "?" + urllib.parse.urlencode(params), {"User-Agent": "YouMusic (personal player)"})
    return json.loads(body) if code == 200 else None


def lyrics(artist: str, title: str, duration_ms: int) -> dict:
    key = f"{artist}|{title}"
    if key in _lyrics_cache:
        return _lyrics_cache[key]
    a = clean_artist(artist)
    first = re.split(r"\s*(?:,|&|\bfeat\.?|\bft\.?|\sx\s|×)\s*", a, flags=re.I)[0].strip()
    t = clean_title(title)
    sec = duration_ms / 1000

    def exact(art: str):
        p = {"artist_name": art, "track_name": t}
        if duration_ms > 0:
            p["duration"] = str(duration_ms // 1000)
        try:
            r = _lrclib("get", p)
        except (OSError, ValueError):
            return None
        return r if isinstance(r, dict) and _has_text(r) else None

    def best(params: dict):
        try:
            items = _lrclib("search", params) or []
        except (OSError, ValueError):
            return None
        items = [x for x in items if _has_text(x) and (sec <= 0 or x.get("duration") is None or abs(x["duration"] - sec) <= 6)]
        if not items:
            return None
        return min(items, key=lambda x: (0 if (x.get("syncedLyrics") or "").strip() else 10) + (abs(x["duration"] - sec) if sec > 0 and x.get("duration") is not None else 3))

    found = exact(a) or (exact(first) if first != a else None) or best({"track_name": t, "artist_name": first}) or best({"q": f"{first} {t}"})
    if not found:
        out = {"plain": None, "synced": None}
    elif found.get("instrumental"):
        out = {"plain": "♪ Инструментал", "synced": None}
    else:
        out = {"plain": found.get("plainLyrics"), "synced": found.get("syncedLyrics")}
    if len(_lyrics_cache) > 200:
        _lyrics_cache.clear()
    _lyrics_cache[key] = out
    return out


# ---------- translation ----------


def translate(lines: list[str], to: str) -> dict:
    text = "\n".join(lines)
    url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={urllib.parse.quote(to)}&dt=t"
    req = urllib.request.Request(url, data=urllib.parse.urlencode({"q": text}).encode(), headers={"User-Agent": net.UA})
    with net.opener().open(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    joined = "".join((part[0] or "") for part in (data[0] or []) if isinstance(part, list) and part)
    out = [s.strip() for s in joined.split("\n")]
    aligned = ["" if not lines[i].strip() else (out[i] if i < len(out) else "") for i in range(len(lines))]
    return {"lines": aligned, "from": data[2] if len(data) > 2 and isinstance(data[2], str) else None}


# ---------- Deezer features ----------


class Features:
    MAX_PER_CALL = 40
    MAX_CACHED = 5000

    def __init__(self, file: Path | None):
        self.file = file
        self.lock = threading.Lock()
        self.cache: dict[str, dict] = {}
        if file:
            try:
                self.cache = json.loads(file.read_text("utf-8"))
            except (OSError, ValueError):
                pass

    def features(self, tracks: list[dict]) -> dict:
        from concurrent.futures import ThreadPoolExecutor

        with self.lock:
            known = {t["id"]: self.cache[t["id"]] for t in tracks if t["id"] in self.cache}
        seen: set[str] = set()
        missing = []
        for t in tracks:
            if t["id"] not in known and t["id"] not in seen:
                seen.add(t["id"])
                missing.append(t)
        missing = missing[: self.MAX_PER_CALL]
        with ThreadPoolExecutor(6) as pool:
            fresh = list(pool.map(self._safe_lookup, missing))
        got = {q["id"]: f for q, f in zip(missing, fresh) if f is not None}
        if got:
            with self.lock:
                self.cache.update(got)
                while len(self.cache) > self.MAX_CACHED:
                    self.cache.pop(next(iter(self.cache)))
                if self.file:
                    try:
                        tmp = self.file.with_suffix(".tmp")
                        tmp.write_text(json.dumps(self.cache, ensure_ascii=False), "utf-8")
                        tmp.replace(self.file)
                    except OSError:
                        pass
        return {**known, **got}

    def _safe_lookup(self, q: dict):
        try:
            return self._lookup(q)
        except (OSError, ValueError, KeyError):
            return None  # network failures are retried next time

    @staticmethod
    def _search(query: str) -> list[dict]:
        return net.get_json("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": query, "limit": "10"})).get("data") or []

    @staticmethod
    def _best(items: list[dict], q: dict):
        words = {w for w in re.split(r"\W+", q["title"].lower()) if len(w) > 2}
        plausible = [i for i in items if not words or any(w in (i.get("title") or "").lower() for w in words)]
        dur = q.get("durationMs") or 0
        if dur <= 0:
            return plausible[0] if plausible else None
        scored = [(abs((i.get("duration") or 0) * 1000 - dur), i) for i in plausible]
        scored = [s for s in scored if s[0] < 20_000]
        return min(scored, key=lambda s: s[0])[1] if scored else None

    def _lookup(self, q: dict) -> dict:
        artist = re.split(r"[,&]", q["artist"])[0].strip()
        title = re.sub(r"\s*[(\[].*?[)\]]", "", q["title"]).strip()
        hit = self._best(self._search(f'artist:"{artist}" track:"{title}"'), q) or self._best(self._search(f"{artist} {title}"), q)
        if not hit or not hit.get("id"):
            return {"found": False, "genres": [], "explicit": False}
        track = net.get_json(f"https://api.deezer.com/track/{hit['id']}")
        album_id = (track.get("album") or {}).get("id")
        album = {}
        if album_id:
            try:
                album = net.get_json(f"https://api.deezer.com/album/{album_id}")
            except (OSError, ValueError):
                album = {}
        year = (track.get("release_date") or "")[:4]
        return {
            "found": True,
            "bpm": track.get("bpm") or None,
            "gainDb": track.get("gain"),
            "genres": [g.get("name") for g in ((album.get("genres") or {}).get("data") or []) if g.get("name")],
            "explicit": bool(track.get("explicit_lyrics")),
            "year": int(year) if year.isdigit() else None,
            "rank": track.get("rank"),
            "cover": album.get("cover_xl") or (track.get("album") or {}).get("cover_xl"),
        }


# ---------- import ----------

SPOTIFY = re.compile(r"open\.spotify\.com/(?:intl-[a-z]+/)?(playlist|album|track)/([A-Za-z0-9]+)")
YANDEX_USER_PLAYLIST = re.compile(r"music\.yandex\.[a-z]+/users/([^/?#]+)/playlists/(\d+)")
YANDEX_PLAYLIST = re.compile(r"music\.yandex\.[a-z]+/playlists/([A-Za-z0-9.-]+)")
YANDEX_ALBUM = re.compile(r"music\.yandex\.[a-z]+/album/(\d+)(?:[/?#]|$)")
YANDEX_LIKES = re.compile(r"music\.yandex\.[a-z]+/users/([^/?#]+)/tracks")
VK = re.compile(r"(?:^|//|\.)vk\.(?:com|ru)/")
NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
VK_MESSAGE = (
    "VK отдаёт музыку только после входа в аккаунт, поэтому ссылку прочитать нельзя. "
    "Откройте плейлист в VK, выделите и скопируйте список треков и вставьте его во вкладку «Список»."
)


def import_fetch(link: str) -> dict:
    url = link.strip()
    if m := SPOTIFY.search(url):
        return _spotify(m.group(1), m.group(2))
    if m := YANDEX_USER_PLAYLIST.search(url):
        return _yandex_playlist(f"users/{m.group(1)}/playlists/{m.group(2)}")
    if m := YANDEX_PLAYLIST.search(url):
        return _yandex_playlist(f"playlist/{m.group(1)}")
    if m := YANDEX_ALBUM.search(url):
        return _yandex_album(m.group(1))
    if m := YANDEX_LIKES.search(url):
        return _yandex_playlist(f"users/{m.group(1)}/playlists/3", "Мне нравится (Яндекс)")
    if VK.search(url):
        raise ApiError("unavailable", VK_MESSAGE)
    raise ApiError("bad_request", "Нужна ссылка на плейлист или альбом Spotify или Яндекс Музыки")


def chart(source: str) -> dict:
    if source != "yandex":
        raise ApiError("bad_request", "Этот чарт пока недоступен")
    tracks = []
    try:
        result = _yandex_api("landing3/chart")
        ch = result.get("chart") or result
        tracks = [x for x in (_yandex_track(e["track"]) for e in ch.get("tracks") or [] if isinstance(e, dict) and e.get("track")) if x]
    except (ApiError, OSError, ValueError):
        pass
    try:
        if not tracks:
            tracks = _yandex_playlist("users/yamusic-top/playlists/1076")["tracks"]
    except ApiError as e:
        # Yandex answers only from Russian networks (the web player's server is abroad): fall back to YouTube's chart for Russia.
        if e.code not in ("unavailable", "network"):
            raise
        return _youtube_chart()
    return {"title": "Чарт Яндекс Музыки", "source": "yandex", "tracks": tracks, "via": None}


def _youtube_chart(country: str = "RU") -> dict:
    from . import ytm

    try:
        resp = ytm.call("browse", {"browseId": "FEmusic_charts", "formData": {"selectedValues": [country]}})
        ids = [i[2:] for i in ytm.walk(resp, "browseId") if isinstance(i, str) and i.startswith("VLPL")]
        if not ids:
            raise ApiError("unavailable", "Чарт недоступен")
        tracks = ytm.collection(ytm.playlist_url(ids[0])).get("tracks") or []
    except (ytm.YtmError, OSError):
        raise ApiError("network", "Не удалось загрузить чарт") from None
    return {
        "title": "Чарт YouTube",
        "source": "yandex",
        "tracks": [{"title": t["title"], "artist": t["artist"], "durationMs": t.get("durationMs") or 0, "artwork": t.get("artwork"), "album": t.get("album")} for t in tracks],
        "via": None,
    }


def _spotify(kind: str, id_: str) -> dict:
    code, html = net.get(f"https://open.spotify.com/embed/{kind}/{id_}")
    if code != 200:
        raise ApiError("not_found", f"Spotify не отдал плейлист (код {code}). Он должен быть публичным.")
    m = NEXT_DATA.search(html.decode("utf-8", "replace"))
    try:
        entity = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]  # type: ignore[union-attr]
    except (AttributeError, KeyError, TypeError, ValueError):
        raise ApiError("extraction", "Spotify изменил страницу — не удалось прочитать список") from None
    cover = None
    if kind == "album":
        srcs = (entity.get("coverArt") or {}).get("sources") or []
        if srcs:
            cover = max(srcs, key=lambda s: s.get("width") or 0).get("url")
    tracks = [
        {"title": o["title"], "artist": o.get("subtitle") or "", "durationMs": o.get("duration") or 0, "artwork": cover, "album": None}
        for o in entity.get("trackList") or []
        if isinstance(o, dict) and o.get("title")
    ]
    if not tracks and kind == "track":
        tracks = [{"title": entity.get("name") or "", "artist": entity.get("subtitle") or "", "durationMs": entity.get("duration") or 0, "artwork": None, "album": None}]
    return {"title": entity.get("name") or "Spotify", "source": "spotify", "tracks": tracks, "via": None}


def _yandex_get(url: str) -> tuple[int, str]:
    try:
        code, body = net.get(url, {"X-Yandex-Music-Client": "YandexMusicAndroid/24023621"}, timeout=20)
    except OSError:
        raise ApiError("network", "Не удалось связаться с Яндекс Музыкой") from None
    text = body.decode("utf-8", "replace")
    if code == 451 or (code == 200 and not text.lstrip().startswith("{")):
        raise ApiError("unavailable", "Яндекс Музыка недоступна из этой сети. Попробуйте перенос в приложении на телефоне.")
    return code, text


def _yandex_api(path: str) -> dict:
    sep = "&" if "?" in path else "?"
    code, body = _yandex_get(f"https://api.music.yandex.net/{path}{sep}rich-tracks=true")
    if code == 404:
        raise ApiError("not_found", "Плейлист не найден или скрыт. Сделайте его публичным.")
    if code in (401, 403):
        raise ApiError("not_found", "Плейлист закрыт. Откройте доступ по ссылке в Яндекс Музыке.")
    if code != 200:
        raise ApiError("network", f"Яндекс Музыка ответила кодом {code}")
    result = json.loads(body).get("result")
    if not isinstance(result, dict):
        raise ApiError("extraction", "Неожиданный ответ Яндекс Музыки")
    return result


def _yandex_playlist(path: str, fallback: str = "Яндекс Музыка") -> dict:
    result = _yandex_api(path)
    entries = [e for e in result.get("tracks") or [] if isinstance(e, dict)]
    full = [e["track"] for e in entries if isinstance(e.get("track"), dict)]
    if len(full) != len(entries):
        ids = [f"{e['id']}:{e['albumId']}" if e.get("albumId") else str(e["id"]) for e in entries if e.get("id")]
        full = []
        for i in range(0, len(ids), 100):
            code, body = _yandex_get("https://api.music.yandex.net/tracks?track-ids=" + ",".join(ids[i : i + 100]))
            if code == 200:
                full += [x for x in json.loads(body).get("result") or [] if isinstance(x, dict)]
    return {"title": result.get("title") or fallback, "source": "yandex", "tracks": [x for x in map(_yandex_track, full) if x], "via": None}


def _yandex_album(id_: str) -> dict:
    result = _yandex_api(f"albums/{id_}/with-tracks")
    tracks = [t for vol in result.get("volumes") or [] for t in vol if isinstance(t, dict)]
    return {"title": result.get("title") or "Альбом", "source": "yandex", "tracks": [x for x in map(_yandex_track, tracks) if x], "via": None}


def _yandex_track(t: dict) -> dict | None:
    title = t.get("title")
    if not title:
        return None
    version = t.get("version")
    album = (t.get("albums") or [None])[0] or {}
    cover = t.get("coverUri") or album.get("coverUri")
    return {
        "title": f"{title} ({version})" if version else title,
        "artist": ", ".join(a.get("name") for a in t.get("artists") or [] if a.get("name")),
        "durationMs": t.get("durationMs") or 0,
        "artwork": "https://" + cover.replace("%%", "1000x1000") if cover else None,
        "album": album.get("title"),
    }


# ---------- artwork proxy ----------

IMG_HOSTS = re.compile(
    r"^https://([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|googleusercontent\.com|yandex\.net|scdn\.co|spotifycdn\.com|dzcdn\.net|deezer\.com|grzxk\.ru)/"
)


def image(url: str) -> tuple[bytes, str]:
    """Same-origin copy of a cover, so the UI canvas can read its colours. Only known artwork hosts."""
    if not IMG_HOSTS.match(url):
        raise ApiError("bad_request", "Этот адрес картинки не поддерживается")
    req = urllib.request.Request(url, headers={"User-Agent": net.UA})
    with net.opener().open(req, timeout=15) as r:
        ctype = r.headers.get("Content-Type", "image/jpeg")
        data = r.read(8 << 20)
    if not ctype.startswith("image/"):
        raise ApiError("bad_request", "Это не картинка")
    return data, ctype

