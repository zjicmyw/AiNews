import { extractJsonPayload } from "./opportunityUtils.js";

const CEX_OFFICIAL_HOSTS = {
  Binance: ["binance.com"],
  OKX: ["okx.com"],
  Bybit: ["bybit.com", "bybit.eu", "announcements.bybit.com", "announcements.bybitglobal.com"],
  Gate: ["gate.com", "gate.io"],
  Bitget: ["bitget.com"]
};

const BLOCKED_HOSTS = new Set(["x.com", "twitter.com", "t.co", "localhost", "127.0.0.1", "::1"]);

const ANNOUNCEMENT_PATH_PATTERN =
  /announcement|announcements|support|article|articles|campaign|activity|promo|promotion|launch|blog|help|news/i;

const GENERIC_SEARCH_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "earn",
  "event",
  "campaign",
  "launch",
  "pool",
  "fixed",
  "simple",
  "official",
  "page",
  "open",
  "trade",
  "trading",
  "access",
  "activity"
]);

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

function cleanText(value) {
  return String(value || "").trim();
}

function toFiniteNumber(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value > 1 && value <= 100) return value / 100;
    return value;
  }
  const match = cleanText(value).match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > 1 && parsed <= 100) return parsed / 100;
  return parsed;
}

function parseIsoDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function detectNoFixedDeadline(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return false;
  return /no fixed (end date|deadline)|without fixed (end date|deadline)|until further notice|ongoing|持续中|长期有效|无固定截止|未注明固定截止|每月更新|按月|monthly/.test(
    text
  );
}

function buildNoFixedDeadline(value, source = "no_fixed_deadline") {
  if (!detectNoFixedDeadline(value)) return null;
  return {
    deadline_at: null,
    deadline_source: source,
    deadline_confidence: 0.55,
    deadline_text: cleanText(value) || "无固定截止"
  };
}

function normalizeEmbeddedText(value) {
  return decodeHtmlEntities(value)
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[{}\[\]",]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDeadlineLikeText(value) {
  const text = cleanText(value);
  if (!text) return false;
  return /(deadline|end(?:time|date)?|period|until|campaign|promotion|subscription|registration|date|time|utc|gmt|活动|期间|截止|结束|时间|\d{4}[年/-]\d{1,2}[月/-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})/i.test(
    text
  );
}

function extractKeywordSnippets(value, { radius = 220, limit = 20 } = {}) {
  const text = normalizeEmbeddedText(value);
  if (!text) return [];
  const pattern =
    /deadline|end(?:time|date)?|period|until|campaign|promotion|subscription|registration|活动时间|活动期间|截止|结束|认购期|报名时间|申购时间/gi;
  const snippets = [];
  const seen = new Set();
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, match.index - radius);
    const end = Math.min(text.length, match.index + radius);
    const snippet = text.slice(start, end);
    if (!isDeadlineLikeText(snippet) || seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet);
    if (snippets.length >= limit) break;
  }
  return snippets;
}

function extractEmbeddedDeadlineText(html) {
  const snippets = [];
  const text = String(html || "");

  for (const tagMatch of text.matchAll(/<[^>]+>/g)) {
    const tag = tagMatch[0];
    if (/^<\/?(?:script|style)\b/i.test(tag)) continue;
    for (const attrMatch of tag.matchAll(/\b([:\w-]+)\s*=\s*["']([^"']{1,500})["']/gi)) {
      const pair = `${attrMatch[1]} ${attrMatch[2]}`;
      if (isDeadlineLikeText(pair)) snippets.push(normalizeEmbeddedText(pair));
      if (snippets.length >= 40) break;
    }
    if (snippets.length >= 40) break;
  }

  for (const scriptMatch of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const scriptText = scriptMatch[1];
    if (!isDeadlineLikeText(scriptText)) continue;
    snippets.push(...extractKeywordSnippets(scriptText, { radius: 260, limit: 10 }));
    if (snippets.length >= 80) break;
  }

  return snippets.join(" ");
}

