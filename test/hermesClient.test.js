import assert from "node:assert/strict";
import test from "node:test";
import { HermesClient, buildHermesArgs } from "../src/hermesClient.js";

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
