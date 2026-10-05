// Core scraping logic. Shared by the CLI (index.js) and the Vercel API handlers.

const { buildMatcher, filterTweets } = require("./filter");
const { getConfig } = require("./config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class NotLoggedInError extends Error {
  constructor(message = "Not logged in") {
    super(message);
    this.name = "NotLoggedInError";
    this.code = "NOT_LOGGED_IN";
  }
}

class ScrapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScrapeError";
    this.code = "SCRAPE_FAILED";
  }
}

// Cloudflare's interstitial. Worth its own error code: without it the run just
// reports "no tweets found", which sends you off inspecting account names and
// privacy settings when the real cause is the runner's IP or browser fingerprint.
class ChallengeError extends Error {
  constructor(message = "Blocked by Cloudflare's bot check") {
    super(message);
    this.name = "ChallengeError";
    this.code = "CHALLENGE";
  }
}

// Visible text on the interstitial. Body innerText excludes script contents, so
// these can only match what a human would actually see on the page.
//
// Deliberately no "Ray ID" alone: tweets about Ray ID (the dev tool, Ray-Ban,
// the Steam game) would false-positive, and that would discard real data.
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser/i;
const CHALLENGE_BODY =
  /performing security verification|this website uses a security service|verify (?:that )?you are (?:not a bot|human)|checking your browser before accessing|enable javascript and cookies to continue/i;

// Works out why a page produced no tweets, instead of guessing "account missing".
async function diagnose(page, username) {
  const currentUrl = page.url();
  const title = await page.title().catch(() => "?");
  const bodyText = await page
    .evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : ""))
    .catch(() => "");

  const isChallenge = CHALLENGE_TITLE.test(title) || CHALLENGE_BODY.test(bodyText);

  if (process.env.CI === "true") {
    const screenshotPath = `/tmp/debug-${username}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    console.error(`[DEBUG] @${username} — URL: ${currentUrl} | Title: ${title}`);
    console.error(`[DEBUG] Body preview: ${bodyText.replace(/\n/g, " ")}`);
    console.error(`[DEBUG] Screenshot saved to ${screenshotPath}`);
  }

  if (isChallenge) {
    return new ChallengeError(
      `Cloudflare blocked @${username} (interstitial: "${title}"). The accounts are fine; the browser or its IP was flagged.`
    );
  }
  if (/login|flow/i.test(currentUrl)) return new NotLoggedInError();

  return new ScrapeError(
    `No tweets found for @${username}. The account may be missing, private or suspended, or X's markup may have changed.`
  );
}

// Runs inside the page: reads every tweet currently rendered in the DOM.
// Must stay self-contained -- it is serialized and evaluated in the browser.
function extractVisibleTweets() {
  return [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => {
    const timeEl = a.querySelector("time");
    const link = timeEl && timeEl.closest("a");
    const href = link ? link.getAttribute("href") : null; // /user/status/123
    const m = href && href.match(/^\/([^/]+)\/status\/(\d+)/);
    const textEl = a.querySelector('[data-testid="tweetText"]');
    const ctx = a.querySelector('[data-testid="socialContext"]');
    const imgEls = a.querySelectorAll('div[data-testid="tweetPhoto"] img');
    const videoEls = a.querySelectorAll("video");
    return {
      id: m ? m[2] : null,
      author: m ? m[1] : null,
      text: textEl ? textEl.innerText : "",
      date: timeEl ? timeEl.getAttribute("datetime") : null,
      socialContext: ctx ? ctx.innerText : "",
      images: [
        ...[...imgEls].map((img) => img.src),
        ...[...videoEls].map((v) => v.getAttribute("poster")),
      ].filter(Boolean),
    };
  });
}

async function scrapeAccount(page, username, options) {
  const config = options.config;
  const maxScrolls = options.maxScrolls;
  const maxTweets = options.maxTweets;
  const signal = options.signal;

  await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded", timeout: 45000 });

  try {
    await page.waitForSelector('article[data-testid="tweet"]', {
      timeout: config.selectorTimeoutMs,
    });
  } catch {
    // The first wait can be lost to a Cloudflare interstitial that clears a
    // moment later, so grant one bounded grace period before diagnosing. Never
    // an unbounded retry -- that is just a hang with extra steps.
    const recovered = await page
      .waitForSelector('article[data-testid="tweet"]', { timeout: config.challengeGraceMs })
      .then(() => true)
      .catch(() => false);
    if (!recovered) throw await diagnose(page, username);
  }

  const collected = new Map();
  let stale = 0;

  for (let i = 0; i < maxScrolls && collected.size < maxTweets; i++) {
    if (signal && signal.aborted) break;

    const before = collected.size;
    for (const tweet of await page.evaluate(extractVisibleTweets)) {
      if (tweet.id && !collected.has(tweet.id)) collected.set(tweet.id, tweet);
    }

    stale = collected.size === before ? stale + 1 : 0;
    if (stale >= config.staleScrollLimit) break; // nothing new -> end of timeline
    if (collected.size >= maxTweets) break;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await sleep(config.scrollDelayMs + Math.random() * config.scrollJitterMs);
  }

  return [...collected.values()];
}

// Scrapes one already-open page and applies the keyword/repost filters.
// `seen` is a Set of tweet ids to treat as already-reported (stateless onlyNew).
async function scrapeOne(page, username, options = {}) {
  const config = getConfig(options.configOverrides);
  const maxTweets = options.limit || config.maxTweetsPerAccount;
  const maxScrolls = options.maxScrolls || config.maxScrolls;

  const raw = await scrapeAccount(page, username, {
    config,
    maxScrolls,
    maxTweets,
    signal: options.signal,
  });

  const { kept, stats } = filterTweets(raw, username, {
    isBlocked: buildMatcher(options.ignoreKeywords || config.ignoreKeywords, config.matchMode),
    // `seen` may be a Set or a (username) => Set resolver, so a single
    // scrapeMany() call can track each account independently.
    seen: typeof options.seen === "function" ? options.seen(username) : options.seen,
    onlyNew: options.onlyNew !== false,
    limit: maxTweets,
  });

  return {
    username,
    kept,
    stats,
    allIds: raw.map((t) => t.id).filter(Boolean),
  };
}

// Scrapes several accounts through a single browser instance.
// Returns per-account results; one failing account never aborts the others.
async function scrapeMany(page, usernames, options = {}) {
  const config = getConfig(options.configOverrides);

  const results = [];
  for (const username of usernames) {
    const result = {
      username,
      ok: true,
      error: null,
      code: null,
      tweets: [],
      stats: null,
    };

    try {
      const { kept, stats, allIds } = await scrapeOne(page, username, {
        ...options,
        limit: options.limit,
        maxScrolls: options.maxScrolls,
      });
      result.tweets = kept;
      result.stats = stats;
      result.allIds = allIds;
    } catch (err) {
      result.ok = false;
      result.error = err.message;
      result.code = err.code || "ERROR";
      result.allIds = [];
    }

    results.push(result);

    if (options.delayBetweenAccountsMs !== false && username !== usernames[usernames.length - 1]) {
      await sleep(options.delayBetweenAccountsMs ?? config.delayBetweenAccountsMs);
    }
  }

  return results;
}

module.exports = {
  scrapeOne,
  scrapeMany,
  extractVisibleTweets,
  diagnose,
  NotLoggedInError,
  ScrapeError,
  ChallengeError,
};