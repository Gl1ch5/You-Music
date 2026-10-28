"""
YouTube Music through its public web API (InnerTube, client WEB_REMIX): search, suggestions, "up next" radio,
albums, playlists and artists. No key and no account. Responses are walked generically, so small layout changes
do not break parsing. Track/collection/artist dicts follow web/src/bridge/contract.ts.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from typing import Any

from . import net

API = "https://music.youtube.com/youtubei/v1/"
CLIENT = {"clientName": "WEB_REMIX", "clientVersion": "1.20251015.03.00", "hl": "ru", "gl": "RU"}

# Search filters of YouTube Music ("params" of the search request).
PARAMS = {
    "songs": "EgWKAQIIAWoMEA4QChADEAQQCRAF",
    "songs2": "Eg-KAQwIARAAGAAgACgAMABqChAEEAUQAxAKEAk%3D",
    "videos": "EgWKAQIQAWoMEA4QChADEAQQCRAF",
    "albums": "EgWKAQIYAWoMEA4QChADEAQQCRAF",
    "artists": "EgWKAQIgAWoMEA4QChADEAQQCRAF",
    "playlists": "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D",
}

TYPE_WORDS = {
    "композиция", "песня", "song", "видео", "video", "альбом", "album", "сингл", "single", "ep", "мини-альбом",
    "исполнитель", "artist", "плейлист", "playlist", "выпуск", "episode", "профиль", "profile", "подкаст", "podcast",
}

_pages: dict[str, tuple[str, str, float]] = {}
_lock = threading.Lock()


class YtmError(Exception):
    pass


def call(endpoint: str, body: dict[str, Any], query: str = "") -> dict[str, Any]:
    payload = {"context": {"client": CLIENT}, **body}
    req = urllib.request.Request(
        f"{API}{endpoint}?prettyPrint=false{query}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": net.UA, "Origin": "https://music.youtube.com", "Referer": "https://music.youtube.com/"},
    )
    try:
        with net.opener().open(req, timeout=15) as r:
            return json.load(r)
    except Exception as e:  # noqa: BLE001 — every network/parse failure means the same to the UI
        raise YtmError(f"YouTube Music не ответил: {e}") from e


# ───────── generic helpers ─────────


def walk(o: Any, key: str, out: list | None = None) -> list:
    out = [] if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                out.append(v)
            walk(v, key, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, key, out)
    return out


def first(o: Any, key: str) -> Any:
    found = walk(o, key)
    return found[0] if found else None


def text(o: Any) -> str:
    if not isinstance(o, dict):
        return ""
    if "simpleText" in o:
        return o["simpleText"]
    return "".join(r.get("text", "") for r in o.get("runs") or [])


def best_thumb(o: Any) -> str | None:
    thumbs = first(o, "thumbnails") or []
    if not thumbs:
        return None
    url = max(thumbs, key=lambda t: t.get("width") or 0).get("url")
    return upscale(url)


def upscale(url: str | None, size: int = 544) -> str | None:
    """Google image URLs carry their size ("=w60-h60-…"); ask for a large square instead."""
    if not url:
        return url
    if "googleusercontent.com" in url or "ggpht.com" in url:
        return re.sub(r"=w\d+-h\d+.*$", f"=w{size}-h{size}-l90-rj", url)
    return url


def parse_duration(s: str) -> int:
    parts = s.strip().split(":")
    if not all(p.isdigit() for p in parts) or not 2 <= len(parts) <= 3:
        return 0
    sec = 0
    for p in parts:
        sec = sec * 60 + int(p)
    return sec * 1000


def parse_count(s: str) -> int | None:
    """'131 млн прослушиваний' / '2,2 тыс. просмотров' / '1.2M views' → number."""
    m = re.search(r"([\d.,]+)\s*(тыс|млн|млрд|K|M|B)?", s.replace("\xa0", " "))
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    mult = {"тыс": 1e3, "K": 1e3, "млн": 1e6, "M": 1e6, "млрд": 1e9, "B": 1e9}.get(m.group(2) or "", 1)
    return int(n * mult)


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def channel_url(channel_id: str) -> str:
    return f"https://www.youtube.com/channel/{channel_id}"


def playlist_url(playlist_id: str) -> str:
    return f"https://www.youtube.com/playlist?list={playlist_id}"


def page_type(nav: Any) -> str:
    return first(nav, "pageType") or ""


# ───────── list items ─────────


def _runs(item: dict, col: int) -> list[dict]:
    cols = item.get("flexColumns") or []
    if col >= len(cols):
        return []
    return (cols[col].get("musicResponsiveListItemFlexColumnRenderer", {}).get("text") or {}).get("runs") or []


def _segments(runs: list[dict]) -> list[list[dict]]:
    """Runs split by the " • " separators."""
    out: list[list[dict]] = [[]]
    for r in runs:
        if r.get("text", "").strip() == "•":
            out.append([])
        else:
            out[-1].append(r)
    return [s for s in out if s]


def track_from_item(item: dict, album: str | None = None, artwork: str | None = None, official: bool = False) -> dict | None:
    """A song or video row (search results, album and playlist pages, artist top songs)."""
    title_runs = _runs(item, 0)
    vid = (item.get("playlistItemData") or {}).get("videoId") or first(title_runs, "videoId") or first(item.get("overlay"), "videoId")
    if not vid or not title_runs:
        return None
    title = "".join(r.get("text", "") for r in title_runs)
    artists: list[str] = []
    artist_id = None
    duration = 0
    views = None
    kind_word = None
    album_name = album
    plain: list[str] = []
    for col in range(1, len(item.get("flexColumns") or [])):
        for seg in _segments(_runs(item, col)):
            s = "".join(r.get("text", "") for r in seg).strip()
            nav_ids = [first(r, "browseId") for r in seg if r.get("navigationEndpoint")]
            ptypes = [page_type(r.get("navigationEndpoint")) for r in seg if r.get("navigationEndpoint")]
            if any(t == "MUSIC_PAGE_TYPE_ALBUM" for t in ptypes):
                album_name = s
            elif any(t in ("MUSIC_PAGE_TYPE_ARTIST", "MUSIC_PAGE_TYPE_USER_CHANNEL") for t in ptypes):
                artists += [r["text"] for r in seg if r.get("navigationEndpoint")]
                artist_id = artist_id or next((i for i in nav_ids if i and i.startswith("UC")), None)
            elif parse_duration(s):
                duration = parse_duration(s)
            elif re.search(r"(просмотр|прослушиван|views|plays)", s, re.I):
                views = parse_count(s)
            elif s.lower() in TYPE_WORDS and kind_word is None:
                kind_word = s.lower()
            elif s:
                plain.append(s)
    for fixed in item.get("fixedColumns") or []:
        s = text((fixed.get("musicResponsiveListItemFixedColumnRenderer") or {}).get("text"))
        if parse_duration(s):
            duration = parse_duration(s)
    if not artists and plain:
        artists = [plain[0]]
    mvt = first(item, "musicVideoType") or ""
    return {
        "id": f"yt:{vid}",
        "source": "yt",
        "title": title,
        "artist": ", ".join(dict.fromkeys(a for a in artists if a)) or "",
        "album": album_name,
        "durationMs": duration,
        "artwork": artwork or best_thumb(item.get("thumbnail")),
        "url": watch_url(vid),
        "artistUrl": channel_url(artist_id) if artist_id else None,
        "official": official or mvt == "MUSIC_VIDEO_TYPE_ATV" or kind_word in ("композиция", "песня", "song"),
        "views": views,
    }


def entry_from_item(item: dict) -> dict | None:
    """Any search row: track, album, playlist or artist."""
    nav = item.get("navigationEndpoint") or {}
    browse = (nav.get("browseEndpoint") or {}).get("browseId")
    ptype = page_type(nav)
    if not browse:
        t = track_from_item(item)
        return {"kind": "track", "track": t} if t else None
    title = "".join(r.get("text", "") for r in _runs(item, 0))
    sub = [("".join(r.get("text", "") for r in seg)).strip() for col in range(1, 3) for seg in _segments(_runs(item, col))]
    sub = [s for s in sub if s and s.lower() not in TYPE_WORDS]
    art = best_thumb(item.get("thumbnail"))
    if ptype == "MUSIC_PAGE_TYPE_ARTIST" or (browse.startswith("UC") and ptype != "MUSIC_PAGE_TYPE_USER_CHANNEL"):
        subs = next((parse_count(s) for s in sub if re.search(r"(подписч|слушател|subscri|listen)", s, re.I)), None)
        return {"kind": "artist", "artist": {"id": f"ytch:{browse}", "name": title, "artwork": art, "url": channel_url(browse), "subscribers": subs}}
    if ptype == "MUSIC_PAGE_TYPE_ALBUM" or browse.startswith("MPRE"):
        playlist_id = first(item.get("overlay"), "playlistId") or first(item.get("menu"), "playlistId")
        url = playlist_url(playlist_id) if playlist_id else f"ytm:album/{browse}"
        return {"kind": "album", "collection": {"kind": "album", "id": f"ytpl:{playlist_id or browse}", "title": title, "subtitle": " • ".join(sub[:2]) or None, "artwork": art, "url": url, "count": None}}
    if ptype == "MUSIC_PAGE_TYPE_PLAYLIST" or browse.startswith("VL"):
        pid = browse[2:] if browse.startswith("VL") else browse
        return {"kind": "playlist", "collection": {"kind": "playlist", "id": f"ytpl:{pid}", "title": title, "subtitle": " • ".join(sub[:1]) or None, "artwork": art, "url": playlist_url(pid), "count": None}}
    return None


# ───────── search ─────────


def _remember(token: str | None, filter_: str) -> str | None:
    if not token:
        return None
    with _lock:
        now = time.time()
        for k in [k for k, v in _pages.items() if now - v[2] > 1800]:
            _pages.pop(k, None)
        key = f"p{int(now * 1000)}{len(_pages)}"
        _pages[key] = (token, filter_, now)
        return key


def _continuation(o: Any) -> str | None:
    return first(o, "nextContinuationData") and first(first(o, "nextContinuationData"), "continuation") or first(first(o, "continuationCommand"), "token")


def _search_raw(query: str, params: str | None) -> dict:
    return call("search", {"query": query, **({"params": urllib.parse.unquote(params)} if params else {})})


def _items(resp: dict) -> list[dict]:
    return walk(resp, "musicResponsiveListItemRenderer")


def search(query: str, filter_: str = "all", page: str | None = None) -> dict:
    if page:
        with _lock:
            saved = _pages.pop(page, None)
        if not saved:
            raise YtmError("Страница устарела")
        token, f, _ = saved
        resp = call("search", {}, f"&ctoken={urllib.parse.quote(token)}&continuation={urllib.parse.quote(token)}&type=next")
        if not _items(resp):
            resp = call("search", {"continuation": token})
        items = [e for e in (entry_from_item(i) for i in _items(resp)) if e]
        return {"items": items, "nextPage": _remember(_continuation(resp.get("continuationContents") or resp.get("onResponseReceivedCommands")), f)}
    if filter_ == "all":
        songs = _songs(query)
        try:
            videos = _filtered(query, "videos")
        except YtmError:
            videos = {"items": [], "nextPage": None}
        seen = {i["track"]["id"] for i in songs["items"] if i.get("track")}
        top = _top(query)
        return {"items": top + songs["items"][:12] + [i for i in videos["items"] if i.get("track", {}).get("id") not in seen], "nextPage": videos["nextPage"]}
    if filter_ == "songs":
        return _songs(query)
    return _filtered(query, filter_)


def _songs(query: str) -> dict:
    for key in ("songs", "songs2"):
        res = _filtered(query, key, official=True)
        if res["items"]:
            return res
    return _filtered(query, "videos")


def _filtered(query: str, filter_: str, official: bool = False) -> dict:
    resp = _search_raw(query, PARAMS.get(filter_))
    items = []
    for i in _items(resp):
        e = entry_from_item(i)
        if not e:
            continue
        if official and e.get("track"):
            e["track"]["official"] = True
        if filter_ in ("albums",) and e["kind"] != "album":
            continue
        if filter_ == "artists" and e["kind"] != "artist":
            continue
        if filter_ == "playlists" and e["kind"] not in ("playlist", "album"):
            continue
        if filter_.startswith("songs") or filter_ == "videos":
            if e["kind"] != "track":
                continue
        items.append(e)
    shelf = first(resp, "musicShelfRenderer")
    return {"items": items, "nextPage": _remember(_continuation(shelf), filter_)}


def _top(query: str) -> list[dict]:
    """The artist or album YouTube Music puts on top of the unfiltered search."""
    try:
        resp = _search_raw(query, None)
    except YtmError:
        return []
    card = first(resp, "musicCardShelfRenderer")
    out = []
    if card:
        nav = first(card.get("title"), "navigationEndpoint") or card.get("onTap") or {}
        browse = first(nav, "browseId")
        name = text(card.get("title"))
        if browse and browse.startswith("UC"):
            out.append({"kind": "artist", "artist": {"id": f"ytch:{browse}", "name": name, "artwork": best_thumb(card.get("thumbnail")), "url": channel_url(browse), "subscribers": None}})
        elif browse and browse.startswith("MPRE"):
            pid = first(card.get("buttons"), "playlistId")
            out.append({"kind": "album", "collection": {"kind": "album", "id": f"ytpl:{pid or browse}", "title": name, "subtitle": text(card.get("subtitle")), "artwork": best_thumb(card.get("thumbnail")), "url": playlist_url(pid) if pid else f"ytm:album/{browse}", "count": None}})
    if not out:
        for i in _items(resp)[:6]:
            e = entry_from_item(i)
            if e and e["kind"] == "artist":
                out.append(e)
                break
    return out


def suggestions(query: str) -> list[str]:
    if not query.strip():
        return []
    url = "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ru&q=" + urllib.parse.quote(query)
    try:
        with net.opener().open(urllib.request.Request(url, headers={"User-Agent": net.UA}), timeout=6) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        return [s for s in data[1] if isinstance(s, str)][:8]
    except Exception:  # noqa: BLE001
        return []


# ───────── track, radio ─────────


def _panel_track(v: dict) -> dict | None:
    vid = v.get("videoId")
    if not vid:
        return None
    byline = (v.get("longBylineText") or v.get("shortBylineText") or {}).get("runs") or []
    segs = _segments(byline)
    artists, artist_id, album, views = [], None, None, None
    for seg in segs:
        s = "".join(r.get("text", "") for r in seg).strip()
        ptypes = [page_type(r.get("navigationEndpoint")) for r in seg if r.get("navigationEndpoint")]
        if "MUSIC_PAGE_TYPE_ALBUM" in ptypes:
            album = s
        elif any(t in ("MUSIC_PAGE_TYPE_ARTIST", "MUSIC_PAGE_TYPE_USER_CHANNEL") for t in ptypes):
            artists += [r["text"] for r in seg if r.get("navigationEndpoint")]
            artist_id = artist_id or next((first(r, "browseId") for r in seg if (first(r, "browseId") or "").startswith("UC")), None)
        elif re.search(r"(просмотр|прослушиван|views|plays)", s, re.I):
            views = parse_count(s)
        elif not artists and s and not re.fullmatch(r"\d{4}", s):
            artists.append(s)
    mvt = first(v, "musicVideoType") or ""
    return {
        "id": f"yt:{vid}",
        "source": "yt",
        "title": text(v.get("title")),
        "artist": ", ".join(dict.fromkeys(artists)),
        "album": album,
        "durationMs": parse_duration(text(v.get("lengthText"))),
        "artwork": best_thumb(v.get("thumbnail")),
        "url": watch_url(vid),
        "artistUrl": channel_url(artist_id) if artist_id else None,
        "official": mvt == "MUSIC_VIDEO_TYPE_ATV",
        "views": views,
    }


def radio(video_id: str) -> list[dict]:
    """The track itself followed by YouTube Music's endless "up next" mix for it."""
    resp = call("next", {"videoId": video_id, "playlistId": f"RDAMVM{video_id}", "isAudioOnly": True, "enablePersistentPlaylistPanel": True, "tunerSettingValue": "AUTOMIX_SETTING_NORMAL"})
    out, seen = [], set()
    for v in walk(resp, "playlistPanelVideoRenderer"):
        t = _panel_track(v)
        if t and t["id"] not in seen:
            seen.add(t["id"])
            out.append(t)
    return out


