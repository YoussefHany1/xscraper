// Resolves configuration from four layers, later layers win:
//   1. built-in defaults
//   2. ./config.js  (your editable file)
//   3. environment variables (shared by the CLI and the Vercel deployment)
//   4. per-request overrides (e.g. from a query string)

const path = require("path");

require("./env").loadEnvFile();

const base = require("../config");

const ROOT_DIR = path.join(__dirname, "..");

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function toList(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toEnum(value, fallback, allowed) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

// Config values may be relative; always resolve them against the project root
// so the CLI, the Actions workflow and Vercel all agree on the same file.
function resolvePath(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
}

const DEFAULTS = {
  accounts: [],
  ignoreKeywords: [],
  matchMode: "word",
  maxTweetsPerAccount: 20,
  maxScrolls: 15,
  delayBetweenAccountsMs: 4000,
  onlyNew: true,
  headless: true,

  // Where the scraped dataset lives. All three are written by the CLI (and by
  // the GitHub Actions workflow) and committed to the repo.
  outputFile: "data/tweets.json",
  stateFile: "data/state.json",
  metaFile: "data/meta.json",
  profileDir: ".browser-profile",

  // Retention. Without pruning the dataset grows by up to a few thousand
  // records a day and every commit carries the whole file.
  pruneMaxAgeDays: 14,
  pruneMaxPerAccount: 500,

  // Where the session comes from, and which browser binary drives it.
  //   sessionSource: auto | env | profile
  //   browserSource: auto | playwright | system
  sessionSource: "auto",
  browserSource: "auto",
  browserChannel: "msedge",

  // API data source (cache mode). Falls back to deriving a raw.githubusercontent
  // URL from GITHUB_REPOSITORY + GITHUB_REF_NAME when unset.
  dataUrl: null,
  dataMetaUrl: null,
  dataToken: null,
  cacheTtlSeconds: 600, // matches the 15 min Actions cadence
  datasetMemoMs: 300000, // in-function memo, avoids re-fetching on every invoke
  datasetTimeoutMs: 8000,

  // Scraping internals.
  viewport: { width: 1280, height: 1600 },
  selectorTimeoutMs: 20000,
  scrollDelayMs: 1200,
  scrollJitterMs: 800,
  staleScrollLimit: 3,
  stateMaxPerAccount: 500,
};

function fromEnv() {
  const env = process.env;
  const o = {};
  const assign = (key, value) => {
    if (value !== undefined) o[key] = value;
  };

  assign("accounts", toList(env.XSCRAPER_ACCOUNTS, undefined));
  assign("ignoreKeywords", toList(env.XSCRAPER_IGNORE_KEYWORDS, undefined));
  assign("matchMode", env.XSCRAPER_MATCH_MODE || undefined);
  assign("maxTweetsPerAccount", toNumber(env.XSCRAPER_MAX_TWEETS, undefined));
  assign("maxScrolls", toNumber(env.XSCRAPER_MAX_SCROLLS, undefined));
  assign("delayBetweenAccountsMs", toNumber(env.XSCRAPER_DELAY_MS, undefined));
  assign("headless", toBoolean(env.XSCRAPER_HEADLESS, undefined));
  assign("onlyNew", toBoolean(env.XSCRAPER_ONLY_NEW, undefined));

  assign("outputFile", env.XSCRAPER_OUTPUT_FILE || undefined);
  assign("stateFile", env.XSCRAPER_STATE_FILE || undefined);
  assign("metaFile", env.XSCRAPER_META_FILE || undefined);
  assign("profileDir", env.XSCRAPER_PROFILE_DIR || undefined);

  assign("pruneMaxAgeDays", toNumber(env.XSCRAPER_PRUNE_MAX_AGE_DAYS, undefined));
  assign("pruneMaxPerAccount", toNumber(env.XSCRAPER_PRUNE_MAX_PER_ACCOUNT, undefined));

  assign("sessionSource", toEnum(env.XSCRAPER_SESSION, undefined, ["auto", "env", "profile"]));
  assign("browserSource", toEnum(env.XSCRAPER_BROWSER, undefined, ["auto", "playwright", "system"]));
  assign("browserChannel", env.XSCRAPER_BROWSER_CHANNEL || undefined);

  assign("dataUrl", env.XSCRAPER_DATA_URL || undefined);
  assign("dataMetaUrl", env.XSCRAPER_DATA_META_URL || undefined);
  assign("dataToken", env.XSCRAPER_DATA_TOKEN || undefined);
  assign("cacheTtlSeconds", toNumber(env.XSCRAPER_CACHE_TTL_SECONDS, undefined));

  return o;
}

// Applied after the layers merge, so relative paths from config.js and from env
// both get anchored to the project root.
function normalize(config) {
  config.outputFile = resolvePath(config.outputFile);
  config.stateFile = resolvePath(config.stateFile);
  config.metaFile = resolvePath(config.metaFile);
  config.profileDir = resolvePath(config.profileDir);

  if (!config.dataMetaUrl && config.dataUrl) {
    config.dataMetaUrl = config.dataUrl.replace(/tweets\.json(?=$|\?)/, "meta.json");
  }

  return config;
}

let cached = null;

// Test hook: the base config is memoized, so a test that mutates the
// environment has to invalidate it explicitly.
function resetConfigCache() {
  cached = null;
}

function getConfig(overrides) {
  if (!overrides && cached) return cached;
  const resolved = normalize({ ...DEFAULTS, ...pick([base, fromEnv()]), ...pick([overrides]) });
  if (!overrides) cached = resolved;
  return resolved;
}

function pick(sources) {
  const result = {};
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      if (source[key] !== undefined) result[key] = source[key];
    }
  }
  return result;
}

function listAccounts(overrides) {
  return [...new Set(getConfig(overrides).accounts.map(normalizeUsername).filter(Boolean))];
}

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(x|twitter)\.com\//i, "")
    .split(/[/?#]/)[0]
    .trim();
}

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

function isValidUsername(username) {
  return USERNAME_RE.test(username);
}

module.exports = {
  getConfig,
  resetConfigCache,
  listAccounts,
  normalizeUsername,
  isValidUsername,
  ROOT_DIR,
};