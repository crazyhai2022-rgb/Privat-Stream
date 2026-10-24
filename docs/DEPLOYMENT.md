# Deployment

## 1. Requirements

| Component | Version | Notes |
| --- | --- | --- |
| Node.js | 20+ | 22 LTS recommended |
| PostgreSQL | 14+ | Managed services (RDS, Neon, Supabase, DigitalOcean) all work |
| ffmpeg | 5+ | `ffmpeg` and `ffprobe` must be on the worker's PATH |
| Object storage | — | Any S3-compatible service |
| SMTP | — | Any provider |

Sizing: transcoding is the CPU-heavy part. Two vCPUs handle light traffic; give the worker more
cores, or run it separately (`RUN_WORKER=false` on the web process), as uploads grow.

## 2. Configuration

Copy `.env.example` and fill it in. The app refuses to start in production unless:

- `APP_SECRET` is set and at least 32 characters,
- `DATABASE_URL` is set,
- `EXPOSE_EMAIL_OUTBOX` is off.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # APP_SECRET
```

Set `TRUST_PROXY=true` only behind a proxy you control, so rate limiting reads the real client IP.

## 3. First deploy

```bash
git clone <your repo> && cd privat-stream/server
npm ci --omit=dev
npm run migrate
npm run create-admin -- --email you@example.com --name "Your Name"
NODE_ENV=production npm start
```

## 4. systemd

```ini
# /etc/systemd/system/privat-stream.service
[Unit]
Description=Privat Stream
After=network.target postgresql.service

[Service]
Type=simple
User=privat
WorkingDirectory=/srv/privat-stream/server
EnvironmentFile=/srv/privat-stream/server/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/privat-stream/server/tmp /srv/privat-stream/server/storage-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now privat-stream
```

## 5. nginx

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.com;

  ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

  # Large enough for your biggest allowed upload.
  client_max_body_size 1200m;
  client_body_timeout 300s;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;     # stream uploads straight through
    proxy_read_timeout 300s;
  }
}
server {
  listen 80;
  server_name your-domain.com;
  return 301 https://$host$request_uri;
}
```

## 6. Docker

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
WORKDIR /app/server
CMD ["node", "src/index.js"]
```

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: privat_stream
    volumes: [pgdata:/var/lib/postgresql/data]
  app:
    build: .
    env_file: server/.env
    environment:
      DATABASE_URL: postgres://postgres:change-me@db:5432/privat_stream
    ports: ["4000:4000"]
    depends_on: [db]
volumes: { pgdata: }
```

With `STORAGE_DRIVER=local`, mount a volume at `/app/server/storage-data` so files survive restarts.

## 7. Separating the worker

```bash
# web process
RUN_WORKER=false node src/index.js
# worker process (same code, same database and storage)
RUN_WORKER=true PORT=4001 node src/index.js
```

Both run migrations safely; the job queue claims rows with `FOR UPDATE SKIP LOCKED`, so several
workers can run at once.

## 8. Production checklist

- [ ] `NODE_ENV=production`, strong `APP_SECRET`, `DATABASE_URL` set
- [ ] HTTPS terminated in front of the app; `COOKIE_SECURE` on (automatic in production)
- [ ] `BASE_URL` matches the real public URL (verification links and the Origin check depend on it)
- [ ] `TRUST_PROXY=true` behind your proxy, and `client_max_body_size` above your upload limit
- [ ] SMTP configured and a test verification email received
- [ ] Object storage configured and a test upload played back
- [ ] First Super Admin created with `create-admin`; no shared credentials
- [ ] Upload limits, categories and the Telegram policy reviewed in **Platform settings**
- [ ] Database backups scheduled; storage bucket versioning or backups enabled
- [ ] `npm test` passing against the deployed revision

## 9. Backups

The database holds all metadata; object storage holds the files. Back up both.

```bash
pg_dump "$DATABASE_URL" | gzip > backup-$(date +%F).sql.gz
# restore
gunzip -c backup-2026-01-01.sql.gz | psql "$DATABASE_URL"
```

## 10. Operations

- `GET /healthz` returns `{"ok":true}` when the database is reachable — use it for your load balancer.
- Failed processing jobs stay in `video_jobs` with the error; the video returns to **Draft** with a
  message for the creator and a **Retry processing** button.
- Jobs stuck in `running` for more than 30 minutes are re-queued automatically at startup.
