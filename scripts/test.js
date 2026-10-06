// Smoke tests for the pure layers, the dataset pipeline and the API handlers.
// No browser is launched and no network is touched -- fetch is stubbed.
//
//   npm test

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Hermetic environment: a developer's real .env must not leak a live session or
// a data URL into the assertions. Must be set before lib/config is required.
process.env.XSCRAPER_SKIP_ENV_FILE = "1";

delete process.env.X_STORAGE_STATE;
delete process.env.ALLOWED_ACCOUNTS;
delete process.env.GITHUB_REPOSITORY;
delete process.env.GITHUB_REF_NAME;
delete process.env.XSCRAPER_DATA_URL;
delete process.env.XSCRAPER_DATA_TOKEN;

const { getConfig, resetConfigCache, listAccounts, normalizeUsername, isValidUsername } = require("../lib/config");
const { buildMatcher, filterTweets, isRepost } = require("../lib/filter");
const { describeSession, getStorageState } = require("../lib/session");
const { resolveSession, resolveBrowserSource, resolveSessionSource } = require("../lib/browser");
const {
  pruneRecords,
  writeDataset,
  loadDataset,
  resolveDataUrls,
  resetDatasetCache,
  datasetAgeSeconds,
  DataUnavailableError,
} = require("../lib/dataset");