function htmlToText(html) {
  const embeddedText = extractEmbeddedDeadlineText(html);
  return cleanText(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .concat(" ", embeddedText)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractUrls(value) {
  const urls = [];
  const seen = new Set();
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  const pattern = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const match of text.matchAll(pattern)) {
    const url = match[0].replace(/[.,;:!?，。；：！？]+$/g, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function decodeHtmlEntities(value) {
  return cleanText(value)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)));
}

export function extractHtmlLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const text = String(html || "");
  for (const match of text.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const rawHref = decodeHtmlEntities(match[1]);
    if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref) || /^mailto:/i.test(rawHref)) continue;
    try {
      const url = new URL(rawHref, baseUrl);
      url.hash = "";
      const normalized = url.toString();
      if (!isPublicHttpsUrl(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      links.push(normalized);
    } catch {
      // Ignore malformed page links.
    }
  }
  return links;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

export function isPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

function hostMatches(hostname, allowed) {
  const host = hostname.toLowerCase();
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isOfficialOpportunityUrl(value, item = {}) {
  if (!isPublicHttpsUrl(value)) return false;
  const url = new URL(value);
  const exchange = cleanText(item.exchange);
  if (item.section === "cex" || exchange) {
    const allowed = CEX_OFFICIAL_HOSTS[exchange] || [];
    return allowed.length > 0 && hostMatches(url.hostname, allowed);
  }
  return !BLOCKED_HOSTS.has(url.hostname.toLowerCase());
}

function parseRawJson(rawJson) {
  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function textIncludes(item, patterns) {
  const text = [
    item.activity_name,
    item.type,
    item.venue,
    item.asset,
    item.stablecoin,
    item.expected_yield,
    item.reward,
    item.duration,
    item.participation,
    item.risk_note
  ]
    .map(cleanText)
    .join(" ")
    .toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
}

function opportunitySearchTokens(item = {}) {
  const text = [
    item.activity_name,
    item.venue,
    item.asset,
    item.stablecoin,
    item.expected_yield,
    item.reward,
    item.participation
  ]
    .map(cleanText)
    .join(" ")
    .toLowerCase()
    .replace(/\$/g, " ");
  const tokens = new Set(
    text
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 3 && !GENERIC_SEARCH_TOKENS.has(token))
  );
  if (item.asset) tokens.add(String(item.asset).toLowerCase());
  if (item.stablecoin) tokens.add(String(item.stablecoin).toLowerCase());
  return [...tokens].slice(0, 12);
}

function scoreOfficialAnnouncementLink(url, item = {}) {
  if (!isOfficialOpportunityUrl(url, item)) return -1;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return -1;
  }
  const haystack = decodeURIComponent(`${parsed.hostname} ${parsed.pathname} ${parsed.search}`).toLowerCase();
  let score = ANNOUNCEMENT_PATH_PATTERN.test(haystack) ? 20 : 0;
  for (const token of opportunitySearchTokens(item)) {
    if (haystack.includes(token)) score += token.length >= 5 ? 5 : 3;
  }
  if (/spacex|spcx|ipo|pre-ipo|preipo|startup|launchpad|launchpool|poolx|jumpstart/i.test(haystack)) score += 8;
  if (/\/(?:en|zh|cn|article|articles|announcement|announcements|support)\//i.test(parsed.pathname)) score += 2;
  if (parsed.pathname === "/" || parsed.pathname.length < 8) score -= 15;
  return score;
}

export function pickOfficialAnnouncementLinks(links = [], item = {}, limit = 2) {
  const officialUrl = cleanText(item.official_url);
  return [...new Set(links)]
    .filter((url) => url !== officialUrl)
    .map((url) => ({ url, score: scoreOfficialAnnouncementLink(url, item) }))
    .filter((row) => row.score >= 20)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, Number(limit || 0)))
    .map((row) => row.url);
}

