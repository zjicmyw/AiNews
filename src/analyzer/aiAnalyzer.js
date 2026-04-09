import { z } from "zod";
import { fetchJson } from "../http.js";
import { logger } from "../logger.js";

const ACTION_ENUM = ["买入", "卖出", "减仓", "加仓", "持有", "观望"];
const CONFIDENCE_ENUM = ["high", "medium", "low"];
const DEFAULT_REASON = "信息仍在演化，需继续跟踪";
const STRONG_SIGNAL_KEYWORDS = [
  "invasion",
  "war",
  "sanction",
  "embargo",
  "missile",
  "attack",
  "tariff",
  "ceasefire",
  "military",
  "fed",
  "ecb",
  "rate hike",
  "central bank",
  "inflation",
  "liquidity",
  "加息",
  "降息",
  "停火",
  "制裁",
  "袭击",
  "关税",
  "通胀",
  "央行"
];

const analyzerSchema = z.object({
  event_type: z.string().default("macro"),
  title_zh: z.string().default(""),
  news_severity: z.number().min(0).max(100),
  asset_relevance: z.number().min(0).max(100),
  reasons: z.array(z.string()).default([]),
  asset_actions: z
    .array(
      z.object({
        asset: z.string().default("BTC"),
        action: z.string().default("观望"),
        confidence: z.string().default("medium"),
        rationale: z.string().default("")
      })
    )
    .default([])
});

const dailySummarySchema = z.object({
  summary_title: z.string().default("当日风险态势轻量总结"),
  regime_summary: z.string().default("当前风险状态整体平稳，需持续跟踪变化。"),
  key_risks: z.array(z.string()).default([]),
  asset_outlook: z
    .array(
      z.object({
        asset: z.string().default("BTC"),
        action: z.string().default("观望"),
        rationale: z.string().default("信息有限，建议保持谨慎。")
      })
    )
    .default([]),
  risk_watch: z.array(z.string()).default([]),
  overall_assessment: z.string().default("当前市场以区间波动为主。")
});

function extractJson(raw) {
  const text = String(raw || "").trim();
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function compactText(value, maxLen) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!maxLen || text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function sanitizeAssetName(value) {
  const text = compactText(value, 16);
  return text || "BTC";
}

function containsSignal(content, keyword) {
  const body = String(content || "").toLowerCase();
  const word = String(keyword || "").toLowerCase();
  if (!word) return false;
  if (/[\u4e00-\u9fff]/.test(word) || word.includes(" ")) {
    return body.includes(word);
  }
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(body);
}

function countKeywordHits(content, keywords) {
  return keywords.filter((keyword) => containsSignal(content, keyword)).length;
}

function normalizeReasons(reasons) {
  const out = Array.isArray(reasons)
    ? reasons
        .map((item) => compactText(item, 40))
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 2)
    : [];
  while (out.length < 2) out.push(DEFAULT_REASON);
  return out;
}

