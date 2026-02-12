import dotenv from "dotenv";

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
  level3Threshold: toInt(process.env.LEVEL3_THRESHOLD, 75),
  marketConfirmStrong: toInt(process.env.MARKET_CONFIRM_STRONG, 70),
  level3DailyLimit: toInt(process.env.LEVEL3_DAILY_LIMIT, 3),
  dedupWindowMin: toInt(process.env.DEDUP_WINDOW_MIN, 60),
  level2CooldownMin: toInt(process.env.LEVEL2_COOLDOWN_MIN, 90),

  enableMarketConfirmation: toBool(process.env.ENABLE_MARKET_CONFIRMATION, true),
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
  xMinRequestIntervalSec: toInt(process.env.X_MIN_REQUEST_INTERVAL_SEC, 300),
  xUsersPerCycle: toInt(process.env.X_USERS_PER_CYCLE, 3),
  xMaxResultsPerUser: toInt(process.env.X_MAX_RESULTS_PER_USER, 5),
  xExcludeRetweetsReplies: toBool(process.env.X_EXCLUDE_RETWEETS_REPLIES, true),

  aiProvider: pickAiProvider(),
  aiApiKey: process.env.AI_API_KEY || process.env.XAI_API_KEY || process.env.GEMINI_API_KEY || "",
  aiModel: process.env.AI_MODEL || process.env.GROK_MODEL || process.env.GEMINI_MODEL || "",
  aiBaseUrl: process.env.AI_BASE_URL || "",
  aiTimeoutMs: toInt(process.env.AI_TIMEOUT_MS, 15000),
  aiDisable: toBool(process.env.AI_DISABLE, false),

  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  grokApiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY || "",
  grokModel: process.env.GROK_MODEL || "grok-3-latest",

  telegramEnabled: toBool(process.env.TELEGRAM_ENABLED, true),
  telegramMode: (process.env.TELEGRAM_MODE || "relay").toLowerCase(), // relay | direct
  telegramServiceUrl: process.env.TELEGRAM_BOT_API_URL || process.env.TELEGRAM_SERVICE_URL || "http://127.0.0.1:3000",
  telegramServicePath: process.env.TELEGRAM_SERVICE_PATH || "/send-message",
  telegramApiKey: process.env.TELEGRAM_API_KEY || process.env.API_KEY || "",
  telegramApiKeyHeader: process.env.TELEGRAM_API_KEY_HEADER || "X-API-Key",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",

  keywordsFile: process.env.KEYWORDS_FILE || "./config/keywords.txt",
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
