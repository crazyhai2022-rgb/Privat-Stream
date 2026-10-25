# Restarting the app on cPanel

The **Restart** button in *Setup Node.js App* does not always stop the running process. When
that happens you get a confusing half-updated site: a `git pull` refreshes the files on disk,
so the **pages** change immediately, while the **API** keeps running the old code from memory.

Symptoms of exactly that:

- the admin page shows new wording, but a new endpoint answers `{"error":{"code":"unauthorized"}}`
- an environment variable you just added behaves as if it is not set
- a fix you pulled makes no difference

## The reliable restart

Phusion Passenger (what cPanel uses to run Node apps) restarts when the file
`tmp/restart.txt` inside the application root changes.

1. cPanel → **File Manager**
2. Go to `viralx/server/tmp/`
3. Select `restart.txt` → **Edit** → add a space or change the date → **Save**
4. Load your site once. The next request starts a fresh process.

The file is in the repository, so it is always there after a pull.

## Checking which version is live

Open `https://your-domain/api/admin/bootstrap` in a browser:

| Response | Meaning |
| --- | --- |
| `{"available":true}` | New code is running and first-time setup is ready |
| `{"available":false}` | New code is running; an administrator already exists, or the token is not set |
| `{"error":{"code":"unauthorized"...}}` | **Old code is still running** — restart as above |
| 404 page | The app is not serving this path; check the application root |

## The usual order after a change

1. cPanel → **Git Version Control** → *Pull*
2. *Setup Node.js App* → **Run NPM Install** (only when dependencies changed)
3. Touch `tmp/restart.txt` as above
4. Check the table above to confirm the new code is live

Environment variable changes need step 3 too — saving them alone is not enough.
