// X session handling.
//
// Locally the session lives in a Playwright persistent profile (.browser-profile).
// Vercel has no persistent disk, so the same session travels as a JSON
// "storageState" blob in the X_STORAGE_STATE environment variable.

const { chromium } = require("playwright-core");

const { getConfig } = require("./config");

const SESSION_ENV_KEYS = ["X_STORAGE_STATE", "VERCEL_X_STORAGE_STATE"];
const X_COOKIE_DOMAINS = [".x.com", "x.com", ".twitter.com", "twitter.com"];

function readEnvSession() {
  for (const key of SESSION_ENV_KEYS) {
    const raw = process.env[key];
    if (raw && raw.trim()) return { raw, key };
  }
  return null;
}

// Keeps only the x.com cookies: that is all X needs to authenticate, and it
// keeps the env var small enough to paste around comfortably.
function trimState(state) {
  if (!state || typeof state !== "object") return null;
  const cookies = Array.isArray(state.cookies)
    ? state.cookies.filter((c) => X_COOKIE_DOMAINS.includes(c.domain))
    : [];
  return { cookies, origins: [] };
}

// Returns a Playwright-compatible storageState object, or null when unset.
function getStorageState() {
  const found = readEnvSession();
  if (!found) return null;

  let parsed;
  try {
    parsed = JSON.parse(found.raw);
  } catch {
    throw new Error(
      `${found.key} is set but is not valid JSON. Re-export it with: npm run export-session`
    );
  }

  // Accept either a full storageState object or just a cookies array.
  const state = Array.isArray(parsed) ? { cookies: parsed, origins: [] } : parsed;
  const trimmed = trimState(state);

  if (!trimmed.cookies.length) {
    throw new Error(
      `${found.key} contains no x.com cookies. Log in again with: npm run login, then: npm run export-session`
    );
  }
  return trimmed;
}

function describeSession() {
  const found = readEnvSession();
  if (!found) return { configured: false, cookies: 0, source: null, error: null };
  try {
    const state = getStorageState();
    return { configured: true, cookies: state.cookies.length, source: found.key, error: null };
  } catch (err) {
    return { configured: true, cookies: 0, source: found.key, error: err.message };
  }
}

function launchLocal({ headless }) {
  const config = getConfig();
  return chromium.launchPersistentContext(config.profileDir, {
    headless,
    channel: config.browserChannel || undefined,
    viewport: config.viewport,
  });
}

// Opens the saved local profile and dumps its cookies to a storageState blob.
// This is what you paste into the X_STORAGE_STATE env var on Vercel.
async function exportStorageState() {
  const context = await launchLocal({ headless: true });
  try {
    const trimmed = trimState(await context.storageState());
    if (!trimmed.cookies.length) {
      throw new Error("No x.com cookies in the profile. Run: npm run login");
    }
    return trimmed;
  } finally {
    await context.close();
  }
}

// Headed browser that waits for the human to finish logging in.
async function interactiveLogin() {
  const readline = require("readline");
  const context = await launchLocal({ headless: false });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://x.com/i/flow/login");
    console.log("Log in to X in the opened window (a throwaway account is recommended).");
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("When you're logged in and see your home timeline, press Enter here... ", () => {
        rl.close();
        resolve();
      });
    });
    const state = trimState(await context.storageState());
    if (!state.cookies.length) {
      throw new Error("Still not logged in -- no x.com cookies were saved.");
    }
    return state;
  } finally {
    await context.close();
  }
}

module.exports = {
  getStorageState,
  describeSession,
  exportStorageState,
  interactiveLogin,
};