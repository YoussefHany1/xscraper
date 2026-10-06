// Diagnostics that separate the causes of a blocked run.
//
//   npm run doctor
//   npm run doctor -- --json data/diagnostics.json
//
// The key check is `Raw HTTP fetch`: it makes NO browser request, so it carries
// no automation fingerprint at all. If the host itself gets an interstitial, the
// IP is being blocked and no amount of browser hardening can fix it. That one
// check separates "IP flagged" from "fingerprint flagged", which is otherwise
// guesswork.
//
// `--json` writes the verdict where the workflow can commit it back to the
// repo, because Actions logs need authentication and the verdict is useless if
// it cannot be read. The report contains no per-request fields (no ray ids, no
// timestamps), so an unchanged verdict produces an unchanged file and the
// workflow does not commit an empty churn every 15 minutes.

const fs = require("fs");
const https = require("https");

process.env.XSCRAPER_SKIP_ENV_FILE = process.env.XSCRAPER_SKIP_ENV_FILE || "";

const { getConfig, listAccounts } = require("../lib/config");
const { getStorageState, describeSession } = require("../lib/session");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const results = [];
function check(name, status, detail, advice) {
  results.push({ name, status, detail, advice });
  const mark = { ok: "  ok  ", warn: " warn ", bad: " FAIL " }[status] || "  ??  ";
  console.log(`${mark}${name}${detail ? ` — ${detail}` : ""}`);
  if (advice && status !== "ok") console.log(`       -> ${advice}`);
}

// ---------------------------------------------------------------------------

// Raw HTTPS GET. No browser, therefore no webdriver/UA/headless signals.
function rawFetch(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 200000) {
            req.destroy();
          }
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// Markers present in Cloudflare's interstitial, before any JS runs.
const CF_MARKERS = [
  /just a moment/i,
  /cf-browser-verification/i,
  /_cf_chl_opt/i,
  /challenge-platform/i,
  /cdn-cgi\/challenge/i,
  /cf_chl_|__cf_chl/i,
  /ray id/i,
  /performing security verification/i,
];

function looksBlocked({ status, headers, body }) {
  const server = String(headers["server"] || "");
  const cfRay = headers["cf-ray"];
  const viaCf = /cloudflare/i.test(server) || Boolean(cfRay);
  const matched = CF_MARKERS.filter((re) => re.test(body)).map((re) => String(re));
  return {
    blocked: matched.length > 0 || status === 403 || status === 503,
    viaCloudflare: viaCf,
    matched,
  };
}

// ---------------------------------------------------------------------------

// The committed report. Pure: every volatile field (ray id, timestamp) must stay
// out of here, because the workflow commits this file and a timestamp would
// produce a commit every 15 minutes with no actual change.
function buildReport({ verdict, verdictText, http, session, accounts, results }) {
  return {
    verdict,
    verdictText,
    http,
    session,
    accounts,
    checks: results.map(({ name, status, detail }) => ({ name, status, detail })),
    failed: results.filter((r) => r.status === "bad").length,
    warned: results.filter((r) => r.status === "warn").length,
  };
}

