import pg from "pg";

const { Pool } = pg;

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateSymbols(symbol) {
  const base = String(symbol || "").trim().toUpperCase();
  if (!base) return [];
  const direct = `${base}USDT`;
  return base.startsWith("1000") ? [direct] : [direct, `1000${base}USDT`];
}

function chooseCandidate(item, bySymbol) {
  for (const symbol of candidateSymbols(item?.symbol)) {
    if (bySymbol.has(symbol)) return bySymbol.get(symbol);
  }
  return null;
}

function parseTime(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function isFresh(value, maxAgeMs, nowMs) {
  const ts = parseTime(value);
  return ts !== null && ts <= nowMs + 5 * 60 * 1000 && nowMs - ts <= maxAgeMs;
}

export class BinanceMajorNewsMarketMetrics {
  constructor({ config, queryFn = null, nowFn = () => Date.now() }) {
    this.config = config;
    this.nowFn = nowFn;
    this.pool = null;
    if (queryFn) {
      this.queryFn = queryFn;
    } else {
      const statementTimeoutMs = Math.max(1000, Number(config.binanceMajorNewsMarketStatementTimeoutMs || 5000));
      this.pool = new Pool({
        connectionString: config.binanceMajorNewsMarketDatabaseUrl,
        max: 1,
        application_name: "ainews-binance-major-news",
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 3000,
        options: `-c default_transaction_read_only=on -c statement_timeout=${statementTimeoutMs}`
      });
      this.queryFn = async (sql, values) => (await this.pool.query(sql, values)).rows;
    }
  }

  async getMarketCaps(symbols) {
    return this.queryFn(
      `SELECT DISTINCT ON (symbol)
         symbol, date, market_cap, source, updated_at
       FROM marketcap_daily
       WHERE symbol = ANY($1::text[])
       ORDER BY symbol, date DESC`,
      [symbols]
    );
  }

  async getPrices(symbols) {
    const cutoff = new Date(this.nowFn() - 28 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "+00");
    const rows = await this.queryFn(
      `SELECT symbol, ts, close
       FROM bars_5m
       WHERE symbol = ANY($1::text[])
         AND ts >= $2
       ORDER BY symbol, ts DESC`,
      [symbols, cutoff]
    );
    const grouped = new Map();
    for (const row of rows) {
      const symbol = String(row.symbol || "").toUpperCase();
      if (!grouped.has(symbol)) grouped.set(symbol, []);
      grouped.get(symbol).push(row);
    }
    const result = [];
    for (const [symbol, bars] of grouped) {
      const latest = bars[0];
      const latestMs = parseTime(latest?.ts);
      if (latestMs === null) continue;
      const targetMs = latestMs - 24 * 60 * 60 * 1000;
      const previous = bars.find((row) => {
        const ts = parseTime(row.ts);
        return ts !== null && ts <= targetMs;
      });
      result.push({
        symbol,
        latest_ts: latest.ts,
        latest_close: latest.close,
        previous_ts: previous?.ts || null,
        previous_close: previous?.close ?? null
      });
    }
    return result;
  }

  async enrich(items) {
    const rows = Array.isArray(items) ? items : [];
    if (rows.length === 0) return rows;
    const symbols = [...new Set(rows.flatMap((item) => candidateSymbols(item.symbol)))];
    const [capsResult, pricesResult] = await Promise.allSettled([
      this.getMarketCaps(symbols),
      this.getPrices(symbols)
    ]);
    const caps = capsResult.status === "fulfilled" ? capsResult.value : [];
    const prices = pricesResult.status === "fulfilled" ? pricesResult.value : [];
    const capBySymbol = new Map(caps.map((row) => [String(row.symbol).toUpperCase(), row]));
    const priceBySymbol = new Map(prices.map((row) => [String(row.symbol).toUpperCase(), row]));
    const nowMs = this.nowFn();
    const capMaxAgeMs = Math.max(1, Number(this.config.binanceMajorNewsMarketCapMaxAgeHours || 36)) * 60 * 60 * 1000;
    const priceMaxAgeMs = Math.max(1, Number(this.config.binanceMajorNewsMarketPriceMaxAgeMinutes || 45)) * 60 * 1000;

    return rows.map((item) => {
      const cap = chooseCandidate(item, capBySymbol);
      const price = chooseCandidate(item, priceBySymbol);
      const capFresh = cap && isFresh(cap.updated_at, capMaxAgeMs, nowMs);
      const priceFresh = price && isFresh(price.latest_ts, priceMaxAgeMs, nowMs);
      const latest = priceFresh ? safeNumber(price.latest_close) : null;
      const previous = priceFresh ? safeNumber(price.previous_close) : null;
      const latestTs = parseTime(price?.latest_ts);
      const previousTs = parseTime(price?.previous_ts);
      const gapHours = latestTs !== null && previousTs !== null ? (latestTs - previousTs) / 3600000 : null;
      const valid24h = latest !== null && previous !== null && previous > 0 && gapHours >= 23 && gapHours <= 27;
      const base = String(item.symbol || "").toUpperCase();
      const priceScale = price && String(price.symbol).startsWith("1000") && !base.startsWith("1000") ? 1000 : 1;
      return {
        ...item,
        circulating_market_cap_usd: capFresh ? safeNumber(cap.market_cap) : null,
        current_price_usd: latest === null ? null : latest / priceScale,
        price_change_percentage_24h: valid24h ? ((latest / previous) - 1) * 100 : null,
        market_cap_source: capFresh ? `local:marketcap_daily:${cap.source || "unknown"}` : null,
        price_change_source: priceFresh ? `local:bars_5m:${price.symbol}` : null,
        market_metrics_updated_at: priceFresh ? price.latest_ts : capFresh ? cap.updated_at : null
      };
    });
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

export const _test = { candidateSymbols, chooseCandidate, isFresh };
