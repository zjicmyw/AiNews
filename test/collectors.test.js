import assert from "node:assert/strict";
import test from "node:test";
import { CollectorHub } from "../src/collectors/index.js";

test("CollectorHub isolates single-source failures and records health", async () => {
  const healthRecords = [];
  const db = {
    recordHealth: (module, status, detail = "") => {
      healthRecords.push({ module, status, detail });
    }
  };
  const hub = new CollectorHub({}, db);
  hub.collectors = [
    { name: "rss", collect: async () => [{ event_id: "rss-1", source_type: "rss" }] },
    {
      name: "gdelt",
      collect: async () => {
        throw new Error("gdelt boom");
      }
    },
    { name: "x", collect: async () => [{ event_id: "x-1", source_type: "x" }] }
  ];

  const events = await hub.collectAll();

  assert.deepEqual(
    events.map((event) => event.event_id),
    ["rss-1", "x-1"]
  );
  assert.ok(
    healthRecords.some(
      (record) =>
        record.module === "collector.gdelt" &&
        record.status === "error" &&
        record.detail.includes("gdelt boom")
    )
  );
});
