// Local CLI + GitHub Actions entry point. The scraping logic lives in lib/.
//
//   node index.js                          scrape every account in config.js
//   node index.js --accounts nasa,github   add accounts for this run
//   node index.js --login                  open a browser and log in to X
//   node index.js --export-session         print the session JSON for Actions
//
// Locally it drives the installed Edge against .browser-profile/. On GitHub
// Actions it drives Playwright's Chromium using X_STORAGE_STATE.

const fs = require("fs");
const path = require("path");

const { getConfig, listAccounts, normalizeUsername } = require("./lib/config");
const { openBrowser, resolveSession } = require("./lib/browser");
const { scrapeMany } = require("./lib/scraper");
const { loadState, saveState, getSeen, recordSeen, appendTweets } = require("./lib/state");
const { interactiveLogin, exportStorageState } = require("./lib/session");

// ---------- outcome reporting ----------
//
// Actions logs need authentication, so the one fact that matters -- whether the
// run failed as CHALLENGE or as NOT_LOGGED_IN, which need different fixes --
// would be unreachable. The workflow commits data/ with if: always(), so write
// the outcome there and it can be read without repo access.
//
// Deterministic on purpose: no timestamps, ray ids and workspace paths removed.
// An unchanged failure produces an unchanged file, so it does not churn a
// commit every 15 minutes.

const OUTCOME_FILE = path.join(__dirname, "data", "scrape-error.json");

function sanitize(text) {
  return String(text == null ? "" : text)
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>") // Cloudflare ray ids
    .replace(process.env.GITHUB_WORKSPACE || "\u0000", "")
    .replace(/\s+/g, " ")
    .trim();
}

