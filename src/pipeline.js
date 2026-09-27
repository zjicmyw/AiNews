import { parseSchedule } from "./businessDelivery.js";
import { CollectorHub } from "./collectors/index.js";
import { AiAnalyzer } from "./analyzer/aiAnalyzer.js";
import { MarketModule } from "./market/index.js";
import { RiskEngine } from "./riskEngine.js";
import { TelegramNotifier } from "./notifier/telegram.js";
import { OpportunityMonitor } from "./opportunityMonitor.js";
import { SecurityIncidentMonitor } from "./securityIncidentMonitor.js";
import { BinanceMajorNewsMonitor } from "./binanceMajorNewsMonitor.js";
import { BinanceMajorNewsMarketMetrics } from "./binanceMajorNewsMarketMetrics.js";
import { HermesClient, describeHermesError } from "./hermesClient.js";
import { logger } from "./logger.js";
import { readLines } from "./utils.js";
import { isExcludedPreTgeTestnetOpportunity } from "./opportunityUtils.js";

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


function publishToPushLatencySec(publishTimeIso) {
  const ts = Date.parse(publishTimeIso || "");
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

function compactLine(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

export class EnginePipeline {
  constructor({ config, db, tradingViewSignalStore }) {
    this.config = config;
    this.db = db;
    this.collectorHub = new CollectorHub(config, db);
    this.analyzer = new AiAnalyzer(config);
    this.marketModule = new MarketModule(config, tradingViewSignalStore);
    this.riskEngine = new RiskEngine(config, db);
    this.notifier = new TelegramNotifier(config, db);
    this.hermesClient = new HermesClient(config, { stateStore: db });
    this.opportunityMonitor = new OpportunityMonitor({ config, db, hermesClient: this.hermesClient });
    this.binanceMajorNewsMonitor = new BinanceMajorNewsMonitor({ config, hermesClient: this.hermesClient });
    this.binanceMajorNewsMarketMetrics = new BinanceMajorNewsMarketMetrics({ config });
    this.securityIncidentMonitor = new SecurityIncidentMonitor({ config, db, notifier: this.notifier, hermesClient: this.hermesClient });
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
    this.suppressKeywords = readLines(config.suppressKeywordsFile).map((k) => k.toLowerCase());
    this.dailySchedule = parseSchedule(config.dailyReportTimeBj);
    this.dailyReportInFlight = false;
    this.opportunityDailySchedule = parseSchedule(config.opportunityDailyReportTimeBj || config.dailyReportTimeBj);
    this.opportunityDailyReportInFlight = false;
    this.binanceMajorNewsCollectionSchedule = parseSchedule(config.binanceMajorNewsCollectionTimeBj || "18:15");
    this.binanceMajorNewsSchedule = parseSchedule(config.binanceMajorNewsDailyTimeBj || "19:01");
    this.binanceMajorNewsCollectionInFlight = false;
    this.binanceMajorNewsInFlight = false;
  }

  getRuntimeStatus() {
    return { ...this.runtimeStatus, hermes: this.hermesClient.getStatus() };
  }

  getOpportunityStatus() {
    return this.opportunityMonitor.getStatus();
  }

  getOpportunityQueryPlan() {
    return this.opportunityMonitor.getQueryPlan();
  }

  getSecurityIncidentStatus() {
    return this.securityIncidentMonitor.getStatus();
  }

  shouldRunNewsCycle() {
    if (!this.config.enableEngineCycle) return false;
    return Boolean(
      this.config.enableRssSource ||
        this.config.enableGdeltSource ||
        this.config.enableXSource ||
        this.config.enableMarketConfirmation
    );
  }

  shouldAnalyze(event) {
    if (event.source_type === "x") return true;
    if (this.keywords.length === 0) return true;
    return containsKeyword(`${event.title}\n${event.raw_text}`, this.keywords);
  }

  shouldSuppress(event) {
    if (this.suppressKeywords.length === 0) return false;
    return containsKeyword(`${event.title}\n${event.raw_text}`, this.suppressKeywords);
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

  buildOpportunityDailyReportMessage(reportDate, items, collectionResult = {}) {
    const rows = (Array.isArray(items) ? items : [])
      .filter((item) => !isExcludedPreTgeTestnetOpportunity(item));
    const launchCount = rows.filter((item) => item.type === "launch").length;
    const preTgeCount = rows.filter((item) => item.type === "pre_tge").length;
    const lines = [
      `【每日打新 / Pre-TGE 日报】${reportDate}（北京时间）`,
      `采集范围：过去 ${this.config.opportunityLookbackHours || 24} 小时 | 打新 ${launchCount} | Pre-TGE ${preTgeCount}`
    ];

    if (collectionResult?.partial) {
      lines.push("采集状态：部分查询成功，请以来源链接为准");
    } else if (collectionResult?.ok !== true) {
      lines.push(`采集状态：异常（${compactLine(describeHermesError(collectionResult.error || collectionResult.reason || "结果未知"), 120)}）`);
    } else {
      lines.push("采集状态：完成");
    }

    if (rows.length === 0) {
      const emptyMessage = collectionResult?.partial
        ? "已完成的查询未发现符合条件的新机会；未完成部分结果未知。"
        : collectionResult?.ok !== true
          ? "采集失败，今日结果未知，不能据此判断没有新机会。"
          : "今日未发现符合条件且仍可参与的新机会。";
      lines.push("", emptyMessage);
      return lines.join("\n");
    }

    rows.forEach((item, index) => {
      const label = item.type === "pre_tge" ? "Pre-TGE" : "打新";
      const venue = item.exchange || item.venue || "未注明平台";
      const deadline = item.deadline_text || item.deadline_at || "截止时间待核验";
      const reward = item.reward || item.expected_yield || "奖励待核验";
      lines.push(
        "",
        `${index + 1}. [${label}] ${compactLine(item.activity_name, 90)}`,
        `平台：${compactLine(venue, 60)} | 截止：${compactLine(deadline, 100)}`,
        `奖励：${compactLine(reward, 140)}`,
        `参与：${compactLine(item.participation || "请查看官方活动说明", 180)}`,
        `来源：${item.official_url || item.source_url || "待核验"}`
      );
    });

    let message = lines.join("\n");
    const maxChars = Math.max(500, Number(this.config.opportunityDailyReportMaxChars || 3500));
    if (message.length > maxChars) message = `${message.slice(0, maxChars - 1)}…`;
    return message;
  }

  reportDeliveryPreflight({ reportKey, kind, chatId }) {
    const result = this.notifier.preflight?.(chatId);
    if (!result || result.ok) return true;
    if (result.status === "failed") this.notifier.recordPreflight?.({
      businessId: `${reportKey}:part:1`, groupId: reportKey, kind, chatId });
    return false;
  }

  async submitDailyReportBatch({ reportKey, kind, reportDate, scheduledTime, messages, chatId, payload }) {
    if (!this.reportDeliveryPreflight({ reportKey, kind, chatId })) return false;
    const frozen = { messages, chatId: chatId || this.config.telegramChatId, payload, scheduledTime };
    if (this.db.claimNotificationBatch) {
      this.db.claimNotificationBatch({ groupId: reportKey, kind, reportDate, scheduledTime,
        expectedParts: messages.length, ...frozen });
      return this.resumeDailyReportBatch(this.db.getNotificationBatch(reportKey));
    }
    return this.resumeDailyReportBatch({ group_id: reportKey, kind, payload_json: JSON.stringify(frozen) });
  }

  async resumeDailyReportBatch(batch) {
    if (!batch?.payload_json) return false;
    if (this.db.hasDailyReportSent?.(batch.group_id)) return true;
    const frozen = JSON.parse(batch.payload_json);
    if (!this.reportDeliveryPreflight({ reportKey: batch.group_id, kind: batch.kind, chatId: frozen.chatId })) return false;
    for (const [index, message] of frozen.messages.entries()) {
      const result = await this.notifier.send({ message, chatId: frozen.chatId,
        businessId: `${batch.group_id}:part:${index + 1}`, groupId: batch.group_id, kind: batch.kind });
      // Unknown/failed submissions stop here. Already queued/sent segments are reused, never posted again.
      if (!result.ok) return false;
    }
    this.db.saveDailyReport?.({ reportDate: batch.group_id, timezone: BJ_TIMEZONE,
      scheduledTime: frozen.scheduledTime, payload: frozen.payload });
    return true;
  }

  async resumePendingDailyReports() {
    if (this.resumingDailyReports) return;
    this.resumingDailyReports = true;
    try {
      const enabled = { opportunity_daily: this.config.opportunityDailyReportEnabled,
        binance_major_daily: this.config.binanceMajorNewsEnabled, risk_daily: this.config.dailyReportEnabled };
      for (const batch of this.db.getNotificationBatchesToResume?.() || []) {
        if (enabled[batch.kind]) await this.resumeDailyReportBatch(batch);
      }
    } finally { this.resumingDailyReports = false; }
  }

  async maybeSendOpportunityDailyReport(trigger = "timer") {
    if (!this.config.opportunityDailyReportEnabled || this.opportunityDailyReportInFlight) return;
    this.opportunityDailyReportInFlight = true;

    try {
      const now = new Date();
      const bj = getTimeParts(now, BJ_TIMEZONE);
      const shouldSendNow =
        bj.hour > this.opportunityDailySchedule.hour ||
        (bj.hour === this.opportunityDailySchedule.hour && bj.minute >= this.opportunityDailySchedule.minute);
      if (!shouldSendNow) return;

      const dateKey = beijingDateKey(now);
      const reportKey = `opportunity:${dateKey}`;
      if (this.db.hasDailyReportSent?.(reportKey)) return;
      const priorBatch = this.db.getNotificationBatch?.(reportKey);
      if (priorBatch) { await this.resumeDailyReportBatch(priorBatch); return; }
      if (!this.reportDeliveryPreflight({ reportKey: reportKey, kind: "opportunity_daily", chatId: this.config.opportunityDailyReportChatId || this.config.dailyReportChatId })) return;

      const startIso = beijingDayStartUtcIso(dateKey);
      const endIso = now.toISOString();
      const priorRun = this.db.getOpportunityRunSince?.(startIso, endIso);
      if (this.opportunityMonitor.isRunning) return;
      let collectionResult;
      if (priorRun) {
        collectionResult = { ok: priorRun.status === "ok", partial: priorRun.status === "partial",
          run_id: priorRun.id, error: priorRun.error || (priorRun.status === "running" ? "previous_run_interrupted" : ""),
          job_stats: priorRun.job_stats || [] };
      } else if (!this.db.hasOpportunityRunSince?.(startIso, endIso)) {
        collectionResult = await this.opportunityMonitor.runOnce("daily_report");
      } else {
        collectionResult = { ok: false, error: "collection_status_unavailable" };
      }
      if (collectionResult?.reason === "already_running") return;

      const collectionTypes = Array.isArray(this.config.opportunityCollectionTypes)
        ? this.config.opportunityCollectionTypes
        : ["launch", "pre_tge"];
      const storedItems = this.db.getOpportunitiesSeenSince?.(
        startIso,
        new Date().toISOString(),
        collectionTypes,
        this.config.opportunityDailyReportMaxItems
      ) || [];
      const items = storedItems.filter((item) => !isExcludedPreTgeTestnetOpportunity(item));
      const message = this.buildOpportunityDailyReportMessage(dateKey, items, collectionResult);
      if (!await this.submitDailyReportBatch({ reportKey, kind: "opportunity_daily", reportDate: dateKey,
        scheduledTime: this.opportunityDailySchedule.text, messages: [message],
        chatId: this.config.opportunityDailyReportChatId || this.config.dailyReportChatId,
        payload: { mode: "launch_pre_tge", collection_result: collectionResult, item_count: items.length, types: collectionTypes } })) return;
      logger.info("opportunity_daily_report_accepted", {
        trigger,
        date: dateKey,
        items: items.length,
        launch: items.filter((item) => item.type === "launch").length,
        pre_tge: items.filter((item) => item.type === "pre_tge").length
      });
    } catch (error) {
      logger.warn("opportunity_daily_report_failed", { trigger, error: String(error.message || error) });
    } finally {
      this.opportunityDailyReportInFlight = false;
    }
  }

  buildBinanceMajorNewsMessages(reportDate, result) {
    const nowMs = Date.now();
    const recent = (result.items || []).filter((item) => nowMs - Date.parse(item.published_at) <= 48 * 60 * 60 * 1000);
    const fallback = (result.items || []).filter((item) => nowMs - Date.parse(item.published_at) > 48 * 60 * 60 * 1000);
    const statusText = result.status === "ok" ? "完成" : result.status === "partial" ? "部分批次异常" : "异常";
    const header = [
      `【Binance 已上线代币重大消息日报】${reportDate}（北京时间）`,
      `覆盖：${result.universeCount || 0} 个项目代币 | 采集状态：${statusText}`
    ];
    const blocks = [];

    if (result.status === "error") {
      blocks.push(`采集失败：${compactLine(describeHermesError(result.error || "未知错误"), 220)}`);
    } else if (recent.length === 0) {
      const noVerifiedSearch = result.status === "partial" && result.diagnostics?.length > 0
        && result.diagnostics.every((batch) => batch.searched_symbols === 0 && batch.error === "source_identity_unverified");
      blocks.push(noVerifiedSearch ? "来源尚未核验，本轮未执行付费搜索，重大消息结果未知。"
        : result.status === "partial" ? "已完成部分未发现可核验重大消息；未覆盖或来源未核验部分结果未知。" : "今日无重大消息（近 2 天）");
    } else {
      blocks.push(`近 2 天重大消息：${recent.length} 条`);
    }

    const marketCapText = (value) => {
      if (value === null || value === undefined || String(value).trim() === "") return "暂无可靠数据";
      const number = Number(value);
      if (!Number.isFinite(number)) return "暂无可靠数据";
      if (number >= 100000000) return `约 ${(number / 100000000).toFixed(2)} 亿美元`;
      if (number >= 10000) return `约 ${(number / 10000).toFixed(2)} 万美元`;
      return `约 ${number.toFixed(0)} 美元`;
    };
    const changeText = (value) => {
      if (value === null || value === undefined || String(value).trim() === "") return "暂无可靠数据";
      const number = Number(value);
      if (!Number.isFinite(number)) return "暂无可靠数据";
      return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
    };
    const priceText = (value) => {
      if (value === null || value === undefined || String(value).trim() === "") return "暂无可靠数据";
      const number = Number(value);
      if (!Number.isFinite(number)) return "暂无可靠数据";
      if (number >= 1000) return `$${number.toFixed(2)}`;
      if (number >= 1) return `$${number.toFixed(4)}`;
      if (number >= 0.01) return `$${number.toFixed(6)}`;
      return `$${number.toFixed(8)}`;
    };
    const formatItem = (item, index) => [
      `${index + 1}. ${item.token_name}/${item.symbol}`,
      `综合评分：${item.score}/10`,
      `消息核心内容：${item.summary_zh}`,
      ...(item.category === "acquisition" ? [
        `并购阶段：${({ signed: "已签约，尚未交割", completed: "已完成", terminated: "已终止" })[item.acquisition_status] || "未知"}`,
        "注意：公司或资产并购不等于代币兑付、换币或持有人权益承诺，具体以官方披露为准。"
      ] : []),
      `流通市值：${marketCapText(item.circulating_market_cap_usd)} | 当前价：${priceText(item.current_price_usd)} | 24h 涨跌幅：${changeText(item.price_change_percentage_24h)}`,
      `发布时间：${new Date(item.published_at).toLocaleString("zh-CN", { timeZone: BJ_TIMEZONE, hour12: false })}（北京时间）`,
      `来源账号：${item.source_account} | ${item.source_url}`
    ].join("\n");

    recent.forEach((item, index) => blocks.push(formatItem(item, index)));
    if (fallback.length > 0) {
      blocks.push(`近 3-5 天补充：${fallback.length} 条`);
      fallback.forEach((item, index) => blocks.push(formatItem(item, recent.length + index)));
    }
    if (result.status === "partial") {
      const failed = (result.diagnostics || []).filter((item) => item.status !== "ok").length;
      blocks.push(`注：${failed} 个检索批次异常，本期结果不代表完整覆盖。`);
    }

    const maxChars = Math.max(1000, Number(this.config.binanceMajorNewsMessageMaxChars || 3800));
    const messages = [];
    let current = header.join("\n");
    for (const block of blocks) {
      const candidate = `${current}\n\n${block}`;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        messages.push(current);
        current = `${header[0]}（续）\n\n${block}`;
      }
    }
    if (current) messages.push(current);
    return messages;
  }

  async maybeCollectBinanceMajorNewsDaily(trigger = "timer") {
    if (!this.config.binanceMajorNewsEnabled || this.binanceMajorNewsCollectionInFlight) return null;
    const now = new Date();
    const bj = getTimeParts(now, BJ_TIMEZONE);
    const due =
      bj.hour > this.binanceMajorNewsCollectionSchedule.hour ||
      (bj.hour === this.binanceMajorNewsCollectionSchedule.hour && bj.minute >= this.binanceMajorNewsCollectionSchedule.minute);
    if (!due) return null;

    const dateKey = beijingDateKey(now);
    const stored = this.db.getBinanceMajorNewsRun?.(dateKey);
    if (stored?.finished_at && ["ok", "partial", "error"].includes(stored.status)) return stored;

    this.binanceMajorNewsCollectionInFlight = true;
    try {
      this.db.startBinanceMajorNewsRun?.(dateKey);
      let result;
      try {
        result = await this.binanceMajorNewsMonitor.run();
      } catch (error) {
        result = {
          status: "error",
          universeCount: 0,
          items: [],
          diagnostics: [],
          error: String(error?.message || error)
        };
      }
      this.db.finishBinanceMajorNewsRun?.(dateKey, result);
      logger.info("binance_major_news_collection_done", {
        trigger,
        date: dateKey,
        status: result.status,
        universe: result.universeCount,
        items: result.items.length
      });
      return this.db.getBinanceMajorNewsRun?.(dateKey) || null;
    } finally {
      this.binanceMajorNewsCollectionInFlight = false;
    }
  }

  async maybeSendBinanceMajorNewsDailyReport(trigger = "timer") {
    if (!this.config.binanceMajorNewsEnabled || this.binanceMajorNewsInFlight) return;
    this.binanceMajorNewsInFlight = true;
    try {
      const now = new Date();
      const bj = getTimeParts(now, BJ_TIMEZONE);
      const due =
        bj.hour > this.binanceMajorNewsSchedule.hour ||
        (bj.hour === this.binanceMajorNewsSchedule.hour && bj.minute >= this.binanceMajorNewsSchedule.minute);
      if (!due) return;

      const dateKey = beijingDateKey(now);
      const reportKey = `binance-major-news:${dateKey}`;
      if (this.db.hasDailyReportSent?.(reportKey)) return;
      const priorBatch = this.db.getNotificationBatch?.(reportKey);
      if (priorBatch) { await this.resumeDailyReportBatch(priorBatch); return; }
      if (!this.reportDeliveryPreflight({ reportKey: reportKey, kind: "binance_major_daily", chatId: this.config.binanceMajorNewsDailyChatId || this.config.dailyReportChatId })) return;

      let stored = this.db.getBinanceMajorNewsRun?.(dateKey);
      if (!stored?.finished_at) stored = await this.maybeCollectBinanceMajorNewsDaily(trigger);
      if (!stored?.finished_at) return;
      const result = {
        status: stored.status,
        universeCount: stored.universe_count,
        items: stored.findings,
        diagnostics: stored.diagnostics,
        error: stored.error
      };
      result.items = await this.binanceMajorNewsMarketMetrics.enrich(result.items);

      const messages = this.buildBinanceMajorNewsMessages(dateKey, result);
      if (!await this.submitDailyReportBatch({ reportKey, kind: "binance_major_daily", reportDate: dateKey,
        scheduledTime: this.binanceMajorNewsSchedule.text, messages,
        chatId: this.config.binanceMajorNewsDailyChatId || this.config.dailyReportChatId,
        payload: { status: result.status, universe_count: result.universeCount, item_count: result.items.length } })) return;
      logger.info("binance_major_news_report_accepted", {
        trigger,
        date: dateKey,
        status: result.status,
        universe: result.universeCount,
        items: result.items.length
      });
    } catch (error) {
      logger.warn("binance_major_news_report_failed", { trigger, error: String(error?.message || error) });
    } finally {
      this.binanceMajorNewsInFlight = false;
    }
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
      const priorBatch = this.db.getNotificationBatch?.(dateKey);
      if (priorBatch) { await this.resumeDailyReportBatch(priorBatch); return; }
      if (!this.reportDeliveryPreflight({ reportKey: dateKey, kind: "risk_daily", chatId: this.config.dailyReportChatId })) return;

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

      if (!await this.submitDailyReportBatch({ reportKey: dateKey, kind: "risk_daily", reportDate: dateKey,
        scheduledTime: this.dailySchedule.text, messages: [message], chatId: this.config.dailyReportChatId, payload })) return;
      logger.info("daily_report_accepted", {
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

    if (this.shouldSuppress(event)) {
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: 0,
        push_flag: false,
        push_reason: "suppress_keyword_skip",
        payload: {
          event,
          suppress_keywords: this.suppressKeywords
        }
      });
      return;
    }

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

    if (!scoreResult.push_allowed) {
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

      const sendResult = await this.notifier.send({ message, businessId: `risk:${inserted.eventId}`, kind: "risk_event" });
      this.db.insertPushLog({
        event_id: inserted.eventId,
        dedup_key: inserted.dedupKey,
        level: levelToPush,
        push_flag: sendResult.ok,
        push_reason: sendResult.status === "sent" ? (degraded ? "degraded_level2_sent" : "sent") : (sendResult.status || sendResult.reason),
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

  async runDailyTick(trigger) {
    if (this.dailyTickRunning) return;
    this.dailyTickRunning = true;
    try {
      await this.notifier.reconcilePending?.();
      await this.resumePendingDailyReports();
      const results = await Promise.allSettled([
        this.maybeCollectBinanceMajorNewsDaily(trigger),
        this.maybeSendBinanceMajorNewsDailyReport(trigger),
        this.maybeSendOpportunityDailyReport(trigger),
        this.maybeSendDailyReport(trigger)
      ]);
      for (const result of results) {
        if (result.status === "rejected") logger.warn("daily_tick_failed", { error: String(result.reason?.message || result.reason) });
      }
    } catch (error) {
      logger.warn("daily_tick_failed", { error: String(error?.message || error) });
    } finally {
      this.dailyTickRunning = false;
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.securityIncidentMonitor.start();
    if (this.config.opportunityScheduleMode === "interval") this.opportunityMonitor.start();
    const newsCycleEnabled = this.shouldRunNewsCycle();
    if (!newsCycleEnabled) {
      this.db.recordHealth("pipeline", "ok", "news_cycle_disabled");
      logger.info("news_cycle_disabled");
    }
    if (newsCycleEnabled) {
      this.timer = setInterval(() => {
        this.runCycle();
      }, this.config.pollIntervalSec * 1000);
    }

    this.dailyReportTimer = setInterval(() => this.runDailyTick("timer"), Math.max(10, this.config.dailyReportCheckIntervalSec || 30) * 1000);
    await Promise.allSettled([newsCycleEnabled ? this.runCycle() : null, this.runDailyTick("startup")]);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.dailyReportTimer) clearInterval(this.dailyReportTimer);
    this.opportunityMonitor.stop();
    this.securityIncidentMonitor.stop();
    this.binanceMajorNewsMarketMetrics.close().catch((error) => {
      logger.warn("binance_major_news_market_metrics_close_failed", { error: String(error?.message || error) });
    });
    this.isRunning = false;
  }
}