export function inferOfficialUrl(item = {}) {
  const exchange = cleanText(item.exchange);
  if (exchange === "Binance") {
    if (textIncludes(item, ["football trading cup"])) {
      return {
        url: "https://www.binance.com/en/support/announcement/detail/92b1c5c7761443309c8594185a5e8989",
        source: "official_page"
      };
    }
    if (textIncludes(item, ["usd1 simple earn", "10.5% apr with usd1", "usd1 flexible"])) {
      return {
        url: "https://www.binance.com/en/support/announcement/detail/9ee205049edd4b91887b8610bce0c2ab",
        source: "official_page"
      };
    }
    if (textIncludes(item, ["simple earn", "earn", "usd1"])) {
      return { url: "https://www.binance.com/en/earn", source: "official_product" };
    }
    if (textIncludes(item, ["perpetual", "perps", "futures"])) {
      return { url: "https://www.binance.com/en/futures", source: "official_product" };
    }
  }

  if (exchange === "Bybit") {
    if (textIncludes(item, ["ipo express", "spacex tokenized shares", "spacex ipo express"])) {
      return {
        url: "https://announcements.bybit.com/en/article/introducing-spacex-the-first-ipo-on-bybit-ipo-express-blt360da1ebb3f31f8a/",
        source: "official_page"
      };
    }
    if (textIncludes(item, ["football season 2026", "predict & earn", "$1m mnt"])) {
      return {
        url: "https://announcements.bybitglobal.com/en/article/bybit-football-season-2026-trade-predict-win-from-1-000-000-in-rewards--bltf8a798fbfccc3a6d/",
        source: "official_page"
      };
    }
    if (textIncludes(item, ["predict", "prediction"])) {
      return { url: "https://www.bybit.com/en/prediction", source: "official_product" };
    }
    if (textIncludes(item, ["bybit.eu", "fixed earn", "easy earn", "earn usdc"])) {
      return { url: "https://www.bybit.eu/en-EU/earn", source: "official_product" };
    }
  }

  if (exchange === "Gate" && textIncludes(item, ["ipo access", "spacex ipo"])) {
    return { url: "https://www.gate.com/ipo-access", source: "official_product" };
  }

  if (item.section === "onchain") {
    if (textIncludes(item, ["zoth", "zopal"])) {
      return { url: "https://zoth.io/zvault", source: "official_product" };
    }
    if (textIncludes(item, ["pendle"])) {
      return { url: "https://app.pendle.finance", source: "official_product" };
    }
    if (textIncludes(item, ["permapod"])) {
      return { url: "https://app.permapod.xyz", source: "official_product" };
    }
    if (textIncludes(item, ["edel"])) {
      return { url: "https://app.edel.finance", source: "official_product" };
    }
    if (textIncludes(item, ["kamino", "onre"])) {
      return { url: "https://app.kamino.finance", source: "official_product" };
    }
  }

  return { url: "", source: "" };
}

function inferNoFixedDeadline(item = {}) {
  if (item.deadline_at || item.deadline_source) return null;
  if (item.section === "onchain") {
    if (!["stablecoin_earn", "onchain", "short_term"].includes(item.type)) return null;
    if (!textIncludes(item, ["pendle", "permapod", "edel", "kamino", "onre", "zoth", "zopal"])) return null;
    return buildNoFixedDeadline(
      "链上收益/金库类机会通常无固定截止时间，需以协议页面的实时市场、额度、APY 和赎回状态为准。"
    );
  }

  if (item.section === "cex" && item.official_url_source === "official_product") {
    if (item.exchange === "Bybit" && item.type === "stablecoin_earn" && textIncludes(item, ["bybit.eu", "fixed earn", "easy earn", "earn usdc"])) {
      return buildNoFixedDeadline(
        "Bybit EU Earn 为持续产品/限池促销，当前无固定截止时间；需以产品页实时额度、APR 和地区资格为准。"
      );
    }
    if (item.exchange === "Binance" && item.type === "pre_ipo" && textIncludes(item, ["perpetual", "perps", "futures"])) {
      return buildNoFixedDeadline(
        "Binance Pre-IPO/股票永续为持续交易产品，无固定截止时间；需以 Futures 页面实时合约状态为准。"
      );
    }
  }

  return null;
}

