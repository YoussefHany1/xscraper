// GET /api/accounts
// Index of every account this deployment serves, and the endpoint that serves it.

const { send, CORS_HEADERS } = require("../lib/handler");
const { getConfig, listAccounts } = require("../lib/config");
const { loadDataset, datasetAgeSeconds, resolveDataUrls } = require("../lib/dataset");

const MAX_LIMIT = 100;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use GET." } });
  }

  const config = getConfig();
  const configured = listAccounts();
  const { tweetsUrl } = resolveDataUrls();
  const base = (req.headers && req.headers.host ? `https://${req.headers.host}` : "").replace(/\/$/, "");

  // Best effort: the index should still render when the dataset is unreachable.
  let available = new Set(configured);
  let generatedAt = null;
  let ageSeconds = null;
  let total = null;
  let datasetError = null;
  try {
    const dataset = await loadDataset();
    available = new Set(dataset.records.map((r) => r.username).filter(Boolean));
    generatedAt = dataset.generatedAt;
    ageSeconds = datasetAgeSeconds(dataset);
    total = dataset.records.length;
  } catch (err) {
    datasetError = { code: (err && err.code) || "DATA_UNAVAILABLE", message: err && err.message };
  }

  const accounts = [...new Set([...configured, ...available])].sort().map((name) => ({
    username: name,
    profile: `https://x.com/${name}`,
    // Static per-account endpoint (generated) and the generic dynamic one.
    endpoint: `/api/tweets/${name}`,
    fallback: `/api/tweets/${name}?limit=20`,
    configured: configured.includes(name),
    hasData: available.has(name),
  }));

  return send(res, 200, {
    ok: true,
    mode: "cache",
    count: accounts.length,
    accounts,
    genericEndpoint: "/api/tweets/<username>",
    query: {
      limit: `1-${MAX_LIMIT} (max 100)`,
      exclude: "comma-separated tweet ids to skip (stateless onlyNew)",
    },
    dataset: {
      generatedAt,
      ageSeconds,
      total,
      source: tweetsUrl,
      ...(datasetError ? { error: datasetError } : {}),
    },
    matchMode: config.matchMode,
    ignoreKeywords: config.ignoreKeywords,
    baseUrl: base || null,
  });
};

module.exports.config = { maxDuration: 15 };