const passed = [];
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function run() {
  for (const { name, fn } of queue) {
    // Snapshot and restore the environment around every test. Without this, a
    // failing assertion runs before its own cleanup, leaves a stray
    // X_STORAGE_STATE behind, and cascades into unrelated later tests.
    const saved = { ...process.env };
    try {
      await fn();
      passed.push(name);
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n       ${err.message}`);
      process.exitCode = 1;
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(saved)) {
        if (process.env[key] !== value) process.env[key] = value;
      }
    }
  }
  console.log(`\n${passed.length}/${queue.length} passed${process.exitCode ? ", SOME FAILED" : ""}`);
}

// --- config -----------------------------------------------------------------

test("normalizeUsername strips @, URLs and paths", () => {
  assert.equal(normalizeUsername("@FutSheriff"), "FutSheriff");
  assert.equal(normalizeUsername("https://x.com/FutSheriff"), "FutSheriff");
  assert.equal(normalizeUsername("https://twitter.com/FutSheriff/status/123"), "FutSheriff");
  assert.equal(normalizeUsername("FutSheriff?ref=1"), "FutSheriff");
  assert.equal(normalizeUsername("  nasa  "), "nasa");
  assert.equal(normalizeUsername(null), "");
});

test("isValidUsername follows X's 1-15 [A-Za-z0-9_] rule", () => {
  assert.equal(isValidUsername("FutSheriff"), true);
  assert.equal(isValidUsername("a"), true);
  assert.equal(isValidUsername("waytoolongusername1"), false);
  assert.equal(isValidUsername("bad-name"), false);
  assert.equal(isValidUsername(""), false);
});

test("config.js accounts are all valid endpoints", () => {
  const accounts = listAccounts();
  assert.ok(accounts.length >= 5, "expected at least 5 accounts");
  for (const a of accounts) assert.ok(isValidUsername(a), `invalid: ${a}`);
  assert.deepEqual(accounts, [...new Set(accounts)], "accounts must be deduped");
});

test("per-account overrides win over config.js", () => {
  const c = getConfig({ maxTweetsPerAccount: 3, matchMode: "substring" });
  assert.equal(c.maxTweetsPerAccount, 3);
  assert.equal(c.matchMode, "substring");
  assert.equal(getConfig().maxTweetsPerAccount, 20, "cached base config stays clean");
});

test("viewport and scroll defaults survive merging", () => {
  const c = getConfig();
  assert.equal(c.viewport.width, 1280);
  assert.equal(c.staleScrollLimit, 3);
  assert.equal(c.scrollDelayMs, 1200);
});

test("retention and cache defaults match the 15 minute workflow", () => {
  const c = getConfig();
  assert.equal(c.pruneMaxAgeDays, 14);
  assert.equal(c.pruneMaxPerAccount, 500);
  assert.equal(c.cacheTtlSeconds, 600, "600 == */15");
});

test("dataset paths resolve to absolute files under the project root", () => {
  const c = getConfig();
  for (const key of ["outputFile", "stateFile", "metaFile", "profileDir"]) {
    assert.ok(path.isAbsolute(c[key]), `${key} must be absolute, got ${c[key]}`);
  }
  assert.equal(path.basename(c.outputFile), "tweets.json");
  assert.equal(path.basename(c.stateFile), "state.json");
  assert.equal(path.basename(c.metaFile), "meta.json");
});

test("dataMetaUrl is derived from dataUrl", () => {
  const c = getConfig({ dataUrl: "https://example.com/raw/data/tweets.json" });
  assert.equal(c.dataMetaUrl, "https://example.com/raw/data/meta.json");
});

// --- filters ----------------------------------------------------------------

test("word mode ignores partial matches", () => {
  const m = buildMatcher(["nft", "giveaway"], "word");
  assert.equal(m("this is an NFT drop"), true);
  assert.equal(m("a craft project"), false, "nft must not match inside 'craft'");
  assert.equal(m("join my giveaway now"), true);
});

test("word mode is case-insensitive and accent-aware", () => {
  const m = buildMatcher(["AirDrop"], "word");
  assert.equal(m("free AIRDROP here"), true);
  assert.equal(m("café airdrop"), true);
});

test("substring mode matches anywhere", () => {
  const m = buildMatcher(["fc27"], "substring");
  assert.equal(m("the fc27 pack"), true);
  assert.equal(m("FC 27"), false, "space breaks the substring");
});

test("empty keyword list blocks nothing", () => {
  const m = buildMatcher([], "word");
  assert.equal(m("anything at all"), false);
});

test("keywords containing regex metacharacters are escaped", () => {
  const m = buildMatcher(["patreon.com/Duck_MitchyDuck"], "word");
  assert.equal(m("go to patreon.com/Duck_MitchyDuck now"), true);
  assert.equal(m("nothing relevant"), false);
});

test("isRepost flags other authors and retweet labels", () => {
  assert.equal(isRepost({ author: "someoneelse" }, "FutSheriff"), true);
  assert.equal(isRepost({ author: "FutSheriff" }, "futsheriff"), false);
  assert.equal(isRepost({ author: "FutSheriff", socialContext: "Reposted" }, "FutSheriff"), true);
});

// --- filter pipeline --------------------------------------------------------

const rawTweets = [
  { id: "1", author: "FutSheriff", text: "hello world", date: "d1", images: [] },
  { id: "2", author: "FutSheriff", text: "   ", date: "d2", images: [] }, // no caption
  { id: "3", author: "intruder", text: "hello world", date: "d3", images: [] }, // repost
  { id: "4", author: "FutSheriff", text: "free giveaway today", date: "d4", images: [] },
  { id: "5", author: "FutSheriff", text: "already reported", date: "d5", images: [] },
  { id: "6", author: "FutSheriff", text: "brand new drop", date: "d6", images: ["u"] },
];

test("filterTweets applies the whole pipeline in order", () => {
  const { kept, stats } = filterTweets(rawTweets, "FutSheriff", {
    isBlocked: buildMatcher(["giveaway"], "word"),
    seen: new Set(["5"]),
    onlyNew: true,
    limit: 20,
  });

  assert.deepEqual(kept.map((t) => t.id), ["1", "6"]);
  assert.equal(stats.skippedNoCaption, 1);
  assert.equal(stats.skippedRepost, 1);
  assert.equal(stats.skippedKeyword, 1);
  assert.equal(stats.skippedSeen, 1);
  assert.equal(stats.kept, 2);
});

test("filterTweets honours the limit", () => {
  const { kept } = filterTweets(rawTweets, "FutSheriff", {
    isBlocked: () => false,
    seen: new Set(),
    onlyNew: false,
    limit: 2,
  });
  assert.equal(kept.length, 2);
});

test("records carry a canonical x.com url", () => {
  const { kept } = filterTweets([rawTweets[0]], "FutSheriff", {
    isBlocked: () => false,
    onlyNew: false,
    limit: 10,
  });
  assert.equal(kept[0].url, "https://x.com/FutSheriff/status/1");
});

// --- pruning ----------------------------------------------------------------

const DAY = 86400000;
// Anchored to the real clock: pruneRecords unit tests pass it as `now` for
// determinism, while writeDataset uses the wall clock internally.
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const rec = (id, username, dateMs, text = "hello") => ({
  username,
  id,
  author: username,
  text,
  date: iso(dateMs),
  url: `https://x.com/${username}/status/${id}`,
  images: [],
});

test("pruneRecords sorts newest first", () => {
  const out = pruneRecords(
    [rec("a", "nasa", NOW - 3 * DAY), rec("b", "nasa", NOW - 1 * DAY), rec("c", "nasa", NOW - 2 * DAY)],
    { now: NOW }
  );
  assert.deepEqual(out.map((r) => r.id), ["b", "c", "a"]);
});

test("pruneRecords dedupes by tweet id across overlapping runs", () => {
  const out = pruneRecords([rec("a", "nasa", NOW - DAY), rec("a", "nasa", NOW - DAY)], { now: NOW });
  assert.equal(out.length, 1, "the same tweet must not appear twice");
});

test("pruneRecords falls back to url when a record has no id", () => {
  const a = { username: "nasa", url: "https://x.com/nasa/status/9", date: iso(NOW - DAY) };
  const b = { username: "nasa", url: "https://x.com/nasa/status/9", date: iso(NOW - DAY) };
  assert.equal(pruneRecords([a, b], { now: NOW }).length, 1);
});

test("pruneRecords drops records past the retention window", () => {
  const out = pruneRecords(
    [rec("fresh", "nasa", NOW - 1 * DAY), rec("stale", "nasa", NOW - 20 * DAY)],
    { now: NOW, pruneMaxAgeDays: 14 }
  );
  assert.deepEqual(out.map((r) => r.id), ["fresh"]);
});

test("pruneRecords keeps records exactly on the retention boundary", () => {
  const out = pruneRecords([rec("edge", "nasa", NOW - 14 * DAY)], { now: NOW, pruneMaxAgeDays: 14 });
  assert.equal(out.length, 1);
});

test("pruneRecords caps each account independently, newest kept", () => {
  const out = pruneRecords(
    [
      rec("n1", "nasa", NOW - 1 * DAY),
      rec("n2", "nasa", NOW - 2 * DAY),
      rec("n3", "nasa", NOW - 3 * DAY),
      rec("g1", "github", NOW - 1 * DAY),
    ],
    { now: NOW, pruneMaxPerAccount: 2 }
  );
  // Ordering is global-newest-first, so the two 1-day-old records lead.
  assert.deepEqual(out.map((r) => r.id), ["n1", "g1", "n2"]);
  assert.deepEqual(out.filter((r) => r.username === "nasa").map((r) => r.id), ["n1", "n2"]);
  assert.deepEqual(out.filter((r) => r.username === "github").map((r) => r.id), ["g1"]);
});

test("pruneRecords keeps unparseable dates rather than emptying the dataset", () => {
  const out = pruneRecords(
    [rec("ok", "nasa", NOW - 1 * DAY), { username: "nasa", id: "weird", text: "x", date: "not-a-date" }],
    { now: NOW, pruneMaxAgeDays: 14 }
  );
  assert.equal(out.length, 2);
  assert.equal(out[out.length - 1].id, "weird", "undated records sort last");
});

test("writeDataset prunes, writes meta.json and increments the run counter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xscraper-"));
  const overrides = {
    outputFile: path.join(dir, "tweets.json"),
    metaFile: path.join(dir, "meta.json"),
    pruneMaxAgeDays: 14,
    pruneMaxPerAccount: 1,
  };

  const first = writeDataset(
    [rec("a", "nasa", NOW - 1 * DAY), rec("b", "nasa", NOW - 2 * DAY), rec("c", "nasa", NOW - 40 * DAY)],
    { configOverrides: overrides }
  );

  assert.equal(first.total, 1, "cap of 1 + the 40-day-old record pruned");
  assert.deepEqual(JSON.parse(fs.readFileSync(overrides.outputFile, "utf8")).map((r) => r.id), ["a"]);

  const meta = JSON.parse(fs.readFileSync(overrides.metaFile, "utf8"));
  assert.equal(meta.runs, 1);
  assert.equal(meta.total, 1);
  assert.ok(meta.pruned >= 2);
  assert.deepEqual(meta.accounts, [{ username: "nasa", count: 1, newest: iso(NOW - 1 * DAY) }]);

  const second = writeDataset([rec("d", "nasa", NOW)], {
    configOverrides: { ...overrides, pruneMaxPerAccount: 2 },
  });
  assert.equal(second.meta.runs, 2, "run counter advances");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(overrides.outputFile, "utf8")).map((r) => r.id),
    ["d", "a"],
    "newest first, previous record still within the cap"
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- challenge detection ---------------------------------------------------

