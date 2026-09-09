import crypto from "node:crypto";
import { TelegramNotifier } from "./notifier/telegram.js";
import { HermesClient } from "./hermesClient.js";
import { logger } from "./logger.js";

const OUTPUT_SCHEMA =
  '{"generated_at":"ISO","incidents":[{"project":"","incident_type":"hack|exploit|theft|private_key_leak|abnormal_withdrawal|bridge_attack|exchange_incident|other","amount_usd":null,"chain_platform":"","source_url":"https://x.com/.../status/...","source_user":"@","source_type":"official|security_researcher|media|kol|unknown","source_published_at":"ISO","confidence":"high|medium|low","summary":""}]}';

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeConfidence(value) {
  const text = cleanText(value).toLowerCase();
  if (["confirmed", "high", "official"].includes(text)) return "high";
  if (["low", "rumor", "unverified"].includes(text)) return "low";
  return "medium";
}

function normalizeSourceType(value) {
  const text = cleanText(value).toLowerCase();
  if (["official", "security_researcher", "media", "kol"].includes(text)) return text;
  if (/official|官方/.test(text)) return "official";
  if (/security|researcher|audit|安全|审计/.test(text)) return "security_researcher";
  if (/media|news|媒体/.test(text)) return "media";
  if (/kol|influencer/.test(text)) return "kol";
  return "unknown";
}

function parseAmountUsd(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;

  const text = cleanText(value).replace(/,/g, "");
  if (!text || /unknown|未知|不明|n\/a/i.test(text)) return null;
  const matched = text.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!matched) return null;
  const base = Number.parseFloat(matched[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  if (/亿/i.test(text)) return base * 100_000_000;
  if (/\b(billion|bn)\b|[0-9](?:\.[0-9]+)?b\b/i.test(text)) return base * 1_000_000_000;
  if (/\b(million|mn)\b|[0-9](?:\.[0-9]+)?m\b|百万/i.test(text)) return base * 1_000_000;
  if (/万/i.test(text)) return base * 10_000;
  if (/\bthousand\b|[0-9](?:\.[0-9]+)?k\b|千/i.test(text)) return base * 1_000;
  return base;
}

function highestAlertLevel(a, b) {
  const rank = { watch: 0, anomaly: 1, critical: 2 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

function extractJson(raw) {
  const text = cleanText(raw).replace(/^\uFEFF/, "");
  if (!text) return { ok: false, error: "empty_response" };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    const start = candidate.search(/[\[{]/);
    if (start < 0) return { ok: false, error: "invalid_json" };
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return { ok: true, value: JSON.parse(candidate.slice(start, i + 1)) };
          } catch {
            return { ok: false, error: "invalid_json" };
          }
        }
      }
    }
    return { ok: false, error: "invalid_json" };
  }
}

