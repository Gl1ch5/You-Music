"""
You Music for Windows and Linux: the same web UI in a native window (pywebview), served by the local backend.

    python -m youmusic.desktop            # from the desktop/ folder, after `npm run build:web` in web/

The backend listens on a fixed local port: the library lives in the window's storage, which is bound to the
address, so a random port would show an empty library after every start.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import urllib.request
from pathlib import Path

from . import app

PORT = 38741
TITLE = "You Music"


def _bundle_dir() -> Path:
    """Folder with the UI and icons: inside the PyInstaller bundle, or the repository checkout."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent.parent


def _ui_dir() -> Path:
    base = _bundle_dir()
    for p in (base / "ui", base / "web" / "dist-web"):
        if (p / "index.html").is_file():
            return p
    raise SystemExit("Интерфейс не собран: выполните `npm run build:web` в папке web/")


def _icon() -> Path:
    base = _bundle_dir()
    for p in (base / "youmusic" / "assets" / "icon.png", Path(__file__).resolve().parent / "assets" / "icon.png"):
        if p.is_file():
            return p
    return Path()


def _data_dir() -> Path:
    if sys.platform == "win32":
        root = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return root / "YouMusic"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "you-music"


def _music_dir() -> Path:
    return Path.home() / "Music" / "You Music"


def _running(port: int) -> bool:
    """Another copy of the app already serves this port."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/config", timeout=2) as r:
            return b'"desktop"' in r.read()
    except OSError:
        return False


def _free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def main() -> None:
    try:
        import webview  # pywebview
    except ImportError:
        raise SystemExit("Нужен pywebview: pip install -r requirements-desktop.txt")

    data = _data_dir()
    port = PORT
    if not _running(port):
        while not _free(port):
            port += 1
        app.setup(_ui_dir(), "https://grzxk.ru/youmusic", "desktop", data, _music_dir())
        server = app.make_server("127.0.0.1", port)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.create_window(TITLE, f"http://127.0.0.1:{port}/", width=480, height=900, min_size=(360, 560), background_color="#161719", text_select=False)
    icon = _icon()
    webview.start(private_mode=False, storage_path=str(data / "webview"), icon=str(icon) if icon.is_file() else None)


if __name__ == "__main__":
    main()
