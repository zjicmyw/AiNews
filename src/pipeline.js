import { CollectorHub } from "./collectors/index.js";
import { AiAnalyzer } from "./analyzer/aiAnalyzer.js";
import { MarketModule } from "./market/index.js";
import { RiskEngine } from "./riskEngine.js";
import { TelegramNotifier } from "./notifier/telegram.js";
import { logger } from "./logger.js";
import { readLines } from "./utils.js";

const BJ_TIMEZONE = "Asia/Shanghai";

function containsKeyword(text, keywords) {
  const lower = String(text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function getTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    year: Number.parseInt(pick("year"), 10),
    month: Number.parseInt(pick("month"), 10),
    day: Number.parseInt(pick("day"), 10),
    hour: Number.parseInt(pick("hour"), 10),
    minute: Number.parseInt(pick("minute"), 10)
  };
}

function beijingDateKey(date = new Date()) {
  const { year, month, day } = getTimeParts(date, BJ_TIMEZONE);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function beijingDayStartUtcIso(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map((v) => Number.parseInt(v, 10));
  const ms = Date.UTC(year, month - 1, day, 0, 0, 0) - 8 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function parseSchedule(value) {
  const matched = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return { hour: 16, minute: 43, text: "16:43" };
  const hour = Math.min(23, Math.max(0, Number.parseInt(matched[1], 10)));
  const minute = Math.min(59, Math.max(0, Number.parseInt(matched[2], 10)));
  return { hour, minute, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
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
    this.dailySchedule = parseSchedule(config.dailyReportTimeBj);
    this.dailyReportInFlight = false;
  }

  getRuntimeStatus() {
    return this.runtimeStatus;
  }

  shouldAnalyze(event) {
    if (event.source_type === "x") return true;
    if (this.keywords.length === 0) return true;
    return containsKeyword(`${event.title}\n${event.raw_text}`, this.keywords);
  }

  buildDailyReportFallbackMessage(reportDate, summary) {
    const bins = summary.score_bins || {};
    const sources = (summary.sources || [])
      .slice(0, 3)
      .map((item) => `${item.source_type}:${item.count}`)
      .join(" | ");
    const blocked = (summary.blocked_reasons || [])
      .slice(0, 3)
      .map((item) => `${item.push_reason}:${item.count}`)
      .join(" | ");
    const topEvent = summary.top_event
      ? `${summary.top_event.risk_score.toFixed(2)} 分 | ${summary.top_event.title}`
      : "无";

    return [
      `【每日日报】${reportDate}（北京时间）`,
      "统计区间：00:00 - 当前",
      `总消息: ${summary.stats.total_events} | 已评分: ${summary.stats.scored_events} | 已推送: ${summary.stats.pushed_ok}`,
      "",
      "评分区间分布：",
      `0-20: ${bins["0-20"] || 0}`,
      `20-40: ${bins["20-40"] || 0}`,
      `40-50: ${bins["40-50"] || 0}`,
      `50-60: ${bins["50-60"] || 0}`,
      `60-70: ${bins["60-70"] || 0}`,
      `70-80: ${bins["70-80"] || 0}`,
      `80-100: ${bins["80-100"] || 0}`,
      "",
      "今日精简总结：",
      `来源分布TOP: ${sources || "无"}`,
      `阻塞原因TOP: ${blocked || "无"}`,
      `今日最高分: ${topEvent}`
    ].join("\n");
  }

  buildLightDailyReportMessage(reportDate, dailyInput, aiSummary) {
    const stats = dailyInput.stats || {};
    const topEvent = dailyInput.top_event ? `${dailyInput.top_event.risk_score.toFixed(2)} 分 | ${dailyInput.top_event.title}` : "无";
    const keyRisks = (aiSummary.key_risks || []).slice(0, 3);
    let assetOutlook = (aiSummary.asset_outlook || []).slice(0, 3);
    let riskWatch = (aiSummary.risk_watch || []).slice(0, 2);

    const build = () => {
      const lines = [];
      lines.push(`【每日轻量总结】${reportDate}（北京时间）`);
      lines.push("统计区间：当日 00:00 - 当前");
      lines.push(`总消息: ${stats.total_events || 0} | 已评分: ${stats.scored_events || 0} | 已推送: ${stats.pushed_ok || 0}`);
      lines.push("");
      lines.push(`概览: ${aiSummary.summary_title}`);
      lines.push(`Regime: ${aiSummary.regime_summary}`);
      lines.push("");
      lines.push("核心风险：");
      for (const item of keyRisks) {
        lines.push(`- ${item}`);
      }
      lines.push("");
      lines.push("资产建议：");
      for (const item of assetOutlook) {
        lines.push(`· ${item.asset} — ${item.action}：${item.rationale}`);
      }
      lines.push("");
      lines.push("后续关注：");
      for (const item of riskWatch) {
        lines.push(`- ${item}`);
      }
      lines.push("");
      lines.push(`综合判断: ${aiSummary.overall_assessment}`);
      lines.push(`今日最高分: ${topEvent}`);
      return lines.join("\n");
    };

    let message = build();
    while (message.length > this.config.dailyReportMessageMaxChars && assetOutlook.length > 1) {
      assetOutlook = assetOutlook.slice(0, -1);
      message = build();
    }
    while (message.length > this.config.dailyReportMessageMaxChars && riskWatch.length > 1) {
      riskWatch = riskWatch.slice(0, -1);
      message = build();
    }
    if (message.length > this.config.dailyReportMessageMaxChars) {
      message = `${message.slice(0, this.config.dailyReportMessageMaxChars - 1)}…`;
    }
    return message;
  }

  async maybeSendDailyReport(trigger = "timer") {
    if (!this.config.dailyReportEnabled || this.dailyReportInFlight) return;
    this.dailyReportInFlight = true;

    try {
      const now = new Date();
      const bj = getTimeParts(now, BJ_TIMEZONE);
      const shouldSendNow =
        bj.hour > this.dailySchedule.hour ||
        (bj.hour === this.dailySchedule.hour && bj.minute >= this.dailySchedule.minute);

      if (!shouldSendNow) return;

      const dateKey = beijingDateKey(now);
      if (this.db.hasDailyReportSent(dateKey)) return;

      const startIso = beijingDayStartUtcIso(dateKey);
      const endIso = now.toISOString();
      const dailyInput = this.db.getDailySummaryInput(startIso, endIso, this.config.dailyReportMaxEvents);
      let message;
      let payload;

      try {
        const aiSummary = await this.analyzer.generateDailySummary({ ...dailyInput, report_date: dateKey });
        message = this.buildLightDailyReportMessage(dateKey, dailyInput, aiSummary);
        payload = {
          mode: "ai_light_summary",
          summary: aiSummary,
          stats: dailyInput.stats,
          event_count: (dailyInput.events || []).length
        };
      } catch (error) {
        logger.warn("daily_report_ai_failed", {
          trigger,
          date: dateKey,
          error: String(error.message || error)
        });
        message = this.buildDailyReportFallbackMessage(dateKey, dailyInput);
        payload = {
          mode: "fallback_stats",
          stats: dailyInput.stats,
          reason: String(error.message || error)
        };
      }

      const sendResult = await this.notifier.send({ message });

      if (!sendResult.ok) {
        logger.warn("daily_report_send_failed", { trigger, dateKey, reason: sendResult.reason });
        return;
      }

      this.db.saveDailyReport({
        reportDate: dateKey,
        timezone: BJ_TIMEZONE,
        scheduledTime: this.dailySchedule.text,
        payload
      });
      logger.info("daily_report_sent", {
        trigger,
        date: dateKey,
        total_events: dailyInput.stats.total_events,
        scored_events: dailyInput.stats.scored_events,
        pushed_ok: dailyInput.stats.pushed_ok,
        mode: payload.mode
      });
    } catch (error) {
      logger.warn("daily_report_failed", { trigger, error: String(error.message || error) });
    } finally {
      this.dailyReportInFlight = false;
    }
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
    await this.maybeSendDailyReport("startup");

    this.timer = setInterval(() => {
      this.runCycle();
    }, this.config.pollIntervalSec * 1000);

    this.dailyReportTimer = setInterval(() => {
      this.maybeSendDailyReport("timer");
    }, Math.max(10, this.config.dailyReportCheckIntervalSec) * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.dailyReportTimer) clearInterval(this.dailyReportTimer);
    this.isRunning = false;
  }
}
