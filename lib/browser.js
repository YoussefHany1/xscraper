// Browser lifecycle.
//
// Session source and browser binary are independent axes, because CI cannot log
// in interactively while a local dev machine has a real browser and a profile:
//
//   sessionSource   env      -> X_STORAGE_STATE (CI)
//                  profile  -> the .browser-profile/ directory (local)
//   browserSource   playwright -> Playwright drives the browser, using an
//                                installed Edge/Chrome (CI and optionally local)
//                  system     -> Playwright drives a persistent profile (local)
//
// "playwright" names who controls the browser, not which binary it is. On CI it
// will happily drive the runner's preinstalled Edge, which matters because x.com
// is behind Cloudflare and Cloudflare fingerprints Playwright's bundled
// headless shell far more aggressively than a genuine browser.

const fs = require("fs");

const { chromium } = require("playwright-core");

const { getConfig } = require("./config");
const { getStorageState } = require("./session");

// GitHub's ubuntu runners ship Edge and Chrome; desktops usually have one too.
// Used only for the `auto` decision when browserSource is not set explicitly.
const HAS_DESKTOP_BROWSER = process.platform === "win32" || process.platform === "darwin";

function resolveSessionSource(options = {}) {
  const config = getConfig(options.configOverrides);
  const explicit = config.sessionSource;
  if (explicit === "env" || explicit === "profile") return explicit;

  // auto:
  //   CI has no profile, so the secret is the only option.
  //   A logged-in local profile wins over a stale blob in .env -- otherwise
  //   every local run would silently reseed the profile from the export.
  if (process.env.CI === "true") return "env";
  if (fs.existsSync(config.profileDir)) return "profile";
  return getStorageState() ? "env" : "profile";
}

function resolveBrowserSource(options = {}) {
  const explicit = getConfig(options.configOverrides).browserSource;
  if (explicit === "playwright" || explicit === "system") return explicit;
  if (process.env.CI === "true" || !HAS_DESKTOP_BROWSER) return "playwright";
  return "system";
}

// Resolves which session source the current runtime can actually use, so the
// CLI fails with an actionable message instead of a cryptic browser error.
function resolveSession(options = {}) {
  const config = getConfig(options.configOverrides);
  const source = resolveSessionSource(options);

  if (source === "env") {
    let storageState;
    try {
      storageState = getStorageState();
    } catch (err) {
      return { source, storageState: null, error: err.message, hint: "Fix it with: npm run export-session" };
    }
    if (!storageState) {
      return {
        source,
        storageState: null,
        error: "X_STORAGE_STATE is not set.",
        hint: "Produce it with `npm run export-session`, or set XSCRAPER_SESSION=profile to use the local login.",
      };
    }
    return { source, storageState, error: null, hint: null };
  }

  if (!fs.existsSync(config.profileDir)) {
    return {
      source,
      storageState: null,
      error: "No saved session profile.",
      hint: "Run `npm run login` to log in to X, or set X_STORAGE_STATE.",
    };
  }
  return { source, storageState: null, error: null, hint: null };
}