// Stands in for a Playwright Page, so diagnose() can be tested without a browser.
function fakePage({ url = "https://x.com/FutSheriff", title = "FutSheriff / X", body = "" } = {}) {
  return {
    url: () => url,
    title: async () => title,
    evaluate: async () => body,
    screenshot: async () => {},
  };
}

test("a Cloudflare interstitial is reported as CHALLENGE, not a missing account", async () => {
  const { diagnose, ChallengeError } = require("../lib/scraper");
  const page = fakePage({
    title: "Just a moment...",
    body: "x.com Performing security verification\nThis website uses a security service to protect against malicious bots.\nRay ID: a45d9f3bddda4c80",
  });

  const err = await diagnose(page, "FutSheriff");
  assert.ok(err instanceof ChallengeError);
  assert.equal(err.code, "CHALLENGE");
  assert.match(err.message, /FutSheriff/);
  assert.match(err.message, /accounts are fine/, "must not blame the account");
});

test("challenge detection covers the other Cloudflare phrasings", async () => {
  const { diagnose, ChallengeError } = require("../lib/scraper");
  const cases = [
    { title: "Attention Required! | Cloudflare", body: "Please enable cookies." },
    { title: "X", body: "Checking your browser before accessing x.com" },
    { title: "X", body: "Verify you are human by completing the action below." },
    { title: "X", body: "This website uses a security service to protect against malicious bots." },
  ];
  for (const c of cases) {
    const err = await diagnose(fakePage(c), "nasa");
    assert.ok(err instanceof ChallengeError, `expected CHALLENGE for ${JSON.stringify(c)}`);
  }
});

test("a normal page with no tweets stays a generic scrape error", async () => {
  const { diagnose, ScrapeError, ChallengeError } = require("../lib/scraper");
  const err = await diagnose(fakePage({ body: "This account doesn't exist" }), "ghostaccount");
  assert.ok(err instanceof ScrapeError);
  assert.ok(!(err instanceof ChallengeError));
  assert.equal(err.code, "SCRAPE_FAILED");
  assert.match(err.message, /ghostaccount/);
});

test("a login redirect is still reported as NOT_LOGGED_IN", async () => {
  const { diagnose, NotLoggedInError, ChallengeError } = require("../lib/scraper");
  const err = await diagnose(fakePage({ url: "https://x.com/i/flow/login", body: "Log in" }), "nasa");
  assert.ok(err instanceof NotLoggedInError);
  assert.equal(err.code, "NOT_LOGGED_IN");
  assert.ok(!(err instanceof ChallengeError));
});

