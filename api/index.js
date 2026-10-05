// GET /api
// Service index. See /api/accounts for the per-account endpoint list.

const { send } = require("../lib/handler");
const { describeSession } = require("../lib/session");

module.exports = function handler(req, res) {
  return send(res, 200, {
    ok: true,
    name: "x-tweet-filter",
    description: "Tweets from chosen X accounts, with reposts and keyword matches removed.",
    routes: {
      accounts: "/api/accounts",
      health: "/api/health",
      tweets: "/api/tweets/<username>",
      tweetsQuery: "/api/tweets?account=<username>",
    },
    example: "/api/tweets/nasa?limit=10",
    session: describeSession(),
  });
};

module.exports.config = { maxDuration: 15 };