def track_details(video_id: str) -> dict:
    tracks = radio(video_id)
    me = next((t for t in tracks if t["id"] == f"yt:{video_id}"), None)
    if me is None:
        resp = call("player", {"videoId": video_id})
        vd = resp.get("videoDetails") or {}
        if not vd:
            raise YtmError("Видео недоступно")
        thumbs = (vd.get("thumbnail") or {}).get("thumbnails") or []
        me = {
            "id": f"yt:{video_id}", "source": "yt", "title": vd.get("title", ""), "artist": (vd.get("author") or "").removesuffix(" - Topic"),
            "durationMs": int(vd.get("lengthSeconds") or 0) * 1000, "artwork": upscale(thumbs[-1]["url"]) if thumbs else None,
            "url": watch_url(video_id), "artistUrl": channel_url(vd["channelId"]) if vd.get("channelId") else None,
            "official": (vd.get("author") or "").endswith(" - Topic") or vd.get("musicVideoType") == "MUSIC_VIDEO_TYPE_ATV",
            "views": int(vd["viewCount"]) if str(vd.get("viewCount", "")).isdigit() else None,
        }
    return {"track": me, "related": [t for t in tracks if t["id"] != me["id"]][:50]}


# ───────── collections, artists ─────────


def _header(resp: dict) -> dict:
    for key in ("musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicEditablePlaylistDetailHeaderRenderer", "musicImmersiveHeaderRenderer", "musicVisualHeaderRenderer"):
        h = first(resp, key)
        if h:
            return h
    return {}