test("a real timeline never triggers challenge detection", async () => {
  const { diagnose, ChallengeError } = require("../lib/scraper");
  const err = await diagnose(
    fakePage({ title: "FutSheriff / X", body: "Ray ID is not mentioned here, just posts about Ray ID tooling." }),
    "FutSheriff"
  );
  assert.ok(!(err instanceof ChallengeError), "the words 'Ray ID' in a tweet must not false-positive");
});

test("challenge grace is bounded, never unbounded", () => {
  const c = getConfig();
  assert.ok(c.challengeGraceMs >= 1000 && c.challengeGraceMs <= 60000, "grace must be bounded");
});

test("the headless UA is rebuilt to match the real binary", () => {
  const { genuineUserAgent } = require("../lib/browser");

  const edge = genuineUserAgent("151", "msedge", "win32");
  assert.ok(!/Headless/i.test(edge), "the HeadlessChrome token is the loudest tell");
  assert.match(edge, /Chrome\/151\.0\.0\.0/, "version must come from the binary");
  assert.match(edge, /Edg\/151\.0\.0\.0/, "Edge needs its own brand token");
  assert.match(edge, /Windows NT 10\.0; Win64; x64/);

  const chrome = genuineUserAgent("153", "chrome", "linux");
  assert.match(chrome, /Chrome\/153\.0\.0\.0/);
  assert.ok(!/Edg\//.test(chrome), "plain Chrome must not claim to be Edge");
  assert.match(chrome, /X11; Linux x86_64/, "the CI runner is Linux, so the UA must be too");

  assert.match(genuineUserAgent("151", "msedge", "darwin"), /Macintosh/);
  assert.match(genuineUserAgent("151", undefined, "linux"), /Chrome\/151/, "bundled build still gets a UA");
});

test("the exported session keeps x.com localStorage", () => {
  const { trimState } = require("../lib/session");
  const state = trimState({
    cookies: [
      { name: "auth_token", value: "x", domain: ".x.com" },
      { name: "tracker", value: "y", domain: ".example.com" },
    ],
    origins: [
      { origin: "https://x.com", localStorage: [{ name: "k", value: "v" }] },
      { origin: "https://ads.example.com", localStorage: [{ name: "z", value: "z" }] },
      { origin: "not a url", localStorage: [] },
    ],
  });

  assert.equal(state.cookies.length, 1, "non-x cookies are dropped");
  assert.equal(state.origins.length, 1, "x.com localStorage must survive");
  assert.equal(state.origins[0].origin, "https://x.com");
  assert.deepEqual(state.origins[0].localStorage, [{ name: "k", value: "v" }]);
});

test("trimState tolerates a session with no origins", () => {
  const { trimState } = require("../lib/session");
  assert.deepEqual(trimState({ cookies: [{ name: "a", domain: ".x.com" }] }).origins, []);
  assert.deepEqual(trimState({ cookies: [{ name: "a", domain: ".x.com" }], origins: "nope" }).origins, []);
});

test("proxy settings are parsed into a Playwright proxy object", () => {
  const { resolveProxy } = require("../lib/browser");
  const saved = { ...process.env };
  delete process.env.XSCRAPER_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;

  assert.equal(resolveProxy(), null, "no proxy configured");

  process.env.XSCRAPER_PROXY = "http://user:pa%40ss@proxy.example:8080";
  assert.deepEqual(resolveProxy(), {
    server: "http://proxy.example:8080",
    username: "user",
    password: "pa@ss",
  });

  process.env.XSCRAPER_PROXY = "socks5://1.2.3.4:1080";
  assert.deepEqual(resolveProxy(), { server: "socks5://1.2.3.4:1080" });

  process.env.XSCRAPER_PROXY = "garbage://[bad";
  assert.equal(resolveProxy(), null, "an unparseable value must not crash the launch");

  process.env = saved;
});

test("the preflight report is byte-stable, or it churns a commit every 15 minutes", () => {
  // The workflow commits data/diagnostics.json. Any per-request field (ray id,
  // timestamp) would produce a commit every cron run with no actual change.
  const { buildReport, writeReport } = require("./doctor");
  const os = require("os");

  const input = {
    verdict: "ip",
    verdictText: "this host's IP is blocked by Cloudflare",
    http: { status: 403, server: "cloudflare", markers: ["just a moment"], viaCloudflare: true },
    session: { configured: true, error: null, cookies: 12, authToken: true, ct0: true, origins: 0 },
    accounts: 5,
    results: [
      { name: "x.com reachable from this host", status: "bad", detail: "Cloudflare interstitial", advice: "use a proxy" },
      { name: "X session localStorage", status: "warn", detail: "no origins exported" },
      { name: "accounts configured", status: "ok", detail: "5", advice: "" },
    ],
  };

  const first = buildReport(input);
  const second = buildReport(input);
  assert.deepStrictEqual(first, second, "the same input must build the same report");
  assert.equal(first.failed, 1, "counts derive from the checks, not caller bookkeeping");
  assert.equal(first.warned, 1);
  assert.equal(first.checks[0].advice, undefined, "advice belongs on the console, not in the committed file");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
  const a = path.join(tmp, "a.json");
  const b = path.join(tmp, "b.json");
  writeReport(a, first);
  writeReport(b, second);
  assert.equal(fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8"), "the written bytes must match");

  const serialized = JSON.stringify(first);
  assert.ok(!/\d{13}/.test(serialized), "no epoch timestamps");
  assert.ok(!/"[0-9a-f]{32}"/i.test(serialized), "no ray ids");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("debug screenshots land in a real directory on Windows, not a hardcoded /tmp", async () => {
  // The recommended fix for a blocked hosted IP is a Windows self-hosted
  // runner, where "/tmp/debug-x.png" is not a directory that exists.
  const { diagnose, ChallengeError } = require("../lib/scraper");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-"));
  let savedPath = null;

  process.env.CI = "true";
  process.env.XSCRAPER_DEBUG_DIR = dir;

  const page = {
    url: () => "https://x.com/someuser",
    title: async () => "Just a moment...",
    evaluate: async () => "Checking if the site connection is secure",
    screenshot: async (opts) => { savedPath = opts.path; },
  };

  const err = await diagnose(page, "someuser").catch((e) => e);
  assert.ok(err instanceof ChallengeError, "an interstitial must stay a CHALLENGE");
  assert.ok(savedPath, "a screenshot should have been attempted");
  assert.ok(path.isAbsolute(savedPath), "the path must be absolute");
  assert.ok(savedPath.startsWith(dir), `expected ${savedPath} under ${dir}`);
  assert.ok(savedPath.endsWith("debug-someuser.png"), "filename keeps the account name");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every workflow run step pins shell: bash so a Windows runner can execute it", () => {
  // pwsh is the default on Windows runners; these blocks are bash. Checked as
  // line counts rather than by parsing YAML, so the suite needs no YAML
  // dependency to protect a plain-text invariant.
  const src = fs.readFileSync(path.resolve(__dirname, "..", ".github/workflows/scraper.yml"), "utf8");
  const runSteps = src.match(/^\s+run:/gm) || [];
  const pinned = src.match(/^\s+shell: bash/gm) || [];
  assert.ok(runSteps.length >= 5, `expected the run steps, found ${runSteps.length}`);
  assert.equal(
    pinned.length,
    runSteps.length,
    `every run step needs shell: bash (found ${pinned.length} for ${runSteps.length} run steps)`
  );

  assert.match(src, /runs-on: \$\{\{ fromJSON\(/,
    "a bracketed label string must be fromJSON'd or it becomes one bogus label");
  assert.match(src, /if: always\(\)/,
    "the commit step must survive a failed scrape or the verdict is discarded");
  assert.ok(!/^.*path: \/tmp\//m.test(src), "hardcoded /tmp does not exist on a Windows runner");
});

test("the runtime does not depend on the puppeteer-only stealth plugin", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(__dirname, ".."));

  for (const file of files) {
    if (file === __filename) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.ok(!source.includes("playwright-extra"), `${file} still uses playwright-extra`);
    assert.ok(!source.includes("puppeteer-extra"), `${file} still uses a puppeteer-only plugin`);
  }

  const deps = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).dependencies;
  assert.deepEqual(Object.keys(deps), ["playwright-core"], "playwright-core should be the only runtime dep");
});

// --- session + browser resolution ------------------------------------------

test("no session configured -> null state", () => {
  assert.equal(getStorageState(), null);
  assert.deepEqual(describeSession(), {
    configured: false,
    cookies: 0,
    source: null,
    error: null,
  });
});

test("invalid X_STORAGE_STATE JSON throws a helpful error", () => {
  process.env.X_STORAGE_STATE = "{not json";
  assert.throws(() => getStorageState(), /not valid JSON/);
  delete process.env.X_STORAGE_STATE;
});

test("session with no x.com cookies throws a helpful error", () => {
  process.env.X_STORAGE_STATE = JSON.stringify({
    cookies: [{ name: "a", value: "b", domain: ".example.com" }],
  });
  assert.throws(() => getStorageState(), /no x.com cookies/);
  delete process.env.X_STORAGE_STATE;
});

test("session keeps only x.com cookies", () => {
  process.env.X_STORAGE_STATE = JSON.stringify({
    cookies: [
      { name: "auth_token", value: "x", domain: ".x.com" },
      { name: "other", value: "y", domain: ".example.com" },
    ],
    origins: [{ origin: "https://x.com", localStorage: [] }],
  });
  const state = getStorageState();
  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].name, "auth_token");
  assert.equal(state.origins.length, 1, "x.com localStorage is preserved, not blanked");
  delete process.env.X_STORAGE_STATE;
});

test("sessionSource prefers the local profile, falls back to env, and CI takes env", () => {
  const saved = process.env.CI;
  const noProfile = { configOverrides: { sessionSource: "auto", profileDir: "/nope/nope" } };

  assert.equal(resolveSessionSource(noProfile), "profile", "nothing available -> profile (errors with a hint)");
  assert.equal(
    resolveSessionSource({ configOverrides: { sessionSource: "auto", profileDir: __dirname } }),
    "profile",
    "a logged-in profile wins over a blob in .env"
  );

  process.env.X_STORAGE_STATE = JSON.stringify({
    cookies: [{ name: "auth_token", value: "x", domain: ".x.com" }],
  });
  assert.equal(resolveSessionSource(noProfile), "env", "no profile -> the blob");
  assert.equal(resolveSessionSource(), "profile", "the real .browser-profile still wins locally");

  process.env.CI = "true";
  assert.equal(resolveSessionSource(), "env", "CI has no profile, so the secret is the only option");

  delete process.env.CI;
  delete process.env.X_STORAGE_STATE;
  if (saved !== undefined) process.env.CI = saved;
});

test("sessionSource honours an explicit override over both auto rules", () => {
  process.env.X_STORAGE_STATE = JSON.stringify({
    cookies: [{ name: "auth_token", value: "x", domain: ".x.com" }],
  });
  assert.equal(
    resolveSessionSource({ configOverrides: { sessionSource: "profile", profileDir: __dirname } }),
    "profile"
  );
  assert.equal(
    resolveSessionSource({ configOverrides: { sessionSource: "env", profileDir: __dirname } }),
    "env"
  );
  delete process.env.X_STORAGE_STATE;
});

test("resolveSession reports the session source, not a browser mode", () => {
  const missing = resolveSession({ configOverrides: { sessionSource: "profile", profileDir: "/nope/nope" } });
  assert.equal(missing.source, "profile");
  assert.equal(missing.storageState, null);
  assert.ok(missing.error);
  assert.match(missing.hint, /npm run login/);

  const present = resolveSession({ configOverrides: { sessionSource: "profile", profileDir: __dirname } });
  assert.equal(present.error, null);
});

test("resolveSession names X_STORAGE_STATE when the env blob is required", () => {
  const missing = resolveSession({ configOverrides: { sessionSource: "env" } });
  assert.equal(missing.source, "env");
  assert.match(missing.error, /X_STORAGE_STATE/);
});

test("browserSource forces playwright in CI and honours explicit overrides", () => {
  const saved = process.env.CI;
  process.env.CI = "true";
  assert.equal(resolveBrowserSource(), "playwright", "a runner has no installed Edge");
  delete process.env.CI;
  assert.equal(resolveBrowserSource(), "system", "a desktop runs the installed browser");

  assert.equal(resolveBrowserSource({ configOverrides: { browserSource: "playwright" } }), "playwright");
  assert.equal(resolveBrowserSource({ configOverrides: { browserSource: "system" } }), "system");

  if (saved !== undefined) process.env.CI = saved;
});

// --- dataset loading (fetch is stubbed) ------------------------------------

const realFetch = global.fetch;

function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const key = Object.keys(routes).find((k) => String(url).endsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const body = routes[key];
    const resolved = typeof body === "function" ? body() : body;
    return { ok: true, status: 200, json: async () => resolved };
  };
  resetConfigCache();
  resetDatasetCache();
  return calls;
}

function withDataUrl(value, fn) {
  const saved = process.env.XSCRAPER_DATA_URL;
  if (value === null) delete process.env.XSCRAPER_DATA_URL;
  else process.env.XSCRAPER_DATA_URL = value;
  resetConfigCache();
  resetDatasetCache();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.XSCRAPER_DATA_URL;
      else process.env.XSCRAPER_DATA_URL = saved;
      resetConfigCache();
      resetDatasetCache();
    });
}

