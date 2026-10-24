# Running viralX on cPanel shared hosting

This works when your plan lists **Node.js** (cPanel → *Setup Node.js App*). Plans
without it cannot run viralX at all.

Two things shared hosting almost never provides, and what to do about each:

| Missing | Fix |
| --- | --- |
| **PostgreSQL** (cPanel gives MySQL) | Use a free managed PostgreSQL — [Neon](https://neon.tech) or [Supabase](https://supabase.com). Both have a free tier that is plenty for testing, and you only paste a connection string. |
| **ffmpeg** | Install a static build in your home directory with `deploy/install-ffmpeg-static.sh`. If your host blocks that, you can run without it — see *Without ffmpeg* below. |

One more limitation to plan for: Passenger stops your app when nobody is visiting,
so the built-in background worker will not run reliably. Use a cron job instead
(step 7). Your plan lists unlimited cron jobs, so this is free.

---

## 1. Get a PostgreSQL database

1. Sign up at Neon or Supabase and create a project (pick the region closest to
   your hosting — Singapore or Mumbai for Indian hosting).
2. Copy the connection string. It looks like:
   ```
   postgresql://user:password@ep-something.ap-southeast-1.aws.neon.tech/viralx?sslmode=require
   ```
3. Keep it for step 4. You will also set `DATABASE_SSL=true`.

## 2. Put the code on the server

cPanel → **Git Version Control** → *Create* →
`https://github.com/crazyhai2022-rgb/Privat-Stream.git`, repository path
`/home/USERNAME/viralx`.

> Clone it to `~/viralx`, **not** into `public_html`. The Node app serves its own
> files; nothing belongs in the web root.

## 3. Create the Node.js app

cPanel → **Setup Node.js App** → *Create Application*:

| Field | Value |
| --- | --- |
| Node.js version | the newest available (20 or 22) |
| Application mode | **Production** |
| Application root | `viralx/server` |
| Application URL | your domain or subdomain, e.g. `viralx.yourdomain.com` |
| Application startup file | `app.cjs` |

`app.cjs` is in the repo for exactly this — Passenger needs a CommonJS entry point,
and it hands off to the real server.

## 4. Environment variables

Still in *Setup Node.js App*, add these (the **Add Variable** button):

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_SECRET` | 32+ random characters — generate one below |
| `DATABASE_URL` | the connection string from step 1 |
| `DATABASE_SSL` | `true` |
| `BASE_URL` | `https://viralx.yourdomain.com` (exactly how visitors reach it) |
| `TRUST_PROXY` | `true` |
| `RUN_WORKER` | `false` (cron handles processing — step 7) |
| `STORAGE_LOCAL_DIR` | `/home/USERNAME/viralx-media` |

Generate the secret on your own machine:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Email is optional to start — without `SMTP_*` set, verification links are written
to the log instead of being sent, which is fine while testing. Add Brevo, Resend or
your cPanel mailbox before real users sign up.

## 5. Install dependencies and start

In *Setup Node.js App*, press **Run NPM Install**, then **Restart**.

Open `https://viralx.yourdomain.com` — the site should load. Migrations run
automatically on the first start.

> If you get a 503 now, open the app's log file (the path is shown in *Setup Node.js
> App*). The usual causes are a wrong `DATABASE_URL`, a missing `APP_SECRET`, or
> `Application root` not pointing at `viralx/server`.

## 6. Install ffmpeg (strongly recommended)

Over SSH on the hosting account:

```bash
cd ~/viralx && bash deploy/install-ffmpeg-static.sh
```

It downloads a static build into `~/bin` and prints two variables. Add them to the
app's environment variables and restart:

```
FFMPEG_PATH=/home/USERNAME/bin/ffmpeg
FFPROBE_PATH=/home/USERNAME/bin/ffprobe
```

## 7. Cron job for video processing

cPanel → **Cron Jobs** → every minute (`* * * * *`):

```bash
cd /home/USERNAME/viralx/server && /home/USERNAME/nodevenv/viralx/server/22/bin/node src/scripts/process-jobs.js >> /home/USERNAME/logs/viralx-worker.log 2>&1
```

Get the exact node path from *Setup Node.js App* — it shows a command like
`source /home/USERNAME/nodevenv/viralx/server/22/bin/activate`. The `22` is your
Node version, so adjust it.

The script exits immediately when the queue is empty, and two runs can never pick up
the same video, so running it every minute is safe.

## 8. Create your administrator

Over SSH:

```bash
source /home/USERNAME/nodevenv/viralx/server/22/bin/activate
cd ~/viralx/server
node src/scripts/create-admin.js --email you@example.com --name "Your Name" --generate
```

It prints a one-time password. Sign in at `https://viralx.yourdomain.com/admin` and
change it.

No SSH? cPanel → **Terminal** does the same thing.

---

## Without ffmpeg

If your host blocks running binaries from your home directory, set
`REQUIRE_FFMPEG=false`. The site works, but:

- **No thumbnails.** Cards show a "No preview" placeholder.
- **The duration limit is not enforced on the server.** The browser still checks
  before uploading, but someone determined can bypass that. Only the file-size
  limit is enforced for real.
- **Only MP4 and WebM uploads play.** A `.mov` is accepted, then fails with a clear
  message telling the creator to upload an MP4, because nothing can convert it.
- **No compression.** Whatever the creator uploads is what viewers download, so a
  50 MB clip costs 50 MB of bandwidth every view.

Fine for showing the platform to people. Not what you want once real creators upload.

## Storage and the 20 GB limit

With `STORAGE_LOCAL_DIR=/home/USERNAME/viralx-media`, videos sit on your hosting
disk and count against your 20 GB. At roughly 5–15 MB per Short that is a few
thousand clips — enough to launch, not enough to grow.

When it fills up, switch to object storage without moving hosts
([Cloudflare R2](https://developers.cloudflare.com/r2/) gives 10 GB free and charges
nothing for bandwidth out):

```
STORAGE_DRIVER=s3
S3_BUCKET=viralx-media
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

## When to move off shared hosting

Shared plans cap CPU and memory, and transcoding is the heaviest thing this app
does. Watch for: uploads sitting in *Processing* for a long time, the host emailing
you about resource usage, or the site feeling slow while a video is being processed.

At that point a small VPS (₹400–700/month) is the upgrade —
`bash deploy/vps-setup.sh` sets one up in a single command. See
[`HOSTING.md`](HOSTING.md).

## Updating later

cPanel → **Git Version Control** → *Pull*, then *Setup Node.js App* → **Restart**.
Run **NPM Install** again only when dependencies changed.
