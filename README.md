# x-tweet-filter

Scrapes the latest tweets from a fixed list of X accounts, drops reposts and
tweets containing blocked keywords, and serves the result as a cached JSON API.

```
GitHub Actions (every 15 min)          Vercel (edge cached)
──────────────────────────────         ────────────────────
playwright chromium  ──▶ data/tweets.json ──▶ /api/tweets/<User>
login via secret        data/meta.json      /api/health
                        data/state.json     /api/accounts
                     committed to git      fetched at runtime
```

**The API never scrapes.** Requests only read a dataset that a scheduled job
already built. That keeps responses in the tens of milliseconds, avoids the
Vercel function timeout entirely, and means a dead X session can never take the
API down.

---

## Setup

### 1. Clone and install

```bash
npm ci
```

### 2. Configure the accounts

Edit `config.js`:

```js
accounts: ["FutSheriff", "FNBRintel", "LeagueOfLeaks", "Rainbow6Game", "ValorantUpdated"],
ignoreKeywords: ["giveaway", "airdrop", "sponsored"],
```

Then generate one API endpoint per account:

```bash
npm run generate
```

### 3. Log in to X once, locally

```bash
npm run login     # opens a browser; log in, then press Enter
```

This writes `.browser-profile/`, which is gitignored. Use a throwaway account.

### 4. Push to GitHub

There is no git repo yet in a fresh clone:

```bash
git init && git add -A && git commit -m "initial"
gh repo create <owner>/<repo> --private --source=. --push
```

> Make the repo **private** unless you intend the scraped tweets to be public.
> A public repo needs no token to fetch, which is convenient but means the
> dataset is readable by anyone.

### 5. Add the session as a GitHub secret

The CI runner has no browser to log in with, so the session travels as a secret:

```bash
npm run export-session > session.json
gh secret set X_STORAGE_STATE < session.json
rm session.json
```

### 6. Trigger the first run

Actions → **Scrape X** → *Run workflow*. Watch the log. It commits `data/` on
success. You can also run the same thing locally: `npm start`.

---

## Deploying the API

```bash
npx vercel --prod
```

Then set one variable in the Vercel dashboard:

| Variable | Required | Value |
|---|---|---|
| `XSCRAPER_DATA_URL` | yes | `https://raw.githubusercontent.com/<owner>/<repo>/main/data/tweets.json` |
| `XSCRAPER_DATA_TOKEN` | private repo only | a read-only Contents token |
| `ALLOWED_ACCOUNTS` | no | restricts the dynamic route, e.g. `FutSheriff,FNBRintel` |

`meta.json` is derived from `XSCRAPER_DATA_URL` automatically. `X_STORAGE_STATE`
is **not** needed on Vercel any more.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /api/tweets/<Username>` | tweets for one account (generated per account) |
| `GET /api/tweets?account=a,b` | any accounts, comma separated |
| `GET /api/accounts` | index of served accounts and their endpoints |
| `GET /api/health` | dataset freshness, staleness, per-account coverage |

Query parameters: `limit` (1–100), `exclude` (comma-separated tweet ids you
already have, for stateless dedupe).

```bash
curl https://your-app.vercel.app/api/tweets/FutSheriff?limit=5
```

```json
{
  "ok": true,
  "account": "FutSheriff",
  "mode": "cache",
  "count": 5,
  "generatedAt": "2026-10-05T13:30:34.574Z",
  "ageSeconds": 412,
  "options": { "limit": 5, "onlyNew": false, "matchMode": "word", "ignored": 0 },
  "accounts": [
    {
      "username": "FutSheriff",
      "ok": true,
      "stats": { "available": 37, "kept": 5, "skippedExcluded": 0, "skippedKeyword": 0 },
      "tweets": [
        {
          "username": "FutSheriff",
          "id": "2107081608864096367",
          "author": "FutSheriff",
          "text": "Looking for UK/EU based streamer...",
          "date": "2026-10-05T12:12:57.000Z",
          "url": "https://x.com/FutSheriff/status/2107081608864096367",
          "images": ["https://pbs.twimg.com/media/..."]
        }
      ]
    }
  ],
  "dataset": { "total": 103, "runs": 1, "source": "https://raw.githubusercontent.com/..." }
}
```

Success responses are served with
`Cache-Control: public, max-age=60, s-maxage=600, stale-while-revalidate=300`.
Errors are `no-store`, so a transient failure never sticks at the edge.

---

## The data files

| File | Purpose | Committed |
|---|---|---|
| `data/tweets.json` | the dataset, a flat array newest-first | yes |
| `data/meta.json` | last run's timestamp, counts, run number | yes |
| `data/state.json` | seen tweet ids, required for `onlyNew` | yes |

`data/state.json` is the one non-obvious case: `onlyNew: true` compares against
it, so **it must be committed**. Losing it makes every account re-report its
entire retention window on the next run.

`data/meta.json` is what `/api/health` reads to prove the pipeline is alive. It
is rewritten every run even when zero new tweets arrive, so a quiet but healthy
run is distinguishable from a dead one.

### Retention

Unbounded growth would mean every commit carries the whole file forever, so
`config.js` caps it:

```js
pruneMaxAgeDays: 14,
pruneMaxPerAccount: 500,
```

Applied on every write: dedupe by tweet id, drop anything older than 14 days,
keep the newest 500 per account. Raise these to keep more history, at the cost
of a larger committed file.

---

## Freshness

| Setting | Value | Where |
|---|---|---|
| Scrape cadence | `*/15 * * * *` | `.github/workflows/scraper.yml` |
| Edge cache TTL | `s-maxage=600` (10 min) | `config.js` → `cacheTtlSeconds` |
| Worst-case visibility | ~25 min | — |

The TTL is deliberately shorter than the cron interval: a 10-minute cache on a
15-minute scrape can serve at most one generation of data. Raise it above 600
and the API can outlive the data behind it.

If the workflow stops, `/api/health` flips to `stale: true` once the dataset is
more than `cacheTtlSeconds × 2` old, and the run turns red in the Actions tab
(so you get emailed). There is no in-API signal for "logged out" any more — a
dead session is a *pipeline* failure, not an API failure.

---

## Cloudflare blocks automated runs

x.com sits behind Cloudflare, which scores every request. A blocked run reports:

```
! Cloudflare blocked @FutSheriff (interstitial: "Just a moment...").
  The accounts are fine; the browser or its IP was flagged.
