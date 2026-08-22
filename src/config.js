import dotenv from "dotenv";

import fs from "node:fs";

dotenv.config();

function toBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toInt(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function toFloat(value, defaultValue) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readSharedEnvValue(filePath, key) {
  if (!filePath || !key) return "";
  try {
    const parsed = dotenv.parse(fs.readFileSync(filePath));
    return String(parsed[key] || "").trim();
  } catch {
    return "";
  }
}

function pickAiProvider() {
  const explicit = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.XAI_API_KEY) return "grok";
  return "gemini";
}

export const config = {
  env: process.env.NODE_ENV || "development",
  appPort: toInt(process.env.APP_PORT, 3100),
  pollIntervalSec: toInt(process.env.POLL_INTERVAL_SEC, 180),
  dbPath: process.env.DB_PATH || "./data/risk_engine.db",

  level2Threshold: toInt(process.env.LEVEL2_THRESHOLD, 60),
  xLevel2ThresholdLowerForX: toInt(process.env.X_LEVEL2_THRESHOLD_LOWER_FOR_X, 10),
  level3Threshold: toInt(process.env.LEVEL3_THRESHOLD, 75),
  marketConfirmStrong: toInt(process.env.MARKET_CONFIRM_STRONG, 70),
  level3DailyLimit: toInt(process.env.LEVEL3_DAILY_LIMIT, 3),
  dedupWindowMin: toInt(process.env.DEDUP_WINDOW_MIN, 60),
  level2CooldownMin: toInt(process.env.LEVEL2_COOLDOWN_MIN, 90),

  enableMarketConfirmation: toBool(process.env.ENABLE_MARKET_CONFIRMATION, true),
  enableEngineCycle: toBool(process.env.ENABLE_ENGINE_CYCLE, true),
  enableXSource: toBool(process.env.ENABLE_X_SOURCE, true),
  enableGdeltSource: toBool(process.env.ENABLE_GDELT_SOURCE, true),
  enableRssSource: toBool(process.env.ENABLE_RSS_SOURCE, true),
  enableTradingViewWebhook: toBool(process.env.ENABLE_TRADINGVIEW_WEBHOOK, true),

  tradingViewWebhookSecret: process.env.TRADINGVIEW_WEBHOOK_SECRET || "",
  marketSourceMode: process.env.MARKET_SOURCE_MODE || "mixed",
  marketStaleSeconds: toInt(process.env.MARKET_STALE_SECONDS, 180),
  maxCrossSourceBpsDiff: toInt(process.env.MAX_CROSS_SOURCE_BPS_DIFF, 80),
  latencyTargetSec: toInt(process.env.LATENCY_TARGET_SEC, 300),
  newsLookbackMin: toInt(process.env.NEWS_LOOKBACK_MIN, 120),
  useMarketHoursStaleGuard: toBool(process.env.USE_MARKET_HOURS_STALE_GUARD, true),
  usMarketClosedStaleSeconds: toInt(process.env.US_MARKET_CLOSED_STALE_SECONDS, 259200),

  binanceBaseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
  coinbaseBaseUrl: process.env.COINBASE_BASE_URL || "https://api.coinbase.com",
  massiveBaseUrl: process.env.MASSIVE_BASE_URL || "https://api.polygon.io",
  massiveApiKey: process.env.MASSIVE_API_KEY || "",
  finnhubBaseUrl: process.env.FINNHUB_BASE_URL || "https://finnhub.io/api/v1",
  finnhubApiKey: process.env.FINNHUB_API_KEY || "",
  dxySymbol: process.env.DXY_SYMBOL || "UUP",
  equitiesPrimarySource: (process.env.EQUITIES_PRIMARY_SOURCE || "finnhub").toLowerCase(),

  xBearerToken: process.env.X_BEARER_TOKEN || "",
  xApiBaseUrl: process.env.X_API_BASE_URL || "https://api.x.com/2",
  xMinRequestIntervalSec: toInt(process.env.X_MIN_REQUEST_INTERVAL_SEC, 60),
  xUsersPerCycle: toInt(process.env.X_USERS_PER_CYCLE, 0),
  xMaxResultsPerUser: toInt(process.env.X_MAX_RESULTS_PER_USER, 5),
  xExcludeRetweetsReplies: toBool(process.env.X_EXCLUDE_RETWEETS_REPLIES, true),

  aiProvider: pickAiProvider(),
  aiApiKey: process.env.AI_API_KEY || process.env.XAI_API_KEY || process.env.GEMINI_API_KEY || "",
  aiModel: process.env.AI_MODEL || process.env.GROK_MODEL || process.env.GEMINI_MODEL || "",
  aiBaseUrl: process.env.AI_BASE_URL || "",
  aiTimeoutMs: toInt(process.env.AI_TIMEOUT_MS, 15000),
  aiMaxRequestsPerMin: toInt(process.env.AI_MAX_REQUESTS_PER_MIN, 20),
  aiBlockedCooldownSec: toInt(process.env.AI_BLOCKED_COOLDOWN_SEC, 900),
  aiLlmCandidateMinScore: toInt(process.env.AI_LLM_CANDIDATE_MIN_SCORE, 55),
  aiEventRawTextMaxChars: toInt(process.env.AI_EVENT_RAW_TEXT_MAX_CHARS, 500),
  aiDisable: toBool(process.env.AI_DISABLE, false),

  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  grokApiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY || "",
  grokModel: process.env.GROK_MODEL || "grok-3-latest",

  telegramEnabled: toBool(process.env.TELEGRAM_ENABLED, true),
  telegramMode: (process.env.TELEGRAM_MODE || "relay").toLowerCase(),
  telegramServiceUrl: process.env.TELEGRAM_BOT_API_URL || process.env.TELEGRAM_SERVICE_URL || "http://127.0.0.1:3000",
  telegramServicePath: process.env.TELEGRAM_SERVICE_PATH || "/send-message",
  telegramApiKey:
    process.env.TELEGRAM_API_KEY ||
    process.env.API_KEY ||
    readSharedEnvValue(process.env.TELEGRAM_SHARED_ENV_PATH, "API_KEY"),
  telegramApiKeyHeader: process.env.TELEGRAM_API_KEY_HEADER || "X-API-Key",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  dailyReportEnabled: toBool(process.env.DAILY_REPORT_ENABLED, true),
  dailyReportTimeBj: process.env.DAILY_REPORT_TIME_BJ || "19:04",
  dailyReportChatId: process.env.DAILY_REPORT_CHAT_ID || "-5535517204",
  dailyReportCheckIntervalSec: toInt(process.env.DAILY_REPORT_CHECK_INTERVAL_SEC, 30),
  dailyReportMaxEvents: toInt(process.env.DAILY_REPORT_MAX_EVENTS, 5),
  dailyReportMessageMaxChars: toInt(process.env.DAILY_REPORT_MESSAGE_MAX_CHARS, 1200),

  opportunityMonitorEnabled: toBool(process.env.OPPORTUNITY_MONITOR_ENABLED, true),
  opportunityIntervalSec: toInt(process.env.OPPORTUNITY_INTERVAL_SEC, 86400),
  opportunityScheduleMode: (process.env.OPPORTUNITY_SCHEDULE_MODE || "daily_report").toLowerCase(),
  opportunityCollectionTypes: splitCsv(process.env.OPPORTUNITY_COLLECTION_TYPES || "launch,pre_tge"),
  opportunityDailyReportEnabled: toBool(process.env.OPPORTUNITY_DAILY_REPORT_ENABLED, true),
  opportunityDailyReportTimeBj: process.env.OPPORTUNITY_DAILY_REPORT_TIME_BJ || process.env.DAILY_REPORT_TIME_BJ || "19:04",
  opportunityDailyReportChatId:
    process.env.OPPORTUNITY_DAILY_REPORT_CHAT_ID || process.env.DAILY_REPORT_CHAT_ID || "-5535517204",
  opportunityDailyReportMaxItems: toInt(process.env.OPPORTUNITY_DAILY_REPORT_MAX_ITEMS, 8),
  opportunityDailyReportMaxChars: toInt(process.env.OPPORTUNITY_DAILY_REPORT_MAX_CHARS, 3500),
  opportunityHermesBin: process.env.OPPORTUNITY_HERMES_BIN || "hermes",
  opportunityHermesProfile: process.env.OPPORTUNITY_HERMES_PROFILE || "xintel",
  opportunityHermesTimeoutSec: toInt(process.env.OPPORTUNITY_HERMES_TIMEOUT_SEC, 240),
  xintelHermesMaxConcurrency: toInt(process.env.XINTEL_HERMES_MAX_CONCURRENCY, 1),
  xintelHermesMinIntervalMs: toInt(process.env.XINTEL_HERMES_MIN_INTERVAL_MS, 5000),
  opportunityLookbackHours: toInt(process.env.OPPORTUNITY_LOOKBACK_HOURS, 24),
  opportunityStaleAfterHours: toInt(process.env.OPPORTUNITY_STALE_AFTER_HOURS, 1440),
  opportunityMaxFollowups: toInt(process.env.OPPORTUNITY_MAX_FOLLOWUPS, 1),
  opportunityFocusedQueriesEnabled: toBool(process.env.OPPORTUNITY_FOCUSED_QUERIES_ENABLED, false),
  opportunityQueryMatrixEnabled: toBool(process.env.OPPORTUNITY_QUERY_MATRIX_ENABLED, true),
  opportunityAdaptiveQueryPlanEnabled: toBool(process.env.OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED, true),
  opportunityMaxQueryJobs: toInt(process.env.OPPORTUNITY_MAX_QUERY_JOBS, 3),
  opportunityEmptyResponseBackoffSec: toInt(process.env.OPPORTUNITY_EMPTY_RESPONSE_BACKOFF_SEC, 3600),
  opportunityQuotaErrorBackoffSec: toInt(process.env.OPPORTUNITY_QUOTA_ERROR_BACKOFF_SEC, 43200),
  opportunityEnrichmentEnabled: toBool(process.env.OPPORTUNITY_ENRICHMENT_ENABLED, true),
  opportunityEnrichmentMaxItems: toInt(process.env.OPPORTUNITY_ENRICHMENT_MAX_ITEMS, 5),
  opportunityExistingEnrichmentMaxItems: toInt(process.env.OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS, 2),
  opportunityEnrichmentRetryCooldownHours: toInt(process.env.OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS, 12),
  opportunityOfficialCrawlTimeoutSec: toInt(process.env.OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC, 15),
  opportunityGrokDeadlineFallbackEnabled: toBool(process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED, true),
  opportunityGrokDeadlineFallbackMax: toInt(process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX, 1),

  binanceMajorNewsEnabled: toBool(process.env.BINANCE_MAJOR_NEWS_ENABLED, true),
  binanceMajorNewsCollectionTimeBj: process.env.BINANCE_MAJOR_NEWS_COLLECTION_TIME_BJ || "18:15",
  binanceMajorNewsDailyTimeBj: process.env.BINANCE_MAJOR_NEWS_DAILY_TIME_BJ || "19:01",
  binanceMajorNewsDailyChatId:
    process.env.BINANCE_MAJOR_NEWS_DAILY_CHAT_ID || process.env.DAILY_REPORT_CHAT_ID || "-5535517204",
  binanceMajorNewsChunkSize: toInt(process.env.BINANCE_MAJOR_NEWS_CHUNK_SIZE, 60),
  binanceMajorNewsTimeoutSec: toInt(process.env.BINANCE_MAJOR_NEWS_HTTP_TIMEOUT_SEC, 20),
  binanceMajorNewsMaxItems: toInt(process.env.BINANCE_MAJOR_NEWS_MAX_ITEMS, 30),
  binanceMajorNewsMessageMaxChars: toInt(process.env.BINANCE_MAJOR_NEWS_MESSAGE_MAX_CHARS, 3800),
  binanceMajorNewsMarketDatabaseUrl:
    process.env.BINANCE_MAJOR_NEWS_MARKET_DATABASE_URL ||
    "postgres://market_engine:market_engine@127.0.0.1:5432/market_engine",
  binanceMajorNewsMarketStatementTimeoutMs: toInt(process.env.BINANCE_MAJOR_NEWS_MARKET_STATEMENT_TIMEOUT_MS, 5000),
  binanceMajorNewsMarketPriceMaxAgeMinutes: toInt(process.env.BINANCE_MAJOR_NEWS_MARKET_PRICE_MAX_AGE_MINUTES, 45),
  binanceMajorNewsMarketCapMaxAgeHours: toInt(process.env.BINANCE_MAJOR_NEWS_MARKET_CAP_MAX_AGE_HOURS, 36),

  securityIncidentMonitorEnabled: toBool(process.env.SECURITY_INCIDENT_MONITOR_ENABLED, true),
  securityIncidentIntervalSec: toInt(process.env.SECURITY_INCIDENT_INTERVAL_SEC, 1200),
  securityIncidentLargeUsd: toInt(process.env.SECURITY_INCIDENT_LARGE_USD, 5000000),
  securityIncidentCriticalChatId: process.env.SECURITY_INCIDENT_CRITICAL_CHAT_ID || "-5519280405",
  securityIncidentAnomalyChatId: process.env.SECURITY_INCIDENT_ANOMALY_CHAT_ID || "-5363003109",

  keywordsFile: process.env.KEYWORDS_FILE || "./config/keywords.txt",
  suppressKeywordsFile: process.env.SUPPRESS_KEYWORDS_FILE || "./config/suppress_keywords.txt",
  xWhitelistFile: process.env.X_WHITELIST_FILE || "./config/x_whitelist.txt",
  rssFeeds: splitCsv(
    process.env.RSS_FEEDS ||
      "https://www.federalreserve.gov/feeds/press_all.xml,https://www.ecb.europa.eu/rss/press.html"
  ),
  gdeltQuery:
    process.env.GDELT_QUERY ||
    '(sanction OR tariff OR ceasefire OR strike OR invasion OR embargo OR OPEC OR strait OR pipeline OR "central bank" OR "military drill")',
  gdeltMaxRecords: toInt(process.env.GDELT_MAX_RECORDS, 50),
  gdeltMinRequestIntervalSec: toInt(process.env.GDELT_MIN_REQUEST_INTERVAL_SEC, 10),
  gdelt429CooldownSec: toInt(process.env.GDELT_429_COOLDOWN_SEC, 900),

  severeBtcDropPct: toFloat(process.env.SEVERE_BTC_DROP_PCT, -2),
  severeEquityDropPct: toFloat(process.env.SEVERE_EQUITY_DROP_PCT, -1),
  safeHavenGoldUpPct: toFloat(process.env.SAFE_HAVEN_GOLD_UP_PCT, 0.4),
  dxyTighteningUpPct: toFloat(process.env.DXY_TIGHTENING_UP_PCT, 0.2)
};
