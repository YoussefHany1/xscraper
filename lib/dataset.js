// The scraped dataset, from both ends.
//
// Writer side (CLI / GitHub Actions): pruneRecords + writeDataset, keeping
// data/tweets.json bounded and writing data/meta.json for freshness checks.
//
// Reader side (Vercel API): loadDataset fetches the committed files at runtime
// and memoizes them, so a request never touches a browser or a git checkout.

const fs = require("fs");
const path = require("path");

const { getConfig, ROOT_DIR } = require("./config");

// ---------------------------------------------------------------------------
// Writer side
// ---------------------------------------------------------------------------

function recordTimestamp(record) {
  const t = Date.parse(record && record.date);
  return Number.isFinite(t) ? t : 0;
}

function recordKey(record) {
  return (record && (record.id || record.url)) || null;
}

// Dedupe by tweet id, drop anything past maxAgeDays, then cap each account.
// Records with an unparseable date are kept but sorted last, so a date-format
// change on X's side cannot silently empty the dataset.
function pruneRecords(records, options = {}) {
  const maxAgeDays = options.pruneMaxAgeDays;
  const maxPerAccount = options.pruneMaxPerAccount;
  const now = options.now === undefined ? Date.now() : options.now;
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86400000 : null;

  const byId = new Map();
  for (const record of records) {
    const key = recordKey(record);
    if (!key) continue;
    const previous = byId.get(key);
    if (!previous || recordTimestamp(record) > recordTimestamp(previous)) {
      byId.set(key, record);
    }
  }

  let kept = [...byId.values()];

  if (cutoff !== null) {
    kept = kept.filter((r) => {
      const t = Date.parse(r.date);
      return !Number.isFinite(t) || t >= cutoff;
    });
  }

  kept.sort((a, b) => recordTimestamp(b) - recordTimestamp(a));

  if (maxPerAccount > 0) {
    const counts = new Map();
    kept = kept.filter((r) => {
      const n = counts.get(r.username) || 0;
      if (n >= maxPerAccount) return false;
      counts.set(r.username, n + 1);
      return true;
    });
  }

  return kept;
}

function readRecords(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function summarize(records) {
  const accounts = new Map();
  for (const r of records) {
    const entry = accounts.get(r.username) || { username: r.username, count: 0, newest: null };
    entry.count++;
    const t = r.date || null;
    if (t && (!entry.newest || t > entry.newest)) entry.newest = t;
    accounts.set(r.username, entry);
  }
  return [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username));
}

// Merges new records into the dataset, prunes, and rewrites tweets.json + meta.json.
// `previousTotal` lets meta.json report how much history was dropped.
function writeDataset(records, options = {}) {
  const config = getConfig(options.configOverrides);
  const file = config.outputFile;

  const existing = readRecords(file);
  const merged = pruneRecords([...records, ...existing], {
    pruneMaxAgeDays: options.pruneMaxAgeDays ?? config.pruneMaxAgeDays,
    pruneMaxPerAccount: options.pruneMaxPerAccount ?? config.pruneMaxPerAccount,
  });

  if (config.outputFile) writeJson(file, merged);

  let metaTotal = null;
  if (config.metaFile) {
    let runs = 0;
    try {
      const previous = JSON.parse(fs.readFileSync(config.metaFile, "utf8"));
      runs = Number.isFinite(previous && previous.runs) ? previous.runs : 0;
    } catch {}
    runs += 1;

    const meta = {
      generatedAt: new Date().toISOString(),
      runs,
      total: merged.length,
      added: records.length,
      pruned: existing.length + records.length - merged.length,
      accounts: summarize(merged),
      scraper: {
        accounts: (config.accounts || []).map(String),
        ignoreKeywords: (config.ignoreKeywords || []).length,
        matchMode: config.matchMode,
        pruneMaxAgeDays: config.pruneMaxAgeDays,
        pruneMaxPerAccount: config.pruneMaxPerAccount,
      },
    };
    metaTotal = meta;
    writeJson(config.metaFile, meta);
  }

  return { written: records.length, total: merged.length, meta: metaTotal };
}

