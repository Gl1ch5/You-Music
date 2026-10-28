# You Music server (optional)

Small Node 22 service without dependencies. The app works without it; with an account it adds:

* login/password and cloud sync of the library (the app's backup JSON, stored as is);
* AI recommendations through the server's model, 50 requests per user per day;
* a free HTTP CONNECT proxy for signed-in users (only ports 80/443, never to private networks or the server itself).

All secrets (AI key, model, upstream) live in `/opt/youmusic-server/.env` on the server — see `deploy/env.example`.

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
| POST | `/api/ai/chat` | `{messages, temperature}` → `{content, left}` |

## Deploy

```bash
sudo mkdir -p /opt/youmusic-server && sudo cp index.mjs /opt/youmusic-server/
sudo cp deploy/env.example /opt/youmusic-server/.env && sudo chmod 600 /opt/youmusic-server/.env  # fill it in
sudo cp deploy/youmusic-server.service /etc/systemd/system/ && sudo systemctl enable --now youmusic-server
# add deploy/nginx.conf to the site's HTTPS server block, then: sudo nginx -t && sudo systemctl reload nginx
```
