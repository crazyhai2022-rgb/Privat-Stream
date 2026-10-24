# Where viralX can run

## What the app needs

| Requirement | Why |
| --- | --- |
| **Node.js 20+ as a long-running process** | The API and the background worker stay running. This is not a PHP site that runs per request. |
| **PostgreSQL 14+** | All data. MySQL is not a drop-in replacement — the schema uses `uuid`, `jsonb`, arrays, partial indexes and `FOR UPDATE SKIP LOCKED`. |
| **ffmpeg** | Every upload is probed for duration, given a thumbnail and re-encoded for streaming. Without it uploads cannot be validated. |
| **Disk or S3 for the video files** | Videos are never stored in the database. |
| **Permission to run a worker and burn CPU** | Transcoding is CPU-heavy by nature. |

## Shared cPanel hosting — possible when the plan includes Node.js

A plain 503 means the repository was copied into the web root with nothing there able
to run a Node server. That is fixable **if your plan lists Node.js** (cPanel →
*Setup Node.js App*). Hostinger's cPanel plans that advertise "NodeJS" do.

Two gaps remain, and both have answers:

- **No PostgreSQL** — cPanel gives MySQL only. Use a free managed PostgreSQL
  (Neon or Supabase) and paste the connection string; nothing else changes.
- **No ffmpeg** — install a static build into your home directory with
  `deploy/install-ffmpeg-static.sh`, no root needed. If the host blocks that,
  `REQUIRE_FFMPEG=false` keeps the site working with real trade-offs.

Also, Passenger stops the app when it is idle, so the background worker runs from a
cron job instead. Step-by-step: [`CPANEL.md`](CPANEL.md).

**What you give up on shared hosting:** CPU and memory caps make transcoding slow,
and heavy use can get the account flagged. It is a good place to test and launch, not
where a busy platform ends up. Plans *without* Node.js cannot run viralX at all.

## Options that do work

| Host | Cost | Good for | Notes |
| --- | --- | --- | --- |
| **Hostinger VPS** (or any Ubuntu VPS) | ~₹400–700/month | The real deployment | Full root. `deploy/vps-setup.sh` sets everything up in one command. Videos live on the server's disk. |
| **Render** | Free tier, or ~$7/month | Quick testing | `render.yaml` in this repo is a one-click blueprint. The free plan sleeps when idle and has **no persistent disk**, so set up S3 storage before testing real uploads. |
| **Railway** | ~$5/month after the trial | Easiest setup | Detects the Dockerfile, Postgres is one click, volumes available. |
| **Fly.io** | Pay as you go | Multiple regions | Docker-native, Postgres available. |
| **cPanel shared hosting with Node.js** | What you may already pay for | Testing and launching | Needs an external PostgreSQL and a cron worker — see [`CPANEL.md`](CPANEL.md). |

### Fastest path: a VPS

```bash
# on a fresh Ubuntu server, as root
bash <(curl -fsSL https://raw.githubusercontent.com/crazyhai2022-rgb/Privat-Stream/main/deploy/vps-setup.sh)
```

It installs Docker, generates `APP_SECRET` and the database password, starts the
app with PostgreSQL, opens the firewall and creates your first administrator.
Then point a domain at the server and put nginx or Caddy in front for HTTPS —
see [`DEPLOYMENT.md`](DEPLOYMENT.md).

### Fastest path: Render (for testing)

1. Push this repo to GitHub (already done).
2. Render → **New → Blueprint** → pick the repository. It reads `render.yaml`,
   builds the Dockerfile (ffmpeg included) and creates the database.
3. Open the service **Shell** and create your admin:
   ```bash
   cd /app/server && node src/scripts/create-admin.js --email you@example.com --name "Your Name" --generate
   ```
4. Before testing uploads properly, set `STORAGE_DRIVER=s3` and the `S3_*`
   variables — on the free plan the container disk is wiped on every restart.

## Storage for the video files

On a VPS the default (`STORAGE_DRIVER=local`) is fine: files sit in a Docker
volume on the server's disk. On a managed platform you want object storage.

**Cloudflare R2** is the usual choice — 10 GB free and no charge for bandwidth out:

```bash
STORAGE_DRIVER=s3
S3_BUCKET=viralx-media
S3_REGION=auto
S3_ENDPOINT=https://<your-account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

AWS S3, Backblaze B2, DigitalOcean Spaces and MinIO use the same settings with
their own endpoint.

## Email

Verification and password-reset emails need SMTP. Until you configure it in
production the app refuses to send and the registration flow stalls, so set it up
before inviting real users. Brevo, Resend, Mailgun and Amazon SES all have free
or cheap tiers. In development the link is printed to the console instead.

## Sizing

Transcoding is the part that needs CPU. A 2 vCPU / 4 GB VPS handles a small
community comfortably. As uploads grow, move the worker to its own machine:
`RUN_WORKER=false` on the web server and a second container with
`RUN_WORKER=true` sharing the same database and storage.
