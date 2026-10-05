// Shared request handler for every /api/tweets/* endpoint.
//
// Cache mode: this API never scrapes. GitHub Actions scrapes on a cron and
// commits data/tweets.json; each request fetches that file (memoized per warm
// instance) and filters it in memory. That keeps the function fast enough to
// sit behind the Edge Network CDN.
//
// Routes come in three flavours and all funnel through here:
//   /api/tweets/FutSheriff        -> static file generated per config.js account
//   /api/tweets/<anything>        -> api/tweets/[account].js dynamic route
//   /api/tweets?account=<name>    -> the same dynamic route, query-string form

const { getConfig, listAccounts, normalizeUsername, isValidUsername } = require("./config");
const { loadDataset, datasetAgeSeconds, DataUnavailableError } = require("./dataset");
const { buildMatcher } = require("./filter");

const MAX_LIMIT = 100;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Errors must never be cached, or a transient fetch failure sticks at the edge
// for the whole s-maxage window.
function cacheHeaders(config, ok) {
  if (!ok) return { "Cache-Control": "no-store, max-age=0" };
  const ttl = config.cacheTtlSeconds > 0 ? Math.floor(config.cacheTtlSeconds) : 600;
  return {
    "Cache-Control": `public, max-age=60, s-maxage=${ttl}, stale-while-revalidate=300`,
  };
}

function send(res, status, payload, extraHeaders = {}) {
  const config = getConfig();
  const ok = status >= 200 && status < 300;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...cacheHeaders(config, ok),
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload, null, 2));
}

function fail(res, status, code, message, hint) {
  send(res, status, { ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
}

function parsePositiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseIds(value) {
  if (!value) return new Set();
  const list = Array.isArray(value) ? value : String(value).split(",");
  return new Set(
    list
      .flatMap((v) => String(v).split(","))
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

// Optional lockdown: set ALLOWED_ACCOUNTS=a,b,c to restrict the dynamic route.
function allowlist() {
  const raw = process.env.ALLOWED_ACCOUNTS || process.env.XSCRAPER_ALLOWED_ACCOUNTS;
  if (!raw || !raw.trim()) return null;
  return new Set(raw.split(",").map(normalizeUsername).filter(Boolean));
}

function resolveUsernames(req, override) {
  const q = req.query || {};
  const raw = override || q.account || q.username || q.user;
  const many = Array.isArray(raw) ? raw.join(",") : raw;

  const usernames = [
    ...new Set(
      (many ? String(many).split(",") : [])
        .map(normalizeUsername)
        .filter(Boolean)
    ),
  ];

  const invalid = (many ? String(many).split(",") : [])
    .map((s) => s.trim())
    .filter((s) => s && !isValidUsername(normalizeUsername(s)));

  return { usernames, invalid };
}

// Filters the in-memory dataset down to one entry per requested account.
function selectFromDataset(records, usernames, options) {
  const { limit, exclude, isBlocked } = options;

  return usernames.map((username) => {
    const stats = {
      available: 0,
      kept: 0,
      skippedExcluded: 0,
      skippedKeyword: 0,
      skippedOtherAccount: 0,
    };
    const tweets = [];

    for (const record of records) {
      if (!record || record.username !== username) continue;
      stats.available++;
      if (exclude && exclude.has(record.id)) {
        stats.skippedExcluded++;
        continue;
      }
      if (isBlocked && record.text && isBlocked(record.text)) {
        stats.skippedKeyword++;
        continue;
      }
      if (tweets.length >= limit) continue; // counted in `available`, not returned
      tweets.push(record);
      stats.kept++;
    }

    return { username, ok: stats.available > 0, error: null, stats, tweets };
  });
}

async function handleTweets(req, res, options = {}) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return fail(res, 405, "METHOD_NOT_ALLOWED", `Use GET, not ${req.method}.`);
  }

  const config = getConfig();
  const { usernames, invalid } = resolveUsernames(req, options.account);

  if (invalid.length) {
    return fail(
      res,
      400,
      "INVALID_USERNAME",
      `Not a valid X username: ${invalid.join(", ")}`,
      "Usernames are 1-15 characters, letters/digits/underscore, without the leading @."
    );
  }
  if (!usernames.length) {
    return fail(
      res,
      400,
      "MISSING_ACCOUNT",
      "No account requested.",
      `Use /api/tweets/<username> or ?account=<username>. Configured: ${listAccounts().join(", ") || "none"}`
    );
  }

  const limit = parsePositiveInt((req.query || {}).limit, undefined, MAX_LIMIT) || config.maxTweetsPerAccount;

  const allowed = allowlist();
  if (allowed) {
    const blocked = usernames.filter((u) => !allowed.has(u));
    if (blocked.length) {
      return fail(res, 403, "ACCOUNT_NOT_ALLOWED", `Not served by this deployment: ${blocked.join(", ")}`);
    }
  }

  // Stateless onlyNew: the client tells us what it has already seen.
  const exclude = parseIds((req.query || {}).exclude);
  const onlyNew = "exclude" in (req.query || {});

  const startedAt = Date.now();
  let dataset;
  try {
    dataset = await loadDataset();
  } catch (err) {
    return fail(
      res,
      503,
      (err && err.code) || "DATA_UNAVAILABLE",
      (err && err.message) || "The dataset could not be loaded.",
      err && err.hint
    );
  }

  const isBlocked = buildMatcher(config.ignoreKeywords, config.matchMode);
  const results = selectFromDataset(dataset.records, usernames, { limit, exclude, isBlocked });

  const missing = results.filter((r) => !r.ok).map((r) => r.username);

  return send(res, 200, {
    ok: true,
    account: usernames.join(","),
    requested: usernames,
    mode: "cache",
    count: results.reduce((n, r) => n + r.tweets.length, 0),
    generatedAt: dataset.generatedAt,
    ageSeconds: datasetAgeSeconds(dataset),
    durationMs: Date.now() - startedAt,
    options: {
      limit,
      onlyNew,
      matchMode: config.matchMode,
      ignored: exclude.size,
      empty: missing,
    },
    accounts: results,
    dataset: {
      total: dataset.records.length,
      fetchedAt: dataset.fetchedAt,
      runs: dataset.meta ? dataset.meta.runs : null,
      pruned: dataset.meta ? dataset.meta.pruned : null,
      source: dataset.tweetsUrl,
    },
  });
}

module.exports = { handleTweets, send, fail, selectFromDataset, cacheHeaders, CORS_HEADERS };