def collection(url: str) -> dict:
    m = re.search(r"list=([\w-]+)", url)
    album_browse = url.split("ytm:album/")[1] if url.startswith("ytm:album/") else None
    if album_browse:
        browse = album_browse
    elif m:
        pid = m.group(1)
        browse = f"VL{pid}"
        if pid.startswith("OLAK5uy_"):
            # Album playlists open as their album page, which has track numbers and the artist.
            resp = call("browse", {"browseId": browse})
            mp = next((b for b in walk(resp, "browseId") if isinstance(b, str) and b.startswith("MPRE")), None)
            if mp:
                browse = mp
    else:
        raise YtmError("Неизвестная ссылка на подборку")
    resp = call("browse", {"browseId": browse})
    head = _header(resp)
    title = text(head.get("title")) or "Подборка"
    subtitle = " • ".join(s for s in [text(head.get("straplineTextOne")) or text(head.get("subtitle"))] if s) or None
    art = best_thumb(head.get("thumbnail")) or best_thumb(first(resp, "musicThumbnailRenderer"))
    is_album = browse.startswith("MPRE")
    album_artist = text(head.get("straplineTextOne")) if is_album else None
    artist_id = first(head.get("straplineTextOne"), "browseId") if is_album else None
    tracks = []
    for item in walk(resp, "musicResponsiveListItemRenderer"):
        t = track_from_item(item, album=title if is_album else None, artwork=art if is_album else None, official=is_album)
        if t:
            if is_album and not t["artist"]:
                t["artist"] = album_artist or ""
                t["artistUrl"] = channel_url(artist_id) if artist_id else None
            tracks.append(t)
    token = _continuation(first(resp, "musicPlaylistShelfRenderer") or first(resp, "musicShelfRenderer"))
    guard = 0
    while token and len(tracks) < 300 and guard < 6:
        guard += 1
        more = call("browse", {"continuation": token})
        for item in walk(more, "musicResponsiveListItemRenderer"):
            t = track_from_item(item)
            if t:
                tracks.append(t)
        token = _continuation(more.get("continuationContents") or more.get("onResponseReceivedActions"))
    pid = m.group(1) if m else (first(resp, "playlistId") or browse)
    return {
        "collection": {"kind": "album" if is_album else "playlist", "id": f"ytpl:{pid}", "title": title, "subtitle": subtitle, "artwork": art or (tracks[0]["artwork"] if tracks else None), "url": url, "count": len(tracks)},
        "tracks": tracks,
    }


