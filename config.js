// Edit these lists. You can also pass accounts on the command line:
//   node index.js --accounts nasa,github,vercel
//
// After changing `accounts`, run `npm run generate` to create one API endpoint
// per account (api/tweets/<Username>.js). See README.md for deployment.

module.exports = {
  // X usernames WITHOUT the "@".
  accounts: [
    "FutSheriff",
    "FNBRintel",
    "LeagueOfLeaks",
    "Rainbow6Game",
    "ValorantUpdated",
  ],

  // Case-insensitive. A tweet containing ANY of these is ignored.
  ignoreKeywords: [
    "giveaway",
    "airdrop",
    "sponsored",
    "patreon.com/Duck_MitchyDuck",
    "???????",
    "Ronaldo price over the years",
    "The best FC 27 pack so far",
    "Which POTM will you complete?",
  ],

  // "word"      -> whole-word match ("nft" won't match "craft")
  // "substring" -> match anywhere inside the text
  matchMode: "word",

  // Max tweets to collect per account per run (the page is scrolled until reached).
  maxTweetsPerAccount: 20,

  // Max scroll attempts per account (safety limit).
  maxScrolls: 15,

  // Delay between accounts (ms). Keep it generous to stay under the radar.
  delayBetweenAccountsMs: 4000,

  // Only report tweets not seen in previous runs. Depends on stateFile below,
  // which the GitHub Actions workflow commits so this survives between runs.
  onlyNew: true,

  // Run the browser without a window.
  headless: true,

  // ---------------------------------------------------------------------------
  // Dataset files. Written by the CLI (and by the Actions workflow) and
  // committed to the repo. The Vercel API reads them at runtime.
  // ---------------------------------------------------------------------------
  outputFile: "data/tweets.json",
  stateFile: "data/state.json",
  metaFile: "data/meta.json",

  // Retention, applied on every write. Without this the dataset grows by up to
  // a few thousand records a day and every commit carries the whole file.
  pruneMaxAgeDays: 14,
  pruneMaxPerAccount: 500,

  // Where the X session comes from:
  //   "auto"     -> env if X_STORAGE_STATE is set, otherwise the local profile
  //   "env"      -> X_STORAGE_STATE (use this in CI -- no browser to log in with)
  //   "profile"  -> the .browser-profile/ directory
  sessionSource: "auto",

  // Which browser binary drives it:
  //   "auto"      -> playwright's Chromium in CI, the installed browser locally
  //   "playwright" -> Playwright's downloaded Chromium
  //   "system"     -> the installed Edge/Chrome, per browserChannel
  browserSource: "auto",
  browserChannel: "msedge",

  // ---------------------------------------------------------------------------
  // API / cache settings (Vercel only; ignored by the CLI)
  // ---------------------------------------------------------------------------
  // Where the API fetches the dataset from. Falls back to deriving a
  // raw.githubusercontent.com URL from GITHUB_REPOSITORY + GITHUB_REF_NAME.
  dataUrl: null,
  dataMetaUrl: null,

  // Bearer token for a private repo's raw.githubusercontent URL.
  dataToken: null,

  // Edge Cache TTL. Keep in step with the workflow cron (*/15 -> 600).
  cacheTtlSeconds: 600,

  // How long a warm function instance reuses a fetched dataset in memory.
  datasetMemoMs: 300000,

  // ---------------------------------------------------------------------------
  // Scraping internals
  // ---------------------------------------------------------------------------
  viewport: { width: 1280, height: 1600 },
  selectorTimeoutMs: 20000,
  scrollDelayMs: 1200,
  scrollJitterMs: 800,
  staleScrollLimit: 3,

  // Max tweet ids remembered per account in stateFile.
  stateMaxPerAccount: 500,

  // Never commit this -- it is the live X login session.
  profileDir: ".browser-profile",
};