const SAMPLE = [
  rec("100", "FutSheriff", Date.now() - 1000, "newest drop"),
  rec("99", "FutSheriff", Date.now() - 2000, "more news"),
  rec("98", "FutSheriff", Date.now() - 3000, "free giveaway here"), // blocked by config.js
  rec("50", "nasa", Date.now() - 4000, "to the moon"),
];

const SAMPLE_META = {
  generatedAt: new Date().toISOString(),
  runs: 42,
  total: 4,
  added: 1,
  pruned: 0,
  accounts: [{ username: "FutSheriff", count: 3, newest: null }],
};

test("resolveDataUrls prefers XSCRAPER_DATA_URL and derives meta", () => {
  const urls = resolveDataUrls({ configOverrides: { dataUrl: "https://x.dev/o/r/main/data/tweets.json" } });
  assert.equal(urls.tweetsUrl, "https://x.dev/o/r/main/data/tweets.json");
  assert.equal(urls.metaUrl, "https://x.dev/o/r/main/data/meta.json");
});

test("resolveDataUrls falls back to GITHUB_REPOSITORY", () => {
  process.env.GITHUB_REPOSITORY = "octocat/xscraper";
  process.env.GITHUB_REF_NAME = "trunk";
  const urls = resolveDataUrls();
  assert.equal(urls.tweetsUrl, "https://raw.githubusercontent.com/octocat/xscraper/trunk/data/tweets.json");
  assert.equal(urls.metaUrl, "https://raw.githubusercontent.com/octocat/xscraper/trunk/data/meta.json");
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REF_NAME;
});

