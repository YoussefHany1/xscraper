// Seen-tweet tracking for the CLI (and the GitHub Actions workflow).
//
// stateFile is committed to the repo so `onlyNew: true` survives between runs.
// The API stays stateless instead: callers pass ?exclude=<id,id> and dedupe on
// their side.

const fs = require("fs");
const path = require("path");

const { getConfig } = require("./config");
const { writeDataset } = require("./dataset");

function loadState() {
  const { stateFile } = getConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed === "object" && parsed.seen ? parsed : { seen: {} };
  } catch {
    return { seen: {} };
  }
}

function saveState(state) {
  const { stateFile } = getConfig();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile); // atomic: a crash mid-write keeps the old file
}

function getSeen(state, username) {
  return new Set(state.seen[username] || []);
}

function recordSeen(state, username, ids) {
  const { stateMaxPerAccount } = getConfig();
  const seen = getSeen(state, username);
  state.seen[username] = [...new Set([...ids.filter(Boolean), ...seen])].slice(0, stateMaxPerAccount);
}

// Merges records into outputFile, prunes to the retention window, and writes
// metaFile. Returns { written, total, meta }.
function appendTweets(records) {
  if (!records || !records.length) return { written: 0, total: 0, meta: null };
  return writeDataset(records);
}

module.exports = { loadState, saveState, getSeen, recordSeen, appendTweets };