import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { DbClient } from "../src/db.js";
import { OpportunityMonitor } from "../src/opportunityMonitor.js";
import { parseXintelOpportunities } from "../src/opportunityUtils.js";
import { SecurityIncidentMonitor, parseXintelSecurityIncidents } from "../src/securityIncidentMonitor.js";
import { EnginePipeline } from "../src/pipeline.js";
import { RiskEngine } from "../src/riskEngine.js";
import { MarketModule } from "../src/market/index.js";
import { crawlOfficialPage, isPublicHttpsUrl } from "../src/opportunityEnrichment.js";
import { fetchPublicPage } from "../src/publicPageFetch.js";
import { fetchJson } from "../src/http.js";
import { BinanceMajorNewsMonitor, _test as major } from "../src/binanceMajorNewsMonitor.js";
import { BinanceMajorNewsMarketMetrics } from "../src/binanceMajorNewsMarketMetrics.js";

const incidentConfig = { securityIncidentMonitorEnabled: true, securityIncidentIntervalSec: 1200,
  securityIncidentLargeUsd: 5000000, securityIncidentCriticalChatId: "-5519280405", securityIncidentAnomalyChatId: "-5363003109" };
const baseIncident = (overrides = {}) => ({ project: "Audit Example", incident_type: "exploit", amount_usd: 6000000,
  chain_platform: "Ethereum", source_url: "https://x.com/example/status/123", source_user: "@example",
  source_type: "official", source_published_at: new Date().toISOString(), confidence: "high", summary: "Reported exploit", ...overrides });
const parseIncident = (overrides) => parseXintelSecurityIncidents(JSON.stringify({ incidents: [baseIncident(overrides)] }), incidentConfig);
const opportunityConfig = { opportunityMonitorEnabled: true, opportunityCollectionTypes: ["launch", "pre_tge"],
  opportunityLookbackHours: 24, opportunityMaxFollowups: 0, opportunityMaxQueryJobs: 3,
  opportunityEnrichmentEnabled: false, opportunityQuotaErrorBackoffSec: 43200 };
function memoryDb(t) {
  const db = new DbClient(":memory:");
  t.after(() => db.close());
  return db;
}
function mockFetch(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = original; });
}
function pipelineStub(config = {}, db = {}) {
  return Object.assign(Object.create(EnginePipeline.prototype), {
    config, db, runtimeStatus: { last_cycle_event_count: 0 }, keywords: [], suppressKeywords: []
  });
}
function securityMonitor(t) {
  const db = memoryDb(t);
  const sends = [];
  const monitor = new SecurityIncidentMonitor({ config: incidentConfig, db,
    notifier: { send: async (row) => { sends.push(row); return { ok: true, status: "sent" }; } } });
  return { db, monitor, sends };
}

test("A01: unavailable recovery jobs release the lock", async () => {
  const monitor = new OpportunityMonitor({ config: opportunityConfig, db: {} });
  monitor.callHermes = async () => '{"opportunities":[]}';
  assert.equal((await monitor.runOnce("audit", { onlyJobNames: ["nonexistent"] })).reason, "requested_jobs_unavailable");
  assert.equal(monitor.isRunning, false);
  assert.equal((await monitor.runOnce("audit")).ok, true);
});

test("A01: database preparation failure releases the lock and records error", async () => {
  let fail = true;
  const monitor = new OpportunityMonitor({ config: opportunityConfig, db: {
    startOpportunityRun: () => { if (fail) throw new Error("write unavailable"); }
  } });
  monitor.callHermes = async () => '{"opportunities":[]}';
  assert.equal((await monitor.runOnce("audit")).ok, false);
  assert.equal(monitor.isRunning, false);
  fail = false;
  assert.equal((await monitor.runOnce("audit")).ok, true);
});