test("resolveDataUrls returns nulls when nothing is configured", () => {
  const urls = resolveDataUrls();
  assert.equal(urls.tweetsUrl, null);
});

test("loadDataset fetches both files and reports freshness", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    const calls = stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const dataset = await loadDataset();
    resetConfigCache();
    resetDatasetCache();

    assert.equal(calls.length, 2);
    assert.equal(dataset.records.length, 4);
    assert.equal(dataset.meta.runs, 42);
    assert.ok(datasetAgeSeconds(dataset) < 5, "fresh dataset reports a small age");
  });
});

test("loadDataset memoizes so a warm instance does not re-fetch", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    const calls = stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    await loadDataset();
    await loadDataset();
    resetConfigCache();
    resetDatasetCache();
    assert.equal(calls.length, 2, "the second call must come from the memo");
  });
});

test("loadDataset attaches a bearer token when one is configured", async () => {
  const saved = process.env.XSCRAPER_DATA_TOKEN;
  process.env.XSCRAPER_DATA_TOKEN = "github_pat_secret";
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    const calls = stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    await loadDataset();
    resetConfigCache();
    resetDatasetCache();
    const tweetsCall = calls.find((c) => c.url.endsWith("tweets.json"));
    assert.equal(tweetsCall.opts.headers.Authorization, "Bearer github_pat_secret");
  });
  if (saved === undefined) delete process.env.XSCRAPER_DATA_TOKEN;
  else process.env.XSCRAPER_DATA_TOKEN = saved;
  resetConfigCache();
});

