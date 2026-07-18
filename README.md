# First Week Ratings app (v1)

Managers rate a new hire's first 5 working days. Ratings are stored in Factorial; reminders are native Factorial tasks. Zero npm dependencies, needs Node 18+.

## How it works

1. `poller.js` (run daily, e.g. via cron) reads the custom field **"First shift takes place on:"** for all employees. For each employee with a date it creates 5 tasks for their manager (due day 1 to day 5, weekends skipped), each containing a signed rating link. Idempotent; reschedules if the date changes before submission.
2. `server.js` serves the rating form at `/rate/<token>` and on submit writes a row to the **First Week Ratings** custom table (schema 7029) on the employee, then marks the day's task done.
3. `state.json` tracks created tasks and submissions (single source of dedupe).

## Files

- `factorial.js` - API client (reads `.env`)
- `token.js` - HMAC-signed link tokens
- `poller.js` - daily task creator
- `server.js` - form + submit endpoint (port 3141)
- `form.html` - form template (Factorial look)
- `config.json` - IDs of the field/schema/table columns in the demo account

## Setup

`.env` (already present, demo account):

```
FACTORIAL_BASE=https://api.eu2.demo.factorial.dev/api/2026-07-01
FACTORIAL_API_KEY=<api key>
TOKEN_SECRET=<random secret>
APP_URL=<public URL of server.js>
```

Run:

```
node server.js          # keep running (or behind a process manager / reverse proxy)
node poller.js          # once per day (cron)
```

## Verified end-to-end against the demo account (18 Jul 2026)

- API key works against `api.eu2.demo.factorial.dev`
- Created custom field "First shift takes place on:" (id 2071076) and set it to 2026-07-20 for Hellen Howard
- Created custom table "First Week Ratings" (schema 7029) with Day number, Shift date, Rating, Comment, Rated by, Submitted at
- Poller created 5 tasks for manager Charles Carter (due 20-24 Jul); second run created 0 (idempotent)
- Form rendered with live employee data; submitting 5 stars + comment wrote row 1201 (6 values) and marked task 49166443 done
- Duplicate submission correctly rejected (409)

Check it visually in the demo UI: Hellen Howard > Others tab (First Week Ratings row), and Tasks (day 2 done, days 1/3/4/5 open). Note: row 1200 on Hellen is a leftover manual API test; delete it in the UI.

## Deploying on Render

The repo includes `render.yaml` (Frankfurt region, starter plan ~$7/month, 1 GB persistent disk for `state.json`). The poller runs inside the web service every 6 hours, so no separate cron service is needed.

1. Push this folder to a GitHub repo (`.env` is gitignored; secrets go in Render, not in git).
2. On render.com: New > Blueprint > select the repo. Render reads `render.yaml`.
3. When prompted, fill in `FACTORIAL_API_KEY` (the demo key) and leave `APP_URL` empty for now. `TOKEN_SECRET` is generated automatically.
4. After the first deploy, copy the service URL (e.g. `https://first-week-ratings.onrender.com`), set it as `APP_URL` in the service's environment, and redeploy.
5. Old tasks contain localhost links. Run `node cleanup-tasks.js --yes` locally once (it discards open rating tasks); within 10 seconds of the redeploy the poller recreates them with public links.
6. Verify: open the link from a task in the demo account on your phone; submit; check the row in Factorial.

## Before production

- Host `server.js` behind HTTPS and set `APP_URL` accordingly; regenerate `TOKEN_SECRET`
- Move `state.json` to a real store (SQLite/Postgres) if running redundantly
- Restrict table visibility via Settings > Permissions (view for HR group only) and verify while logged in as a test employee
- Recreate field/schema in the client's production account and update `config.json` (or add a setup script)
- Agree reminder/escalation behaviour for missed days and low ratings
