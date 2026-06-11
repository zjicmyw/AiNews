import crypto from "node:crypto";

export const CEX_EXCHANGES = ["Binance", "OKX", "Bybit", "Gate", "Bitget"];
export const STABLECOINS = ["USDT", "USDC", "USD1"];

const TYPE_ALIASES = new Map([
  ["launch", "launch"],
  ["launchpad", "launch"],
  ["ido", "launch"],
  ["ieo", "launch"],
  ["airdrop", "launch"],
  ["farm", "launch"],
  ["pre_ipo", "pre_ipo"],
  ["pre-ipo", "pre_ipo"],
  ["preipo", "pre_ipo"],
  ["pre_token", "pre_ipo"],
  ["pre-token", "pre_ipo"],
  ["pre_listing", "pre_ipo"],
  ["pre-listing", "pre_ipo"],
  ["short_term", "short_term"],
  ["short-term", "short_term"],
  ["temporary", "short_term"],
  ["stablecoin_earn", "stablecoin_earn"],
  ["stablecoin", "stablecoin_earn"],
  ["earn", "stablecoin_earn"],
  ["onchain", "onchain"],
  ["dex", "onchain"]
]);

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeExchange(value) {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return "";
  if (raw.includes("binance") || raw.includes("币安")) return "Binance";
  if (raw.includes("okx") || raw.includes("okex")) return "OKX";
  if (raw.includes("bybit")) return "Bybit";
  if (raw.includes("gate")) return "Gate";
  if (raw.includes("bitget")) return "Bitget";
  return cleanText(value);
}

function normalizeType(value, fallback = "") {
  const raw = cleanText(value || fallback).toLowerCase().replace(/\s+/g, "_");
  return TYPE_ALIASES.get(raw) || raw || "short_term";
}

function normalizeSection(value, type, exchange) {
  const raw = cleanText(value).toLowerCase();
  if (raw === "onchain" || raw === "dex" || type === "onchain") return "onchain";
  if (CEX_EXCHANGES.includes(exchange)) return "cex";
  return "onchain";
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value);
  if (!text) return null;
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseApyPercentFromText(value) {
  const text = cleanText(value).replace(/,/g, "");
  if (!text) return null;
  const candidates = [];

  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:a\.?p\.?y\.?|a\.?p\.?r\.?|annual|年化)?/gi)) {
    const contextStart = Math.max(0, match.index - 28);
    const contextEnd = Math.min(text.length, match.index + match[0].length + 28);
    const context = text.slice(contextStart, contextEnd);
    const linked = /a\.?p\.?y\.?|a\.?p\.?r\.?|annual|年化|收益|利率|rate|earn/i.test(context);
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) candidates.push({ value: parsed, linked });
  }

  for (const match of text.matchAll(/(?:a\.?p\.?y\.?|a\.?p\.?r\.?|annual|年化|收益|利率|rate)\D{0,24}(\d+(?:\.\d+)?)/gi)) {
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) candidates.push({ value: parsed, linked: true });
  }

  const linked = candidates.filter((candidate) => candidate.linked);
  const pool = linked.length ? linked : candidates;
  if (!pool.length) return null;
  return Math.max(...pool.map((candidate) => candidate.value));
}

export function parseApyPercent(raw = {}) {
  const direct = [raw.apy, raw.apr, raw.expected_apy, raw.yield].map((value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    return parseApyPercentFromText(value);
  });
  const directValues = direct.filter(Number.isFinite);
  if (directValues.length) return Math.max(...directValues);

  const descriptiveValues = [raw.expected_yield, raw.reward, raw.rewards, raw.incentive, raw.participation, raw.duration]
    .map(parseApyPercentFromText)
    .filter(Number.isFinite);
  if (descriptiveValues.length) return Math.max(...descriptiveValues);
  return null;
}

export function parseMaxApyPercent(raw = {}) {
  const direct = [raw.apy, raw.apr, raw.expected_apy, raw.yield].map((value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    return parseApyPercentFromText(value);
  });
  const descriptiveValues = [raw.expected_yield, raw.reward, raw.rewards, raw.incentive, raw.participation, raw.duration]
    .map(parseApyPercentFromText)
    .filter(Number.isFinite);
  const values = direct.concat(descriptiveValues).filter(Number.isFinite);
  if (values.length) return Math.max(...values);
  return null;
}

function parseIsoDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function findJsonEnd(text, start) {
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return -1;

  const stack = [closer];
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i + 1;
    }
  }

  return -1;
}

