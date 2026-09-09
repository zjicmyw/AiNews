import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DbClient } from "../src/db.js";
import { TelegramNotifier } from "../src/notifier/telegram.js";
import {
  SecurityIncidentMonitor,
  buildSecurityIncidentMessage,
  classifySecurityIncident,
  parseXintelSecurityIncidents,
  scoreSecurityIncidentEvidence
} from "../src/securityIncidentMonitor.js";

const now = new Date("2026-06-13T08:00:00.000Z");

function baseIncident(overrides = {}) {
  return {
    project: "Example CEX",
    incident_type: "exchange_incident",
    amount_usd: 4_999_999,
    chain_platform: "CEX",
    source_url: "https://x.com/example/status/1",
    source_user: "@example",
    source_type: "official",
    source_published_at: "2026-06-13T07:55:00.000Z",
    confidence: "high",
    summary: "交易所热钱包出现异常提款。",
    ...overrides
  };
}

function createDbStub() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    getSecurityIncidentByDedup: (key) => rows.get(key) || null,
    upsertSecurityIncident: (item) => {
      const existing = rows.get(item.dedup_key) || {};
      const merged = {
        ...existing,
        ...item,
        amount_usd: Math.max(Number(existing.amount_usd || 0), Number(item.amount_usd || 0)) || null,
        alert_level:
          existing.alert_level === "critical" || item.alert_level === "critical"
            ? "critical"
            : existing.alert_level === "anomaly" || item.alert_level === "anomaly"
              ? "anomaly"
              : item.alert_level
      };
      rows.set(item.dedup_key, merged);
      calls.push({ name: "upsert", item: merged });
      return merged;
    },
    markSecurityIncidentPushed: (key, level) => {
      const existing = rows.get(key) || {};
      rows.set(key, {
        ...existing,
        [level === "critical" ? "critical_pushed_at" : "anomaly_pushed_at"]: new Date().toISOString()
      });
      calls.push({ name: "markPushed", key, level });
    },
    recordHealth: (module, status, detail) => {
      calls.push({ name: "health", module, status, detail });
    }
  };
}

test("parseXintelSecurityIncidents parses direct JSON payloads", () => {
  const parsed = parseXintelSecurityIncidents(
    JSON.stringify({
      incidents: [baseIncident()]
    }),
    { securityIncidentIntervalSec: 600, securityIncidentLargeUsd: 5_000_000 },
    now
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.incidents.length, 1);
  assert.equal(parsed.incidents[0].project, "Example CEX");
  assert.equal(parsed.incidents[0].alert_level, "anomaly");
  assert.equal(parsed.incidents[0].amount_usd, 4_999_999);
  assert.equal(parsed.incidents[0].evidence_level, "high");
  assert.ok(parsed.incidents[0].dedup_key);
  assert.deepEqual(parsed.skipped, []);
});

test("parseXintelSecurityIncidents parses markdown fenced JSON and filters old rows", () => {
  const parsed = parseXintelSecurityIncidents(
    `\`\`\`json
{"incidents":[${JSON.stringify(baseIncident({ source_url: "https://x.com/example/status/2" }))},${JSON.stringify(
      baseIncident({
        project: "Old Bridge",
        source_url: "https://x.com/example/status/old",
        source_published_at: "2026-06-13T03:00:00.000Z"
      })
    )}]}
\`\`\``,
    { securityIncidentIntervalSec: 600 },
    now
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.incidents.length, 1);
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.skipped[0].reason, "outside_lookback");
  assert.equal(parsed.incidents[0].source_url, "https://x.com/example/status/2");
});

test("parseXintelSecurityIncidents skips missing time, missing source, and low confidence rows", () => {
  const parsed = parseXintelSecurityIncidents(
    JSON.stringify({
      incidents: [
        baseIncident({ source_published_at: null, source_url: "https://x.com/example/status/no-time" }),
        baseIncident({ source_url: "" }),
        baseIncident({ confidence: "low", source_url: "https://x.com/example/status/low" })
      ]
    }),
    { securityIncidentIntervalSec: 600 },
    now
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.incidents.length, 0);
  assert.deepEqual(parsed.skipped.map((item) => item.reason), [
    "missing_source_published_at",
    "missing_source_url",
    "low_confidence"
  ]);
});