test("A02: partial quota failure preserves pause and skips further model enrichment", async () => {
  const monitor = new OpportunityMonitor({ config: { ...opportunityConfig, opportunityMaxFollowups: 1, opportunityEnrichmentEnabled: true }, db: {} });
  let calls = 0;
  monitor.callHermes = async () => {
    if (++calls === 1) return JSON.stringify({ opportunities: [{ activity_name: "Audit launch", type: "launch",
      section: "onchain", source_url: "https://x.com/example/status/456", source_user: "@example",
      source_published_at: new Date().toISOString(), credibility: "official" }] });
    throw new Error("hermes_failed:403:personal-team-blocked:spending-limit");
  };
  const result = await monitor.runOnce("audit");
  assert.equal(result.partial, true);
  assert.equal(calls, 2);
  assert.ok(Date.parse(monitor.getStatus().paused_until) > Date.now() + 43100000);
  assert.equal((await monitor.runOnce("audit")).reason, "xintel_quota_error_backoff");
  assert.equal(calls, 2);
});

test("A03: security parser rejects invalid sources, future times, categories, amounts and account mismatch", () => {
  for (const overrides of [
    { source_url: "not-a-url" }, { source_url: "javascript:alert(1)" },
    { source_url: "https://127.0.0.2/private" }, { source_published_at: "2099-01-01T00:00:00Z" },
    { incident_type: "price_rally" }, { amount_usd: -1 }, { amount_usd: "-5m" },
    { amount_usd: "between 1 and 10 million" }, { confidence: "" }, { source_user: "@someoneelse" },
    { source_published_at: null, event_time: new Date().toISOString() }
  ]) assert.equal(parseIncident(overrides).incidents.length, 0, JSON.stringify(overrides));
  assert.equal(parseIncident({ amount_usd: null }).incidents[0].alert_level, "anomaly");
  assert.equal(parseIncident({ amount_usd: "$5m" }).incidents[0].alert_level, "critical");
  for (const amount of ["5 m", "5 mn", "5million", "0.005 billion", "5000 k"])
    assert.equal(parseIncident({ amount_usd: amount }).incidents[0].amount_usd, 5000000, amount);
});

test("A17: missing affiliation coverage never becomes a complete empty result", async () => {
  const monitor = new BinanceMajorNewsMonitor({ config: {}, sourceRegistry: {},
    hermesClient: { call: async () => '{"items":[]}' } });
  monitor.getUniverse = async () => ["AUDIT"];
  const result = await monitor.run();
  assert.equal(result.status, "partial");
  assert.equal(result.diagnostics[0].symbols_without_verified_sources, 1);
});

test("A04: two projects sharing a source are independent; tracking params are not a new event", async (t) => {
  const { db, monitor, sends } = securityMonitor(t);
  const a = parseIncident({ project: "Project A" }).incidents[0];
  const b = parseIncident({ project: "Project B" }).incidents[0];
  await monitor.processIncident(a);
  await monitor.processIncident(b);
  await monitor.processIncident(parseIncident({ project: "Project A", source_url: a.source_url + "?s=20" }).incidents[0]);
  assert.equal(sends.length, 2);
  assert.equal(db.getSecurityIncidents().length, 2);
});

test("A04: evidence with a common incident reference merges across reporting sources", async (t) => {
  const { db, monitor, sends } = securityMonitor(t);
  const common = { event_reference_url: "https://example.org/security/incident-1" };
  await monitor.processIncident(parseIncident({ ...common, amount_usd: null }).incidents[0]);
  await monitor.processIncident(parseIncident({ ...common, source_url: "https://x.com/researcher/status/234", source_user: "@researcher" }).incidents[0]);
  assert.equal(db.getSecurityIncidents().length, 1);
  assert.deepEqual(sends.map((row) => row.chatId), ["-5363003109", "-5519280405"]);
});

