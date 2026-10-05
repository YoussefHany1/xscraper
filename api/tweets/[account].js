// GET /api/tweets/<username>
// Dynamic route: serves any X username, not just the ones in config.js.
// The generated static files next to this one (e.g. FutSheriff.js) take priority
// for accounts listed in config.js.

const { handleTweets } = require("../../lib/handler");

module.exports = function handler(req, res) {
  const account = (req.query && req.query.account) || undefined;
  return handleTweets(req, res, { account });
};

module.exports.config = { maxDuration: 120 };