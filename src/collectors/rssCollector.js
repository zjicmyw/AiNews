import Parser from "rss-parser";
import { logger } from "../logger.js";

const parser = new Parser({ timeout: 10000 });

export class RssCollector {
  constructor(config) {
    this.config = config;
  }

  async collect() {
    if (!this.config.enableRssSource || this.config.rssFeeds.length === 0) return [];
    const lookbackMs = this.config.newsLookbackMin * 60 * 1000;
    const now = Date.now();
    const events = [];

    for (const feedUrl of this.config.rssFeeds) {
      try {
        const feed = await parser.parseURL(feedUrl);
        const items = (feed.items || []).slice(0, 20);
        for (const item of items) {
          const publishTime = item.isoDate || item.pubDate || new Date().toISOString();
          const publishTs = Date.parse(publishTime);
          if (Number.isFinite(publishTs) && now - publishTs > lookbackMs) continue;
          events.push({
            id: item.guid || item.id || item.link || `${feedUrl}:${item.title}`,
            title: item.title || "(untitled)",
            source: feed.title || new URL(feedUrl).host,
            source_type: "rss",
            timestamp: new Date().toISOString(),
            publish_time: new Date(publishTime).toISOString(),
            url: item.link || "",
            raw_text: item.contentSnippet || item.content || item.title || ""
          });
        }
      } catch (error) {
        logger.warn("rss_collect_failed", { feedUrl, error: String(error.message || error) });
      }
    }

    return events;
  }
}
