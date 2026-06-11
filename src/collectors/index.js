import { RssCollector } from "./rssCollector.js";
import { GdeltCollector } from "./gdeltCollector.js";
import { XCollector } from "./xCollector.js";
import { logger } from "../logger.js";

function getCollectorName(collector) {
  if (collector?.name) return collector.name;
  return String(collector?.constructor?.name || "unknown")
    .replace(/Collector$/i, "")
    .toLowerCase();
}

export class CollectorHub {
  constructor(config, db) {
    this.db = db;
    this.collectors = [new RssCollector(config), new GdeltCollector(config), new XCollector(config, db)];
  }

  async collectAll() {
    const results = await Promise.allSettled(this.collectors.map((collector) => collector.collect()));
    const events = [];

    results.forEach((result, index) => {
      const collector = this.collectors[index];
      if (result.status === "fulfilled") {
        events.push(...(Array.isArray(result.value) ? result.value : []));
        return;
      }

      const collectorName = getCollectorName(collector);
      const detail = String(result.reason?.message || result.reason);
      this.db?.recordHealth?.(`collector.${collectorName}`, "error", detail);
      logger.warn("collector_collect_failed", { collector: collectorName, error: detail });
    });

    return events;
  }
}
