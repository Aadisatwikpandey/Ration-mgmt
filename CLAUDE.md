# Rules for working on this repo

Shared rules for Claude Code and for people. Claude loads this file automatically, so everyone working here follows the same conventions. If a rule needs to change, change it here in a PR.

## Working rules

- **Read-only by default.** Don't change anything unless the person explicitly asks for that change. That covers file edits, git writes (commit, push, pull, checkout, stash), and anything under `data/`. Approval for one change doesn't carry over to the next.
- **Run read-only commands yourself** instead of asking the person to: `git log/diff/show/grep`, reading files, `curl` GETs against a local test server.
- **Never touch real data.** Test against a throwaway folder: `DATA_DIR=/tmp/ration-test PORT=8765 python3 server.py`. Never read, copy or commit `data/` or `.env`; they hold the household's spending and PIN.
- **Git:** never commit straight to `main`. Make a branch, open a PR, and push only when asked. Commit messages: a short imperative summary, then *why* in the body.
- **The repo is public.** No personal details, emails, real PINs, real data or machine-specific paths in code, docs or commits. Use placeholders (`mac-mini.tail1234.ts.net`, `APP_PIN=`).
- **Report honestly:** say what was tested and how, and what wasn't.

## What this is

A phone app for a household's monthly wholesale ration list and weekly fresh shopping. It covers ticking items, wholesale-trip prices, mid-month top-ups, spend history, a monthly review that adjusts next month's quantities, and calendar reminders. One Python server on a Mac mini serves it to Android phones. See `README.md` for features and setup.

## Hard constraints (don't break these)

1. **Mac mini only.** No cloud hosting (Vercel and similar were removed on purpose). Away from home, access goes through Tailscale (`tailscale serve --bg 8080`), which also provides HTTPS.
2. **No dependencies and no build step.**
   - The server is `server.py`, Python **standard library only**. It must run on the macOS system Python **3.9** (`/usr/bin/python3`), so no `match`, no `X | Y` type unions and no `str.removesuffix`, plus anything else newer than 3.9.
   - The frontend is plain ES modules in `public/`: no frameworks, bundlers, npm packages or CDN links.
3. **As little memory and CPU as possible.** The server idles at about 20 MB RSS with no measurable CPU; keep it that way.
   - No polling. Phones long-poll `GET /api/state?rev=N&wait=25`.
   - Data stays in memory (`Store.data`, `Store.body`) and the disk is written only on change.
   - Static files are served from memory with ETags.
   - No per-request logging. No background threads or timers on the server.
   - Measure RSS before and after any server change (`ps -o rss= -p <pid>`).
4. **Never lose or delete data.**
   - Writes are atomic: temp file, `fsync`, `os.replace`.
   - Daily backups in `data/backups/` are never pruned. A restore keeps a `pre-import-*` copy first.
   - A damaged `data.json` stops the server; it is never overwritten.
   - Items are archived (`archived: true`), never removed. Months are kept forever.
   - Data-shape changes must be **additive and optional**. An old `data.json` must keep loading, and existing keys must never be renamed.
5. **Phone-first (Android Chrome).**
   - Tap targets of at least 44 px, and inputs at 16 px or more (so the page doesn't zoom).
   - Sheets keep a pinned Save button, and the back button closes a sheet instead of leaving the app.
   - Check every UI change at 375×812 in both light and dark mode.
6. **Security stays strict.**
   - The CSP is `script-src 'self'; style-src 'self'`: no inline scripts, inline styles or `on*=` attributes. Set dynamic sizes from JS (see `data-w`).
   - Escape all user text with `esc()` before it goes into HTML.
   - Writes need `application/json` and a same-origin `Origin`. The PIN cookie is HttpOnly + SameSite=Strict. Login locks after 5 failures.

## How the code fits together

- **Edits are ops**, not whole-file saves: `{p: [path…], v: value}` sets a value and `{p: [path…], d: 1}` removes one. Paths start at `settings | categories | items | months | weeks`, and each segment matches `[A-Za-z0-9_-]{1,64}`.
  - `public/shared/ops.js` (browser) and `valid_op` / `apply_ops` in `server.py` **must stay identical**. Change both together.
- **The phone keeps** the last server copy plus pending ops in `localStorage`, and shows server + pending. Pending ops are sent after 400 ms and retried when offline.
- **Data shape**, in `data.json` and `defaults.json`:
  - `settings`: `startMonth` (`"2026-10"`), `people`, `basePeople`, reminder fields, budget.
  - `categories`: `{title, freq: monthly|weekly, order}`.
  - `items`: `{name, cat, order, qty+unit (g|ml|pcs, stored for basePeople) | text, note?, archived?}`.
  - `months["YYYY-MM"]`: `checked`, `purchases`, `feedback` (`more|ok|less`), `applied`, `appliedAt`, `notes`.
  - `weeks["YYYY-MM-DD" of Monday]`: `checked`.
- **Purchases:** `{kind: wholesale|topup|fresh|milk|meat|other, date, shop?, total?, open?, lines?}`. Each line is `{item?, name, qty?, amount?}`.
  - A purchase belongs to the **list month being viewed**, not to its date's month.
  - There's one wholesale trip per month. The bill `total` wins over the sum of its lines.
- **Review:** a top-up of a list item counts as "needed more" unless it's marked otherwise. The suggested quantity is the current amount plus the topped-up amount, or ±25% when there's no top-up.
- **`public/sw.js`** caches the app shell (network first, with a 3-second fallback). Never cache `/api/`. Bump `CACHE` when the shell file list changes.

## Testing a change

Run everything against a temp `DATA_DIR`, never `data/`.

- **Syntax:** `python3 -m py_compile server.py && /usr/bin/python3 -m py_compile server.py`. For JS, `node --check public/app.js` if Node is around (it's only a dev tool here).
- **API with curl:**
  - login with a wrong PIN, the right PIN, then the lockout
  - `/api/ops` with valid ops, plus the bad ones (`__proto__`, a root delete, an unknown root, a non-JSON body, a cross-site `Origin`)
  - 25 simultaneous saves, all kept
  - a long-poll answered when another save lands
  - a damaged `data.json` refusing to start
- **UI:** the phone-size browser at 375×812, light and dark. Embedded browser panes may block service workers; test offline mode in real Chrome (headless over the DevTools protocol works).
- **Memory:** report the server's RSS if the server changed.

## Style

- Match the surrounding code: small functions, comments that explain *why*, and existing names and patterns.
- User-facing text is short and plain, for someone in a busy market.
- Keep `README.md` in step with behaviour changes.
