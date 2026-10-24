# Privat Stream

A Shorts-first video platform: short vertical videos are the main content type, long-form
landscape videos sit alongside them. It ships with a working backend, database, object storage,
a video processing pipeline, a black-themed front-end and a protected Super Admin panel.

- **Shorts-first home feed** — a Shorts section, then 4–5 long-video cards, then more Shorts, repeating as you scroll.
- **Immersive Shorts viewer** — one video per screen, scroll/swipe between them, Heart, Dislike, Comment, Share, Save.
- **Long-video watch page** — 16:9 player, Telegram button, expandable description, collapsed comments, related videos below, and a reserved (empty) ad column on desktop.
- **Accounts** — registration, email verification, login/logout, password reset, Argon2id hashing, server-side sessions.
- **Creator approval** — a new user must verify their email, create a channel and be approved by an administrator before they can upload.
- **Uploads** — separate Short and long-video flows, server-side validation, object storage, background processing (thumbnails, duration checks, a streaming rendition), moderation queue.
- **Separate metrics** — views, unique views, hearts, dislikes, comments, shares and saves are each tracked on their own and never merged into one number.
- **Super Admin panel** — dashboard, user management, creator approvals, video moderation, reports, popularity and ranking controls, categories, platform settings and an audit log.

---

## 1. Quick start (development)

Requirements: **Node.js 20+** and **ffmpeg** (`ffmpeg` and `ffprobe` on your PATH).
PostgreSQL is optional for development — see below.

```bash
cd server
npm install
cp ../.env.example .env        # optional; sensible defaults work without it
npm run seed                   # demo creators + generated sample videos (development only)
npm run create-admin -- --email you@example.com --name "Your Name"
npm start
```

Open <http://localhost:4000> for the site and <http://localhost:4000/admin> for the admin panel.

### Installing ffmpeg

| Platform | Command |
| --- | --- |
| Debian / Ubuntu | `sudo apt install ffmpeg` |
| macOS (Homebrew) | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |
| Docker | already in the provided `Dockerfile` |

### The development database

With no `DATABASE_URL`, the app runs an **embedded PostgreSQL (PGlite)** stored in
`server/.data/pglite`, so `npm start` works with nothing installed.

> **One process at a time.** PGlite opens its data directory exclusively. Stop the server before
> running `npm run seed` or `npm run create-admin` — the app will tell you if it is still running.
> Set `DATABASE_URL` to a real PostgreSQL server to lift that restriction (recommended once you
> have more than one person working on it, and required in production).

```bash
# With a real PostgreSQL server
createdb privat_stream
export DATABASE_URL='postgres://user:password@localhost:5432/privat_stream'
npm run migrate && npm start
```

---

## 2. Creating the first administrator

There is **no default admin account and no default password**. You create the first Super Admin
on the server:

```bash
cd server
npm run create-admin -- --email you@example.com --name "Your Name"
# prompts for a password (12+ characters, letters and numbers)

# non-interactive alternatives
ADMIN_PASSWORD='…' npm run create-admin -- --email you@example.com --name "Your Name"
npm run create-admin -- --email you@example.com --name "Your Name" --generate   # prints a one-time password
npm run create-admin -- --email existing@user.com --promote                      # promote an existing account
```

Then sign in at `/admin`. Further administrators are created from **Users → Change role** inside
the panel. Roles:

| Role | Can do |
| --- | --- |
| `super_admin` | Everything: users, roles, settings, categories, audit log, all moderation |
| `moderator` | Dashboard, creator approvals, video moderation, reports, popularity |
| `user` | Normal account; may become a creator |

---

## 3. How the platform works

### Account and creator lifecycle

```
register → verify email → create channel → Pending Review → admin approves → can upload
                                                 ↓
                                     Rejected (edit & resubmit) / Suspended
```

Upload permission is checked against the database on **every** request, so a rejected, pending or
suspended creator cannot upload by editing the page or calling the API directly.

### Video lifecycle

```
Draft → Uploading → Processing → Pending Moderation → Published
                        ↓                 ↓               ↓
                  Draft (+error)      Rejected        Removed → Restored
```

Processing probes the file with `ffprobe`, enforces the duration limit, generates a thumbnail
(9:16 for Shorts, 16:9 for long videos) and encodes one streaming rendition. Original files are
never served directly. If `require_video_moderation` is turned off in settings, processed videos
publish automatically.

### Engagement rules

| Action | Login required? |
| --- | --- |
| Watching | No |
| Sharing | No |
| Heart / Dislike | No — an opaque random id in an HttpOnly cookie identifies the actor; only its HMAC is stored, alongside a hashed IP used for abuse limits |
| Comment | Yes, with a verified email |
| Save | Yes |

