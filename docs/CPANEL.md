# Running viralX on cPanel shared hosting

This works when your plan lists **Node.js** (cPanel → *Setup Node.js App*). Plans
without it cannot run viralX at all.

Two things shared hosting almost never provides, and what to do about each:

| Missing | Fix |
| --- | --- |
| **PostgreSQL** (cPanel gives MySQL) | Either use the built-in embedded database that stores data on your hosting disk, or a free managed PostgreSQL (Neon, Supabase). Step 1 compares them. |
| **ffmpeg** | Install a static build in your home directory with `deploy/install-ffmpeg-static.sh`. If your host blocks that, you can run without it — see *Without ffmpeg* below. |

One more limitation to plan for: Passenger stops your app when nobody is visiting,
so the built-in background worker will not run reliably. Use a cron job instead
(step 7). Your plan lists unlimited cron jobs, so this is free.

---

## 1. Choose where the data lives

**Option A — the built-in database (no extra service).** viralX ships with an embedded
PostgreSQL that stores everything in a folder on your hosting disk. Nothing to sign up for.
Set `ALLOW_EMBEDDED_DB=true` and `PGLITE_DIR` in step 4.

Keep the folder **outside** the repository, e.g. `/home/USERNAME/viralx-data/db`, so a Git
*Pull* never touches your data.

Two things to know: only one process may open it at a time (so the cron worker and
command-line scripts cannot run while the app is up), and there is no `pg_dump` — you back it
up by copying the folder.

**Option B — a managed PostgreSQL (recommended once you have real users).** Create a free
project on [Neon](https://neon.tech) or [Supabase](https://supabase.com), copy the connection
string into `DATABASE_URL` and set `DATABASE_SSL=true`. This removes the single-process limit
and gives you real backups. Nothing else in the setup changes.

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

Still in *Setup Node.js App*, add these with the **Add Variable** button:

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_SECRET` | 32+ random characters — generate one below |
| `BASE_URL` | exactly how visitors reach the site, e.g. `https://viralx.yourdomain.com` |
| `TRUST_PROXY` | `true` |
| `RUN_WORKER` | `false` (cron handles processing — step 7) |
| `STORAGE_LOCAL_DIR` | `/home/USERNAME/viralx-data/media` |

Then, for **Option A** (built-in database):

| Name | Value |
| --- | --- |
| `ALLOW_EMBEDDED_DB` | `true` |
| `PGLITE_DIR` | `/home/USERNAME/viralx-data/db` |

or, for **Option B** (managed PostgreSQL):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the connection string |
| `DATABASE_SSL` | `true` |

Generate the secret on your own machine:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Run in Production mode, not Development

Set **Application mode: Production**. Development mode is not just slower — it turns off
checks that exist for a live site, and the app refuses to start in production until the
important settings are present, which is exactly what you want.

### Email

Until SMTP exists, add `MAIL_TRANSPORT=log`. Sign-up keeps working and the verification link
is written to the app's log file (visible in *Setup Node.js App*), where only you can read it.

Do **not** set `EXPOSE_EMAIL_OUTBOX`. It serves those links over HTTP for local development
only; on a reachable server anyone could use it to take over an account. It is off by default
and production refuses to start with it on.

Once you have SMTP (Brevo, Resend, or a cPanel mailbox), remove `MAIL_TRANSPORT` and set
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`.

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

> **With the built-in database this cron job cannot run**, because the app already holds the
> database open. Leave `RUN_WORKER=true` instead so the app processes videos itself, and
> accept that a video may wait until someone visits the site and wakes the app. Moving to a
> managed PostgreSQL (step 1, Option B) removes this limitation.

## 8. Create your administrator

**With SSH or cPanel Terminal:**

```bash
source /home/USERNAME/nodevenv/viralx/server/24/bin/activate
cd ~/viralx/server
node src/scripts/create-admin.js --email you@example.com --name "Your Name" --generate
```

> With the built-in database this only works while the app is **stopped**, because one
> process may open it at a time. Stop the app in *Setup Node.js App* first, run the command,
> then start it again.

**Without a shell** (Terminal disabled, or you do not want to stop the app) — use the
one-time bootstrap, which only exists until the first Super Admin is created:

1. Add an environment variable `ADMIN_BOOTSTRAP_TOKEN` with 24+ random characters, and restart.
2. From your own computer, run (replacing the values):

   ```bash
   curl -X POST https://viralx.yourdomain.com/api/admin/bootstrap \
     -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
     -d '{"token":"YOUR_TOKEN","email":"you@example.com","full_name":"Your Name","password":"a-strong-password"}'
   ```
3. **Delete `ADMIN_BOOTSTRAP_TOKEN`** and restart.

The endpoint answers only while no Super Admin exists, refuses a token shorter than 24
characters, compares tokens in constant time, is rate limited, and records the action in the
audit log. A wrong token gets the same 404 as a missing one, so it reveals nothing.

Then sign in at `https://viralx.yourdomain.com/admin`.

## 9. Check the moderation settings

In the admin panel, **Platform settings → Moderation**:

- **Require a verified email address** — off by default, which is what you want until SMTP
  works. Anyone can sign up and create a channel; it still lands in *Pending Review*, and only
  your approval lets them upload. Turn this on once email is sending.
- **Every new upload must be approved** — leave on so nothing goes live unseen.

New creators appear under **Creator approvals**.

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