export function findOfficialUrl(item = {}) {
  const candidates = [
    item.official_url,
    item.announcement_url,
    item.source_url,
    item.participation,
    item.expected_yield,
    item.reward,
    item.risk_note,
    item.deadline_text,
    parseRawJson(item.raw_json)
  ].flatMap((value) => extractUrls(value).concat(cleanText(value).startsWith("http") ? [cleanText(value)] : []));

  return candidates.find((url) => isOfficialOpportunityUrl(url, item)) || "";
}

function timezoneOffsetMinutes(context) {
  const text = cleanText(context);
  const offsetMatch = text.match(/\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/i);
  if (offsetMatch) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    return sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] || 0));
  }
  if (/\b(?:UTC|GMT)\b/i.test(text)) return 0;
  return 0;
}

function makeUtcIso(year, month, day, hour = 23, minute = 59, second = 59, offsetMinutes = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractDatesFromContext(context) {
  const dates = [];
  const text = cleanText(context);
  const offsetMinutes = timezoneOffsetMinutes(text);

  for (const match of text.matchAll(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s*(?:[^\d]{0,12}(\d{1,2}):(\d{2}))?/g)) {
    dates.push({
      iso: makeUtcIso(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] ? Number(match[4]) : 23,
        match[5] ? Number(match[5]) : 59,
        59,
        offsetMinutes
      ),
      text: match[0]
    });
  }

  for (const match of text.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(?:至|到|-|–)\s*(\d{1,2})日/g)) {
    dates.push({
      iso: makeUtcIso(Number(match[1]), Number(match[2]), Number(match[4]), 23, 59, 59, offsetMinutes),
      text: match[0]
    });
  }

  for (const match of text.matchAll(
    /(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(?:\d{1,2}:\d{2})?\s*(?:至|到|-|–)\s*(?:(\d{1,2})月)?(\d{1,2})日?\s*(?:(\d{1,2}):(\d{2}))?/g
  )) {
    dates.push({
      iso: makeUtcIso(
        Number(match[1]),
        Number(match[4] || match[2]),
        Number(match[5]),
        match[6] ? Number(match[6]) : 23,
        match[7] ? Number(match[7]) : 59,
        59,
        offsetMinutes
      ),
      text: match[0]
    });
  }

  for (const match of text.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:\s*(?:to|-|–)\s*(\d{1,2}))?,?\s+(\d{4})(?:[^\d]{0,12}(\d{1,2}):(\d{2})\s*(AM|PM)?)?/gi
  )) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[3] || match[2]);
    let hour = match[5] ? Number(match[5]) : 23;
    const meridiem = cleanText(match[7]).toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    dates.push({
      iso: makeUtcIso(
        Number(match[4]),
        month,
        day,
        hour,
        match[6] ? Number(match[6]) : 59,
        59,
        offsetMinutes
      ),
      text: match[0]
    });
  }

  return dates.filter((date) => date.iso);
}

export function extractDeadlineFromText(text, now = new Date()) {
  const normalized = cleanText(text).replace(/\s+/g, " ");
  if (!normalized) return null;

  const keywordPattern =
    /(deadline|end(?:s|ed)?(?: at| on)?|until|subscription period|campaign period|promotion period|event period|registration period|competition period|allocation|spot listing|活动时间|活动期间|截止|结束|认购期|报名时间|申购时间)/gi;
  const contexts = [];
  for (const match of normalized.matchAll(keywordPattern)) {
    const start = Math.max(0, match.index - 80);
    const end = Math.min(normalized.length, match.index + 260);
    contexts.push(normalized.slice(start, end));
  }

  const parsed = contexts.flatMap((context) => extractDatesFromContext(context));
  if (parsed.length === 0) return null;

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const future = parsed.filter((row) => Date.parse(row.iso) >= nowMs - 60 * 60 * 1000);
  const candidates = future.length ? future : parsed;
  candidates.sort((a, b) => Date.parse(b.iso) - Date.parse(a.iso));
  const best = candidates[0];
  return {
    deadline_at: best.iso,
    deadline_text: best.text,
    deadline_source: "official_page",
    deadline_confidence: 0.9
  };
}