test("A04: newly learned event time remains an alias without rewriting historical notification IDs", async (t) => {
  const { db, monitor, sends } = securityMonitor(t);
  const first = parseIncident({}).incidents[0];
  const legacyKey = "legacy-source-only-key";
  db.upsertSecurityIncident({ ...first, dedup_key: legacyKey, event_identity: "legacy-identity" });
  db.markSecurityIncidentPushed(legacyKey, "critical");
  const eventTime = new Date(Date.now() - 3600000).toISOString();
  await monitor.processIncident(parseIncident({ event_time: eventTime }).incidents[0]);
  await monitor.processIncident(parseIncident({}).incidents[0]);
  await monitor.processIncident(parseIncident({ event_time: eventTime, source_url: "https://x.com/researcher/status/234", source_user: "@researcher" }).incidents[0]);
  assert.equal(sends.length, 0);
  assert.equal(db.getSecurityIncidents().length, 1);
  assert.equal(db.getSecurityIncidents()[0].dedup_key, legacyKey);
});

test("A05: merged amount and evidence upgrade once and never downgrade", async (t) => {
  const { db, monitor, sends } = securityMonitor(t);
  const first = parseIncident({ source_type: "unknown", confidence: "medium", source_user: "", summary: "" }).incidents[0];
  await monitor.processIncident(first);
  await monitor.processIncident(parseIncident({ amount_usd: null }).incidents[0]);
  await monitor.processIncident(parseIncident({ amount_usd: 1 }).incidents[0]);
  const stored = db.getSecurityIncidentByDedup(first.dedup_key);
  assert.equal(stored.amount_usd, 6000000);
  assert.equal(stored.alert_level, "critical");
  assert.ok(stored.critical_pushed_at);
  assert.deepEqual(sends.map((row) => row.chatId), ["-5363003109", "-5519280405"]);
});

test("A06: malformed collections fail, valid empty lists succeed", async () => {
  for (const raw of ['{"error":"search failed"}', '{}', '{"incidents":"invalid"}', 'null']) {
    assert.equal(parseXintelSecurityIncidents(raw).ok, false, raw);
    assert.equal(parseXintelOpportunities(raw).ok, false, raw);
  }
  assert.equal(parseXintelOpportunities('{"opportunities":"invalid"}').ok, false);
  assert.equal(parseXintelSecurityIncidents('{"incidents":[]}').ok, true);
  assert.equal(parseXintelOpportunities('{"opportunities":[]}').ok, true);
  const monitor = new BinanceMajorNewsMonitor({ config: {}, hermesClient: { call: async () => '{"error":"search failed"}' } });
  monitor.getUniverse = async () => ["BTC"];
  assert.equal((await monitor.run()).status, "error");
});

for (const rejection of ["cooldown", "dedup"]) {
  test(`A07: degraded alerts respect ${rejection} rejection`, async () => {
    let sends = 0;
    let score;
    const config = { level2Threshold: 60, level3Threshold: 75, marketConfirmStrong: 70,
      level2CooldownMin: 90, dedupWindowMin: 60, telegramEnabled: true,
      telegramMode: "relay", telegramServiceUrl: "http://example.invalid", telegramApiKey: "test", telegramChatId: "-1" };
    const db = { insertEventIfNew: () => ({ inserted: true, eventId: "audit", dedupKey: "audit" }),
      canPushByDedup: () => rejection !== "dedup", canPushLevel2ByCooldown: () => false,
      saveScore: (row) => { score = row; }, insertPushLog: () => {} };
    const pipeline = pipelineStub(config, db);
    pipeline.riskEngine = new RiskEngine(config, db);
    pipeline.analyzer = { analyze: async () => ({ news_severity: 100, asset_relevance: 100, reasons: [], _meta: { valid: true } }) };
    pipeline.notifier = { buildMessage: () => "test", send: async () => { sends++; return { ok: true }; } };
    await pipeline.processEvent({ title: "Audit", source_type: "x" }, { confirmation_score: 100,
      is_data_anomaly: true, confirmation_reasons: [], anomaly_reasons: [] });
    assert.equal(score.push_allowed, false);
    assert.equal(sends, 0);
  });
}

