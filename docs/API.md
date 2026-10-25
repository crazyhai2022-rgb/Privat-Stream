# API reference

REST over JSON. Session cookies carry authentication; state-changing requests need the
`X-CSRF-Token` header (the token is returned by `/api/auth/me` and the login endpoints).
Errors use `{ "error": { "code", "message", "details"? } }` with a matching HTTP status.

Pagination uses `?page=0` (zero-based) and returns `has_more`.

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/config` | Branding, upload limits, categories, ad settings, policies |
| GET | `/api/categories` | Categories with published counts |
| GET | `/api/videos` | `kind`, `sort`, `category`, `channel`, `q`, `page`, `limit` |
| GET | `/api/feed/home` | Alternating Shorts / long-video sections, by page |
| GET | `/api/feed/for-you` | `kind`, `limit` (≤30), `exclude` (ids already shown). Personalised mix: what the viewer watches / new / exploratory. Pseudonymous, never repeats |
| POST | `/api/visit` | Page-view ping for visitor analytics (skips bots, admins and Do Not Track) |
| POST | `/api/channels/:handle/subscribe` (`DELETE` to undo) | Idempotent; returns `subscribers` and `subscribed` |
| GET | `/robots.txt`, `/sitemap.xml` | Generated; private pages and `/admin` are excluded |
| GET | `/api/videos/:id` | One video, plus the viewer's own reaction and save state |
| GET | `/api/videos/:id/related` | Related videos (same kind, same category first) |
| GET | `/api/videos/:id/comments` | Only called when the comments panel is opened |
| GET | `/api/channels/:handle` | Public channel profile |
| GET | `/stream/:id`, `/thumb/:id` | Media; access-checked, supports range requests |

## Authentication

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` | `full_name`, `email`, `password`, `password_confirm` |
| POST | `/api/auth/verify-email` | `token` from the emailed link |
| POST | `/api/auth/resend-verification` | Authenticated |
| POST | `/api/auth/login` / `logout` / `logout-everywhere` | |
| GET | `/api/auth/me` | Current user, channel, upload permission, CSRF token |
| POST | `/api/auth/forgot-password` / `reset-password` | |
| PATCH | `/api/auth/profile` | `full_name` |
| POST | `/api/auth/change-password` | Revokes other sessions |

## Creator

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/me/channel` | Create; requires a verified email. Status starts at `pending` |
| PATCH | `/api/me/channel` | Update; `resubmit: true` re-enters review after a rejection |
| POST/DELETE | `/api/me/channel/avatar`, `/banner` | Multipart image, re-encoded server-side |
| GET | `/api/me/channel/details`, `/api/me/channel/stats` | |
| GET | `/api/me/videos` | Every video with its own separate metrics |
| POST | `/api/videos` | Create a draft (metadata); approved creators only |
| POST | `/api/videos/:id/upload` | Multipart `video` (+ optional `thumbnail`) → `202` |
| GET | `/api/videos/:id/status` | Poll while processing |
| POST | `/api/videos/:id/retry` | Retry failed processing |
| PATCH/DELETE | `/api/videos/:id` | Edit metadata / remove |

## Creator earnings, payments and tools

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me/earnings`, `/me/earnings/chart`, `/me/earnings/videos` | Balance (pending / payable / carried forward), per-day chart (`range`, `from`, `to`), per-video earnings |
| GET | `/api/me/payouts` | Payout history with status and reference |
| GET/POST | `/api/me/payment-methods` | UPI or BTC / ETH / USDT (TRC20 / BEP20 / ERC20). Identifiers are encrypted; only a masked label is returned |
| POST/DELETE | `/api/me/payment-methods/:id/default` / `:id` | |
| POST | `/api/videos/:id/thumbnail` | Custom thumbnail (JPEG/PNG/WebP, exact aspect, size-checked) |
| POST | `/api/videos/:id/thumbnail/frame` | Frame captured in the browser from the video |
| POST | `/api/me/channel/avatar`, `/me/channel/banner` | Cropped to 400 × 400 and 2560 × 1440 |
| POST | `/api/research/analyze` | `{ url }` → 1–5 distinct title / description / 5 hashtags / keyword suggestions. SSRF-protected; `mode` is `ai` or `template` |

## Engagement

| Method | Path | Login | Notes |
| --- | --- | --- | --- |
| POST | `/api/videos/:id/react` | No | `{ "type": "heart" \| "dislike" \| null }` |
| POST | `/api/videos/:id/view` | No | De-duplicated per actor per 30 min |
| POST | `/api/videos/:id/share` | No | Returns the canonical URL |
| PUT/DELETE | `/api/videos/:id/save` | Yes | |
| GET | `/api/me/saved` | Yes | |
| POST | `/api/videos/:id/comments` | Yes (verified) | |
| DELETE | `/api/comments/:id` | Yes | Own comments only |
| POST | `/api/videos/:id/report`, `/api/comments/:id/report` | Yes (verified) | |

## Admin (`/api/admin`, separate session cookie)

`POST /auth/login`, `POST /auth/logout`, `GET /auth/me` (returns the role's permission list), then:

| Area | Endpoints |
| --- | --- |
| Dashboard | `GET /dashboard` |
| Users | `GET /users`, `GET /users/:id`, `POST /users/:id/suspend \| activate \| role` |
| Creators | `GET /creators`, `POST /channels/:id/approve \| reject \| suspend \| activate` |
| Videos | `GET /videos`, `GET /videos/:id`, `PATCH /videos/:id`, `POST /videos/:id/approve \| reject \| remove \| restore \| feature \| pin \| recount \| invalidate`, `GET /videos/:id/suspicious` |
| Reports | `GET /reports`, `POST /reports/:id/investigate \| dismiss \| action` |
| Popularity | `GET /popularity?list=…` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/:id`, `GET /tags`, `POST /tags/remove` |
| Settings | `GET /settings`, `PUT /settings/:key` |
| Audit | `GET /audit` |

Destructive actions require `confirm: true` and a `reason`. Every admin action is written to the
audit log. Permissions are enforced per role on the server, never in the client.

### Creator payments (Super Admin only: `/api/admin/payments`, permission `payments`)

| Area | Endpoints |
| --- | --- |
| Overview | `GET /summary` (cards + graph data), `GET /eligibility?filter=eligible\|below\|no_method` |
| Payment methods | `GET /methods?status=`, `POST /methods/:id/review` (`verify \| reject \| request_changes`), `POST /methods/:id/reveal` (audited) |
| Batches | `GET /batches`, `POST /batches` (`period_start`), `GET /batches/:id`, `POST /batches/:id/approve`, `POST /batches/:id/cancel` (both need `confirm: true`) |
| Payouts | `GET /payouts`, `POST /payouts/:id/transition` (`to`: approved, processing, paid, failed, on_hold, cancelled, eligible; paid needs `transaction_ref` or `tx_hash` + `tx_network`) |
| Adjustments | `GET /adjustments`, `POST /adjustments` (`channel_id`, `amount`, `reason`) |
| Reports | `GET /reconciliation`, `GET /rates`, `GET /export/payouts.csv`, `GET /export/earnings.csv` |

Rates and payout rules are edited with `PUT /api/admin/settings/monetization`; every rate change is recorded in the rate history.
Visitor analytics: `GET /api/admin/analytics/visitors?days=` (permission `analytics`). Recommendation mix: setting `recommendations`.