test("loadDataset throws a typed error when no URL is configured", async () => {
  await withDataUrl(null, async () => {
    stubFetch({});
    await assert.rejects(loadDataset(), (err) => {
      assert.ok(err instanceof DataUnavailableError);
      assert.equal(err.code, "DATA_UNAVAILABLE");
      assert.match(err.message, /No dataset URL/);
      assert.match(err.hint, /XSCRAPER_DATA_URL/);
      return true;
    });
  });
});

test("loadDataset turns a 404 into an actionable error", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({}); // nothing matches -> 404
    await assert.rejects(loadDataset(), (err) => {
      assert.equal(err.code, "DATA_UNAVAILABLE");
      assert.match(err.message, /404/);
      assert.match(err.hint, /public/);
      return true;
    });
  });
});

test("loadDataset rejects a non-array tweets payload", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": { error: "not an array" }, "meta.json": SAMPLE_META });
    await assert.rejects(loadDataset(), /did not contain a JSON array/);
  });
});

test("a missing meta.json degrades to no freshness, not a failure", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    global.fetch = async (url) =>
      String(url).endsWith("meta.json")
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => SAMPLE };
    resetConfigCache();
    resetDatasetCache();
    const dataset = await loadDataset();
    resetConfigCache();
    resetDatasetCache();
    assert.equal(dataset.records.length, 4);
    assert.equal(dataset.meta, null);
    assert.equal(datasetAgeSeconds(dataset), null);
  });
});

// --- API handlers (no browser, no network) ---------------------------------

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ? JSON.parse(body) : null;
    },
    json() {
      return this.body;
    },
  };
}

function fakeReq(query = {}, method = "GET") {
  return { method, query, headers: { host: "example.vercel.app" } };
}

const { handleTweets } = require("../lib/handler");

test("OPTIONS returns 204 with CORS headers", async () => {
  const res = fakeRes();
  await handleTweets(fakeReq({}, "OPTIONS"), res, { account: "nasa" });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
});

test("non-GET returns 405", async () => {
  const res = fakeRes();
  await handleTweets(fakeReq({ account: "nasa" }, "POST"), res, { account: "nasa" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.json().error.code, "METHOD_NOT_ALLOWED");
});

test("missing account returns 400", async () => {
  const res = fakeRes();
  await handleTweets(fakeReq({}), res, {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "MISSING_ACCOUNT");
});

test("invalid username returns 400", async () => {
  const res = fakeRes();
  await handleTweets(fakeReq({}), res, { account: "this-name-is-way-too-long" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_USERNAME");
});

test("ALLOWED_ACCOUNTS blocks anything else with 403", async () => {
  process.env.ALLOWED_ACCOUNTS = "nasa,github";
  const res = fakeRes();
  await handleTweets(fakeReq({}), res, { account: "FutSheriff" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "ACCOUNT_NOT_ALLOWED");
  delete process.env.ALLOWED_ACCOUNTS;
});

test("cache mode serves tweets from the dataset without a browser", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await handleTweets(fakeReq({}), res, { account: "FutSheriff" });
    resetConfigCache();
    resetDatasetCache();

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "cache", "no scraping on the request path");
    assert.equal(body.account, "FutSheriff");
    // 3 FutSheriff records, minus the one blocked by 'giveaway'.
    assert.equal(body.count, 2);
    assert.deepEqual(body.accounts[0].tweets.map((t) => t.id), ["100", "99"]);
    assert.equal(body.accounts[0].stats.available, 3);
    assert.equal(body.accounts[0].stats.skippedKeyword, 1);
    assert.equal(body.dataset.runs, 42);
    assert.equal(body.dataset.source, "https://example.com/data/tweets.json");
  });
});

test("a configured keyword list is re-applied at read time", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await handleTweets(fakeReq({}), res, {
      account: "FutSheriff",
    });
    resetConfigCache();
    resetDatasetCache();
    assert.ok(!res.json().accounts[0].tweets.some((t) => /giveaway/.test(t.text)));
  });
});

test("cache mode honours ?exclude for stateless onlyNew", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await handleTweets(fakeReq({ exclude: "100" }), res, { account: "FutSheriff" });
    resetConfigCache();
    resetDatasetCache();

    const body = res.json();
    assert.equal(body.options.onlyNew, true);
    assert.equal(body.options.ignored, 1);
    assert.deepEqual(body.accounts[0].tweets.map((t) => t.id), ["99"]);
    assert.equal(body.accounts[0].stats.skippedExcluded, 1);
  });
});

test("cache mode honours ?limit", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await handleTweets(fakeReq({ limit: "1" }), res, { account: "FutSheriff" });
    resetConfigCache();
    resetDatasetCache();
    assert.equal(res.json().count, 1);
  });
});

