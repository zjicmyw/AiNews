import { fetchJson } from "../http.js";
import { logger } from "../logger.js";
import { readLines } from "../utils.js";

export class XCollector {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.userIdCache = new Map();
    this.sinceIdCache = new Map();
    this.lastRequestAt = 0;
    this.roundRobinCursor = 0;
  }

  getWhitelistUsernames() {
    return readLines(this.config.xWhitelistFile)
      .map((line) => line.replace(/^@/, "").trim())
      .filter(Boolean);
  }

  async resolveUserId(username) {
    if (this.userIdCache.has(username)) return this.userIdCache.get(username);

    if (this.db?.getCachedXUserId) {
      const cached = this.db.getCachedXUserId(username);
      if (cached) {
        this.userIdCache.set(username, cached);
        return cached;
      }
    }

    const url = `${this.config.xApiBaseUrl}/users/by/username/${encodeURIComponent(username)}`;
    const json = await fetchJson(
      url,
      {
        headers: {
          Authorization: `Bearer ${this.config.xBearerToken}`
        }
      },
      10000
    );
    const id = json?.data?.id;
    if (!id) throw new Error(`x_user_not_found:${username}`);
    this.userIdCache.set(username, id);
    if (this.db?.saveXUserId) {
      this.db.saveXUserId(username, id);
    }
    return id;
  }

  pickUsersForThisCycle(usernames) {
    const size = usernames.length;
    const take = Number(this.config.xUsersPerCycle || 0);
    if (take <= 0 || take >= size) return usernames;

    const picked = [];
    for (let i = 0; i < take; i += 1) {
      picked.push(usernames[(this.roundRobinCursor + i) % size]);
    }
    this.roundRobinCursor = (this.roundRobinCursor + take) % size;
    return picked;
  }

  async fetchTweets(userId, sinceId) {
    const maxResults = Math.max(5, Math.min(100, Number(this.config.xMaxResultsPerUser || 5)));
    const params = new URLSearchParams({
      max_results: String(maxResults),
      "tweet.fields": "created_at,lang"
    });
    if (this.config.xExcludeRetweetsReplies) {
      params.set("exclude", "retweets,replies");
    }
    if (sinceId) params.set("since_id", sinceId);

    const url = `${this.config.xApiBaseUrl}/users/${userId}/tweets?${params.toString()}`;
    const json = await fetchJson(
      url,
      {
        headers: {
          Authorization: `Bearer ${this.config.xBearerToken}`
        }
      },
      12000
    );
    return {
      tweets: json?.data || [],
      newestId: json?.meta?.newest_id || null
    };
  }

  async collect() {
    if (!this.config.enableXSource || !this.config.xBearerToken) return [];
    const usernames = this.getWhitelistUsernames();
    if (usernames.length === 0) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      this.lastRequestAt > 0 &&
      nowSec - this.lastRequestAt < Math.max(1, this.config.xMinRequestIntervalSec || 60)
    ) {
      return [];
    }
    this.lastRequestAt = nowSec;

    const lookbackMs = this.config.newsLookbackMin * 60 * 1000;
    const now = Date.now();
    const events = [];
    const activeUsers = this.pickUsersForThisCycle(usernames);

    for (const username of activeUsers) {
      try {
        const userId = await this.resolveUserId(username);
        let sinceId = this.sinceIdCache.get(userId);
        if (!sinceId && this.db?.getCachedXSinceId) {
          sinceId = this.db.getCachedXSinceId(userId);
          if (sinceId) this.sinceIdCache.set(userId, sinceId);
        }

        const { tweets, newestId } = await this.fetchTweets(userId, sinceId);
        if (newestId) {
          this.sinceIdCache.set(userId, newestId);
          if (this.db?.saveXSinceId) {
            this.db.saveXSinceId(userId, newestId);
          }
        }

        for (const tweet of tweets) {
          const createdAt = tweet.created_at ? Date.parse(tweet.created_at) : now;
          if (Number.isFinite(createdAt) && now - createdAt > lookbackMs) continue;
          events.push({
            id: tweet.id,
            title: `${username}: ${(tweet.text || "").slice(0, 120)}`,
            source: `x:${username}`,
            source_type: "x",
            timestamp: new Date().toISOString(),
            publish_time: tweet.created_at || new Date().toISOString(),
            url: `https://x.com/${username}/status/${tweet.id}`,
            raw_text: tweet.text || ""
          });
        }
      } catch (error) {
        logger.warn("x_collect_failed", {
          username,
          error: String(error.message || error)
        });
      }
    }

    return events;
  }
}
