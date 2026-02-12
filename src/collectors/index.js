import { RssCollector } from "./rssCollector.js";
import { GdeltCollector } from "./gdeltCollector.js";
import { XCollector } from "./xCollector.js";

export class CollectorHub {
  constructor(config, db) {
    this.collectors = [new RssCollector(config), new GdeltCollector(config), new XCollector(config, db)];
  }

  async collectAll() {
    const all = await Promise.all(this.collectors.map((collector) => collector.collect()));
    return all.flat();
  }
}