export async function crawlOfficialPage(url, { fetchFn = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!fetchFn) throw new Error("fetch_unavailable");
  if (!isPublicHttpsUrl(url)) throw new Error("invalid_public_https_url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "AiNews opportunity deadline verifier/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
      }
    });
    if (!response.ok) throw new Error(`official_fetch_${response.status}`);
    const text = await response.text();
    const pageText = htmlToText(text);
    if (/javascript is disabled[\s\S]{0,120}not a robot/i.test(pageText)) {
      throw new Error("official_fetch_blocked_or_empty");
    }
    const finalUrl = response.url || url;
    return {
      url: finalUrl,
      text: pageText.slice(0, 120000),
      links: extractHtmlLinks(text, finalUrl)
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildDeadlineFallbackPrompt(item) {
  return `
请用 X/Grok 搜索并核验这个机会的官方公告链接和截止时间。优先官方公告/活动页；没有官方页时才用官方 X 原帖。

机会：
${JSON.stringify(
  {
    activity_name: item.activity_name,
    type: item.type,
    section: item.section,
    exchange: item.exchange,
    venue: item.venue,
    asset: item.asset,
    stablecoin: item.stablecoin,
    deadline_at: item.deadline_at,
    deadline_text: item.deadline_text,
    official_url: item.official_url,
    official_url_source: item.official_url_source,
    source_user: item.source_user,
    source_url: item.source_url,
    participation: item.participation
  },
  null,
  2
)}

只输出 JSON，不要解释：
{"official_url":"","deadline_at":null,"deadline_text":"","deadline_source":"official_page|x_post|grok|no_fixed_deadline|unverified","deadline_confidence":0,"duration":"","participation":"","risk_note":""}
要求：official_url 优先官方公告/活动页，不要用交易所首页；deadline_at 能确认就用 UTC ISO，不能确认固定截止但官方显示长期/持续中时用 deadline_source="no_fixed_deadline"。
`.trim();
}

function refreshStatus(item, now = new Date()) {
  const deadlineMs = item.deadline_at ? Date.parse(item.deadline_at) : null;
  const expired = Number.isFinite(deadlineMs) && deadlineMs < now.getTime();
  if (expired) return { ...item, status: "expired" };
  if (!item.source_url || !item.source_user || item.credibility === "unverified") return { ...item, status: "unverified" };
  if ((item.type === "stablecoin_earn" || item.type === "launch" || item.type === "pre_ipo") && !item.deadline_at && item.deadline_source !== "no_fixed_deadline") {
    return { ...item, status: "unverified" };
  }
  return { ...item, status: "active" };
}

function mergeEnrichment(item, enrichment) {
  const deadlineAt = parseIsoDate(enrichment.deadline_at);
  const confidence = toFiniteNumber(enrichment.deadline_confidence);
  const officialUrl = cleanText(enrichment.official_url);
  const officialUrlSource = cleanText(enrichment.official_url_source || enrichment.officialUrlSource);
  const inferredOfficial = !officialUrl && !item.official_url ? inferOfficialUrl(item) : { url: "", source: "" };
  const nextDeadlineAt = deadlineAt || item.deadline_at || null;
  const nextDeadlineText = cleanText(enrichment.deadline_text) || item.deadline_text || "";
  const noFixedParts = [
    nextDeadlineText,
    enrichment.duration,
    enrichment.participation,
    enrichment.risk_note,
    item.duration,
    item.risk_note
  ];
  const noFixedDisplayText = noFixedParts.find((part) => detectNoFixedDeadline(part)) || noFixedParts.join(" ");
  const noFixed = !nextDeadlineAt && detectNoFixedDeadline(noFixedParts.join(" "))
    ? buildNoFixedDeadline(noFixedDisplayText, "no_fixed_deadline")
    : inferNoFixedDeadline(item);
  return {
    ...item,
    official_url:
      officialUrl && isOfficialOpportunityUrl(officialUrl, item)
        ? officialUrl
        : item.official_url || inferredOfficial.url || null,
    official_url_source:
      officialUrl && isOfficialOpportunityUrl(officialUrl, item)
        ? officialUrlSource || "official_page"
        : item.official_url_source || inferredOfficial.source || null,
    deadline_at: nextDeadlineAt,
    deadline_source: nextDeadlineAt
      ? cleanText(enrichment.deadline_source) || item.deadline_source || null
      : noFixed?.deadline_source || null,
    deadline_confidence: nextDeadlineAt
      ? Number.isFinite(confidence)
        ? confidence
        : item.deadline_confidence ?? null
      : noFixed
        ? Number.isFinite(confidence)
          ? confidence
          : noFixed.deadline_confidence
        : null,
    deadline_text: nextDeadlineAt ? nextDeadlineText || null : noFixed?.deadline_text || null,
    duration: cleanText(enrichment.duration) || item.duration,
    participation: cleanText(enrichment.participation) || item.participation,
    risk_note: cleanText(enrichment.risk_note) || item.risk_note,
    enriched_at: new Date().toISOString(),
    enrichment_error: null
  };
}

function needsDeadlineEnrichment(item) {
  if (!item) return false;
  if (!item.deadline_at && ["stablecoin_earn", "launch", "pre_ipo"].includes(item.type)) return true;
  if (!item.official_url && item.section === "cex") return true;
  if (!item.official_url && inferOfficialUrl(item).url) return true;
  if (item.official_url_source === "official_product" && inferOfficialUrl(item).source === "official_page") return true;
  if (!item.deadline_at && !item.deadline_source && inferNoFixedDeadline(item)) return true;
  if (!item.deadline_source && item.deadline_at) return true;
  return false;
}

async function crawlLinkedOfficialAnnouncements(item, links, { fetchFn, timeoutMs, now, maxLinks = 2 } = {}) {
  const candidates = pickOfficialAnnouncementLinks(links, item, maxLinks);
  const errors = [];
  let nextItem = item;
  for (const url of candidates) {
    try {
      const page = await crawlOfficialPage(url, { fetchFn, timeoutMs });
      const extracted = extractDeadlineFromText(page.text, now);
      const noFixed = buildNoFixedDeadline(page.text);
      const enrichment = {
        official_url: page.url || url,
        official_url_source: "official_page",
        ...(extracted || noFixed || {
          deadline_source: nextItem.deadline_source || null,
          deadline_confidence: nextItem.deadline_confidence ?? null
        })
      };
      nextItem = mergeEnrichment(nextItem, enrichment);
      if (extracted || noFixed) {
        return { item: nextItem, errors };
      }
    } catch (error) {
      errors.push(`linked_official:${String(error.message || error)}`);
    }
  }
  return { item: nextItem, errors };
}

export async function enrichOpportunities(items, options = {}) {
  const config = options.config || {};
  if (!config.opportunityEnrichmentEnabled) return items;

  const now = options.now || new Date();
  const maxItems = Math.max(0, Number(config.opportunityEnrichmentMaxItems ?? 5));
  const grokFallbackMax = Math.max(0, Number(config.opportunityGrokDeadlineFallbackMax ?? 2));
  const timeoutMs = Math.max(1000, Number(config.opportunityOfficialCrawlTimeoutSec ?? 15) * 1000);
  const fetchFn = options.fetchFn || globalThis.fetch;
  const callHermes = options.callHermes;
  let enrichedCount = 0;
  let fallbackCount = 0;

  const enrichedItems = [];
  for (const original of items) {
    let item = { ...original };
    if (!needsDeadlineEnrichment(item) || enrichedCount >= maxItems) {
      enrichedItems.push(item);
      continue;
    }

    enrichedCount += 1;
    const errors = [];
    let officialUrl = findOfficialUrl(item);
    const inferred = inferOfficialUrl(item);
    if (inferred.url && inferred.source === "official_page" && item.official_url_source === "official_product") {
      item.official_url = inferred.url;
      item.official_url_source = inferred.source;
      officialUrl = inferred.url;
    } else if (!officialUrl) {
      if (inferred.url) {
        item.official_url = item.official_url || inferred.url;
        item.official_url_source = item.official_url_source || inferred.source;
        officialUrl = inferred.url;
        if (inferred.source === "official_page") {
          officialUrl = inferred.url;
        }
      }
    }

    if (!item.deadline_at && !item.deadline_source) {
      const noFixed = inferNoFixedDeadline(item);
      if (noFixed) item = mergeEnrichment(item, noFixed);
    }

    const shouldDiscoverFromOfficialProduct =
      officialUrl &&
      item.section === "cex" &&
      item.official_url_source === "official_product" &&
      !item.deadline_at &&
      item.deadline_source !== "no_fixed_deadline";
    const shouldCrawlOfficialUrl =
      officialUrl &&
      (!(item.official_url_source === "official_product" && officialUrl === item.official_url) ||
        shouldDiscoverFromOfficialProduct);
    if (shouldCrawlOfficialUrl) {
      try {
        const page = await crawlOfficialPage(officialUrl, { fetchFn, timeoutMs });
        officialUrl = page.url || officialUrl;
        const extracted = extractDeadlineFromText(page.text, now);
        const noFixed = buildNoFixedDeadline(page.text);
        item = mergeEnrichment(item, {
          official_url: officialUrl,
          official_url_source: item.official_url_source === "official_product" ? "official_product" : "official_page",
          ...(extracted || noFixed || {
            deadline_source: item.deadline_source || "official_page",
            deadline_confidence: item.deadline_at ? item.deadline_confidence || 0.7 : 0.3
          })
        });
        if (!item.deadline_at && item.deadline_source !== "no_fixed_deadline" && page.links?.length) {
          const linked = await crawlLinkedOfficialAnnouncements(item, page.links, {
            fetchFn,
            timeoutMs,
            now,
            maxLinks: 2
          });
          item = linked.item;
          errors.push(...linked.errors);
        }
      } catch (error) {
        errors.push(`official:${String(error.message || error)}`);
      }
    }

    if (!item.deadline_at && !item.deadline_source) {
      const noFixed = inferNoFixedDeadline(item);
      if (noFixed) item = mergeEnrichment(item, noFixed);
    }

    if (
      (!item.deadline_at || !item.official_url) &&
      config.opportunityGrokDeadlineFallbackEnabled &&
      callHermes &&
      fallbackCount < grokFallbackMax
    ) {
      fallbackCount += 1;
      try {
        const raw = await callHermes(buildDeadlineFallbackPrompt(item));
        const parsed = extractJsonPayload(raw);
        if (parsed.ok && parsed.value && typeof parsed.value === "object") {
          item = mergeEnrichment(item, parsed.value);
          const fallbackOfficial = findOfficialUrl(item);
          if (!item.deadline_at && fallbackOfficial && item.official_url_source !== "official_product") {
            const page = await crawlOfficialPage(fallbackOfficial, { fetchFn, timeoutMs });
            const extracted = extractDeadlineFromText(page.text, now);
            const noFixed = buildNoFixedDeadline(page.text);
            if (extracted || noFixed) {
              item = mergeEnrichment(item, { official_url: page.url || fallbackOfficial, ...(extracted || noFixed) });
            }
          }
        } else {
          errors.push(`grok:${parsed.error || "invalid_json"}`);
        }
      } catch (error) {
        errors.push(`grok:${String(error.message || error)}`);
      }
    }

    if (errors.length) {
      item.enrichment_error = errors.join("; ");
      item.enriched_at = item.enriched_at || new Date().toISOString();
    }

    enrichedItems.push(refreshStatus(item, now));
  }

  return enrichedItems;
}