test("parseXintelSecurityIncidents rejects empty and invalid JSON", () => {
  assert.deepEqual(parseXintelSecurityIncidents("", {}, now), { ok: false, error: "empty_response" });
  assert.deepEqual(parseXintelSecurityIncidents("No results found", {}, now), { ok: false, error: "invalid_json" });
});

test("classifySecurityIncident uses the configured large-loss threshold", () => {
  const config = { securityIncidentLargeUsd: 5_000_000 };
  const highEvidence = { evidence_score: 70 };

  assert.equal(classifySecurityIncident({ ...highEvidence, amount_usd: 4_999_999 }, config), "anomaly");
  assert.equal(classifySecurityIncident({ ...highEvidence, amount_usd: 5_000_000 }, config), "critical");
  assert.equal(classifySecurityIncident({ ...highEvidence, amount_usd: null }, config), "anomaly");
  assert.equal(classifySecurityIncident({ amount_usd: 5_000_000, evidence_score: 49 }, config), "watch");
});

test("scoreSecurityIncidentEvidence grades source strength and completeness", () => {
  assert.equal(
    scoreSecurityIncidentEvidence({
      source_type: "official",
      confidence: "high",
      source_url: "https://x.com/example/status/1",
      source_user: "@example",
      source_published_at: "2026-06-13T07:55:00.000Z",
      amount_usd: 1,
      summary: "confirmed"
    }),
    100
  );
  assert.equal(
    scoreSecurityIncidentEvidence({
      source_type: "unknown",
      confidence: "medium",
      source_url: "https://x.com/example/status/1",
      source_published_at: "2026-06-13T07:55:00.000Z"
    }),
    45
  );
});

test("SecurityIncidentMonitor deduplicates anomaly alerts and sends upgrade critical alerts", async () => {
  const db = createDbStub();
  const sends = [];
  const notifier = {
    send: async ({ message, chatId }) => {
      sends.push({ message, chatId });
      return { ok: true, status: "sent", reason: "gateway_confirmed" };
    }
  };
  const monitor = new SecurityIncidentMonitor({
    config: {
      securityIncidentMonitorEnabled: true,
      securityIncidentLargeUsd: 5_000_000,
      securityIncidentCriticalChatId: "-5519280405",
      securityIncidentAnomalyChatId: "-5363003109"
    },
    db,
    notifier
  });
  const anomaly = parseXintelSecurityIncidents(JSON.stringify({ incidents: [baseIncident()] }), monitor.config, now).incidents[0];
  const critical = {
    ...anomaly,
    amount_usd: 5_000_000,
    alert_level: "critical",
    raw_json: JSON.stringify({ ...baseIncident(), amount_usd: 5_000_000 })
  };

  assert.deepEqual(await monitor.processIncident(anomaly), { pushed: true, reason: "sent" });
  assert.deepEqual(await monitor.processIncident(anomaly), { pushed: false, reason: "dedup_skip" });
  assert.deepEqual(await monitor.processIncident(critical), { pushed: true, reason: "sent" });

  assert.equal(sends.length, 2);
  assert.equal(sends[0].chatId, "-5363003109");
  assert.equal(sends[1].chatId, "-5519280405");
  assert.match(sends[1].message, /【危急警报】/);
});

test("SecurityIncidentMonitor stores low-evidence rows without pushing", async () => {
  const db = createDbStub();
  const sends = [];
  const monitor = new SecurityIncidentMonitor({
    config: {
      securityIncidentMonitorEnabled: true,
      securityIncidentLargeUsd: 5_000_000,
      securityIncidentCriticalChatId: "-5519280405",
      securityIncidentAnomalyChatId: "-5363003109"
    },
    db,
    notifier: {
      send: async (payload) => {
        sends.push(payload);
        return { ok: true };
      }
    }
  });
  const parsed = parseXintelSecurityIncidents(
    JSON.stringify({
      incidents: [
        baseIncident({
          amount_usd: null,
          source_type: "unknown",
          source_user: "",
          summary: "",
          confidence: "medium"
        })
      ]
    }),
    monitor.config,
    now
  );

  const result = await monitor.processIncident(parsed.incidents[0]);

  assert.deepEqual(result, { pushed: false, reason: "evidence_below_push_threshold" });
  assert.equal(sends.length, 0);
  assert.equal(db.calls.filter((call) => call.name === "upsert").length, 1);
});

