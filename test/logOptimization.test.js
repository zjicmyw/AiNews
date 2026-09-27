import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbClient } from "../src/db.js";
import { HermesClient } from "../src/hermesClient.js";
import { OpportunityMonitor } from "../src/opportunityMonitor.js";
import { BinanceMajorNewsMonitor } from "../src/binanceMajorNewsMonitor.js";
import { createHttpServer } from "../src/httpServer.js";
import { EnginePipeline } from "../src/pipeline.js";

const config = { opportunityMonitorEnabled: true, opportunityHermesProfile: "xintel",
  opportunityQuotaErrorBackoffSec: 43200, opportunityCollectionTypes: ["launch", "pre_tge"] };
const quotaCallback = (callback) => callback({ code: 1 }, "Billing or credits exhausted: spending-limit", "session_id: fixture");

test("quota state survives SQLite reopen and is isolated by Hermes profile", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ainews-quota-"));
  let db = new DbClient(join(dir, "state.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let calls = 0;
  const execFileFn = (_bin, _args, _options, callback) => { calls++; quotaCallback(callback); };
  const client = new HermesClient(config, { stateStore: db, execFileFn });
  await assert.rejects(client.call("initial"), /spending-limit/);
  const retryAt = client.getStatus().retry_after;
  db.close();
  db = new DbClient(join(dir, "state.db"));
  const restarted = new HermesClient(config, { stateStore: db, execFileFn });
  assert.equal(restarted.getStatus().retry_after, retryAt);
  await assert.rejects(restarted.call("restarted"), /spending-limit/);
  assert.equal(calls, 1);
  assert.equal(new HermesClient({ ...config, opportunityHermesProfile: "another" }, { stateStore: db }).getStatus().blocked, false);
  const monitor = new OpportunityMonitor({ config, db, hermesClient: restarted });
  assert.equal(monitor.getStatus().paused_until, retryAt);
  assert.equal((await monitor.runOnce("fixture")).ok, false);
  assert.equal(monitor.getStatus().paused_until, retryAt);
  assert.equal(calls, 1);
});

test("quota wait expiry comes from provider block rather than sliding twelve hours", () => {
  const monitor = new OpportunityMonitor({ config, db: {} });
  const until = new Date(Date.now() + 10000).toISOString();
  monitor.applyQuotaPause(new Error(`hermes_quota_exhausted:spending-limit:retry_after=${until}`));
  assert.equal(monitor.getStatus().paused_until, until);
  monitor.applyQuotaPause(new Error(`cex_launch:hermes_quota_exhausted:spending-limit:retry_after=${until}`));
  assert.equal(monitor.getStatus().paused_until, until);
});

test("quota rejects queued jobs immediately without waiting the normal inter-call delay", async () => {
  let calls = 0;
  const client = new HermesClient(config, { minIntervalMs: 10000,
    execFileFn: (_bin, _args, _options, callback) => { calls++; setTimeout(() => quotaCallback(callback), 5); } });
  const started = Date.now();
  const results = await Promise.allSettled([client.call("one"), client.call("two"), client.call("three")]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.ok(Date.now() - started < 1000);
  assert.equal(client.timer, null);
  assert.equal(client.getStatus().queued, 0);
});

test("expired quota state allows one successful call and clears persisted block", async (t) => {
  const db = new DbClient(":memory:");
  t.after(() => db.close());
  const seed = new HermesClient(config, { stateStore: db });
  db.setHermesQuotaState(seed.stateKey, Date.now() - 1);
  const client = new HermesClient(config, { stateStore: db,
    execFileFn: (_b, _a, _o, callback) => callback(null, '{"items":[]}', "") });
  assert.equal(client.getStatus().blocked, false);
  assert.equal(await client.call("allowed"), '{"items":[]}');
  assert.equal(db.getHermesQuotaState(seed.stateKey).blocked_until_ms, 0);
});

test("failed persistence does not clear the in-memory quota block", async () => {
  const client = new HermesClient(config, {
    stateStore: { setHermesQuotaState: () => { throw new Error("write unavailable"); } },
    execFileFn: (_b, _a, _o, callback) => quotaCallback(callback)
  });
  await assert.rejects(client.call("one"), /spending-limit/);
  assert.equal(client.getStatus().blocked, true);
  assert.equal(client.getStatus().persistence_error, true);
});

const verifiedFixtureRegistry = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [`FIX${i}`, [{ account: "@example", role: "project_official", evidence_url: "https://example.org/team", verified_at: "2026-01-01T00:00:00Z" }]]));

