# Trending and ranking

Every sort on the platform reads one stored number per video, except **Trending**, which is
computed on demand from recent activity. Nothing is merged into a single "popularity" figure that
the UI then pretends is views or hearts — the separate counters stay separate everywhere.

## Sorting options

| Sort | Orders by |
| --- | --- |
| Trending | the score below (pinned videos first) |
| Most Viewed | `views_count` |
| Most Hearted | `hearts_count` |
| Most Disliked | `dislikes_count` |
| Most Commented | `comments_count` |
| Most Shared | `shares_count` |
| Recently Uploaded | `published_at` |
| Admin Featured | featured videos, pinned rank first, then most recently featured |

## The trending score

For each video, activity is counted **only inside the configured time window**:

```
recent_views    = distinct actors who viewed in the window
recent_hearts   = hearts created in the window
recent_shares   = distinct actors who shared in the window
recent_comments = visible comments created in the window
recent_dislikes = dislikes created in the window

base = max(0,
    w_views    × recent_views
  + w_hearts   × recent_hearts
  + w_shares   × recent_shares
  + w_comments × recent_comments
  − w_dislikes × recent_dislikes)

engagement_bonus = 1 + w_engagement × min(1, (recent_hearts + recent_shares + recent_comments) / max(recent_views, 1))

time_decay = max(0.1, 0.5 ^ (hours_since_published / half_life_hours))

score = base × engagement_bonus × time_decay
```

### Defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| `window_hours` | 72 | Only activity from the last 3 days counts |
| `half_life_hours` | 48 | A video's score halves every 2 days |
| `w_views` | 1 | A view is the baseline unit |
| `w_hearts` | 4 | A heart is worth four views |
| `w_shares` | 6 | A share is the strongest positive signal |
| `w_comments` | 3 | Comments indicate real engagement |
| `w_dislikes` | 2 | Dislikes subtract |
| `w_engagement` | 2 | Up to a 3× bonus for a high engagement rate |

A Super Admin changes all of these under **Platform settings → Trending & ranking**; the effect is
immediate and recorded in the audit log.

## Why old videos cannot dominate

Three independent mechanisms:

1. **The window.** Only activity inside `window_hours` is counted, so a video with a million views
   from last year contributes nothing today.
2. **Time decay.** The score halves every `half_life_hours`, with a floor of 0.1 so an older video
   that is genuinely active again can still climb.
3. **The engagement-rate bonus** rewards videos whose viewers actually react, which favours fresh
   content that resonates over content that merely accumulated impressions.

The other sorts are deliberately lifetime totals — "Most Viewed" should mean most viewed.

## Anti-abuse safeguards

- **One reaction per actor per video.** Logged-in users are keyed by user id; anonymous visitors by
  an opaque random identifier in an HttpOnly cookie, stored only as an HMAC.
- **Views are de-duplicated** per actor per 30 minutes; the trending score counts *distinct* actors,
  so repeated views from one person add nothing to ranking.
- **Shares are counted once per actor per hour**, and distinct actors in the score.
- **Creators' own views do not count.**
- **Rate limits** on every engagement endpoint, plus a per-network hourly cap on anonymous reactions.
- **Visibility.** Removing a video or suspending its channel takes it out of every ranking at once.

## What administrators can and cannot do

**Can:** feature and unfeature videos, pin up to 50 videos to a rank, change every weight and
window above, inspect each video's separate metrics and trending score, review suspicious
engagement, and invalidate engagement from a specific network or actor (with a written reason;
all counters are then recomputed from the remaining events and the action is audited).

**Cannot:** type a view, heart, dislike, comment, share or save count. There is no endpoint that
sets a counter to an arbitrary value — the only write paths are real engagement events, a recount
from the source tables, and the audited invalidation above. The admin API deliberately ignores
counter fields sent in a metadata update, and a test asserts this.
