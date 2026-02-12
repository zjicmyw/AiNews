import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

function nowIso() {
  return new Date().toISOString();
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readLines(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return {
      name,
      status: result.status || "OK",
      detail: result.detail || "",
      ms: Date.now() - start
    };
  } catch (error) {
    return {
      name,
      status: "FAIL",
      detail: String(error?.message || error),
      ms: Date.now() - start
    };
  }
}

async function checkBinance() {
  const base = process.env.BINANCE_BASE_URL || "https://api.binance.com";
  const btc = await fetchWithTimeout(`${base}/api/v3/ticker/price?symbol=BTCUSDT`);
  if (!btc.ok) return { status: "FAIL", detail: `BTCUSDT status=${btc.status}` };

  const gold = await fetchWithTimeout(`${base}/api/v3/ticker/price?symbol=PAXGUSDT`);
  if (!gold.ok) return { status: "FAIL", detail: `PAXGUSDT status=${gold.status}` };

  return { status: "OK", detail: "BTCUSDT + PAXGUSDT available" };
}

async function checkCoinbase() {
  const base = process.env.COINBASE_BASE_URL || "https://api.coinbase.com";
  const btc = await fetchWithTimeout(`${base}/v2/prices/BTC-USD/spot`);
  if (!btc.ok) return { status: "FAIL", detail: `BTC-USD status=${btc.status}` };

  const gold = await fetchWithTimeout(`${base}/v2/prices/PAXG-USD/spot`);
  if (!gold.ok) return { status: "FAIL", detail: `PAXG-USD status=${gold.status}` };

  return { status: "OK", detail: "BTC-USD + PAXG-USD available" };
}

async function checkMassive() {
  const equitiesPrimary = String(process.env.EQUITIES_PRIMARY_SOURCE || "finnhub").toLowerCase();
  if (equitiesPrimary === "finnhub") {
    return { status: "SKIP", detail: "EQUITIES_PRIMARY_SOURCE=finnhub" };
  }

  const key = process.env.MASSIVE_API_KEY || "";
  if (!key) return { status: "SKIP", detail: "MASSIVE_API_KEY not configured" };

  const base = process.env.MASSIVE_BASE_URL || "https://api.polygon.io";
  const to = Date.now();
  const from = to - 15 * 60 * 1000;
  const url = `${base}/v2/aggs/ticker/I:SPX/range/1/minute/${from}/${to}?adjusted=true&sort=desc&limit=10&apiKey=${encodeURIComponent(
    key
  )}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    return { status: "FAIL", detail: `status=${resp.status} body=${resp.text.slice(0, 120)}` };
  }

  return { status: "OK", detail: "Massive SPX aggregate available" };
}

async function checkFinnhub() {
  const key = process.env.FINNHUB_API_KEY || "";
  if (!key) return { status: "SKIP", detail: "FINNHUB_API_KEY not configured" };

  const base = process.env.FINNHUB_BASE_URL || "https://finnhub.io/api/v1";
  const dxySymbol = process.env.DXY_SYMBOL || "UUP";

  const qqq = await fetchWithTimeout(`${base}/quote?symbol=QQQ&token=${encodeURIComponent(key)}`);
  if (!qqq.ok) return { status: "FAIL", detail: `QQQ quote status=${qqq.status}` };

  const dxy = await fetchWithTimeout(`${base}/quote?symbol=${encodeURIComponent(dxySymbol)}&token=${encodeURIComponent(key)}`);
  if (!dxy.ok) return { status: "FAIL", detail: `${dxySymbol} quote status=${dxy.status}` };

  return { status: "OK", detail: `QQQ + ${dxySymbol} quote available` };
}

async function checkXApi() {
  const token = process.env.X_BEARER_TOKEN || "";
  if (!token) return { status: "SKIP", detail: "X_BEARER_TOKEN not configured" };

  const base = process.env.X_API_BASE_URL || "https://api.x.com/2";
  const whitelist = readLines(process.env.X_WHITELIST_FILE || "./config/x_whitelist.txt");
  const firstUser = (whitelist[0] || "@zoomerfied").replace(/^@/, "");
  const url = `${base}/users/by/username/${encodeURIComponent(firstUser)}`;

  const resp = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!resp.ok) {
    return { status: "FAIL", detail: `${firstUser} status=${resp.status} body=${resp.text.slice(0, 120)}` };
  }

  return { status: "OK", detail: `X user lookup available (${firstUser})` };
}

async function checkAiProvider() {
  const provider = (String(process.env.AI_PROVIDER || "").toLowerCase() || (process.env.XAI_API_KEY ? "grok" : "gemini"));

  if (provider === "grok" || provider === "xai") {
    const key = process.env.AI_API_KEY || process.env.XAI_API_KEY || process.env.GROK_API_KEY || "";
    if (!key) return { status: "SKIP", detail: "Grok key not configured" };

    const base = process.env.AI_BASE_URL || "https://api.x.ai";
    const resp = await fetchWithTimeout(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` }
    });

    if (!resp.ok) {
      return { status: "FAIL", detail: `grok status=${resp.status} body=${resp.text.slice(0, 160)}` };
    }

    return { status: "OK", detail: "Grok models endpoint available" };
  }

  const key = process.env.AI_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!key) return { status: "SKIP", detail: "Gemini key not configured" };

  const base = process.env.AI_BASE_URL || "https://generativelanguage.googleapis.com";
  const resp = await fetchWithTimeout(`${base}/v1beta/models?key=${encodeURIComponent(key)}`);
  if (!resp.ok) {
    return { status: "FAIL", detail: `gemini status=${resp.status} body=${resp.text.slice(0, 160)}` };
  }

  return { status: "OK", detail: "Gemini models endpoint available" };
}