def artist(url: str) -> dict:
    m = re.search(r"(UC[\w-]{20,})", url)
    if not m:
        raise YtmError("Неизвестная ссылка на исполнителя")
    channel = m.group(1)
    resp = call("browse", {"browseId": channel})
    head = _header(resp)
    name = text(head.get("title"))
    tracks = []
    for shelf in walk(resp, "musicShelfRenderer"):
        for item in shelf.get("contents") or []:
            t = track_from_item(item.get("musicResponsiveListItemRenderer") or {})
            if t:
                if not t["artist"]:
                    t["artist"] = name
                t["artistUrl"] = t["artistUrl"] or channel_url(channel)
                tracks.append(t)
    # "Songs" shelf shows five; its "more" leads to the full list.
    more_browse = next((b for b in (first(s.get("title"), "browseId") for s in walk(resp, "musicShelfRenderer")) if b and b.startswith("VL")), None)
    if more_browse:
        try:
            # The full list has durations, the shelf does not.
            full = collection(playlist_url(more_browse[2:]))["tracks"]
            known = {t["id"] for t in full}
            tracks = full + [t for t in tracks if t["id"] not in known]
        except YtmError:
            pass
    albums = []
    for card in walk(resp, "musicTwoRowItemRenderer"):
        nav = card.get("navigationEndpoint") or {}
        browse = first(nav, "browseId") or ""
        if not browse.startswith("MPRE"):
            continue
        pid = first(card.get("thumbnailOverlay"), "playlistId") or first(card.get("menu"), "playlistId")
        albums.append({"kind": "album", "id": f"ytpl:{pid or browse}", "title": text(card.get("title")), "subtitle": text(card.get("subtitle")) or None, "artwork": best_thumb(card.get("thumbnailRenderer")), "url": playlist_url(pid) if pid else f"ytm:album/{browse}", "count": None})
    subs = None
    sub_btn = first(head, "subscribeButtonRenderer")
    if sub_btn:
        subs = parse_count(text(sub_btn.get("subscriberCountText")))
    return {
        "artist": {"id": f"ytch:{channel}", "name": name, "artwork": best_thumb(head.get("thumbnail")), "url": channel_url(channel), "subscribers": subs},
        "banner": best_thumb(head.get("thumbnail")),
        "tracks": tracks[:50],
        "albums": albums[:30],
    }