// ---------------------------------------------------------------------------
// Reader side (Vercel API)
// ---------------------------------------------------------------------------

class DataUnavailableError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "DataUnavailableError";
    this.code = "DATA_UNAVAILABLE";
    this.hint = hint || null;
  }
}

function resolveDataUrls(options = {}) {
  const config = getConfig(options.configOverrides);
  const metaUrl = config.dataMetaUrl || null;

  if (config.dataUrl) {
    return {
      tweetsUrl: config.dataUrl,
      metaUrl: metaUrl || config.dataUrl.replace(/tweets\.json(?=$|\?)/, "meta.json"),
    };
  }

  // Convenience: derive a raw.githubusercontent.com URL in GitHub Actions.
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || "main";
  if (repo) {
    const base = `https://raw.githubusercontent.com/${repo}/${branch}/data`;
    return { tweetsUrl: `${base}/tweets.json`, metaUrl: metaUrl || `${base}/meta.json` };
  }

  return { tweetsUrl: null, metaUrl: null };
}

const memo = { data: null, at: 0, error: null, errorAt: 0 };
const ERROR_RETRY_MS = 30000;

function resetDatasetCache() {
  memo.data = null;
  memo.at = 0;
  memo.error = null;
  memo.errorAt = 0;
}

async function fetchJson(url, headers, timeoutMs) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new DataUnavailableError(
      `Fetching ${url} returned HTTP ${response.status}.`,
      "Is the repo public, or is XSCRAPER_DATA_TOKEN set? Has a workflow run committed data/tweets.json yet?"
    );
  }
  return response.json();
}

// Fetches the committed dataset. Memoized for datasetMemoMs so a warm function
// instance answers from memory instead of re-fetching per request.
async function loadDataset(options = {}) {
  const config = getConfig(options.configOverrides);
  const memoMs = options.memoMs ?? config.datasetMemoMs;
  const now = Date.now();

  if (memo.data && now - memo.at < memoMs) return memo.data;
  if (memo.error && now - memo.errorAt < ERROR_RETRY_MS) throw memo.error;

  const { tweetsUrl, metaUrl } = resolveDataUrls(options);
  if (!tweetsUrl) {
    const error = new DataUnavailableError(
      "No dataset URL is configured.",
      "Set XSCRAPER_DATA_URL to the raw URL of data/tweets.json (see README)."
    );
    memo.error = error;
    memo.errorAt = now;
    throw error;
  }

  const headers = { Accept: "application/json" };
  if (config.dataToken) headers.Authorization = `Bearer ${config.dataToken}`;

  const timeoutMs = config.datasetTimeoutMs;

  try {
    const [tweets, meta] = await Promise.all([
      fetchJson(tweetsUrl, headers, timeoutMs),
      metaUrl ? fetchJson(metaUrl, headers, timeoutMs).catch(() => null) : Promise.resolve(null),
    ]);

    if (!Array.isArray(tweets)) {
      throw new DataUnavailableError(
        `${tweetsUrl} did not contain a JSON array.`,
        "data/tweets.json must be a flat array of tweet records."
      );
    }

    const dataset = {
      records: tweets,
      meta: meta || null,
      tweetsUrl,
      fetchedAt: new Date().toISOString(),
      generatedAt: (meta && meta.generatedAt) || null,
    };

    memo.data = dataset;
    memo.at = now;
    memo.error = null;
    return dataset;
  } catch (err) {
    const error =
      err instanceof DataUnavailableError
        ? err
        : new DataUnavailableError(
            `Could not fetch the dataset: ${err.message}`,
            `Check that ${tweetsUrl} is reachable from Vercel.`
          );
    memo.error = error;
    memo.errorAt = now;
    throw error;
  }
}

function datasetAgeSeconds(dataset, now = Date.now()) {
  const stamp = dataset && (dataset.generatedAt || (dataset.meta && dataset.meta.generatedAt));
  if (!stamp) return null;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

module.exports = {
  pruneRecords,
  readRecords,
  writeJson,
  writeDataset,
  summarize,
  loadDataset,
  resolveDataUrls,
  resetDatasetCache,
  datasetAgeSeconds,
  DataUnavailableError,
  ROOT_DIR,
};