async function checkTelegram() {
  const mode = String(process.env.TELEGRAM_MODE || "relay").toLowerCase();

  if (mode === "direct") {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token) return { status: "SKIP", detail: "TELEGRAM_BOT_TOKEN not configured for direct mode" };

    const resp = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
    if (!resp.ok) return { status: "FAIL", detail: `status=${resp.status} body=${resp.text.slice(0, 120)}` };
    return { status: "OK", detail: "Telegram direct available (getMe)" };
  }

  const serviceUrl = process.env.TELEGRAM_BOT_API_URL || process.env.TELEGRAM_SERVICE_URL || "http://127.0.0.1:3000";
  const apiKey = process.env.TELEGRAM_API_KEY || process.env.API_KEY || "";
  if (!apiKey) return { status: "SKIP", detail: "TELEGRAM_API_KEY/API_KEY not configured for relay mode" };

  const healthPath = process.env.TELEGRAM_SERVICE_HEALTH_PATH || "/health";
  const base = serviceUrl.replace(/\/+$/, "");

  const healthResp = await fetchWithTimeout(`${base}${healthPath}`);
  if (healthResp.ok) {
    return { status: "OK", detail: `Telegram relay reachable (${base}${healthPath})` };
  }

  const rootResp = await fetchWithTimeout(`${base}/`);
  if ([200, 401, 403, 404].includes(rootResp.status)) {
    return { status: "OK", detail: `Telegram relay process reachable (${base})` };
  }

  return { status: "FAIL", detail: `relay unreachable status=${healthResp.status}/${rootResp.status}` };
}

async function checkRssFeeds() {
  const feeds = parseCsv(
    process.env.RSS_FEEDS ||
      "https://www.federalreserve.gov/feeds/press_all.xml,https://www.ecb.europa.eu/rss/press.html"
  );

  if (feeds.length === 0) return { status: "SKIP", detail: "RSS_FEEDS not configured" };

  const url = feeds[0];
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) return { status: "FAIL", detail: `feed status=${resp.status} url=${url}` };
  return { status: "OK", detail: `RSS reachable (${url})` };
}

async function checkGdelt() {
  const query =
    process.env.GDELT_QUERY ||
    '(sanction OR tariff OR ceasefire OR strike OR invasion OR embargo OR OPEC OR strait OR pipeline OR "central bank" OR "military drill")';

  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    maxrecords: "1",
    format: "json",
    sort: "DateDesc"
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
  const resp = await fetchWithTimeout(url, {}, 20000);
  if (!resp.ok) {
    if (resp.status === 429) {
      return { status: "SKIP", detail: "rate_limited_429 (respect GDELT interval/cooldown)" };
    }
    return { status: "FAIL", detail: `status=${resp.status} body=${resp.text.slice(0, 140)}` };
  }
  return { status: "OK", detail: "GDELT reachable" };
}

async function main() {
  const checks = [
    runCheck("Binance", checkBinance),
    runCheck("Coinbase", checkCoinbase),
    runCheck("Massive", checkMassive),
    runCheck("Finnhub", checkFinnhub),
    runCheck("X API", checkXApi),
    runCheck("AI Provider", checkAiProvider),
    runCheck("Telegram", checkTelegram),
    runCheck("RSS", checkRssFeeds),
    runCheck("GDELT", checkGdelt)
  ];

  const results = await Promise.all(checks);
  const failed = results.filter((row) => row.status === "FAIL");
  const ok = results.filter((row) => row.status === "OK");
  const skipped = results.filter((row) => row.status === "SKIP");

  console.log(`\n[API CHECK] ${nowIso()}`);
  for (const row of results) {
    console.log(`${row.status.padEnd(5)} | ${row.name.padEnd(11)} | ${String(row.ms).padStart(5)}ms | ${row.detail}`);
  }

  console.log(`\nSummary: OK=${ok.length}, FAIL=${failed.length}, SKIP=${skipped.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`FATAL | ${String(error?.message || error)}`);
  process.exit(1);
});

