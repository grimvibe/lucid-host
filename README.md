# Lucid Host

A platform to host, manage and monitor WhatsApp, Telegram and Discord bots and other Node.js / Python apps — with a neon dashboard, live logs and one-click controls.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end smoke test (starts its own temporary server)
```

The first account you create becomes the **administrator**. Then:

1. **Add Project** → choose runtime and platform.
2. **Deploy** → paste a public Git URL (private repos: add an access token) or upload a `.zip`.
3. Add **Environment** variables (encrypted at rest, never shown again), then **Start**.
4. Watch **Logs** live, restart, stop, or let auto-restart recover crashes.

## What's included

| Roadmap step | Implemented |
|---|---|
| 1. Secure the platform | Registration/login, scrypt password hashing, HttpOnly session cookies, project ownership, AES-256-GCM encrypted env vars, rate limiting, CSP and security headers |
| 2. Hosting engine | Per-project workspace, isolated env (platform secrets never leak to bots), memory limits, optional Docker runner |
| 3. Process controls | Start / stop / restart, live CPU & memory, uptime, crash detection with backoff auto-restart, restore on reboot |
| 4. Deployment | Git clone or zip upload (zip-slip safe), dependency install (npm / pip venv), custom install/build/start commands, validation and clear errors |
| 5. UX | Project details page, live logs (SSE), notifications, search, light/dark theme, mobile layout |
| 6. Administration | User management, per-user project & memory limits, suspend/delete, all-projects view, audit log |
| 7. Production | Dockerfile, `.env.example`, graceful shutdown, health endpoint |

## Configuration

See `.env.example`. Important ones: `SECRET_KEY`, `COOKIE_SECURE=true` (behind HTTPS), `TRUST_PROXY`, `REGISTRATION_OPEN`, `RUNNER`.

## Running other people's bots — read this

With `RUNNER=process` (default) bots run as normal processes under the **same OS user** as Lucid Host. Memory is capped and secrets are not passed on, but a malicious bot could still read files that user can read. Use this mode for **your own** bots.

If other people can deploy code, use `RUNNER=docker` (Docker must be installed). Each install/build/start then runs in its own container with CPU, memory and process limits and all capabilities dropped. *The Docker runner is new and has not been tested end to end — try it with a harmless bot first.*

## Going live

1. Get a server (VPS or your own machine) with Node 20+, `git`, and Python 3 if you host Python bots.
2. `cp .env.example .env`, set `SECRET_KEY` (`openssl rand -hex 32`) and `COOKIE_SECURE=true`.
3. Put a reverse proxy with HTTPS in front (Caddy is easiest):
   ```
   host.example.com {
       reverse_proxy localhost:3000
   }
   ```
   and set `TRUST_PROXY=1`. Streaming logs need response buffering off (Caddy does this by default; for Nginx add `proxy_buffering off;`).
4. Keep it running: `docker build -t lucid-host . && docker run -d --restart unless-stopped -p 3000:3000 -v lucid-data:/data --env-file .env lucid-host`, or use pm2/systemd.
5. **Back up** the data directory (database, `.secret` key, projects) regularly. Losing `.secret`/`SECRET_KEY` makes stored env vars unreadable.
6. After creating your admin account set `REGISTRATION_OPEN=false` if it's private.

## API overview

`/api/auth/*` (register, login, logout, me, password) · `/api/projects` (CRUD, `/start` `/stop` `/restart`, `/deploy`, `/upload`, `/env`, `/logs`, `/logs/stream`) · `/api/stats` · `/api/server` · `/api/notifications` · `/api/admin/*` · `/health`