test("A08: resumed daily report preserves partial run evidence", async (t) => {
  const db = memoryDb(t);
  const runId = db.startOpportunityRun({ startedAt: new Date(Date.now() - 1000).toISOString(), prompt: "audit" });
  db.finishOpportunityRun(runId, { status: "partial", durationMs: 1, rawResponse: "{}", error: "pre_tge timeout", itemCount: 0, jobStats: [] });
  const pipeline = pipelineStub({ opportunityDailyReportEnabled: true, opportunityDailyReportMaxItems: 8 }, db);
  pipeline.opportunityDailySchedule = { hour: 0, minute: 0, text: "00:00" };
  pipeline.notifier = { preflight: () => ({ ok: true }) };
  pipeline.opportunityMonitor = { runOnce: async () => { throw Error("must reuse run"); } };
  let batch;
  pipeline.submitDailyReportBatch = async (value) => { batch = value; return true; };
  await pipeline.maybeSendOpportunityDailyReport("audit");
  assert.match(batch.messages[0], /部分查询成功/);
  assert.match(batch.messages[0], /未完成部分结果未知/);
  assert.doesNotMatch(batch.messages[0], /采集状态：完成|今日未发现符合条件/);
  assert.equal(batch.payload.collection_result.run_id, Number(runId));
});

test("A08: skipped collection cannot become a completed empty report", () => {
  for (const reason of ["disabled", "already_running", "xintel_quota_error_backoff"]) {
    const message = pipelineStub().buildOpportunityDailyReportMessage("2026-09-21", [], { skipped: true, reason });
    assert.match(message, /结果未知/);
    assert.doesNotMatch(message, /采集状态：完成|今日未发现符合条件/);
  }
});

test("A09: private address forms and unsafe redirect targets are blocked", async () => {
  for (const url of ["https://127.0.0.2/", "https://[::1]/", "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/",
    "https://0x7f000001/", "https://2130706433/", "https://169.254.169.254/", "https://10.0.0.1/", "https://user:pass@example.org/"]) {
    assert.equal(isPublicHttpsUrl(url), false, url);
  }
  let requests = 0;
  await assert.rejects(crawlOfficialPage("https://example.org/", { fetchFn: async (_url, options) => {
    requests++;
    assert.equal(options.redirect, "manual");
    return { status: 302, headers: { get: () => "http://127.0.0.1:3000/private" } };
  } }), /invalid_public_https_url/);
  assert.equal(requests, 1);
  await assert.rejects(crawlOfficialPage("https://example.org/", { fetchFn: async () => ({ ok: true, url: "https://127.0.0.1/" }) }), /unexpected_redirect/);
});

test("A09: DNS private/mixed answers fail before connecting; public resolution is pinned", async () => {
  let connections = 0;
  for (const addresses of [[{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]]) {
    await assert.rejects(fetchPublicPage("https://example.org/", { lookupFn: async () => addresses, requestFn: () => { connections++; } }), /non_public_dns_address/);
  }
  assert.equal(connections, 0);
  const result = await fetchPublicPage("https://example.org/", {
    lookupFn: async () => [{ address: "8.8.8.8", family: 4 }],
    requestFn: (url, options, callback) => {
      assert.equal(url.hostname, "example.org");
      assert.equal(options.agent, false);
      options.lookup("example.org", {}, (_error, address) => assert.equal(address, "8.8.8.8"));
      const request = new EventEmitter();
      request.end = () => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
        callback(response);
        response.emit("data", Buffer.from("public page"));
        response.emit("end");
      };
      return request;
    }
  });
  assert.equal(await result.text(), "public page");
});

