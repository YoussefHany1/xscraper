// Keyword + repost filtering. Pure functions, no I/O, safe to use on Vercel.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(keywords, mode) {
  const list = (keywords || []).map((k) => String(k).trim()).filter(Boolean);

  if (!list.length) return () => false;

  if (mode === "substring") {
    const lower = list.map((k) => k.toLowerCase());
    return (text) => lower.some((k) => String(text).toLowerCase().includes(k));
  }

  // Default "word" mode: whole-word match, so "nft" won't match "craft".
  // \p{L}\p{N} keeps accented letters and digits inside words.
  const regexes = list.map(
    (k) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(k)}($|[^\\p{L}\\p{N}_])`, "iu")
  );
  return (text) => regexes.some((re) => re.test(text));
}

function isRepost(tweet, username) {
  // A repost is rendered on the profile page but authored by someone else.
  // Comparing authors works in every UI language; the label check is a second net.
  if (tweet.author && tweet.author.toLowerCase() !== String(username).toLowerCase()) return true;
  return /repost|retweet/i.test(tweet.socialContext || "");
}

function toRecord(tweet, username) {
  return {
    username,
    id: tweet.id,
    author: tweet.author,
    text: tweet.text,
    date: tweet.date,
    url: `https://x.com/${tweet.author || username}/status/${tweet.id}`,
    images: tweet.images || [],
  };
}

// Applies the full pipeline: no-caption -> repost -> keyword -> already-seen.
function filterTweets(tweets, username, options) {
  const { isBlocked, seen, onlyNew = true, limit } = options;

  const kept = [];
  const stats = {
    scraped: tweets.length,
    kept: 0,
    skippedNoCaption: 0,
    skippedRepost: 0,
    skippedKeyword: 0,
    skippedSeen: 0,
  };

  for (const tweet of tweets) {
    if (stats.kept >= limit) break;

    if (!tweet.text || !tweet.text.trim()) {
      stats.skippedNoCaption++;
      continue;
    }
    if (isRepost(tweet, username)) {
      stats.skippedRepost++;
      continue;
    }
    if (isBlocked(tweet.text)) {
      stats.skippedKeyword++;
      continue;
    }
    if (onlyNew && seen && seen.has(tweet.id)) {
      stats.skippedSeen++;
      continue;
    }

    kept.push(toRecord(tweet, username));
    stats.kept++;
  }

  return { kept, stats };
}

module.exports = {
  buildMatcher,
  isRepost,
  filterTweets,
};