function writeReport(jsonPath, report) {
  fs.mkdirSync(require("path").dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;

  const config = getConfig();
  const accounts = listAccounts();

  console.log("\nx-scraper doctor\n================");

  // 1. Config
  check(
    "accounts configured",
    accounts.length ? "ok" : "bad",
    `${accounts.length}: ${accounts.join(", ") || "none"}`,
    "Add accounts to config.js"
  );

  // 2. Session
  const session = describeSession();
  let sessionInfo = { configured: Boolean(session.configured), error: session.error || null };
  if (!session.configured) {
    check("X session present", "bad", "X_STORAGE_STATE is not set", "gh secret set X_STORAGE_STATE < session.json");
  } else if (session.error) {
    check("X session present", "bad", session.error, "Re-export it with: npm run export-session");
  } else {
    const state = getStorageState();
    const names = state.cookies.map((c) => c.name);
    const hasAuth = names.includes("auth_token");
    const hasCt0 = names.includes("ct0");
    const origins = (state.origins || []).length;
    sessionInfo = { ...sessionInfo, cookies: names.length, authToken: hasAuth, ct0: hasCt0, origins };
    check(
      "X session cookies",
      hasAuth || hasCt0 ? "ok" : "warn",
      `${names.length} cookies | auth_token=${hasAuth} ct0=${hasCt0} | origins=${origins}`,
      "A blob with no auth_token/ct0 is not a logged-in session"
    );
    if (!origins) {
      check(
        "X session localStorage",
        "warn",
        "no origins exported",
        "X keeps state in localStorage; re-run `npm run export-session` with the updated trimState"
      );
    }
  }

  // 3. Raw HTTP — the decisive check. No browser, no fingerprint.
  console.log("\n  Raw HTTPS request to x.com (no browser involved)\n");
  let verdict = "unknown";
  let httpInfo = null;
  try {
    const res = await rawFetch("https://x.com/robots.txt");
    const { blocked, viaCloudflare, matched } = looksBlocked(res);

    console.log(`  HTTP ${res.status} | server=${res.headers.server || "-"} | cf-ray=${res.headers["cf-ray"] || "-"}`);
    if (matched.length) console.log(`  markers: ${matched.join(", ")}`);

    // Deliberately no ray id: it changes every request and would churn the
    // committed report even when nothing actually changed.
    httpInfo = { status: res.status, server: String(res.headers["server"] || ""), markers: matched, viaCloudflare };

    if (blocked) {
      verdict = "ip";
      check("x.com reachable from this host", "bad", "Cloudflare interstitial on a plain HTTPS request",
        "The IP is blocked. No browser change can fix this -- use a self-hosted runner or a proxy.");
    } else {
      verdict = "clear";
      check("x.com reachable from this host", "ok", `HTTP ${res.status}, no interstitial`,
        "The IP is fine, so any block is caused by the browser fingerprint or the session.");
    }
  } catch (err) {
    httpInfo = { error: err.message };
    check("x.com reachable from this host", "warn", err.message, "Check network egress.");
  }

  // 4. Only meaningful if the raw request passed.
  if (verdict === "clear") {
    const { openBrowser, resolveBrowserSource, resolveSession } = require("../lib/browser");
    const src = resolveBrowserSource();
    const sess = resolveSession();

    if (sess.error) {
      check("browser session resolved", "bad", sess.error, sess.hint);
    } else if (src === "system") {
      check("browser session resolved", "ok", `${sess.source} / system (${config.browserChannel})`);
    } else {
      let b;
      try {
        b = await openBrowser();
        const probe = await b.page.evaluate(() => ({
          ua: navigator.userAgent,
          wd: navigator.webdriver,
        }));
        const headlessLeak = /Headless/i.test(probe.ua);
        const major = (b.browser && b.browser.version().split(".")[0]) || "";
        const uaMajor = (probe.ua.match(/Chrome\/(\d+)/) || [])[1];
        const mismatch = major && uaMajor && major !== uaMajor;

        check("browser fingerprint", headlessLeak || probe.wd || mismatch ? "warn" : "ok",
          `${b.mode} v${major} | webdriver=${probe.wd} | UA=${probe.ua}`,
          headlessLeak ? "UA leaks Headless" : probe.wd ? "navigator.webdriver is exposed" : "UA version does not match the binary");

        await b.cleanup();
      } catch (err) {
        check("browser launch", "bad", err.message, "See README for browser troubleshooting.");
      }
    }
  }

  console.log("\n----------------\n");
  const failed = results.filter((r) => r.status === "bad").length;
  const warned = results.filter((r) => r.status === "warn").length;
  console.log(`${failed} failed, ${warned} warnings\n`);

  let verdictText;
  if (verdict === "ip") {
    verdictText = "this host's IP is blocked by Cloudflare";
    console.log("VERDICT: this host's IP is blocked by Cloudflare.");
    console.log("The accounts, the session and the browser code are not the problem.");
    console.log("Move the job somewhere with a residential IP:\n");
    console.log("  1. Self-hosted runner on this machine (works today, proven):");
    console.log("     https://docs.github.com/actions/hosting-your-own-runners");
    console.log("     then set runs-on: [self-hosted, windows] in the workflow\n");
    console.log("  2. A residential proxy, added to the workflow as an env var.\n");
  } else if (verdict === "clear") {
    verdictText = "the IP is fine; the block is the fingerprint or the session";
    console.log("VERDICT: the IP is fine -- look at the session and fingerprint warnings above.");
  } else {
    verdictText = "unknown: the network check did not complete";
    console.log("VERDICT: unknown -- the network check did not complete.");
  }

  const report = buildReport({
    verdict,
    verdictText,
    http: httpInfo,
    session: sessionInfo,
    accounts: accounts.length,
    results,
  });

  if (jsonPath) {
    writeReport(jsonPath, report);
    console.log(`Report written to ${jsonPath}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((r) => `| ${r.name} | ${r.status} | ${String(r.detail || "").replace(/\|/g, "\\|")} |`)
      .join("\n");
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## x-scraper preflight\n\n**Verdict:** ${verdictText}\n\n` +
        `| Check | Status | Detail |\n|---|---|---|\n${rows}\n\n` +
        `Committed to \`data/diagnostics.json\` so it can be read without repo access.\n`
    );
  }

  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error("doctor crashed:", err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { buildReport, writeReport, looksBlocked, CF_MARKERS };
