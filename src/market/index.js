import { fetchJson } from "../http.js";
import { clamp, nowSec, pctChange } from "../utils.js";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchBinancePriceAnd1h(baseUrl, symbol) {
  const [ticker, klines] = await Promise.all([
    fetchJson(`${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),
    fetchJson(`${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=2`)
  ]);

  const current = toNumber(ticker?.price);
  const lastKline = Array.isArray(klines) && klines.length > 0 ? klines[klines.length - 1] : null;
  const prevKline = Array.isArray(klines) && klines.length > 1 ? klines[0] : null;
  const price1hAgo = prevKline ? toNumber(prevKline[4]) : null;
  const lastCloseTimeSec = lastKline ? Math.floor(Number(lastKline[6]) / 1000) : null;

  return {
    source: "binance",
    symbol,
    current,
    price1hAgo,
    change1hPct: pctChange(current, price1hAgo),
    lastUpdateSec: lastCloseTimeSec || nowSec()
  };
}

async function fetchCoinbaseSpot(baseUrl, product) {
  const json = await fetchJson(`${baseUrl}/v2/prices/${encodeURIComponent(product)}/spot`);
  const current = toNumber(json?.data?.amount);
  return {
    source: "coinbase",
    symbol: product,
    current,
    price1hAgo: null,
    change1hPct: null,
    lastUpdateSec: nowSec()
  };
}

async function fetchMassiveMinuteChange(baseUrl, apiKey, ticker) {
  const endMs = Date.now();
  const startMs = endMs - 70 * 60 * 1000;
  const url = `${baseUrl}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${startMs}/${endMs}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, {}, 12000);
  const rows = json?.results || [];
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(`massive_not_enough_data:${ticker}`);
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const firstPrice = toNumber(first?.o ?? first?.c);
  const lastPrice = toNumber(last?.c ?? last?.o);
  const lastUpdateSec = Math.floor(toNumber(last?.t) / 1000) || nowSec();

  return {
    source: "massive",
    symbol: ticker,
    current: lastPrice,
    price1hAgo: firstPrice,
    change1hPct: pctChange(lastPrice, firstPrice),
    lastUpdateSec
  };
}

async function fetchFinnhubCandle(baseUrl, apiKey, endpoint, symbol) {
  const to = nowSec();
  const from = to - 70 * 60;
  const url = `${baseUrl}/${endpoint}/candle?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, {}, 12000);
  if (json?.s !== "ok" || !Array.isArray(json?.c) || json.c.length < 2) {
    throw new Error(`finnhub_no_candle:${endpoint}:${symbol}`);
  }
  const closes = json.c;
  const times = json.t || [];
  const current = toNumber(closes[closes.length - 1]);
  const price1hAgo = toNumber(closes[0]);
  const lastUpdateSec = toNumber(times[times.length - 1]) || nowSec();
  return {
    source: "finnhub",
    symbol,
    current,
    price1hAgo,
    change1hPct: pctChange(current, price1hAgo),
    lastUpdateSec
  };
}

async function fetchFinnhubQuote(baseUrl, apiKey, symbol) {
  const json = await fetchJson(
    `${baseUrl}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`,
    {},
    10000
  );
  const current = toNumber(json?.c);
  const previousClose = toNumber(json?.pc);
  const dayOpen = toNumber(json?.o);
  const ts = toNumber(json?.t);
  const intradayBase = Number.isFinite(dayOpen) && dayOpen > 0 ? dayOpen : previousClose;
  return {
    source: "finnhub",
    symbol,
    current,
    price1hAgo: intradayBase,
    change1hPct: pctChange(current, intradayBase),
    lastUpdateSec: ts || nowSec()
  };
}

function asStale(lastUpdateSec) {
  if (!Number.isFinite(lastUpdateSec)) return Number.POSITIVE_INFINITY;
  return nowSec() - lastUpdateSec;
}

function bpsDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return Math.abs(((a - b) / a) * 10000);
}

function asFinnhubEquitySymbol(symbol) {
  if (symbol === "I:SPX") return "SPY";
  return symbol;
}

function getNewYorkParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    weekday: pick("weekday"),
    hour: Number.parseInt(pick("hour"), 10),
    minute: Number.parseInt(pick("minute"), 10)
  };
}

function isUsRegularMarketOpen(tsMs) {
  const { weekday, hour, minute } = getNewYorkParts(new Date(tsMs));
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)) return false;
  const minutes = hour * 60 + minute;
  // 09:30 - 16:00 ET
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

export class MarketModule {
  constructor(config, tradingViewSignalStore) {
    this.config = config;
    this.tradingViewSignalStore = tradingViewSignalStore;
  }

  async fetchBtc() {
    const primary = await fetchBinancePriceAnd1h(this.config.binanceBaseUrl, "BTCUSDT");
    let backup = null;
    try {
      backup = await fetchCoinbaseSpot(this.config.coinbaseBaseUrl, "BTC-USD");
    } catch {
      backup = null;
    }
    return { primary, backup };
  }

  async fetchGold() {
    const primary = await fetchBinancePriceAnd1h(this.config.binanceBaseUrl, "PAXGUSDT");
    let backup = null;
    try {
      backup = await fetchCoinbaseSpot(this.config.coinbaseBaseUrl, "PAXG-USD");
    } catch {
      backup = null;
    }
    return { primary, backup };
  }

  async fetchEquities() {
    const symbols = ["I:SPX", "QQQ"];
    const primarySource = String(this.config.equitiesPrimarySource || "finnhub").toLowerCase();
    const points = [];

    for (const symbol of symbols) {
      const finnhubSymbol = asFinnhubEquitySymbol(symbol);
      if (primarySource === "massive") {
        try {
          points.push(await fetchMassiveMinuteChange(this.config.massiveBaseUrl, this.config.massiveApiKey, symbol));
          continue;
        } catch {
          points.push(await fetchFinnhubQuote(this.config.finnhubBaseUrl, this.config.finnhubApiKey, finnhubSymbol));
          continue;
        }
      }

      // Default path: Finnhub as primary, Massive as fallback (if Massive key is available)
      try {
        points.push(await fetchFinnhubQuote(this.config.finnhubBaseUrl, this.config.finnhubApiKey, finnhubSymbol));
      } catch {
        if (this.config.massiveApiKey) {
          points.push(await fetchMassiveMinuteChange(this.config.massiveBaseUrl, this.config.massiveApiKey, symbol));
        } else {
          throw new Error(`equity_source_failed:${symbol}`);
        }
      }
    }

    const valid = points.filter((p) => Number.isFinite(p.change1hPct));
    if (valid.length === 0) {
      throw new Error("equities_no_valid_points");
    }

    const avgChange = valid.reduce((sum, p) => sum + p.change1hPct, 0) / valid.length;
    const latestSec = Math.min(...valid.map((p) => p.lastUpdateSec || nowSec()));
    return {
      source: valid.map((v) => v.source).join("+"),
      symbol: "SPX+QQQ",
      current: null,
      price1hAgo: null,
      change1hPct: avgChange,
      lastUpdateSec: latestSec,
      points: valid
    };
  }

  async fetchDxy() {
    const symbolCandidates = [this.config.dxySymbol, "UUP", "USDX"].filter(Boolean);
    for (const symbol of symbolCandidates) {
      try {
        return await fetchFinnhubQuote(this.config.finnhubBaseUrl, this.config.finnhubApiKey, symbol);
      } catch {
        // continue
      }
    }

    try {
      return await fetchFinnhubCandle(this.config.finnhubBaseUrl, this.config.finnhubApiKey, "index", this.config.dxySymbol);
    } catch {
      try {
        return await fetchFinnhubQuote(this.config.finnhubBaseUrl, this.config.finnhubApiKey, this.config.dxySymbol);
      } catch {
        return await fetchFinnhubCandle(this.config.finnhubBaseUrl, this.config.finnhubApiKey, "forex", "OANDA:USDX");
      }
    }
  }

  computeConfirmation(inputs) {
    const reasons = [];
    let score = 0;

    if (Number.isFinite(inputs.btc.change1hPct) && inputs.btc.change1hPct <= this.config.severeBtcDropPct) {
      score += 30;
      reasons.push(`BTC 1h下跌 ${inputs.btc.change1hPct.toFixed(2)}%`);
    }

    if (
      Number.isFinite(inputs.equities.change1hPct) &&
      inputs.equities.change1hPct <= this.config.severeEquityDropPct
    ) {
      score += 20;
      reasons.push(`美股代理1h下跌 ${inputs.equities.change1hPct.toFixed(2)}%`);
    }

    if (
      Number.isFinite(inputs.gold.change1hPct) &&
      inputs.gold.change1hPct >= this.config.safeHavenGoldUpPct &&
      Number.isFinite(inputs.btc.change1hPct) &&
      inputs.btc.change1hPct < 0
    ) {
      score += 20;
      reasons.push(`黄金走强且风险资产走弱 ${inputs.gold.change1hPct.toFixed(2)}%`);
    }

    if (
      Number.isFinite(inputs.dxy.change1hPct) &&
      inputs.dxy.change1hPct >= this.config.dxyTighteningUpPct &&
      Number.isFinite(inputs.btc.change1hPct) &&
      inputs.btc.change1hPct < 0
    ) {
      score += 20;
      reasons.push(`DXY上行且风险资产走弱 ${inputs.dxy.change1hPct.toFixed(2)}%`);
    }

    const volatilityBase = [inputs.btc.change1hPct, inputs.equities.change1hPct].filter(Number.isFinite);
    if (volatilityBase.some((v) => Math.abs(v) >= 2.5)) {
      score += 10;
      reasons.push("短窗波动放大");
    }

    const tvSignal = this.tradingViewSignalStore.getRecentSignal(15 * 60);
    if (tvSignal) {
      reasons.push(`TradingView补充信号:${tvSignal.direction}`);
    }

    return {
      confirmation_score: clamp(score, 0, 100),
      reasons
    };
  }

  async getSnapshot() {
    const anomalyReasons = [];
    const raw = {};

    let btc;
    let gold;
    let equities;
    let dxy;

    try {
      const btcData = await this.fetchBtc();
      btc = btcData.primary;
      raw.btc = btcData;
      if (btcData.backup?.current && btc.current) {
        const diff = bpsDiff(btc.current, btcData.backup.current);
        if (Number.isFinite(diff) && diff > this.config.maxCrossSourceBpsDiff) {
          anomalyReasons.push(`BTC主备价差过大:${diff.toFixed(1)}bps`);
        }
      }
    } catch (error) {
      anomalyReasons.push(`BTC数据失败:${String(error.message || error)}`);
    }

    try {
      const goldData = await this.fetchGold();
      gold = goldData.primary;
      raw.gold = goldData;
      if (goldData.backup?.current && gold.current) {
        const diff = bpsDiff(gold.current, goldData.backup.current);
        if (Number.isFinite(diff) && diff > this.config.maxCrossSourceBpsDiff) {
          anomalyReasons.push(`黄金主备价差过大:${diff.toFixed(1)}bps`);
        }
      }
    } catch (error) {
      anomalyReasons.push(`黄金数据失败:${String(error.message || error)}`);
    }

    try {
      equities = await this.fetchEquities();
      raw.equities = equities;
    } catch (error) {
      anomalyReasons.push(`美股代理数据失败:${String(error.message || error)}`);
    }

    try {
      dxy = await this.fetchDxy();
      raw.dxy = dxy;
    } catch (error) {
      anomalyReasons.push(`DXY数据失败:${String(error.message || error)}`);
    }

    const staleThresholdFor = (item) => {
      const strict = this.config.marketStaleSeconds;
      if (!this.config.useMarketHoursStaleGuard) return strict;
      if (!item?.source?.includes("finnhub")) return strict;

      // Equities proxy and DXY(UUP/USDX) follow US regular trading hours.
      const isUsProxy =
        item.symbol === "SPX+QQQ" ||
        item.symbol === "SPY" ||
        item.symbol === "QQQ" ||
        item.symbol === "UUP" ||
        item.symbol === "USDX" ||
        item.symbol === this.config.dxySymbol;

      if (!isUsProxy) return strict;
      if (isUsRegularMarketOpen(Date.now())) return strict;
      return this.config.usMarketClosedStaleSeconds;
    };

    for (const item of [btc, gold, equities, dxy]) {
      if (!item) continue;
      const stale = asStale(item.lastUpdateSec);
      const threshold = staleThresholdFor(item);
      if (stale > threshold) {
        anomalyReasons.push(`${item.symbol}数据过旧:${stale}s(阈值${threshold}s)`);
      }
    }

    const missing = [];
    if (!btc) missing.push("BTC");
    if (!equities) missing.push("EQUITIES");
    if (!gold) missing.push("GOLD");
    if (!dxy) missing.push("DXY");
    if (missing.length > 0) {
      anomalyReasons.push(`关键资产缺失:${missing.join(",")}`);
    }

    let confirmation = { confirmation_score: 0, reasons: [] };
    if (btc && equities && gold && dxy) {
      confirmation = this.computeConfirmation({ btc, equities, gold, dxy });
    } else {
      anomalyReasons.push("确认分无法完整计算");
    }

    return {
      btc_change_1h: btc?.change1hPct ?? null,
      equities_change_1h: equities?.change1hPct ?? null,
      gold_change_1h: gold?.change1hPct ?? null,
      dxy_change_1h: dxy?.change1hPct ?? null,
      confirmation_score: confirmation.confirmation_score,
      confirmation_reasons: confirmation.reasons,
      is_data_anomaly: anomalyReasons.length > 0,
      anomaly_reasons: anomalyReasons,
      raw
    };
  }
}