test("A09: DNS lookup respects abort even when resolver never returns", async () => {
  const controller = new AbortController();
  const request = fetchPublicPage("https://example.org/", { signal: controller.signal, lookupFn: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(request, /official_dns_aborted/);
});

test("A10: missing market metrics remain unknown while real zero change is preserved", async () => {
  const metrics = new BinanceMajorNewsMarketMetrics({ config: {}, queryFn: async () => [] });
  const items = await metrics.enrich([{ symbol: "AUDIT", token_name: "Audit", published_at: new Date().toISOString() }]);
  const message = pipelineStub().buildBinanceMajorNewsMessages("2026-09-21", { status: "ok", items }).join("\n");
  assert.equal((message.match(/暂无可靠数据/g) || []).length, 3);
  items[0].price_change_percentage_24h = 0;
  assert.match(pipelineStub().buildBinanceMajorNewsMessages("2026-09-21", { status: "ok", items }).join("\n"), /\+0\.00%/);
});

test("A11: safety monitor and timers start before a pending daily collection", async () => {
  const pipeline = pipelineStub({ opportunityScheduleMode: "daily_report", dailyReportCheckIntervalSec: 30 }, { recordHealth: () => {} });
  let release;
  let entered;
  const collecting = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  let securityStarted = false;
  pipeline.notifier = {};
  pipeline.shouldRunNewsCycle = () => false;
  pipeline.resumePendingDailyReports = async () => {};
  pipeline.maybeCollectBinanceMajorNewsDaily = async () => { entered(); await pending; };
  pipeline.maybeSendBinanceMajorNewsDailyReport = async () => {};
  pipeline.maybeSendOpportunityDailyReport = async () => {};
  pipeline.maybeSendDailyReport = async () => {};
  pipeline.securityIncidentMonitor = { start: () => { securityStarted = true; } };
  const start = pipeline.start();
  try {
    await collecting;
    assert.equal(securityStarted, true);
    assert.ok(pipeline.dailyReportTimer);
  } finally {
    release();
    await start;
    clearInterval(pipeline.dailyReportTimer);
  }
});

test("A12: BTC uses one-minute history near an hour ago, not the last hour close", async (t) => {
  const now = Math.floor(Date.now() / 1000);
  mockFetch(t, async (url) => ({ ok: true, text: async () => {
    if (url.includes("/ticker/price")) return '{"price":"99"}';
    if (url.includes("/klines")) {
      assert.match(url, /interval=1m/);
      return JSON.stringify([[0, 0, 0, 0, "110", 0, (now - 3600) * 1000],
        [0, 0, 0, 0, "100", 0, (now - 30) * 1000], [0, 0, 0, 0, "99", 0, (now + 30) * 1000]]);
    }
    return '{"data":{"amount":"99"}}';
  } }));
  const market = new MarketModule({ binanceBaseUrl: "https://binance.invalid", coinbaseBaseUrl: "https://coinbase.invalid" }, {});
  const btc = await market.fetchBtc();
  assert.equal(btc.primary.price1hAgo, 110);
  assert.equal(btc.primary.change1hPct, -10);
  assert.ok(btc.primary.lastUpdateSec <= now);
});

test("A12: equities use hourly candle history; day-open-only quotes are not hourly confirmation", async (t) => {
  const now = Math.floor(Date.now() / 1000);
  let historyAvailable = true;
  mockFetch(t, async (url) => ({ ok: true, text: async () => {
    if (url.includes("/candle")) return JSON.stringify(historyAvailable ? { s: "ok", c: [120, 110, 100, 99], t: [now - 4200, now - 3600, now - 300, now] } : { s: "no_data" });
    return JSON.stringify({ c: 99, o: 100, pc: 100, t: now });
  } }));
  const market = new MarketModule({ finnhubBaseUrl: "https://finnhub.invalid" }, {});
  assert.equal((await market.fetchEquities()).change1hPct, -10);
  historyAvailable = false;
  await assert.rejects(market.fetchEquities(), /equity_source_failed/);
});

test("A13: any missing hourly input is anomalous", async () => {
  const market = new MarketModule({ marketStaleSeconds: 180, maxCrossSourceBpsDiff: 80,
    severeBtcDropPct: -2, severeEquityDropPct: -1, safeHavenGoldUpPct: 0.4, dxyTighteningUpPct: 0.2 }, { getRecentSignal: () => null });
  for (const invalid of [null, NaN, undefined]) {
    const point = (symbol, change1hPct) => ({ symbol, change1hPct, lastUpdateSec: Math.floor(Date.now() / 1000) });
    market.fetchBtc = async () => ({ primary: point("BTC", -3) });
    market.fetchGold = async () => ({ primary: point("GOLD", invalid) });
    market.fetchEquities = async () => point("SPX+QQQ", -2);
    market.fetchDxy = async () => point("UUP", 0.5);
    const snapshot = await market.getSnapshot();
    assert.equal(snapshot.is_data_anomaly, true);
    assert.equal(snapshot.confirmation_score, 0);
  }
});

test("A14: provider errors never contain URL credentials or response bodies", async (t) => {
  let ok = true;
  mockFetch(t, async () => ({ ok, status: 403, text: async () => "DUMMY_BODY_SECRET" }));
  for (const key of ["token", "key", "apiKey"]) {
    await assert.rejects(fetchJson(`https://provider.invalid/quote?${key}=DUMMY_URL_SECRET`), (error) => {
      assert.doesNotMatch(error.message, /DUMMY_|provider\.invalid/); return true;
    });
  }
  ok = false;
  await assert.rejects(fetchJson("https://provider.invalid/"), /^Error: HTTP 403$/);
});

test("A15: failed or unknown sends appear in monitor health", async (t) => {
  const db = memoryDb(t);
  for (const status of ["failed", "unknown"]) {
    const monitor = new SecurityIncidentMonitor({ config: incidentConfig, db, notifier: { send: async () => ({ ok: false, status }) } });
    monitor.callHermes = async () => JSON.stringify({ incidents: [baseIncident()] });
    const result = await monitor.runOnce("audit");
    assert.equal(result.ok, false);
    assert.equal(result.delivery_failures, 1);
    assert.equal(db.getRecentHealth("security_incident_monitor", 1)[0].status, "warning");
    assert.match(monitor.getStatus().last_error, /notification_delivery/);
  }
});

test("A16: both crypto assets attempt backup when primary fails, without fabricating hourly change", async (t) => {
  const calls = [];
  mockFetch(t, async (url) => {
    calls.push(url);
    if (url.includes("binance.invalid")) throw new Error("primary unavailable");
    return { ok: true, text: async () => '{"data":{"amount":"100"}}' };
  });
  const market = new MarketModule({ binanceBaseUrl: "https://binance.invalid", coinbaseBaseUrl: "https://coinbase.invalid" }, {});
  for (const result of [await market.fetchBtc(), await market.fetchGold()]) {
    assert.equal(result.primary.source, "coinbase");
    assert.equal(result.primary.current, 100);
    assert.equal(result.primary.change1hPct, null);
  }
  assert.equal(calls.filter((url) => url.includes("coinbase.invalid")).length, 2);
});

const newsItem = () => ({ symbol: "AUDIT", category: "funding", score: 9, published_at: new Date().toISOString(),
  event_novelty: "new_decision", materiality: "high", evidence_strength: "confirmed", catalyst_type: "capital_inflow",
  catalyst_strength: "high", token_impact: "direct", product_change_type: "not_applicable",
  catalyst_path_zh: "New funding increases protocol capital", source_url: "https://x.com/example/status/123",
  source_account: "@example", source_role: "project_official" });

test("A17: media, missing roles and mismatched source accounts are rejected", () => {
  for (const fields of [{ source_role: "media" }, { source_role: "" }, { source_account: "@different" }]) {
    assert.equal(major.normalizeItem({ ...newsItem(), ...fields }, new Set(["AUDIT"]), Date.now()), null);
  }
});

test("A17: official affiliation must be independently registered; unresolved identity keeps partial coverage", async () => {
  const monitor = new BinanceMajorNewsMonitor({ config: {}, sourceRegistry: {},
    hermesClient: { call: async () => JSON.stringify({ items: [newsItem()] }) } });
  monitor.getUniverse = async () => ["AUDIT"];
  const unknown = await monitor.run();
  assert.equal(unknown.status, "partial");
  assert.equal(unknown.items.length, 0);
  assert.equal(unknown.diagnostics[0].unverified_sources, 1);
  monitor.sourceRegistry = { AUDIT: [{ account: "@example", role: "project_official",
    evidence_url: "https://example.org/team", verified_at: "2026-01-01T00:00:00Z" }] };
  const verified = await monitor.run();
  assert.equal(verified.status, "ok");
  assert.equal(verified.items.length, 1);
});