test("SecurityIncidentMonitor runOnce records parse failures without sending alerts", async () => {
  const db = createDbStub();
  const sends = [];
  const monitor = new SecurityIncidentMonitor({
    config: {
      securityIncidentMonitorEnabled: true
    },
    db,
    notifier: {
      send: async (payload) => {
        sends.push(payload);
        return { ok: true };
      }
    }
  });
  monitor.callHermes = async () => "No results found";

  const result = await monitor.runOnce("test");

  assert.equal(result.ok, false);
  assert.match(result.error, /xintel_parse_failed:invalid_json/);
  assert.equal(sends.length, 0);
  assert.equal(db.calls.find((call) => call.name === "health").status, "error");
});

test("SecurityIncidentMonitor runOnce writes incidents and sends alerts from mocked Hermes", async () => {
  const db = createDbStub();
  const sends = [];
  const monitor = new SecurityIncidentMonitor({
    config: {
      securityIncidentMonitorEnabled: true,
      securityIncidentIntervalSec: 600,
      securityIncidentLargeUsd: 5_000_000,
      securityIncidentCriticalChatId: "-5519280405",
      securityIncidentAnomalyChatId: "-5363003109"
    },
    db,
    notifier: {
      send: async (payload) => {
        sends.push(payload);
        return { ok: true };
      }
    }
  });
  monitor.callHermes = async () =>
    JSON.stringify({ incidents: [baseIncident({ amount_usd: "$5m", source_published_at: new Date().toISOString() })] });

  const result = await monitor.runOnce("test");

  assert.deepEqual(result, { ok: true, incidents: 1, pushed: 1, skipped: 0, skip_reasons: {} });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, "-5519280405");
  assert.equal(db.calls.filter((call) => call.name === "upsert").length, 1);
  assert.equal(db.calls.find((call) => call.name === "health").status, "ok");
});

test("DbClient keeps max security amount and highest alert level on upsert", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ainews-security-db-"));
  const dbPath = path.join(dir, "test.db");
  const db = new DbClient(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = parseXintelSecurityIncidents(
    JSON.stringify({ incidents: [baseIncident()] }),
    { securityIncidentLargeUsd: 5_000_000 },
    now
  ).incidents[0];
  const upgraded = {
    ...first,
    amount_usd: 5_000_000,
    alert_level: "critical",
    evidence_score: 70,
    evidence_level: "high"
  };
  const downgraded = {
    ...first,
    amount_usd: 1,
    alert_level: "anomaly",
    source_type: "unknown",
    evidence_score: 55,
    evidence_level: "medium"
  };

  db.upsertSecurityIncident(first);
  db.upsertSecurityIncident(upgraded);
  db.upsertSecurityIncident(downgraded);
  const row = db.getSecurityIncidentByDedup(first.dedup_key);

  assert.equal(row.amount_usd, 5_000_000);
  assert.equal(row.alert_level, "critical");
  assert.equal(row.source_type, "official");
  assert.equal(row.evidence_score, 100);
  assert.equal(row.evidence_level, "high");
});

test("TelegramNotifier relay send supports chatId override", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ success: true, status: "sent", taskId: "fixture-task", messageId: 1 })
    };
  };

  try {
    const notifier = new TelegramNotifier({
      telegramEnabled: true,
      telegramMode: "relay",
      telegramServiceUrl: "http://127.0.0.1:3000",
      telegramServicePath: "/send-message",
      telegramApiKey: "secret",
      telegramApiKeyHeader: "X-API-Key",
      telegramChatId: "default-chat"
    });

    const result = await notifier.send({ message: "hello", chatId: "override-chat" });

    assert.equal(result.ok, true);
    assert.equal(requests[0].url, "http://127.0.0.1:3000/send-message");
    assert.equal(requests[0].options.headers["X-API-Key"], "secret");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      chatId: "override-chat",
      message: "hello",
      idempotencyKey: requests[0].options.headers["X-Idempotency-Key"]
    });
    assert.equal(result.status, "sent");
    assert.match(requests[0].options.headers["X-Idempotency-Key"], /^ainews:/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("buildSecurityIncidentMessage renders unknown amounts explicitly", () => {
  const message = buildSecurityIncidentMessage({
    ...baseIncident({ amount_usd: null }),
    alert_level: "anomaly"
  });

  assert.match(message, /【异常提醒】/);
  assert.match(message, /金额: 未知/);
});