Hearts and saves are separate: hearting is a reaction, saving adds the video to the viewer's
**Saved Videos**. Comments are never included in the video payload — the client fetches them only
when the viewer opens the comments panel.

Views are counted once per actor per 30 minutes, shares once per actor per hour, and a creator's
views of their own video are not counted.

### Telegram link priority

1. The global link, when a Super Admin has **locked** it.
2. The creator's own link, when creator overrides are allowed and the creator enabled their button.
3. The global link.
4. Otherwise the button is hidden.

Only `https://t.me/…` links are accepted, anywhere they can be entered.

### Trending

See [`docs/TRENDING.md`](docs/TRENDING.md) for the formula, the configurable weights and the
anti-abuse safeguards. Administrators can feature and pin videos and change the ranking weights,
but **cannot type engagement numbers**: counters are rebuilt from stored events, and removing
proven-abusive engagement is a separate, audited action.

---

## 4. Project layout

```
server/
  src/
    config.js            environment and validated production checks
    app.js               express app: security headers, CSRF, routes, static front-end
    index.js             entry point: migrate, serve, run the worker
    db/                  database adapter (PostgreSQL / embedded), migrations, seed
    routes/              auth, channels, videos, engagement, admin, public
    services/            settings, telegram, sessions, processing, videos, audit, mail
    middleware/core.js   sessions, CSRF, permissions, rate limits, error handling
    storage/             local disk and S3-compatible drivers
    lib/                 crypto, password hashing, ffmpeg helpers, upload handling
    scripts/create-admin.js
  tests/                 automated tests for permissions and workflows
web/
  index.html, css/, js/  public site (no build step)
  admin/                 Super Admin panel
docs/                    API reference, trending, deployment
```

No bundler is involved: the front-end is native ES modules served as static files.

---

## 5. Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the API, worker and front-end |
| `npm run dev` | Same, restarting on file changes |
| `npm run migrate` | Apply database migrations (also runs automatically on start) |
| `npm run seed` | Development demo data (refuses to run in production) |
| `npm run create-admin` | Create or promote a Super Admin |
| `npm test` | Automated tests |

---

## 6. Tests

```bash
cd server && npm test
```

62 tests cover registration and verification, login lockout and password reset, CSRF and session
scoping, the creator approval gate (including direct API bypass attempts), upload validation,
processing, the moderation workflow, report handling, metric independence, counter integrity,
Telegram priority, admin authorization for every role, SQL-injection and IDOR attempts, path
traversal, and security headers. They run against an in-memory database and need no setup.

---

## 7. Deployment

Full instructions, including nginx, systemd, Docker and a production checklist, are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The short version:

```bash
export NODE_ENV=production
export APP_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
export DATABASE_URL='postgres://…'
export BASE_URL='https://your-domain.com'
export STORAGE_DRIVER=s3   # + the S3_* variables
export SMTP_HOST=…         # + the other SMTP variables
cd server && npm ci --omit=dev && npm run migrate && npm start
```

The app refuses to start in production without `APP_SECRET` and `DATABASE_URL`, or with the
development email outbox still exposed.

---

## 8. External services you need to configure

| Service | Needed for | If you skip it |
| --- | --- | --- |
| **PostgreSQL 14+** | All data | Required in production; development falls back to an embedded database |
| **S3-compatible storage** (AWS S3, Cloudflare R2, Backblaze B2, MinIO…) | Video and image files | Development stores files on local disk; fine for one server with a persistent disk, not for several |
| **SMTP** (Amazon SES, Postmark, Mailgun, Resend, your own server…) | Verification and password-reset emails | Required in production; in development the link is printed to the console and stored in the `email_outbox` table |
| **ffmpeg** | Thumbnails, duration checks, streaming renditions | Required. Without it, uploads cannot be validated or processed |

Nothing else calls a third-party service. There is no analytics, tracking or ad script in the code —
the advertisement area is a reserved empty box you can fill when you choose a provider.

---

## 9. Security notes

- Passwords are hashed with Argon2id; sessions are server-side and only a SHA-256 of the cookie is stored.
- The admin panel uses a separate cookie, a separate session scope and `SameSite=Strict`.
- Every state-changing request is checked for CSRF (per-session token + Origin check).
- All SQL uses parameterised queries; uploads are identified by magic bytes, not by filename or the client's MIME type.
- Storage keys are validated and resolved inside the storage root, so no path can escape it.
- The Content-Security-Policy forbids inline scripts, framing and third-party sources.
- Authorization is enforced server-side on every request; frontend state grants nothing.
- Destructive admin actions need explicit confirmation and a written reason, and are recorded in the audit log.
- Never commit `.env`. Rotate `APP_SECRET` and database credentials if they are ever exposed.