// Playwright drives the browser; an ephemeral context is seeded from the
// X_STORAGE_STATE blob. Prefers an installed Edge/Chrome and only falls back to
// Playwright's bundled build if neither is present.
async function launchPlaywright({ storageState, headless, viewport, config }) {
  const resolved = config || getConfig();

  const channels = [];
  if (resolved.browserChannel) channels.push(resolved.browserChannel);
  if (!channels.includes("chrome")) channels.push("chrome");
  const attempts = [...channels.map((channel) => ({ channel })), {}];

  let lastError;
  for (const attempt of attempts) {
    let browser;
    try {
      browser = await chromium.launch({
        headless,
        ...attempt,
        args: [
          // Removes navigator.webdriver, which is otherwise a one-line tell.
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
        ],
        // The CI container runs as root without user namespaces. Only the
        // bundled build needs this; a channel launch goes through the distro
        // package's own sandbox setup.
        ...(process.env.CI === "true" && !attempt.channel ? { chromiumSandbox: false } : {}),
      });
    } catch (err) {
      // Fall through only when the binary is missing, never on a real failure.
      if (!/executable doesn't exist|ENOENT|no such file/i.test(err.message)) throw err;
      lastError = err;
      continue;
    }

    // Playwright rewrites the UA in headless mode to include "HeadlessChrome",
    // which is the loudest single tell on this site. Rebuild a genuine UA from
    // the version of the binary actually running, so it cannot drift out of
    // sync the way a hardcoded one does.
    const version = browser.version() || "";
    const major = version.split(".")[0];
    const contextOptions = {
      storageState: storageState || undefined,
      viewport,
      locale: "en-US",
      timezoneId: "UTC",
    };
    if (/^\d+$/.test(major)) {
      contextOptions.userAgent = genuineUserAgent(major, attempt.channel, process.platform);
    }

    const context = await browser.newContext(contextOptions);

    return {
      browser,
      context,
      page: await context.newPage(),
      mode: attempt.channel ? `playwright:${attempt.channel}` : "playwright:bundled",
      cleanup: () => browser.close(),
    };
  }

  throw new Error(
    `No browser binary found. Tried ${channels.join(", ") || "(no channel configured)"} then Playwright's bundled build. ` +
      `Install Edge or Chrome, set browserChannel in config.js, or run: npx playwright-core install chromium`
  );
}

// Persistent context against .browser-profile, using the installed browser.
//
// Note: launchPersistentContext accepts a `storageState` option but silently
// ignores it -- the cookies only land if you call addCookies() yourself. So when
// the session comes from the env blob, seed it explicitly.
async function launchSystem({ headless, viewport, config, storageState }) {
  const resolved = config || getConfig();
  if (!fs.existsSync(resolved.profileDir)) {
    throw new Error("No saved session. Run first: npm run login");
  }
  const context = await chromium.launchPersistentContext(resolved.profileDir, {
    headless,
    channel: resolved.browserChannel || undefined,
    viewport,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  if (storageState && storageState.cookies && storageState.cookies.length) {
    await context.addCookies(storageState.cookies);
  }

  const page = context.pages()[0] || (await context.newPage());
  return {
    browser: null,
    context,
    page,
    mode: "system",
    cleanup: () => context.close(),
  };
}

// Chromium's headless mode advertises "HeadlessChrome" and a truncated version.
// Mirror what the real browser sends, including Edge's own "Edg/" token, and
// keep the platform token aligned with where this is actually running -- a
// Linux UA on a Windows box is as suspicious as a wrong version number.
function genuineUserAgent(major, channel, platform) {
  const token =
    platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";

  const isEdge = /edge|msedge/i.test(channel || "");
  const brand = isEdge ? ` Edg/${major}.0.0.0` : "";

  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${brand}`;
}

// Single entry point used by both the CLI and the Actions workflow.
async function openBrowser(options = {}) {
  const config = getConfig(options.configOverrides);
  const viewport = options.viewport || config.viewport;
  const headless = options.headless !== undefined ? options.headless : config.headless;

  const session = resolveSession(options);
  if (session.error) {
    throw new Error(`${session.error} ${session.hint || ""}`.trim());
  }

  const browserSource = resolveBrowserSource(options);

  if (browserSource === "system") {
    return launchSystem({ headless, viewport, config, storageState: session.storageState });
  }
  return launchPlaywright({ storageState: session.storageState, headless, viewport, config });
}

// Convenience wrapper: guarantees cleanup even on timeout/abort.
async function withBrowser(fn, options = {}) {
  const session = await openBrowser(options);
  try {
    return await fn(session);
  } finally {
    await session.cleanup();
  }
}

module.exports = {
  openBrowser,
  withBrowser,
  resolveSession,
  resolveSessionSource,
  resolveBrowserSource,
  genuineUserAgent,
};