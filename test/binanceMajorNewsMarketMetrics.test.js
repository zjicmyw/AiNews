import test from "node:test";
import assert from "node:assert/strict";

import { BinanceMajorNewsMarketMetrics, _test } from "../src/binanceMajorNewsMarketMetrics.js";

test("candidateSymbols supports local 1000x futures symbols", () => {
  assert.deepEqual(_test.candidateSymbols("BONK"), ["BONKUSDT", "1000BONKUSDT"]);
  assert.deepEqual(_test.candidateSymbols("1000SATS"), ["1000SATSUSDT"]);
});

test("local market metrics use fresh market cap and bars to compute 24h change", async () => {
  const now = Date.parse("2026-08-21T00:45:00.000Z");
  const queryFn = async (sql) => {
    if (sql.includes("marketcap_daily")) {
      return [{
        symbol: "SCRUSDT",
        date: "2026-08-21",
        market_cap: 4035243,
        source: "gate",
        updated_at: "2026-08-21T00:30:00.000Z"
      }];
    }
    if (sql.includes("bars_5m")) {
      return [
        { symbol: "SCRUSDT", ts: "2026-08-21T00:40:00.000Z", close: 0.02135 },
        { symbol: "SCRUSDT", ts: "2026-08-20T00:40:00.000Z", close: 0.02035 }
      ];
    }
    throw new Error("unexpected_query");
  };
  const client = new BinanceMajorNewsMarketMetrics({
    config: {
      binanceMajorNewsMarketPriceMaxAgeMinutes: 30,
      binanceMajorNewsMarketCapMaxAgeHours: 36
    },
    queryFn,
    nowFn: () => now
  });
  const [result] = await client.enrich([{ symbol: "SCR", token_name: "Scroll" }]);
  assert.equal(result.circulating_market_cap_usd, 4035243);
  assert.equal(result.current_price_usd, 0.02135);
  assert.ok(Math.abs(result.price_change_percentage_24h - 4.9140049) < 0.0001);
  assert.equal(result.market_cap_source, "local:marketcap_daily:gate");
  assert.equal(result.price_change_source, "local:bars_5m:SCRUSDT");
});

test("local market metrics scale 1000x contract price back to one token", async () => {
  const now = Date.parse("2026-08-21T00:45:00.000Z");
  const queryFn = async (sql) => sql.includes("marketcap_daily")
    ? [{ symbol: "1000BONKUSDT", market_cap: 200000000, source: "coingecko", updated_at: "2026-08-21T00:30:00.000Z" }]
    : [
        { symbol: "1000BONKUSDT", ts: "2026-08-21T00:40:00.000Z", close: 0.012 },
        { symbol: "1000BONKUSDT", ts: "2026-08-20T00:40:00.000Z", close: 0.01 }
      ];
  const client = new BinanceMajorNewsMarketMetrics({ config: {}, queryFn, nowFn: () => now });
  const [result] = await client.enrich([{ symbol: "BONK", token_name: "Bonk" }]);
  assert.equal(result.current_price_usd, 0.000012);
  assert.ok(Math.abs(result.price_change_percentage_24h - 20) < 0.0001);
});