for (const successfulBatches of [0, 1]) {
  test(`major news stops quota failures with ${successfulBatches} earlier successful batches`, async () => {
    let calls = 0;
    const monitor = new BinanceMajorNewsMonitor({ config: { binanceMajorNewsChunkSize: 30 }, sourceRegistry: verifiedFixtureRegistry(90),
      hermesClient: { call: async () => {
        if (calls++ < successfulBatches) return '{"items":[]}';
        throw new Error("hermes_quota_exhausted:spending-limit");
      } } });
    monitor.getUniverse = async () => Array.from({ length: 90 }, (_, i) => `FIX${i}`);
    const result = await monitor.run();
    assert.equal(calls, successfulBatches + 1);
    assert.equal(result.status, successfulBatches ? "partial" : "error");
    assert.equal(result.diagnostics.length, 3);
    assert.equal(result.diagnostics.filter((item) => item.status === "skipped").length, 2 - successfulBatches);
    assert.match(result.error, /spending-limit/);
    assert.equal((result.error.match(/spending-limit/g) || []).length, 1);
  });
}

test("non-quota major news failure still allows independent later batches", async () => {
  let calls = 0;
  const monitor = new BinanceMajorNewsMonitor({ config: { binanceMajorNewsChunkSize: 30 }, sourceRegistry: verifiedFixtureRegistry(60),
    hermesClient: { call: async () => { calls++; if (calls === 1) throw new Error("timeout"); return '{"items":[]}'; } } });
  monitor.getUniverse = async () => Array.from({ length: 60 }, (_, i) => `FIX${i}`);
  assert.equal((await monitor.run()).status, "partial");
  assert.equal(calls, 2);
});

test("quota health is actionable, remains failed, and exposes shared backoff without side effects", async (t) => {
  const retryAt = new Date(Date.now() + 60000).toISOString();
  const server = createHttpServer({ config: { appPort: 0 },
    db: { getLatestOpportunityRun: () => ({ id: 1, status: "error",
      error: `cex_launch:hermes_quota_exhausted:spending-limit:retry_after=${retryAt}`, item_count: 0 }),
      getLatestRegimeStatus: () => ({}), getLastHighEvents: () => [] },
    getOpportunityStatus: () => ({ running: false, hermes: { blocked: true, retry_after: retryAt } }),
    getRuntimeStatus: () => ({ hermes: { blocked: true, retry_after: retryAt } }) });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = await (await fetch(`${base}/api/opportunities/runs/latest`)).json();
  assert.equal(body.latest_run.status, "error");
  assert.equal(body.run_health.ok, false);
  assert.equal(body.run_health.issues[0].type, "quota_exhausted");
  assert.equal(body.run_health.issues[0].retry_after, retryAt);
  assert.match(body.run_health.summary, /额度或订阅权限不足/);
  const runtime = await (await fetch(`${base}/status.json`)).json();
  assert.equal(runtime.hermes.retry_after, retryAt);
});

test("quota reports describe missing collection without an empty-success claim", () => {
  const pipeline = Object.assign(Object.create(EnginePipeline.prototype), { config: {} });
  const error = "cex_launch:hermes_quota_exhausted:spending-limit:retry_after=2026-09-27T12:00:00Z";
  const opportunity = pipeline.buildOpportunityDailyReportMessage("2026-09-27", [], { ok: false, error });
  const major = pipeline.buildBinanceMajorNewsMessages("2026-09-27", { status: "error", error, items: [] }).join("\n");
  for (const message of [opportunity, major]) {
    assert.match(message, /额度或订阅权限不足/);
    assert.match(message, /结果未知/);
    assert.doesNotMatch(message, /今日无重大消息|今日未发现符合条件/);
  }
});