function buildDedupKey(item) {
  const source = cleanText(item.source_url).toLowerCase();
  const raw = source || [item.project, item.incident_type, item.source_published_at].map((part) => cleanText(part).toLowerCase()).join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function classifySecurityIncident(item, config = {}) {
  const score = Number(item?.evidence_score || 0);
  const threshold = Number(config.securityIncidentLargeUsd || 5_000_000);
  const isLarge = Number.isFinite(item?.amount_usd) && item.amount_usd >= threshold;
  if (isLarge && score >= 70) return "critical";
  if (score >= 50) return "anomaly";
  return "watch";
}

export function scoreSecurityIncidentEvidence(item = {}) {
  let score = 0;
  const sourceType = normalizeSourceType(item.source_type);
  if (sourceType === "official" || sourceType === "security_researcher") score += 35;
  else if (sourceType === "media") score += 25;
  else if (sourceType === "kol") score += 20;
  else score += 5;

  if (item.confidence === "high") score += 25;
  else if (item.confidence === "medium") score += 15;

  if (item.source_url) score += 15;
  if (item.source_published_at) score += 10;
  if (item.source_user) score += 5;
  if (Number.isFinite(item.amount_usd)) score += 10;
  if (item.summary) score += 5;
  return Math.max(0, Math.min(100, score));
}

function evidenceLevel(score) {
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function addSkip(skipped, reason, row) {
  skipped.push({
    reason,
    project: cleanText(row?.project || row?.project_name || row?.protocol || row?.exchange),
    source_url: cleanText(row?.source_url || row?.url || row?.link)
  });
}

function countSkipReasons(skipped = []) {
  return skipped.reduce((acc, item) => {
    const key = item.reason || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export function parseXintelSecurityIncidents(raw, config = {}, now = new Date()) {
  const parsed = extractJson(raw);
  if (!parsed.ok) return parsed;

  const root = parsed.value;
  const rows = Array.isArray(root) ? root : root?.incidents || root?.security_incidents || root?.items || [];
  if (!Array.isArray(rows)) return { ok: false, error: "invalid_shape" };

  const intervalSec = clampInt(config.securityIncidentIntervalSec, 60, 3600, 1200);
  const lookbackMs = Math.max(2 * 60 * 60 * 1000, intervalSec * 3 * 1000);
  const minTs = now.getTime() - lookbackMs;
  const incidents = [];
  const skipped = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      addSkip(skipped, "invalid_item", row);
      continue;
    }
    const project = cleanText(row.project || row.project_name || row.protocol || row.exchange);
    const incidentType = cleanText(row.incident_type || row.type || row.category || "other");
    const sourcePublishedAt = cleanText(row.source_published_at || row.published_at || row.event_time || row.time);
    const sourceTs = Date.parse(sourcePublishedAt);
    if (!project || !incidentType) {
      addSkip(skipped, "missing_required_fields", row);
      continue;
    }
    if (!Number.isFinite(sourceTs)) {
      addSkip(skipped, "missing_source_published_at", row);
      continue;
    }
    if (sourceTs < minTs) {
      addSkip(skipped, "outside_lookback", row);
      continue;
    }

    const item = {
      project,
      incident_type: incidentType,
      amount_usd: parseAmountUsd(row.amount_usd ?? row.loss_usd ?? row.loss ?? row.amount),
      chain_platform: cleanText(row.chain_platform || row.chain || row.platform || row.exchange),
      source_url: cleanText(row.source_url || row.url || row.link),
      source_user: cleanText(row.source_user || row.user || row.account),
      source_type: normalizeSourceType(row.source_type || row.sourceType),
      source_published_at: new Date(sourceTs).toISOString(),
      confidence: normalizeConfidence(row.confidence),
      summary: cleanText(row.summary || row.description || row.note)
    };

    if (!item.source_url) {
      addSkip(skipped, "missing_source_url", row);
      continue;
    }
    if (item.confidence === "low") {
      addSkip(skipped, "low_confidence", row);
      continue;
    }
    item.evidence_score = scoreSecurityIncidentEvidence(item);
    item.evidence_level = evidenceLevel(item.evidence_score);
    item.alert_level = classifySecurityIncident(item, config);
    item.dedup_key = buildDedupKey(item);
    item.raw_json = JSON.stringify(row);
    incidents.push(item);
  }

  return { ok: true, incidents, skipped };
}

export function buildSecurityIncidentPrompt(config = {}) {
  const intervalSec = clampInt(config.securityIncidentIntervalSec, 60, 3600, 1200);
  const lookbackMinutes = Math.max(120, Math.ceil((intervalSec * 3) / 60));
  return `
用 X/Grok 搜索过去 ${lookbackMinutes} 分钟内区块链项目安全事件。监控对象包括交易所、链、协议、跨链桥、钱包、托管方、做市商和链上项目。

只返回疑似或确认的被盗、攻击、漏洞利用、私钥泄露、异常提款、跨链桥攻击、交易所安全事故。忽略普通行情波动、清算、跑路传闻、空投骗局广告、无来源重复转载。

字段要求：
- amount_usd 填确认或可信估算的美元损失金额；无法确认填 null。
- source_url 优先填 X 原帖或官方/安全机构帖子链接。
- source_user 填发帖账号；source_type 填 official/security_researcher/media/kol/unknown。
- source_published_at 必须填来源发布时间 UTC ISO；无法确认不要返回该条。
- confidence 只用 high/medium/low；纯谣言不要返回。
- summary 用简体中文，说明发生了什么和当前影响。

只输出 JSON，不要解释：
${OUTPUT_SCHEMA}
`.trim();
}

export function buildSecurityIncidentMessage(item) {
  const isCritical = item.alert_level === "critical";
  const isLargePending = item.alert_level === "anomaly" && Number.isFinite(item.amount_usd) && item.amount_usd >= Number(item.large_threshold || 5_000_000);
  const amount = Number.isFinite(item.amount_usd) ? `$${Math.round(item.amount_usd).toLocaleString("en-US")}` : "未知";
  const lines = [];
  lines.push(isCritical ? "【危急警报】区块链安全事件" : "【异常提醒】区块链安全事件");
  if (isLargePending) lines.push("标记: 大额待确认");
  lines.push(`项目: ${item.project}`);
  lines.push(`事件类型: ${item.incident_type}`);
  lines.push(`金额: ${amount}`);
  lines.push(`链/平台: ${item.chain_platform || "未知"}`);
  lines.push(`置信度: ${item.confidence || "medium"}`);
  lines.push(`证据: ${item.evidence_level || "unknown"} (${Number(item.evidence_score || 0)})`);
  lines.push(`时间: ${item.source_published_at || "未知"}`);
  lines.push(`来源: ${item.source_url || "N/A"}`);
  lines.push("");
  lines.push(`摘要: ${item.summary || "暂无摘要"}`);
  return lines.join("\n");
}

export class SecurityIncidentMonitor {
  constructor({ config, db, notifier, hermesClient }) {
    this.config = config;
    this.db = db;
    this.notifier = notifier || new TelegramNotifier(config, db);
    this.hermesClient = hermesClient || new HermesClient(config, { minIntervalMs: 0 });
    this.isRunning = false;
    this.timer = null;
    this.nextRunAt = null;
    this.lastStartedAt = null;
    this.lastFinishedAt = null;
    this.lastError = "";
  }

  getStatus() {
    return {
      enabled: Boolean(this.config.securityIncidentMonitorEnabled),
      running: this.isRunning,
      last_started_at: this.lastStartedAt,
      last_finished_at: this.lastFinishedAt,
      next_run_at: this.nextRunAt,
      last_error: this.lastError
    };
  }

  callHermes(prompt) {
    return this.hermesClient.call(prompt);
  }

  shouldPush(existing, item) {
    if (item.alert_level === "watch") return false;
    if (item.alert_level === "critical") return !existing?.critical_pushed_at;
    if (existing?.critical_pushed_at) return false;
    return !existing?.anomaly_pushed_at;
  }

  async processIncident(item) {
    const existing = this.db.getSecurityIncidentByDedup?.(item.dedup_key) || null;
    const stored = this.db.upsertSecurityIncident?.(item) || null;
    const effective = {
      ...item,
      ...stored,
      amount_usd: Math.max(
        Number.isFinite(Number(existing?.amount_usd)) ? Number(existing.amount_usd) : 0,
        Number.isFinite(Number(item.amount_usd)) ? Number(item.amount_usd) : 0,
        Number.isFinite(Number(stored?.amount_usd)) ? Number(stored.amount_usd) : 0
      ) || null,
      alert_level: highestAlertLevel(existing?.alert_level || "watch", stored?.alert_level || item.alert_level)
    };
    effective.large_threshold = Number(this.config.securityIncidentLargeUsd || 5_000_000);
    if (!this.shouldPush(existing, effective)) {
      return { pushed: false, reason: effective.alert_level === "watch" ? "evidence_below_push_threshold" : "dedup_skip" };
    }

    const chatId =
      effective.alert_level === "critical"
        ? this.config.securityIncidentCriticalChatId
        : this.config.securityIncidentAnomalyChatId;
    const message = buildSecurityIncidentMessage(effective);
    const sendResult = await this.notifier.send({ message, chatId, businessId: `security:${effective.dedup_key}:${effective.alert_level}`, kind: "security_incident" });
    if (sendResult.ok) {
      this.db.markSecurityIncidentPushed?.(effective.dedup_key, effective.alert_level);
    }
    return { pushed: sendResult.ok, reason: sendResult.status || sendResult.reason };
  }

  async runOnce(trigger = "timer") {
    if (!this.config.securityIncidentMonitorEnabled) return { skipped: true, reason: "disabled" };
    if (this.isRunning) return { skipped: true, reason: "already_running" };

    this.isRunning = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = "";
    const startedMs = Date.now();

    try {
      const raw = await this.callHermes(buildSecurityIncidentPrompt(this.config));
      const parsed = parseXintelSecurityIncidents(raw, this.config);
      if (!parsed.ok) {
        throw new Error(`xintel_parse_failed:${parsed.error}`);
      }

      let pushed = 0;
      const processSkipped = [];
      for (const item of parsed.incidents) {
        const result = await this.processIncident(item);
        if (result.pushed) pushed += 1;
        else processSkipped.push({ reason: result.reason, project: item.project, source_url: item.source_url });
      }
      const skipped = [...(parsed.skipped || []), ...processSkipped];
      const skipCounts = countSkipReasons(skipped);

      this.lastFinishedAt = new Date().toISOString();
      this.db.recordHealth?.(
        "security_incident_monitor",
        "ok",
        `trigger=${trigger} incidents=${parsed.incidents.length} pushed=${pushed} skipped=${skipped.length} skip_reasons=${JSON.stringify(skipCounts)} duration_ms=${Date.now() - startedMs}`
      );
      logger.info("security_incident_monitor_done", {
        trigger,
        incidents: parsed.incidents.length,
        pushed,
        skipped: skipped.length,
        skip_reasons: skipCounts,
        duration_ms: Date.now() - startedMs
      });
      return { ok: true, incidents: parsed.incidents.length, pushed, skipped: skipped.length, skip_reasons: skipCounts };
    } catch (error) {
      this.lastError = String(error.message || error);
      this.lastFinishedAt = new Date().toISOString();
      this.db.recordHealth?.("security_incident_monitor", "error", this.lastError);
      logger.warn("security_incident_monitor_failed", { trigger, error: this.lastError });
      return { ok: false, error: this.lastError };
    } finally {
      this.isRunning = false;
      const intervalMs = clampInt(this.config.securityIncidentIntervalSec, 60, 3600, 1200) * 1000;
      this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    }
  }

  start() {
    if (!this.config.securityIncidentMonitorEnabled || this.timer) return;
    const intervalMs = clampInt(this.config.securityIncidentIntervalSec, 60, 3600, 1200) * 1000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.runOnce("startup");
    this.timer = setInterval(() => {
      this.runOnce("timer");
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