function writeScrapeOutcome(outcome) {
  try {
    if (outcome.ok) {
      // A stale failure left behind by an earlier run would be misleading.
      fs.rmSync(OUTCOME_FILE, { force: true });
      return;
    }
    const report = {
      ok: false,
      code: outcome.code || "UNKNOWN",
      failed: (outcome.failed || []).map((f) => ({
        username: f.username || null,
        code: f.code || null,
        message: sanitize(f.error || f.message),
      })),
    };
    fs.mkdirSync(path.dirname(OUTCOME_FILE), { recursive: true });
    fs.writeFileSync(OUTCOME_FILE, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    // Reporting must never take down the scrape it is reporting on.
  }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { login: false, exportSession: false, accounts: [], headed: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--login") out.login = true;
    else if (arg === "--export-session") out.exportSession = true;
    else if (arg === "--headed" || arg === "--show") out.headed = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--accounts" && argv[i + 1]) out.accounts = argv[i + 1].split(",");
  }
  return out;
}

function printUsage() {
  console.log(`
x-tweet-filter

  npm start                             scrape all accounts in config.js
  npm start -- --accounts nasa,github   scrape extra accounts too
  npm start -- --headed                 watch the browser work
  npm run login                         log in to X (one-time, local only)
  npm run export-session                print session JSON for the Actions secret
  npm run generate                      (re)create one API endpoint per account

Data files (committed by the workflow):
  data/tweets.json   the dataset, pruned to config.pruneMaxAgeDays / pruneMaxPerAccount
  data/meta.json     last successful run, used by /api/health for freshness
  data/state.json    seen tweet ids, required for onlyNew
`);
}

// ---------- commands ----------

async function login() {
  await interactiveLogin();
  console.log("Session saved. Run: npm start");
}

async function exportSession() {
  const state = await exportStorageState();
  const json = JSON.stringify(state);
  console.error(
    `${state.cookies.length} cookie(s) captured (${(json.length / 1024).toFixed(1)} KB).`
  );
  console.error(`\nAdd this as a GitHub Actions secret:\n  gh secret set X_STORAGE_STATE < session.json\n`);
  // The blob goes to stdout so it can be piped; the guidance above goes to stderr.
  process.stdout.write(json);
}

async function run(args) {
  const config = getConfig();
  const accounts = [...new Set([...listAccounts(), ...args.accounts.map(normalizeUsername)].filter(Boolean))];

  if (!accounts.length) {
    console.error("No accounts configured. Add some to config.js or pass --accounts.");
    writeScrapeOutcome({ ok: false, code: "NO_ACCOUNTS" });
    process.exit(1);
  }

  // Preflight so a missing session fails in a second instead of after a browser
  // launch plus a 20s selector timeout.
  const session = resolveSession();
  if (session.error) {
    console.error(`No usable session (${session.source}). ${session.hint || ""}`.trim());
    writeScrapeOutcome({ ok: false, code: "NO_SESSION", failed: [{ username: null, code: "NO_SESSION", error: session.error }] });
    process.exit(1);
  }
  console.log(`Session: ${session.source}. Browser: ${process.env.CI === "true" ? "playwright chromium" : config.browserChannel}.`);

  const state = loadState();
  const kept = [];
  let results = [];

  const browser = await openBrowser({ headless: args.headed ? false : config.headless });
  try {
    results = await scrapeMany(browser.page, accounts, {
      onlyNew: config.onlyNew,
      signal: null,
      seen: (username) => getSeen(state, username),
    });

    for (const result of results) {
      console.log(`\n=== @${result.username} ===`);
      if (!result.ok) {
        console.error(`  ! ${result.error}`);
        if (result.code === "NOT_LOGGED_IN") break;
        continue;
      }

      for (const tweet of result.tweets) {
        console.log(`\n[${tweet.date}]\n${tweet.text}\n${tweet.url}`);
        if (tweet.images.length) console.log(`Images: ${tweet.images.join(", ")}`);
        kept.push(tweet);
      }

      const s = result.stats;
      console.log(
        `\n  (skipped: ${s.skippedNoCaption} no caption, ${s.skippedRepost} reposts, ` +
          `${s.skippedKeyword} keyword matches, ${s.skippedSeen} already seen)`
      );

      recordSeen(state, result.username, result.allIds);
    }
  } finally {
    await browser.cleanup();
  }

  saveState(state);

  // Always write, even with zero new tweets: meta.json is what /api/health reads
  // to prove the workflow is still alive. Skipping it would make a healthy quiet
  // run look like a stale one.
  const result = appendTweets(kept);

  if (result.meta) {
    console.log(
      `\nDataset: +${result.meta.added} new, ${result.meta.total} total, ${result.meta.pruned} pruned ` +
        `(> ${config.pruneMaxAgeDays}d or > ${config.pruneMaxPerAccount}/account)`
    );
    console.log(`Wrote ${config.metaFile} (run #${result.meta.runs}).`);
  }
  if (!kept.length) console.log("\nNo new tweets this run.");

  // Failure policy: a dead session or a total wipeout must turn the Actions run
  // red so it shows up in your inbox. A single flaky account should not block
  // the dataset from being committed.
  const failed = results.filter((r) => !r.ok);
  if (!results.length || failed.length === results.length || failed.some((f) => f.code === "NOT_LOGGED_IN")) {
    console.error(`\nRun failed: ${failed.map((f) => `${f.username} (${f.error})`).join("; ") || "no accounts ran"}`);

    // The code is the whole point: CHALLENGE means the browser or its IP was
    // flagged, NOT_LOGGED_IN means the session secret is stale. They need
    // different fixes, so record which one it actually was.
    const codes = failed.map((f) => f.code).filter(Boolean);
    const outcomeCode =
      !failed.length ? "NO_RESULTS"
        : new Set(codes).size === 1 ? codes[0]
          : codes.includes("NOT_LOGGED_IN") ? "NOT_LOGGED_IN"
            : codes.includes("CHALLENGE") ? "CHALLENGE"
              : "MIXED";
    writeScrapeOutcome({ ok: false, code: outcomeCode, failed });

    // A challenge is an infrastructure problem, not a data problem, so say what
    // to actually do about it instead of listing account names.
    const challenged = failed.filter((f) => f.code === "CHALLENGE");
    if (challenged.length === failed.length && challenged.length) {
      console.error(
        "\nEvery account was blocked by Cloudflare, so the session and accounts are probably fine.\n" +
          "This is the browser or the IP being flagged:\n" +
          "  - Prefer a real browser: the workflow already asks for the installed Edge, then Chrome.\n" +
          "  - GitHub runner IPs are datacenter addresses and are blocked more often. If it keeps\n" +
          "    happening, run this on a self-hosted runner (your own machine) or use a residential proxy.\n" +
          "  - The local command (npm start) working while CI fails is a strong IP signal."
      );
    }
    process.exit(1);
  }
  if (failed.length) {
    console.warn(`\n${failed.length}/${results.length} accounts failed; committing partial results.`);
    // Exit 0, but still record it: a run where every account was challenged is
    // not a healthy run even though the dataset was committed.
    const codes = new Set(failed.map((f) => f.code));
    writeScrapeOutcome({
      ok: false,
      code: codes.size === 1 ? `PARTIAL_${[...codes][0]}` : "PARTIAL_MIXED",
      failed,
    });
  } else {
    writeScrapeOutcome({ ok: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printUsage();
  if (args.login) return login();
  if (args.exportSession) return exportSession();
  return run(args);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  writeScrapeOutcome({
    ok: false,
    code: "FATAL",
    failed: [{ username: null, code: "FATAL", error: err && (err.stack || err.message) }],
  });
  process.exit(1);
});