function normalizeAssetActions(assetActions, fallbackActions = []) {
  const source =
    Array.isArray(assetActions) && assetActions.length > 0 ? assetActions : Array.isArray(fallbackActions) ? fallbackActions : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const asset = sanitizeAssetName(item?.asset);
    const action = ACTION_ENUM.includes(item?.action) ? item.action : "观望";
    const confidence = CONFIDENCE_ENUM.includes(item?.confidence) ? item.confidence : "medium";
    const rationale = compactText(item?.rationale || "信息有限，建议保持谨慎。", 40);
    const key = `${asset}|${action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ asset, action, confidence, rationale });
    if (out.length >= 3) break;
  }
  if (out.length > 0) return out;
  return [
    {
      asset: "BTC",
      action: "观望",
      confidence: "low",
      rationale: "信息有限，建议保持谨慎。"
    }
  ];
}

function buildHeuristicAssetActions({ severeHits, policyHits }) {
  if (severeHits > 0) {
    return [
      { asset: "BTC", action: "减仓", confidence: "high", rationale: "地缘风险抬升，短期波动放大。" },
      { asset: "黄金", action: "加仓", confidence: "medium", rationale: "避险需求可能阶段性上升。" }
    ];
  }
  if (policyHits > 0) {
    return [
      { asset: "BTC", action: "观望", confidence: "medium", rationale: "政策信号未落地，先观察。" },
      { asset: "SPX", action: "观望", confidence: "medium", rationale: "等待宏观数据确认方向。" }
    ];
  }
  return [{ asset: "BTC", action: "观望", confidence: "low", rationale: "证据不足，避免过度交易。" }];
}

function heuristicAnalyze(event) {
  const content = `${event.title}\n${event.raw_text}`.toLowerCase();
  const severeHits = countKeywordHits(content, [
    "invasion",
    "war",
    "sanction",
    "embargo",
    "missile",
    "attack",
    "emergency",
    "tariff"
  ]);
  const policyHits = countKeywordHits(content, ["fed", "ecb", "rate", "central bank", "inflation", "liquidity"]);
  const newsSeverity = Math.min(100, 40 + severeHits * 15 + policyHits * 8);
  const assetRelevance = Math.min(100, 45 + severeHits * 10 + policyHits * 10);
  const reasons = [];
  if (severeHits > 0) reasons.push("检测到地缘或制裁相关高风险词");
  if (policyHits > 0) reasons.push("检测到流动性或政策相关词");
  if (reasons.length === 0) reasons.push("事件可能影响风险偏好，但证据有限");

  return {
    event_type: severeHits > 0 ? "geopolitical" : "macro_policy",
    title_zh: "",
    news_severity: newsSeverity,
    asset_relevance: assetRelevance,
    reasons: normalizeReasons(reasons),
    asset_actions: normalizeAssetActions([], buildHeuristicAssetActions({ severeHits, policyHits }))
  };
}

function buildPrompt(event, maxRawChars = 500) {
  const compactEvent = {
    title: compactText(event?.title, 180),
    source: compactText(event?.source, 80),
    source_type: compactText(event?.source_type, 24),
    publish_time: event?.publish_time || event?.timestamp || "",
    raw_text: compactText(event?.raw_text, maxRawChars)
  };

  const schemaHint = `{
  "event_type": "string",
  "title_zh": "string",
  "news_severity": 0-100,
  "asset_relevance": 0-100,
  "reasons": ["string","string"],
  "asset_actions": [
    {"asset":"string","action":"买入|卖出|减仓|加仓|持有|观望","confidence":"high|medium|low","rationale":"string"}
  ]
}`;

  return [
    "你是风险新闻结构化分析器。",
    "只输出严格 JSON，不要 Markdown，不要解释，不要多余字段。",
    "目标：评估事件对风险偏好的影响，并生成简洁中文输出。",
    "字段要求：",
    schemaHint,
    "要求：title_zh 使用简体中文，不超过 60 字。",
    "要求：reasons 最多 2 条，短句，每条不超过 40 字。",
    "要求：asset_actions 只给最相关资产，1-3 条，不要全资产铺开，不要价格点位。",
    "评分范围 news_severity/asset_relevance 必须在 0-100。",
    "输入事件：",
    JSON.stringify(compactEvent)
  ].join("\n");
}

function buildDailySummaryPrompt(input) {
  const compactInput = {
    report_date: input.report_date,
    report_window: {
      start_iso: input.report_window?.start_iso || "",
      end_iso: input.report_window?.end_iso || ""
    },
    stats: input.stats || {},
    score_bins: input.score_bins || {},
    market_snapshot: {
      confirmation_score: Number(input.market_snapshot?.confirmation_score || 0),
      is_data_anomaly: Boolean(input.market_snapshot?.is_data_anomaly),
      btc_change_1h: input.market_snapshot?.btc_change_1h ?? null,
      equities_change_1h: input.market_snapshot?.equities_change_1h ?? null,
      gold_change_1h: input.market_snapshot?.gold_change_1h ?? null,
      dxy_change_1h: input.market_snapshot?.dxy_change_1h ?? null
    },
    events: (input.events || []).slice(0, 5).map((item) => ({
      title: compactText(item?.title_zh || item?.title, 120),
      source: compactText(item?.source, 60),
      risk_score: Number(item?.risk_score || 0),
      level: Number(item?.level || 0),
      regime: compactText(item?.regime, 24),
      reasons: normalizeReasons(item?.reasons || []),
      asset_actions: normalizeAssetActions(item?.asset_actions || [])
    }))
  };

  const schemaHint = `{
  "summary_title": "string",
  "regime_summary": "string",
  "key_risks": ["string","string","string"],
  "asset_outlook": [{"asset":"string","action":"买入|卖出|减仓|加仓|持有|观望","rationale":"string"}],
  "risk_watch": ["string","string"],
  "overall_assessment": "string"
}`;

  return [
    "你是风控日报生成器，只输出严格 JSON。",
    "这是一份当日轻量总结，不是 7 天历史事件追踪。",
    "禁止输出历史时间线、免责声明、价格点位。",
    "输出字段如下：",
    schemaHint,
    "要求：",
    "1) key_risks 最多 3 条；2) asset_outlook 最多 3 条；3) risk_watch 最多 2 条。",
    "4) 全部使用简体中文，文本简洁。",
    "输入数据：",
    JSON.stringify(compactInput)
  ].join("\n");
}

function pickProviderConfig(config) {
  const provider = String(config.aiProvider || "").toLowerCase();
  if (provider === "grok" || provider === "xai") {
    return {
      provider: "grok",
      apiKey: config.aiApiKey || config.grokApiKey,
      model: config.aiModel || config.grokModel || "grok-3-latest",
      baseUrl: config.aiBaseUrl || "https://api.x.ai"
    };
  }

  return {
    provider: "gemini",
    apiKey: config.aiApiKey || config.geminiApiKey,
    model: config.aiModel || config.geminiModel || "gemini-2.5-flash",
    baseUrl: config.aiBaseUrl || "https://generativelanguage.googleapis.com"
  };
}

export class AiAnalyzer {
  constructor(config) {
    this.config = config;
    this.providerConfig = pickProviderConfig(config);
    this.requestWindowMs = 60 * 1000;
    this.requestTimestamps = [];
    this.providerBlockedUntilMs = 0;
    this.lastRateLimitWarnAtMs = 0;
    this.lastBlockedWarnAtMs = 0;
  }

  pruneRequestWindow(nowMs) {
    const threshold = nowMs - this.requestWindowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < threshold) {
      this.requestTimestamps.shift();
    }
  }

  isOverLocalRateLimit(nowMs) {
    const limit = Number(this.config.aiMaxRequestsPerMin || 0);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    this.pruneRequestWindow(nowMs);
    return this.requestTimestamps.length >= limit;
  }

  markRequest(nowMs) {
    this.pruneRequestWindow(nowMs);
    this.requestTimestamps.push(nowMs);
  }

  isProviderBlocked(nowMs) {
    return nowMs < this.providerBlockedUntilMs;
  }

  maybeWarnOncePerMinute(type, nowMs, meta = {}) {
    const field = type === "blocked" ? "lastBlockedWarnAtMs" : "lastRateLimitWarnAtMs";
    if (nowMs - this[field] < 60 * 1000) return;
    this[field] = nowMs;
    logger.warn(type === "blocked" ? "ai_provider_cooldown_active" : "ai_local_rate_limit_active", meta);
  }

  isAbusive403(errorMessage) {
    const text = String(errorMessage || "").toLowerCase();
    return text.includes("http 403") && text.includes("abusive traffic patterns");
  }

  shouldCallLlm(event, heuristicResult) {
    if (String(event?.source_type || "").toLowerCase() === "x") return true;
    const minScore = Math.max(1, Number(this.config.aiLlmCandidateMinScore || 55));
    if (Number(heuristicResult.news_severity || 0) >= minScore) return true;
    if (Number(heuristicResult.asset_relevance || 0) >= minScore) return true;
    const content = `${event?.title || ""}\n${event?.raw_text || ""}`.toLowerCase();
    return STRONG_SIGNAL_KEYWORDS.some((kw) => containsSignal(content, kw));
  }

  parseEventAnalysis(text, fallbackAnalysis) {
    const parsedRaw = extractJson(text);
    const obj = JSON.parse(parsedRaw);
    const parsed = analyzerSchema.parse(obj);
    return {
      ...parsed,
      title_zh: compactText(parsed.title_zh, 60),
      reasons: normalizeReasons(parsed.reasons),
      asset_actions: normalizeAssetActions(parsed.asset_actions, fallbackAnalysis.asset_actions)
    };
  }

  parseDailySummary(text) {
    const parsedRaw = extractJson(text);
    const obj = JSON.parse(parsedRaw);
    const parsed = dailySummarySchema.parse(obj);
    const keyRisks = Array.isArray(parsed.key_risks)
      ? parsed.key_risks.map((item) => compactText(item, 40)).filter(Boolean).slice(0, 3)
      : [];
    const assetOutlook = Array.isArray(parsed.asset_outlook)
      ? parsed.asset_outlook
          .map((item) => ({
            asset: sanitizeAssetName(item?.asset),
            action: ACTION_ENUM.includes(item?.action) ? item.action : "观望",
            rationale: compactText(item?.rationale || "信息有限，建议保持谨慎。", 40)
          }))
          .slice(0, 3)
      : [];
    const riskWatch = Array.isArray(parsed.risk_watch)
      ? parsed.risk_watch.map((item) => compactText(item, 40)).filter(Boolean).slice(0, 2)
      : [];

    return {
      summary_title: compactText(parsed.summary_title, 36) || "当日风险态势轻量总结",
      regime_summary: compactText(parsed.regime_summary, 120) || "当前风险状态整体平稳，需持续跟踪变化。",
      key_risks: keyRisks.length > 0 ? keyRisks : ["暂无突发高风险事件。"],
      asset_outlook:
        assetOutlook.length > 0
          ? assetOutlook
          : [{ asset: "BTC", action: "观望", rationale: "证据有限，建议保持谨慎。" }],
      risk_watch: riskWatch.length > 0 ? riskWatch : ["关注突发政策与地缘风险信号。"],
      overall_assessment: compactText(parsed.overall_assessment, 120) || "当前市场以区间波动为主。"
    };
  }

  async callGemini(prompt) {
    const endpoint = `${this.providerConfig.baseUrl}/v1beta/models/${encodeURIComponent(
      this.providerConfig.model
    )}:generateContent?key=${encodeURIComponent(this.providerConfig.apiKey)}`;

    const response = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      },
      this.config.aiTimeoutMs
    );

    return response?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
  }

  async callGrok(prompt, systemPrompt) {
    const endpoint = `${this.providerConfig.baseUrl}/v1/chat/completions`;
    const response = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.providerConfig.apiKey}`
        },
        body: JSON.stringify({
          model: this.providerConfig.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: prompt
            }
          ]
        })
      },
      this.config.aiTimeoutMs
    );

    return response?.choices?.[0]?.message?.content || "";
  }

  async analyzeWithGemini(event, fallbackAnalysis) {
    const prompt = buildPrompt(event, this.config.aiEventRawTextMaxChars);
    const text = await this.callGemini(prompt);
    return this.parseEventAnalysis(text, fallbackAnalysis);
  }

  async analyzeWithGrok(event, fallbackAnalysis) {
    const prompt = buildPrompt(event, this.config.aiEventRawTextMaxChars);
    const text = await this.callGrok(prompt, "你是风险新闻结构化分析器，只允许输出 JSON。");
    return this.parseEventAnalysis(text, fallbackAnalysis);
  }

  async analyze(event) {
    const heuristic = heuristicAnalyze(event);
    if (this.config.aiDisable || !this.providerConfig.apiKey) {
      return { ...heuristic, _meta: { mode: "heuristic", valid: true } };
    }

    if (!this.shouldCallLlm(event, heuristic)) {
      return { ...heuristic, _meta: { mode: "heuristic_prefilter", valid: true } };
    }

    const nowMs = Date.now();
    if (this.isProviderBlocked(nowMs)) {
      const remainSec = Math.max(1, Math.ceil((this.providerBlockedUntilMs - nowMs) / 1000));
      this.maybeWarnOncePerMinute("blocked", nowMs, {
        provider: this.providerConfig.provider,
        model: this.providerConfig.model,
        remaining_sec: remainSec
      });
      return {
        ...heuristic,
        _meta: { mode: `${this.providerConfig.provider}_cooldown_heuristic`, valid: true }
      };
    }

    if (this.isOverLocalRateLimit(nowMs)) {
      this.maybeWarnOncePerMinute("rate_limit", nowMs, {
        provider: this.providerConfig.provider,
        model: this.providerConfig.model,
        max_requests_per_min: this.config.aiMaxRequestsPerMin
      });
      return {
        ...heuristic,
        _meta: { mode: `${this.providerConfig.provider}_rate_limited_heuristic`, valid: true }
      };
    }

    this.markRequest(nowMs);

    try {
      const parsed =
        this.providerConfig.provider === "grok"
          ? await this.analyzeWithGrok(event, heuristic)
          : await this.analyzeWithGemini(event, heuristic);

      return {
        ...parsed,
        _meta: { mode: this.providerConfig.provider, valid: true, model: this.providerConfig.model }
      };
    } catch (error) {
      const errorText = String(error.message || error);
      if (this.isAbusive403(errorText)) {
        this.providerBlockedUntilMs = Date.now() + Math.max(60, this.config.aiBlockedCooldownSec || 900) * 1000;
        logger.warn("ai_provider_blocked_cooldown", {
          provider: this.providerConfig.provider,
          model: this.providerConfig.model,
          cooldown_sec: Math.max(60, this.config.aiBlockedCooldownSec || 900)
        });
      }

      logger.warn("ai_analyze_failed", {
        provider: this.providerConfig.provider,
        model: this.providerConfig.model,
        error: errorText.slice(0, 400)
      });

      return {
        ...heuristic,
        _meta: { mode: `${this.providerConfig.provider}_fallback_heuristic`, valid: true }
      };
    }
  }

  async generateDailySummary(dailyInput) {
    if (!dailyInput) throw new Error("daily_input_missing");
    if (this.config.aiDisable || !this.providerConfig.apiKey) {
      throw new Error("daily_summary_ai_disabled");
    }

    const nowMs = Date.now();
    if (this.isProviderBlocked(nowMs)) {
      throw new Error("daily_summary_provider_cooldown");
    }
    if (this.isOverLocalRateLimit(nowMs)) {
      throw new Error("daily_summary_local_rate_limit");
    }
    this.markRequest(nowMs);

    const prompt = buildDailySummaryPrompt(dailyInput);
    try {
      const text =
        this.providerConfig.provider === "grok"
          ? await this.callGrok(prompt, "你是风控日报生成器，只允许输出 JSON。")
          : await this.callGemini(prompt);
      return this.parseDailySummary(text);
    } catch (error) {
      const errorText = String(error.message || error);
      if (this.isAbusive403(errorText)) {
        this.providerBlockedUntilMs = Date.now() + Math.max(60, this.config.aiBlockedCooldownSec || 900) * 1000;
      }
      logger.warn("ai_daily_summary_failed", {
        provider: this.providerConfig.provider,
        model: this.providerConfig.model,
        error: errorText.slice(0, 400)
      });
      throw error;
    }
  }
}