test("an account absent from the dataset is reported as empty, not an error", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await handleTweets(fakeReq({}), res, { account: "vercel" });
    resetConfigCache();
    resetDatasetCache();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().options.empty, ["vercel"]);
    assert.equal(res.json().count, 0);
  });
});

test("success responses are edge-cacheable, errors are not", async () => {
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });

    const ok = fakeRes();
    await handleTweets(fakeReq({}), ok, { account: "nasa" });
    resetDatasetCache();
    assert.match(ok.headers["Cache-Control"], /^public, /);
    assert.match(ok.headers["Cache-Control"], /s-maxage=600/);
    assert.match(ok.headers["Cache-Control"], /stale-while-revalidate=300/);
    assert.equal(ok.headers["Access-Control-Allow-Origin"], "*");

    const bad = fakeRes();
    await handleTweets(fakeReq({}), bad, { account: "bad-name!" });
    assert.equal(bad.headers["Cache-Control"], "no-store, max-age=0");
  });
});

test("an unreachable dataset returns 503 DATA_UNAVAILABLE", async () => {
  await withDataUrl(null, async () => {
    stubFetch({});
    const res = fakeRes();
    await handleTweets(fakeReq({}), res, { account: "FutSheriff" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "DATA_UNAVAILABLE");
    assert.match(res.json().error.hint, /XSCRAPER_DATA_URL/);
  });
});

test("health reports freshness and per-account coverage", async () => {
  const health = require("../api/health");
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await health(fakeReq(), res);
    resetConfigCache();
    resetDatasetCache();

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "cache");
    assert.equal(body.stale, false);
    assert.equal(res.headers["X-Health"], "ok");
    assert.equal(body.dataset.runs, 42);
    assert.ok(body.accounts.configured.includes("FutSheriff"));
    assert.ok(body.accounts.missing.includes("ValorantUpdated"), "no records -> missing");
    assert.ok(!body.accounts.missing.includes("FutSheriff"));
  });
});

test("health flags stale data past two missed cron windows", async () => {
  const health = require("../api/health");
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    const staleMeta = { ...SAMPLE_META, generatedAt: new Date(Date.now() - 5000 * 1000).toISOString() };
    stubFetch({ "tweets.json": SAMPLE, "meta.json": staleMeta });
    const res = fakeRes();
    await health(fakeReq(), res);
    resetConfigCache();
    resetDatasetCache();

    assert.equal(res.statusCode, 200, "stale is still a 200 -- the API is up");
    assert.equal(res.json().stale, true);
    assert.equal(res.headers["X-Health"], "stale");
  });
});

test("health returns 503 when the dataset is unreachable", async () => {
  const health = require("../api/health");
  await withDataUrl(null, async () => {
    stubFetch({});
    const res = fakeRes();
    await health(fakeReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().ok, false);
    assert.equal(res.json().error.code, "DATA_UNAVAILABLE");
  });
});

test("health is never edge-cached, so it can still notice a stale dataset", async () => {
  const health = require("../api/health");
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await health(fakeReq(), res);
    resetConfigCache();
    resetDatasetCache();
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers["Cache-Control"],
      "no-store, max-age=0",
      "a cached 200 would mask a dead pipeline for the whole s-maxage window"
    );
  });
});

test("accounts endpoint lists one route per config.js account", async () => {
  const accounts = require("../api/accounts");
  await withDataUrl("https://example.com/data/tweets.json", async () => {
    stubFetch({ "tweets.json": SAMPLE, "meta.json": SAMPLE_META });
    const res = fakeRes();
    await accounts(fakeReq(), res);
    resetConfigCache();
    resetDatasetCache();

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.ok(body.count >= listAccounts().length);

    for (const name of listAccounts()) {
      const entry = body.accounts.find((a) => a.username === name);
      assert.ok(entry, `${name} missing from the index`);
      assert.equal(entry.endpoint, `/api/tweets/${name}`);
      assert.ok(fs.existsSync(path.join(__dirname, "..", "api", "tweets", `${name}.js`)));
    }
    assert.equal(body.mode, "cache");
    assert.ok(!("session" in body), "no session is exposed by a cache-only API");
  });
});

test("every generated endpoint passes its account to the handler", () => {
  const dir = path.join(__dirname, "..", "api", "tweets");
  const accounts = listAccounts();

  for (const name of fs.readdirSync(dir)) {
    if (name === "[account].js" || !name.endsWith(".js")) continue;
    const username = name.replace(/\.js$/, "");
    assert.ok(accounts.includes(username), `stale endpoint file: ${name}`);

    const source = fs.readFileSync(path.join(dir, name), "utf8");
    assert.ok(source.includes(JSON.stringify(username)), `${name} does not hardcode its account`);
  }
});

test("no runtime module still references the removed chromium pack", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(__dirname, ".."));

  for (const file of files) {
    if (file === __filename) continue; // this file names the package it looks for
    const source = fs.readFileSync(file, "utf8");
    assert.ok(!source.includes("@sparticuz/chromium"), `${file} still requires sparticuz`);
    assert.ok(!source.includes("shouldUseServerless"), `${file} still uses the old browser toggle`);
  }
});

async function teardown() {
  global.fetch = realFetch;
}

run().then(teardown);