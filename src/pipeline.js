import { CollectorHub } from "./collectors/index.js";
import { AiAnalyzer } from "./analyzer/aiAnalyzer.js";
import { MarketModule } from "./market/index.js";
import { RiskEngine } from "./riskEngine.js";
import { TelegramNotifier } from "./notifier/telegram.js";
import { logger } from "./logger.js";
import { readLines } from "./utils.js";

function containsKeyword(text, keywords) {
  const lower = String(text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function publishToPushLatencySec(publishTimeIso) {
  const ts = Date.parse(publishTimeIso || "");
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

export class EnginePipeline {
  constructor({ config, db, tradingViewSignalStore }) {
    this.config = config;
    this.db = db;
    this.collectorHub = new CollectorHub(config, db);
    this.analyzer = new AiAnalyzer(config);
    this.marketModule = new MarketModule(config, tradingViewSignalStore);
    this.riskEngine = new RiskEngine(config, db);
    this.notifier = new TelegramNotifier(config);
    this.runtimeStatus = {
      regime: "Neutral",
      regime_probability: 50,
      risk_score: 0,
      market_confirmation: 0,
      updated_at: new Date().toISOString(),
      last_cycle_event_count: 0
    };
    this.isRunning = false;
    this.keywords = readLines(config.keywordsFile).map((k) => k.toLowerCase());
  }

  getRuntimeStatus() {
    return this.runtimeStatus;
  }

  shouldAnalyze(event) {
    if (event.source_type === "x") return true;
    if (this.keywords.length === 0) return true;
    return containsKeyword(`${event.title}\n${event.raw_text}`, this.keywords);
  }

  async processEvent(event, marketSnapshot) {
    const inserted = this.db.insertEventIfNew(event);
    if (!inserted.inserted) return;

    if (!this.shouldAnalyze(event)) {
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: 0,
        push_flag: false,
        push_reason: "keyword_filter_skip"
      });
      return;
    }

    const analysis = await this.analyzer.analyze(event);

    if (!analysis || !analysis._meta?.valid) {
      this.db.markEventLlmInvalid(inserted.eventId);
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: 0,
        push_flag: false,
        push_reason: "llm_invalid"
      });
      return;
    }

    const scoreResult = this.riskEngine.evaluate({
      event,
      analysis,
      marketSnapshot,
      dedupKey: inserted.dedupKey
    });

    this.db.saveScore({
      event_id: inserted.eventId,
      ...scoreResult
    });

    const latencySec = publishToPushLatencySec(event.publish_time);

    let levelToPush = scoreResult.level;
    const degraded = scoreResult.degraded_from_level3;

    if (degraded && levelToPush < 2) {
      levelToPush = 2;
    }

    if (!scoreResult.push_allowed && !degraded) {
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: levelToPush,
        push_flag: false,
        push_reason: scoreResult.push_reason,
        latency_publish_to_push_sec: latencySec,
        payload: {
          event,
          analysis,
          scoreResult,
          marketSnapshot
        }
      });
      return;
    }

    if (levelToPush >= 2) {
      const message = this.notifier.buildMessage({
        level: levelToPush,
        event,
        analysis,
        scoreResult,
        marketSnapshot,
        degraded
      });

      const sendResult = await this.notifier.send({ message });
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: levelToPush,
        push_flag: sendResult.ok,
        push_reason: sendResult.ok ? (degraded ? "degraded_level2_sent" : "sent") : sendResult.reason,
        latency_publish_to_push_sec: latencySec,
        payload: {
          event,
          analysis,
          scoreResult,
          marketSnapshot,
          message
        }
      });
    } else {
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: levelToPush,
        push_flag: false,
        push_reason: "level_below_push_threshold",
        latency_publish_to_push_sec: latencySec,
        payload: {
          event,
          analysis,
          scoreResult,
          marketSnapshot
        }
      });
    }

    this.runtimeStatus = {
      regime: scoreResult.regime,
      regime_probability: scoreResult.regime_probability,
      risk_score: scoreResult.risk_score,
      market_confirmation: scoreResult.market_confirmation,
      updated_at: new Date().toISOString(),
      last_cycle_event_count: this.runtimeStatus.last_cycle_event_count
    };
  }

  async runCycle() {
    try {
      const events = await this.collectorHub.collectAll();
      this.runtimeStatus.last_cycle_event_count = events.length;

      const marketSnapshot = this.config.enableMarketConfirmation
        ? await this.marketModule.getSnapshot()
        : {
            btc_change_1h: null,
            equities_change_1h: null,
            gold_change_1h: null,
            dxy_change_1h: null,
            confirmation_score: 0,
            confirmation_reasons: [],
            is_data_anomaly: false,
            anomaly_reasons: [],
            raw: {}
          };

      this.db.saveMarketSnapshot(marketSnapshot);

      for (const event of events) {
        await this.processEvent(event, marketSnapshot);
      }

      this.db.recordHealth("pipeline", "ok", `events=${events.length}`);
      logger.info("cycle_done", {
        events: events.length,
        confirmation: marketSnapshot.confirmation_score,
        anomaly: marketSnapshot.is_data_anomaly
      });
    } catch (error) {
      this.db.recordHealth("pipeline", "error", String(error.message || error));
      logger.error("cycle_failed", { error: String(error.message || error) });
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.runCycle();
    this.timer = setInterval(() => {
      this.runCycle();
    }, this.config.pollIntervalSec * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
  }
}
