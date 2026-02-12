import { z } from "zod";
import { fetchJson } from "../http.js";
import { logger } from "../logger.js";

const analyzerSchema = z.object({
  event_type: z.string().default("macro"),
  news_severity: z.number().min(0).max(100),
  asset_relevance: z.number().min(0).max(100),
  assets: z.array(z.string()).default([]),
  direction_hint: z.record(z.string()).optional().default({}),
  time_horizon: z.string().default("short"),
  reasons: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([])
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

function normalizeReasons(reasons) {
  const out = Array.isArray(reasons) ? reasons.slice(0, 3) : [];
  while (out.length < 3) out.push("信息仍在演化，需继续跟踪");
  return out;
}

function heuristicAnalyze(event) {
  const content = `${event.title}\n${event.raw_text}`.toLowerCase();
  const severeHits = ["invasion", "war", "sanction", "embargo", "missile", "attack", "emergency", "tariff"].filter((k) =>
    content.includes(k)
  ).length;
  const policyHits = ["fed", "ecb", "rate", "central bank", "inflation", "liquidity"].filter((k) =>
    content.includes(k)
  ).length;
  const newsSeverity = Math.min(100, 40 + severeHits * 15 + policyHits * 8);
  const assetRelevance = Math.min(100, 45 + severeHits * 10 + policyHits * 10);
  const reasons = [];
  if (severeHits > 0) reasons.push("检测到地缘或制裁相关高风险词");
  if (policyHits > 0) reasons.push("检测到流动性或政策相关词");
  if (reasons.length === 0) reasons.push("事件可能影响风险偏好，但证据有限");

  return {
    event_type: severeHits > 0 ? "geopolitical" : "macro_policy",
    news_severity: newsSeverity,
    asset_relevance: assetRelevance,
    assets: ["BTC", "ALT"],
    direction_hint: { crypto: "risk_off_bias" },
    time_horizon: "intraday_to_3d",
    reasons: normalizeReasons(reasons),
    unknowns: []
  };
}

function buildPrompt(event) {
  const schemaHint = `{
  "event_type": "string",
  "news_severity": 0-100,
  "asset_relevance": 0-100,
  "assets": ["string"],
  "direction_hint": {"asset":"direction"},
  "time_horizon": "string",
  "reasons": ["string","string","string"],
  "unknowns": ["string"]
}`;

  return [
    "你是风险新闻结构化分析器。",
    "只输出严格 JSON，不要 Markdown，不要解释，不要多余字段。",
    "目标：评估事件对 Crypto 市场风险偏好转向的影响。",
    "字段要求：",
    schemaHint,
    "评分范围 news_severity/asset_relevance 必须在 0-100。",
    "输入事件：",
    JSON.stringify(event)
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
  }

  parseAndValidate(text) {
    const parsedRaw = extractJson(text);
    const obj = JSON.parse(parsedRaw);
    const parsed = analyzerSchema.parse(obj);
    return {
      ...parsed,
      reasons: normalizeReasons(parsed.reasons)
    };
  }

  async analyzeWithGemini(event) {
    const prompt = buildPrompt(event);
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

    const text = response?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
    return this.parseAndValidate(text);
  }

  async analyzeWithGrok(event) {
    const prompt = buildPrompt(event);
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
              content: "你是风险新闻结构化分析器，只允许输出 JSON。"
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

    const text = response?.choices?.[0]?.message?.content || "";
    return this.parseAndValidate(text);
  }

  async analyze(event) {
    if (this.config.aiDisable || !this.providerConfig.apiKey) {
      return { ...heuristicAnalyze(event), _meta: { mode: "heuristic", valid: true } };
    }

    try {
      const parsed =
        this.providerConfig.provider === "grok"
          ? await this.analyzeWithGrok(event)
          : await this.analyzeWithGemini(event);

      return {
        ...parsed,
        _meta: { mode: this.providerConfig.provider, valid: true, model: this.providerConfig.model }
      };
    } catch (error) {
      logger.warn("ai_analyze_failed", {
        provider: this.providerConfig.provider,
        model: this.providerConfig.model,
        error: String(error.message || error)
      });

      return {
        ...heuristicAnalyze(event),
        _meta: { mode: `${this.providerConfig.provider}_fallback_heuristic`, valid: true }
      };
    }
  }
}
