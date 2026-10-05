// Minimal .env.local loader, so the same environment variables that configure
// the Vercel deployment can be used locally. Replaces the `dotenv` dependency.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const CANDIDATES = [".env.local", ".env"];

function parse(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile() {
  // Test hook: the suite asserts on an empty environment, and a developer's real
  // .env would otherwise leak a live session into it.
  if (process.env.XSCRAPER_SKIP_ENV_FILE === "1") return [];

  const loaded = [];
  for (const name of CANDIDATES) {
    const file = path.join(ROOT_DIR, name);
    let contents;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parse(contents))) {
      // Real environment variables always win over the file.
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded.push(key);
      }
    }
  }
  return loaded;
}

module.exports = { loadEnvFile };