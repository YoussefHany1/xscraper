// Browser lifecycle.
//
// Session source and browser binary are independent axes, because CI has no
// interactive login and no installed Edge, while a local dev machine is the
// other way round:
//
//   sessionSource   env      -> X_STORAGE_STATE (CI, and Vercel-style deploys)
//                  profile  -> the .browser-profile/ directory (local)
//   browserSource   playwright -> Playwright's downloaded Chromium (CI)
//                  system     -> the installed Edge/Chrome (local)

const fs = require("fs");

const { chromium: chromiumCore } = require("playwright-core");
const { chromium: chromiumExtra } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

chromiumExtra.use(StealthPlugin());

const { getConfig } = require("./config");
const { getStorageState } = require("./session");

// CI runners have no Edge or Chrome installed.
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

// Non-persistent Chromium driven by an X_STORAGE_STATE blob. Used in CI.
async function launchPlaywright({ storageState, headless, viewport }) {
  // Use playwright-extra with stealth plugin in CI to bypass Cloudflare bot detection.
  // Fall back to plain playwright-core locally (stealth is less critical with a real profile).
  const launcher = process.env.CI === "true" ? chromiumExtra : chromiumCore;

  const browser = await launcher.launch({
    headless,
    // The CI container runs as root without user namespaces.
    chromiumSandbox: process.env.CI === "true" ? false : undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const context = await browser.newContext({
    storageState: storageState || undefined,
    viewport,
    locale: "en-US",
    timezoneId: "UTC",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  });

  return {
    browser,
    context,
    page: await context.newPage(),
    mode: "playwright",
    cleanup: () => browser.close(),
  };
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
  return launchPlaywright({ storageState: session.storageState, headless, viewport });
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
};