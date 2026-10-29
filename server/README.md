# You Music server (optional)

Small Node 22 service without dependencies. The app works without it; with an account it adds:

* login/password and cloud sync of the library (the app's backup JSON, stored as is);
* AI recommendations through the server's model, 50 requests per user per day;
* a free HTTP CONNECT proxy for signed-in users (only ports 80/443, never to private networks or the server itself);
* import from Telegram: the bot (long polling, no webhook) links a chat to an account by a one-time code and stores audio files the user sends until the app imports them;
* public pages: the site with stats (`/`), the user agreement (`/terms`), shared track pages (`/t/<videoId>`).

All secrets (AI key, models, upstream, Telegram bot token) live in `/opt/youmusic-server/.env` on the server — see `deploy/env.example`.

## API (prefix `BASE_PATH`, e.g. `https://grzxk.ru/youmusic`)

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ok, ai, proxy}` |
| POST | `/api/register`, `/api/login` | `{login, password}` → `{token, user}` |
| POST | `/api/logout` | Bearer |
| GET | `/api/me` | user, AI quota left, proxy credentials |
| POST | `/api/password` | change password, signs out other devices |
| DELETE | `/api/account` | deletes the account and the synced library |
| GET/PUT | `/api/sync` | `{data: string}` — the library backup |
| POST | `/api/ai/chat` | `{messages, temperature, tier}` → `{content, left}`; `tier: "fast"` uses `AI_MODEL_FAST` |
| GET | `/api/stats` | public counters for the site (no per-user data) |
| POST | `/api/tg/link` | Bearer → `{code, url, linked}` (code lives 15 min) |
| GET | `/api/tg/tracks` | Bearer → `{linked, bot, tracks}` |
| GET | `/api/tg/file/<id>` | Bearer → the audio file |
| GET | `/api/tg/cover/<id>` | the cover (public: the id is a long random string) |
| DELETE | `/api/tg/tracks/<id>` | Bearer |
| GET | `/`, `/terms`, `/t/<videoId>` | HTML pages |

## Deploy

```bash
sudo mkdir -p /opt/youmusic-server && sudo cp index.mjs /opt/youmusic-server/
sudo cp deploy/env.example /opt/youmusic-server/.env && sudo chmod 600 /opt/youmusic-server/.env  # fill it in
sudo cp deploy/youmusic-server.service /etc/systemd/system/ && sudo systemctl enable --now youmusic-server
# add deploy/nginx.conf to the site's HTTPS server block, then: sudo nginx -t && sudo systemctl reload nginx
```

### Web player (`/youmusic/app/`)

The browser version of the app: the Python backend from `desktop/` (catalog and audio via yt-dlp) serves the UI built with
`npm run build:web` and forwards `server/*` to this server. It needs a JS runtime (node/deno) on `PATH` for yt-dlp.

```bash
sudo git clone -b <branch> https://github.com/Gl1ch5/You-Music /opt/youmusic-web/src
sudo python3 -m venv /opt/youmusic-web/venv && sudo /opt/youmusic-web/venv/bin/pip install -r /opt/youmusic-web/src/desktop/requirements.txt PySocks
(cd /opt/youmusic-web/src/web && sudo npm ci && sudo npx vite build --mode web) && sudo cp -r /opt/youmusic-web/src/web/dist-web /opt/youmusic-web/ui
sudo cp deploy/youmusic-web.service /etc/systemd/system/ && sudo systemctl enable --now youmusic-web
```

The site (`/`) shows account statistics (total, new, active, synced, a 30-day growth chart) and links to the web player and desktop builds.