function extractStablecoin(item, asset) {
  const explicit = cleanText(item.stablecoin).toUpperCase();
  if (explicit) return explicit;
  const text = [
    asset,
    item.currency,
    item.expected_yield,
    item.reward,
    item.participation,
    item.activity_name,
    item.name
  ]
    .map(cleanText)
    .join(" ")
    .toUpperCase();
  return STABLECOINS.find((coin) => text.includes(coin)) || "";
}

export function extractJsonPayload(raw) {
  const text = cleanText(raw);
  if (!text) return { ok: false, error: "empty_response" };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const starts = [candidate.indexOf("{"), candidate.indexOf("[")].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;

  if (start < 0) return { ok: false, error: "json_start_not_found" };

  const end = findJsonEnd(candidate, start);
  if (end > start) {
    try {
      return { ok: true, value: JSON.parse(candidate.slice(start, end)) };
    } catch {
      return { ok: false, error: "invalid_json" };
    }
  }

  return { ok: false, error: "invalid_json" };
}

export function parseXintelOpportunities(raw) {
  const parsed = extractJsonPayload(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, opportunities: [] };

  const value = parsed.value;
  const opportunities = Array.isArray(value)
    ? value
    : Array.isArray(value?.opportunities)
      ? value.opportunities
      : Array.isArray(value?.items)
        ? value.items
        : value && typeof value === "object" && (value.activity_name || value.name || value.title)
          ? [value]
          : [];

  if (!Array.isArray(opportunities)) {
    return { ok: false, error: "opportunities_not_array", opportunities: [] };
  }

  return { ok: true, opportunities };
}