```

and exits non-zero with a `CHALLENGE` code. **This is not an account problem** —
the same accounts work from your machine — so don't go checking privacy settings
or usernames.

Two independent things get flagged:

**1. The browser fingerprint** — mostly handled. `lib/browser.js` drives the
*installed* Edge (falling back to Chrome, then to Playwright's own build) rather
than Playwright's bundled headless shell, hides `navigator.webdriver`, and
rewrites the user agent, which Playwright otherwise reports as
`HeadlessChrome`. The rebuilt UA is derived from the running binary's version, so
it can't drift out of sync. Verify with:

```bash
XSCRAPER_BROWSER=playwright XSCRAPER_SESSION=env node -e "
require('./lib/browser').openBrowser().then(async b => {
  console.log(b.mode, b.browser.version());
  console.log(await b.page.evaluate(() => navigator.userAgent));
  console.log('webdriver:', await b.page.evaluate(() => navigator.webdriver));
  await b.cleanup();
});"
```

Expect no `Headless` token and `webdriver: false`.

**2. The IP address** — not fixable in code. GitHub Actions runners sit on Azure
datacenter addresses, which Cloudflare flags far more aggressively than a
residential connection. No user agent or stealth plugin changes that. If the
fingerprint is clean and it *still* blocks, this is the cause.

Options, roughly in order of reliability:

| Option | Trade-off |
|---|---|
| **Self-hosted runner** on your own machine | Proven: `npm start` already works there. Needs your PC on. |
| **Residential proxy** in the workflow | Reliable, costs money, one config change. |
| **Hosted runner** as-is | Free, but blocked often enough to be unreliable. |

### Running from your own machine instead

```bash
# On the machine that can already reach x.com:
npm start -- --accounts FutSheriff,FNBRintel   # or just `npm start`
```

Or wire it to GitHub as a [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners)
and change one line in the workflow:

```yaml
runs-on: [self-hosted, windows]
```

Self-hosted runners have no cost or quota limits, which matters if the hosted
ones start blocking you regularly.

> A note on `puppeteer-extra-plugin-stealth`: it targets puppeteer, not
> Playwright, so most of its evasions silently do nothing here. It was tried and
> removed — `playwright-core` is now the only runtime dependency.

---

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `X_STORAGE_STATE` | GitHub Actions secret | the X login session |
| `XSCRAPER_SESSION` | Actions | `env` — use the secret, not a profile |
| `XSCRAPER_BROWSER` | Actions | `playwright` — the runner has no Edge |
| `XSCRAPER_DATA_URL` | Vercel | raw URL of `data/tweets.json` |
| `XSCRAPER_DATA_TOKEN` | Vercel | only for a private repo |
| `ALLOWED_ACCOUNTS` | Vercel | optional lockdown of the dynamic route |

See `.env.example` for the full override list.

---

## Local development

```bash
npm start                  # scrape every configured account
npm start -- --headed      # watch the browser work
npm start -- --accounts nasa,github
npm test                   # 63 tests, no browser, no network
```

Locally the CLI drives your installed Edge against `.browser-profile/`. In CI it
drives Playwright's downloaded Chromium from the secret. Those are independent
switches:

| | `XSCRAPER_SESSION` | `XSCRAPER_BROWSER` |
|---|---|---|
| local | `auto` → `.browser-profile/` | `auto` → installed Edge |
| Actions | `env` → the secret | `playwright` → Playwright Chromium |

`auto` prefers the local profile when one exists, so a stale blob left in `.env`
cannot hijack your local runs.

---

## Troubleshooting

**`/api/tweets` returns 503 `DATA_UNAVAILABLE`.**
`XSCRAPER_DATA_URL` is unset or unreachable. In Actions, the workflow has not
committed `data/tweets.json` yet. For a private repo, `XSCRAPER_DATA_TOKEN` is
missing or lacks Contents read access.

**Every run says `Cloudflare blocked @…`.**
See [Cloudflare blocks automated runs](#cloudflare-blocks-automated-runs). The
accounts are fine; the IP or browser was flagged.

**`/api/health` reports `stale: true`.**
More than two cron windows passed without a successful run. Open the Actions tab
and read the failing run's log — a red run means the scrape failed, which is
either a Cloudflare block or an expired X session.

**Everything is `onlyNew`-suppressed.**
`data/state.json` was not committed. Verify it is tracked, then reset if needed:

```bash
rm data/state.json && git commit -am "reset seen ids"
```

**Workflow fails at `npm ci`.**
`package-lock.json` is out of sync with `package.json`; run `npm install` locally
and commit the lockfile.

**Workflow fails at the browser step.**
`npx playwright-core install --with-deps chromium` needs the system libraries
that `--with-deps` pulls in. If the runner image changed, check the action log.