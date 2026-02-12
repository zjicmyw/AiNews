import { fetchJson } from "../http.js";
import { logger } from "../logger.js";

function normalizeDate(raw) {
  const text = String(raw || "").trim();
  if (!text) return new Date().toISOString();

  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();

  // GDELT can return compact format like 20260211T164500Z
  const m = text.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }

  return new Date().toISOString();
}

export class GdeltCollector {
  constructor(config) {
    this.config = config;
    this.lastRequestAt = 0;
    this.rateLimitedUntil = 0;
  }

  async collect() {
    if (!this.config.enableGdeltSource) return [];
    const nowSec = Math.floor(Date.now() / 1000);

    if (this.rateLimitedUntil > nowSec) {
      const wait = this.rateLimitedUntil - nowSec;
      logger.info("gdelt_collect_skipped_cooldown", { wait_seconds: wait });
      return [];
    }

    if (this.lastRequestAt > 0 && nowSec - this.lastRequestAt < this.config.gdeltMinRequestIntervalSec) {
      return [];
    }

    const params = new URLSearchParams({
      query: this.config.gdeltQuery,
      mode: "ArtList",
      maxrecords: String(this.config.gdeltMaxRecords),
      format: "json",
      sort: "DateDesc"
    });

    const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;

    try {
      this.lastRequestAt = Math.floor(Date.now() / 1000);
      const data = await fetchJson(url, {}, 15000);
      const articles = data.articles || [];
      const lookbackMs = this.config.newsLookbackMin * 60 * 1000;
      const now = Date.now();

      return articles
        .filter((article) => {
          const ts = Date.parse(normalizeDate(article.seendate));
          if (!Number.isFinite(ts)) return true;
          return now - ts <= lookbackMs;
        })
        .slice(0, 40)
        .map((article) => {
          const publishTime = normalizeDate(article.seendate);
          return {
            id: article.url,
            title: article.title || "(untitled)",
            source: article.domain || "gdelt",
            source_type: "gdelt",
            timestamp: new Date().toISOString(),
            publish_time: publishTime,
            url: article.url || "",
            raw_text: [article.title, article.sourcecountry, article.language].filter(Boolean).join(" | ")
          };
        });
    } catch (error) {
      const msg = String(error.message || error);
      if (msg.includes("HTTP 429")) {
        this.rateLimitedUntil = Math.floor(Date.now() / 1000) + this.config.gdelt429CooldownSec;
        logger.warn("gdelt_collect_failed_rate_limited", {
          error: msg,
          cooldown_seconds: this.config.gdelt429CooldownSec
        });
      } else {
        logger.warn("gdelt_collect_failed", { error: msg });
      }
      return [];
    }
  }
}