export function buildOpportunityDedupKey(item) {
  const sourceUrl = cleanText(item.source_url).toLowerCase();
  if (sourceUrl) return crypto.createHash("sha256").update(sourceUrl).digest("hex");

  const raw = [item.section, item.exchange || item.venue, item.activity_name, item.asset, item.deadline_at]
    .map((value) => cleanText(value).toLowerCase())
    .join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function normalizeOpportunity(raw, now = new Date(), options = {}) {
  if (!raw || typeof raw !== "object") return null;

  const activityName = cleanText(raw.activity_name || raw.name || raw.title);
  if (!activityName) return null;

  const rawSection = cleanText(raw.section).toLowerCase();
  const exchangeInput = cleanText(raw.exchange);
  const exchange = normalizeExchange(exchangeInput);
  if (exchangeInput && !CEX_EXCHANGES.includes(exchange) && rawSection !== "onchain" && rawSection !== "dex") {
    return null;
  }
  const type = normalizeType(raw.type || raw.category, raw.product_type);
  const section = normalizeSection(raw.section, type, exchange);
  const venue = cleanText(raw.venue || exchange || raw.project || raw.protocol);
  const asset = cleanText(raw.asset || raw.coin || raw.token || raw.currency).toUpperCase();
  const stablecoin = extractStablecoin(raw, asset);
  const apy = parseApyPercent(raw);
  const deadlineAt = parseIsoDate(raw.deadline_at || raw.ends_at || raw.end_time || raw.deadline);
  const sourcePublishedAt = parseIsoDate(raw.source_published_at || raw.published_at || raw.posted_at);
  const sourceUrl = cleanText(raw.source_url || raw.x_url || raw.url || raw.link);
  const officialUrl = cleanText(raw.official_url || raw.officialUrl || raw.announcement_url || raw.official_link);
  const officialUrlSource = cleanText(raw.official_url_source || raw.officialUrlSource);
  const sourceUser = cleanText(raw.source_user || raw.user || raw.account);
  const credibilityRaw = cleanText(raw.credibility || raw.source_credibility).toLowerCase();
  const credibility = ["official", "kol", "unverified"].includes(credibilityRaw) ? credibilityRaw : "unverified";
  const deadlineSource = cleanText(raw.deadline_source || raw.deadlineSource || (deadlineAt ? "xintel" : ""));
  const deadlineConfidence = parseNumber(raw.deadline_confidence || raw.deadlineConfidence);

  if (section === "cex" && !CEX_EXCHANGES.includes(exchange)) return null;
  if (type === "launch" && section === "cex" && !CEX_EXCHANGES.includes(exchange)) return null;

  const isStablecoinEarn = type === "stablecoin_earn";
  if (isStablecoinEarn) {
    if (!STABLECOINS.includes(stablecoin)) return null;
    if (!Number.isFinite(apy) || apy < 8) return null;
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : null;
  const sourcePublishedMs = sourcePublishedAt ? Date.parse(sourcePublishedAt) : null;
  const lookbackHours = Number(options.lookbackHours || 0);
  if (
    Number.isFinite(sourcePublishedMs) &&
    Number.isFinite(nowMs) &&
    lookbackHours > 0 &&
    nowMs - sourcePublishedMs > lookbackHours * 60 * 60 * 1000
  ) {
    return null;
  }

  const expired = Number.isFinite(deadlineMs) && Number.isFinite(nowMs) && deadlineMs < nowMs;
  let status = expired ? "expired" : "active";
  if (!sourceUrl || !sourceUser || credibility === "unverified") status = expired ? "expired" : "unverified";
  if (!sourcePublishedAt) status = expired ? "expired" : "unverified";
  if ((isStablecoinEarn || type === "launch" || type === "pre_ipo") && !deadlineAt) {
    status = expired ? "expired" : "unverified";
  }

  const item = {
    dedup_key: "",
    activity_name: activityName,
    type,
    section,
    exchange: section === "cex" ? exchange : "",
    venue: venue || (section === "cex" ? exchange : "Onchain"),
    asset,
    stablecoin,
    apy,
    expected_yield: cleanText(raw.expected_yield || raw.expected_return || raw.yield_detail),
    reward: cleanText(raw.reward || raw.rewards || raw.incentive),
    duration: cleanText(raw.duration || raw.lock_term || raw.period),
    deadline_at: deadlineAt,
    source_published_at: sourcePublishedAt,
    participation: cleanText(raw.participation || raw.how_to_join || raw.join_method),
    source_user: sourceUser,
    source_url: sourceUrl,
    credibility,
    risk_note: cleanText(raw.risk_note || raw.risk || raw.warning) || (section === "onchain" ? "链上机会风险较高，需自行核验合约、锁仓和收益来源。" : "需核验活动条款、额度和地区限制。"),
    status,
    official_url: officialUrl,
    official_url_source: officialUrlSource || (officialUrl ? "official_page" : null),
    deadline_source: deadlineSource || null,
    deadline_confidence: Number.isFinite(deadlineConfidence) ? deadlineConfidence : deadlineAt ? 0.55 : null,
    deadline_text: cleanText(raw.deadline_text || raw.deadlineText),
    enriched_at: raw.enriched_at || null,
    enrichment_error: raw.enrichment_error || null,
    raw_json: JSON.stringify(raw)
  };
  item.dedup_key = buildOpportunityDedupKey(item);
  return item;
}

const DROP_REASON_LABELS = {
  invalid_item: "候选格式无效",
  missing_activity_name: "缺活动名称",
  unsupported_cex: "非目标 CEX",
  unsupported_stablecoin: "非目标稳定币",
  missing_apy: "缺 APY",
  apy_below_threshold: "APY 低于 8%",
  outside_lookback: "超出时间窗口",
  expired: "已过期",
  duplicate: "重复来源",
  unknown_filtered: "未通过筛选"
};

function dropReasonLabel(reason) {
  return DROP_REASON_LABELS[reason] || DROP_REASON_LABELS.unknown_filtered;
}

function classifyNormalizeDrop(raw, now = new Date(), options = {}) {
  if (!raw || typeof raw !== "object") return "invalid_item";

  const activityName = cleanText(raw.activity_name || raw.name || raw.title);
  if (!activityName) return "missing_activity_name";

  const rawSection = cleanText(raw.section).toLowerCase();
  const exchangeInput = cleanText(raw.exchange);
  const exchange = normalizeExchange(exchangeInput);
  if (exchangeInput && !CEX_EXCHANGES.includes(exchange) && rawSection !== "onchain" && rawSection !== "dex") {
    return "unsupported_cex";
  }

  const type = normalizeType(raw.type || raw.category, raw.product_type);
  const section = normalizeSection(raw.section, type, exchange);
  const asset = cleanText(raw.asset || raw.coin || raw.token || raw.currency).toUpperCase();
  const stablecoin = extractStablecoin(raw, asset);
  const apy = parseApyPercent(raw);
  const deadlineAt = parseIsoDate(raw.deadline_at || raw.ends_at || raw.end_time || raw.deadline);
  const sourcePublishedAt = parseIsoDate(raw.source_published_at || raw.published_at || raw.posted_at);

  if (section === "cex" && !CEX_EXCHANGES.includes(exchange)) return "unsupported_cex";
  if (type === "launch" && section === "cex" && !CEX_EXCHANGES.includes(exchange)) return "unsupported_cex";

  if (type === "stablecoin_earn") {
    if (!STABLECOINS.includes(stablecoin)) return "unsupported_stablecoin";
    if (!Number.isFinite(apy)) return "missing_apy";
    if (apy < 8) return "apy_below_threshold";
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : null;
  const sourcePublishedMs = sourcePublishedAt ? Date.parse(sourcePublishedAt) : null;
  const lookbackHours = Number(options.lookbackHours || 0);
  if (
    Number.isFinite(sourcePublishedMs) &&
    Number.isFinite(nowMs) &&
    lookbackHours > 0 &&
    nowMs - sourcePublishedMs > lookbackHours * 60 * 60 * 1000
  ) {
    return "outside_lookback";
  }
  if (Number.isFinite(deadlineMs) && Number.isFinite(nowMs) && deadlineMs < nowMs) return "expired";

  return "unknown_filtered";
}

function summarizeDropReasons(reasonCounts, examplesByReason) {
  return Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({
      reason,
      label: dropReasonLabel(reason),
      count,
      examples: examplesByReason.get(reason) || []
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

function opportunityJobName(raw) {
  return cleanText(raw?.__xintel_job) || "unknown";
}

function createNormalizeReport(inputCount = 0) {
  return {
    input_count: inputCount,
    normalized_count: 0,
    dropped_count: 0,
    duplicate_count: 0,
    drop_reasons: [],
    by_job: {}
  };
}

function ensureJobReport(report, job) {
  if (!report.by_job[job]) {
    report.by_job[job] = {
      input_count: 0,
      normalized_count: 0,
      dropped_count: 0,
      duplicate_count: 0,
      drop_reasons: []
    };
  }
  return report.by_job[job];
}

function recordDrop({ report, jobReport, reason, raw, reasonCounts, examplesByReason, jobReasonCounts, jobExamplesByReason }) {
  const title = cleanText(raw?.activity_name || raw?.name || raw?.title || raw?.source_url || raw?.exchange || raw?.venue);
  reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  jobReasonCounts.set(reason, (jobReasonCounts.get(reason) || 0) + 1);
  if (title) {
    const examples = examplesByReason.get(reason) || [];
    if (examples.length < 3) examples.push(title);
    examplesByReason.set(reason, examples);

    const jobExamples = jobExamplesByReason.get(reason) || [];
    if (jobExamples.length < 3) jobExamples.push(title);
    jobExamplesByReason.set(reason, jobExamples);
  }
  report.dropped_count += 1;
  jobReport.dropped_count += 1;
  if (reason === "duplicate") {
    report.duplicate_count += 1;
    jobReport.duplicate_count += 1;
  }
}

export function normalizeOpportunityBatchWithReport(items, now = new Date(), options = {}) {
  const rows = Array.isArray(items) ? items : [];
  const seen = new Set();
  const normalized = [];
  const report = createNormalizeReport(rows.length);
  const reasonCounts = new Map();
  const examplesByReason = new Map();
  const perJobReasonCounts = new Map();
  const perJobExamples = new Map();

  for (const raw of rows) {
    const job = opportunityJobName(raw);
    const jobReport = ensureJobReport(report, job);
    jobReport.input_count += 1;
    if (!perJobReasonCounts.has(job)) perJobReasonCounts.set(job, new Map());
    if (!perJobExamples.has(job)) perJobExamples.set(job, new Map());
    const jobReasonCounts = perJobReasonCounts.get(job);
    const jobExamplesByReason = perJobExamples.get(job);

    const item = normalizeOpportunity(raw, now, options);
    if (!item) {
      recordDrop({
        report,
        jobReport,
        reason: classifyNormalizeDrop(raw, now, options),
        raw,
        reasonCounts,
        examplesByReason,
        jobReasonCounts,
        jobExamplesByReason
      });
      continue;
    }
    if (seen.has(item.dedup_key)) {
      recordDrop({
        report,
        jobReport,
        reason: "duplicate",
        raw,
        reasonCounts,
        examplesByReason,
        jobReasonCounts,
        jobExamplesByReason
      });
      continue;
    }
    seen.add(item.dedup_key);
    normalized.push(item);
    report.normalized_count += 1;
    jobReport.normalized_count += 1;
  }

  report.drop_reasons = summarizeDropReasons(reasonCounts, examplesByReason);
  for (const [job, jobReport] of Object.entries(report.by_job)) {
    jobReport.drop_reasons = summarizeDropReasons(perJobReasonCounts.get(job) || new Map(), perJobExamples.get(job) || new Map());
  }
  return { items: normalized, report };
}

export function normalizeOpportunityBatch(items, now = new Date(), options = {}) {
  return normalizeOpportunityBatchWithReport(items, now, options).items;
}
