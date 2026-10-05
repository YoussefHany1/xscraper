// GET /api/health
// Data freshness probe. No browser is ever launched, and the X session is not
// involved: that lives in the GitHub Actions workflow now, so a dead session
// shows up as stale data here rather than as an error.

const { send } = require("../lib/handler");
const { listAccounts, getConfig } = require("../lib/config");
const { loadDataset, datasetAgeSeconds, resolveDataUrls } = require("../lib/dataset");

// Beyond two missed cron windows, treat the pipeline as broken rather than slow.
const STALE_MULTIPLIER = 2;

module.exports = async function handler(req, res) {
  const config = getConfig();
  const { tweetsUrl } = resolveDataUrls();

  try {
    const dataset = await loadDataset();
    const ageSeconds = datasetAgeSeconds(dataset);
    const staleAfter = config.cacheTtlSeconds * STALE_MULTIPLIER;
    const stale = ageSeconds === null || ageSeconds > staleAfter;
    const configured = new Set(listAccounts());
    const present = [...new Set(dataset.records.map((r) => r.username).filter(Boolean))].sort();

    return send(
      res,
      200,
      {
        ok: true,
        mode: "cache",
        runtime: process.env.VERCEL ? "vercel" : process.platform,
        node: process.version,
        checkedAt: new Date().toISOString(),
        generatedAt: dataset.generatedAt,
        ageSeconds,
        stale,
        staleAfterSeconds: staleAfter,
        staleSince: dataset.generatedAt || null,
        dataset: {
          total: dataset.records.length,
          runs: dataset.meta ? dataset.meta.runs : null,
          pruned: dataset.meta ? dataset.meta.pruned : null,
          fetchedAt: dataset.fetchedAt,
          source: dataset.tweetsUrl,
        },
        accounts: {
          configured: [...configured],
          present,
          missing: [...configured].filter((a) => !present.includes(a)),
        },
        // Surfaced so a private repo misconfiguration is obvious here.
        dataSourceConfigured: Boolean(tweetsUrl),
        authConfigured: !config.dataUrl || Boolean(config.dataToken),
      },
      {
        ...(stale ? { "X-Health": "stale", Warning: '110 - "Response is stale"' } : { "X-Health": "ok" }),
        // A health probe must not be answered from the edge cache: its whole job
        // is to notice that the dataset went stale or vanished.
        "Cache-Control": "no-store, max-age=0",
      }
    );
  } catch (err) {
    return send(
      res,
      503,
      {
        ok: false,
        mode: "cache",
        checkedAt: new Date().toISOString(),
        error: {
          code: (err && err.code) || "DATA_UNAVAILABLE",
          message: (err && err.message) || "The dataset could not be loaded.",
          ...(err && err.hint ? { hint: err.hint } : {}),
        },
        dataSourceConfigured: Boolean(tweetsUrl),
        hint: "Check /api/health after the first workflow run has committed data/tweets.json.",
      },
      { "X-Health": "error" }
    );
  }
};

module.exports.config = { maxDuration: 15 };