import assert from "node:assert/strict";
import test from "node:test";
import { HermesClient, buildHermesArgs } from "../src/hermesClient.js";
import { OpportunityMonitor } from "../src/opportunityMonitor.js";

test("quota on stdout survives session-only stderr and blocks shared queued calls", async () => {
  let calls = 0;
  const client = new HermesClient({ opportunityQuotaErrorBackoffSec: 43200 }, {
    minIntervalMs: 0,
    execFileFn: (_bin, _args, _options, callback) => {
      calls++;
      callback({ code: 1 }, "Billing or credits exhausted: personal-team-blocked:spending-limit", "session_id: example");
    }
  });
  const results = await Promise.allSettled([client.call("one"), client.call("two")]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /spending-limit/);
  }
  const monitor = new OpportunityMonitor({ config: { opportunityMonitorEnabled: true,
    opportunityCollectionTypes: ["launch", "pre_tge"], opportunityQuotaErrorBackoffSec: 43200 }, db: {}, hermesClient: client });
  assert.equal((await monitor.runOnce("quota_test")).ok, false);
  assert.equal((await monitor.runOnce("quota_test")).reason, "xintel_quota_error_backoff");
  assert.equal(calls, 1);
  client.quotaBlockedUntil = Date.now() - 1;
  await assert.rejects(client.call("after_expiry"), /spending-limit/);
  assert.equal(calls, 2);
});

test("buildHermesArgs uses Hermes chat query mode", () => {
  assert.deepEqual(buildHermesArgs({ opportunityHermesProfile: "xintel" }, "hello"), [
    "--profile",
    "xintel",
    "chat",
    "--query",
    "hello",
    "--quiet",
    "--ignore-rules",
    "--source",
    "tool"
  ]);
});

test("HermesClient serializes concurrent calls", async () => {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const execFileFn = (_bin, args, _options, callback) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(args[4]);
    setTimeout(() => {
      active -= 1;
      callback(null, JSON.stringify({ query: args[4] }), "");
    }, 20);
  };
  const client = new HermesClient(
    {
      opportunityHermesBin: "hermes",
      opportunityHermesProfile: "xintel",
      opportunityHermesTimeoutSec: 10
    },
    { execFileFn, minIntervalMs: 0, maxConcurrency: 1 }
  );

  const [first, second] = await Promise.all([client.call("first"), client.call("second")]);

  assert.equal(maxActive, 1);
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(first, '{"query":"first"}');
  assert.equal(second, '{"query":"second"}');
});

test("HermesClient keeps a minimum interval between process starts", async () => {
  const started = [];
  const execFileFn = (_bin, _args, _options, callback) => {
    started.push(Date.now());
    callback(null, "ok", "");
  };
  const client = new HermesClient(
    {
      opportunityHermesBin: "hermes",
      opportunityHermesProfile: "xintel",
      opportunityHermesTimeoutSec: 10
    },
    { execFileFn, minIntervalMs: 25, maxConcurrency: 1 }
  );

  await Promise.all([client.call("first"), client.call("second")]);

  assert.equal(started.length, 2);
  assert.ok(started[1] - started[0] >= 20);
});
