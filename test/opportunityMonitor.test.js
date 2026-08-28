import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPreTgePrompt, OpportunityMonitor } from "../src/opportunityMonitor.js";

function createDbStub() {
  const calls = [];
  return {
    calls,
    startOpportunityRun: ({ startedAt, prompt }) => {
      calls.push({ name: "start", startedAt, prompt });
      return 42;
    },
    finishOpportunityRun: (runId, row) => {
      calls.push({ name: "finish", runId, row });
    },
    recordHealth: (module, status, detail) => {
      calls.push({ name: "health", module, status, detail });
    }
  };
}

test("OpportunityMonitor records raw output when xintel JSON parsing fails", async () => {
  const db = createDbStub();
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0
    },
    db
  });
  monitor.callHermes = async () => "No results found";

  const result = await monitor.runOnce("test");
  const finish = db.calls.find((call) => call.name === "finish");

  assert.equal(result.ok, false);
  assert.equal(finish.runId, 42);
  assert.equal(finish.row.status, "error");
  assert.equal(finish.row.rawResponse, "## main\nNo results found");
  assert.match(finish.row.error, /xintel_parse_failed/);
  assert.equal(finish.row.jobStats.length, 1);
  assert.equal(finish.row.jobStats[0].name, "main");
  assert.equal(finish.row.jobStats[0].status, "parse_failed");
  assert.equal(finish.row.jobStats[0].candidate_count, 0);
});

test("OpportunityMonitor backs off repeated empty xintel responses", async () => {
  const db = createDbStub();
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: false,
      opportunityQueryMatrixEnabled: false,
      opportunityEmptyResponseBackoffSec: 3600
    },
    db
  });
  monitor.callHermes = async () => "";

  const first = await monitor.runOnce("test");
  const callCountAfterFirst = db.calls.length;
  const second = await monitor.runOnce("test");

  assert.equal(first.ok, false);
  assert.equal(db.calls.find((call) => call.name === "finish").row.error, "main:xintel_parse_failed:empty_response");
  assert.equal(Boolean(monitor.getStatus().paused_until), true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "xintel_empty_response_backoff");
  assert.equal(db.calls.length, callCountAfterFirst);
});

test("OpportunityMonitor records a valid empty candidate response as success", async () => {
  const db = createDbStub();
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 24,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: false,
      opportunityQueryMatrixEnabled: false,
      opportunityEnrichmentEnabled: false
    },
    db
  });
  monitor.callHermes = async () => '{"opportunities":[]}';

  const result = await monitor.runOnce("test");
  const finish = db.calls.find((call) => call.name === "finish");

  assert.deepEqual(result, {
    ok: true,
    partial: false,
    items: 0,
    existing_enriched: 0,
    errors: []
  });
  assert.equal(finish.runId, 42);
  assert.equal(finish.row.status, "ok");
  assert.equal(finish.row.error, "");
  assert.equal(finish.row.itemCount, 0);
  assert.equal(finish.row.jobStats.length, 1);
  assert.equal(finish.row.jobStats[0].status, "ok");
  assert.equal(finish.row.jobStats[0].candidate_count, 0);
});

test("OpportunityMonitor backs off quota errors and stops remaining query jobs", async () => {
  const db = createDbStub();
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: false,
      opportunityQueryMatrixEnabled: true,
      opportunityMaxQueryJobs: 2,
      opportunityQuotaErrorBackoffSec: 43200
    },
    db
  });
  let callCount = 0;
  monitor.callHermes = async () => {
    callCount += 1;
    throw new Error(
      "hermes_failed:1:Error: Error code: 403 - {'code': 'personal-team-blocked:spending-limit', 'error': 'You have run out of credits or need a Grok subscription.'}"
    );
  };

  const first = await monitor.runOnce("test");
  const finish = db.calls.find((call) => call.name === "finish");
  const callCountAfterFirst = callCount;
  const status = monitor.getStatus();
  const pausedMs = Date.parse(status.paused_until) - Date.now();
  const second = await monitor.runOnce("test");

  assert.equal(first.ok, false);
  assert.equal(callCountAfterFirst, 1);
  assert.equal(finish.row.status, "error");
  assert.equal(finish.row.jobStats.length, 1);
  assert.equal(finish.row.jobStats[0].name, "main");
  assert.match(finish.row.error, /spending-limit/);
  assert.equal(Boolean(status.paused_until), true);
  assert.equal(status.next_run_at, status.paused_until);
  assert.ok(pausedMs > 43100 * 1000);
  assert.ok(pausedMs <= 43200 * 1000 + 5000);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "xintel_quota_error_backoff");
  assert.equal(callCount, callCountAfterFirst);
});

test("OpportunityMonitor records partial Hermes output when the command fails", async () => {
  const db = createDbStub();
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0
    },
    db
  });
  monitor.callHermes = async () => {
    const error = new Error("hermes_timeout_after_120000ms");
    error.stdout = '{"opportunities":[';
    error.stderr = "timeout";
    throw error;
  };

  const result = await monitor.runOnce("test");
  const finish = db.calls.find((call) => call.name === "finish");

  assert.equal(result.ok, false);
  assert.equal(finish.row.status, "error");
  assert.equal(finish.row.rawResponse, '## main\n{"opportunities":[\ntimeout');
  assert.equal(finish.row.error, "main:hermes_timeout_after_120000ms");
  assert.equal(finish.row.jobStats.length, 1);
  assert.equal(finish.row.jobStats[0].status, "error");
  assert.equal(finish.row.jobStats[0].raw_length, 26);
  assert.equal(finish.row.jobStats[0].error, "hermes_timeout_after_120000ms");
});

test("OpportunityMonitor.callHermes uses Hermes chat query mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ainews-hermes-"));
  const argsPath = path.join(dir, "args.txt");
  const binPath = path.join(dir, "hermes");
  fs.writeFileSync(
    binPath,
    `#!/bin/sh
printf '%s\\n' "$@" > '${argsPath}'
printf '{"opportunities":[]}'
`,
    { mode: 0o755 }
  );

  try {
    const monitor = new OpportunityMonitor({
      config: {
        opportunityHermesBin: binPath,
        opportunityHermesProfile: "xintel",
        opportunityHermesTimeoutSec: 10
      },
      db: createDbStub()
    });

    const raw = await monitor.callHermes("hello query");
    const args = fs.readFileSync(argsPath, "utf8").trim().split("\n");

    assert.equal(raw, '{"opportunities":[]}');
    assert.deepEqual(args, [
      "--profile",
      "xintel",
      "chat",
      "--query",
      "hello query",
      "--quiet",
      "--ignore-rules",
      "--source",
      "tool"
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpportunityMonitor.callHermes preserves Hermes stderr failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ainews-hermes-error-"));
  const binPath = path.join(dir, "hermes");
  fs.writeFileSync(
    binPath,
    `#!/bin/sh
printf 'Error code: 403 - spending limit reached\\n' >&2
exit 1
`,
    { mode: 0o755 }
  );

  try {
    const monitor = new OpportunityMonitor({
      config: {
        opportunityHermesBin: binPath,
        opportunityHermesProfile: "xintel",
        opportunityHermesTimeoutSec: 10
      },
      db: createDbStub()
    });

    await assert.rejects(
      () => monitor.callHermes("hello query"),
      /hermes_failed:1:Error code: 403 - spending limit reached/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpportunityMonitor prevents overlapping runs", async () => {
  const db = createDbStub();
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true
    },
    db
  });
  monitor.isRunning = true;

  const result = await monitor.runOnce("test");

  assert.deepEqual(result, { skipped: true, reason: "already_running" });
  assert.equal(db.calls.length, 0);
});

test("OpportunityMonitor accumulates focused Gate and onchain query results", async () => {
  const db = createDbStub();
  const upserts = [];
  db.upsertOpportunity = (item) => upserts.push(item);
  db.markExpiredOpportunities = () => {};
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: true,
      opportunityMaxQueryJobs: 3
    },
    db
  });

  monitor.callHermes = async (prompt) => {
    if (prompt.includes("专门搜索过去") && prompt.includes("Gate/Gate.io")) {
      return JSON.stringify({
        opportunities: [
          {
            activity_name: "Gate SpaceX Pre-IPO 机会",
            type: "pre_ipo",
            section: "cex",
            exchange: "Gate",
            venue: "Gate Startup",
            asset: "SPCX",
            expected_yield: "Pre-IPO 配额",
            reward: "SpaceX 相关份额",
            duration: "48 小时",
            deadline_at: "2099-01-01T00:00:00.000Z",
            source_published_at: new Date().toISOString(),
            participation: "通过 Gate 官方活动页认购或交易",
            source_user: "@gate_io",
            source_url: "https://x.com/gate_io/status/1",
            credibility: "official",
            risk_note: "Pre-IPO 存在估值和流动性风险"
          }
        ]
      });
    }
    if (prompt.includes("链上/DEX 稳定币收益专题搜索") || prompt.includes("链上/DEX 高收益机会")) {
      return JSON.stringify({
        opportunities: [
          {
            activity_name: "链上 USDC 积分加成",
            type: "onchain",
            section: "onchain",
            venue: "Example DEX",
            asset: "USDC",
            stablecoin: "USDC",
            expected_yield: "积分加成",
            reward: "交易积分",
            duration: "72 小时",
            deadline_at: "2099-01-02T00:00:00.000Z",
            source_published_at: new Date().toISOString(),
            participation: "连接钱包并向指定池提供流动性",
            source_user: "@exampledex",
            source_url: "https://x.com/exampledex/status/2",
            credibility: "kol",
            risk_note: "需核验合约和收益兑现"
          }
        ]
      });
    }
    return JSON.stringify({ opportunities: [] });
  };

  const result = await monitor.runOnce("test");
  const finish = db.calls.find((call) => call.name === "finish");

  assert.equal(result.ok, true);
  assert.equal(result.items, 2);
  assert.equal(upserts.length, 2);
  assert.ok(upserts.some((item) => item.exchange === "Gate" && item.type === "pre_ipo"));
  assert.ok(upserts.some((item) => item.section === "onchain"));
  assert.equal(finish.row.status, "ok");
  assert.equal(finish.row.jobStats.length, 3);
  assert.equal(finish.row.jobStats.filter((job) => job.status === "ok").length, 3);
  assert.equal(finish.row.jobStats.find((job) => job.name === "gate_spacex").saved_count, 1);
  assert.equal(finish.row.jobStats.find((job) => job.name === "onchain").saved_count, 1);
});

test("OpportunityMonitor limits and rotates matrix query jobs", async () => {
  const db = createDbStub();
  const upserts = [];
  db.getLatestOpportunityRun = () => ({ id: 1 });
  db.upsertOpportunity = (item) => upserts.push(item);
  db.markExpiredOpportunities = () => {};

  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: true,
      opportunityQueryMatrixEnabled: true,
      opportunityMaxQueryJobs: 4
    },
    db
  });

  const prompts = [];
  let callIndex = 0;
  monitor.callHermes = async (prompt) => {
    callIndex += 1;
    prompts.push(prompt);
    return JSON.stringify({
      opportunities: [
        {
          activity_name: `矩阵测试活动 ${callIndex}`,
          type: "short_term",
          section: "cex",
          exchange: "Binance",
          venue: "Binance",
          asset: "USDT",
          expected_yield: "测试奖励",
          reward: "测试奖励",
          duration: "48 小时",
          deadline_at: "2099-01-01T00:00:00.000Z",
          source_published_at: new Date().toISOString(),
          participation: "按官方入口参与",
          source_user: "@binance",
          source_url: `https://x.com/binance/status/${callIndex}`,
          credibility: "official",
          risk_note: "测试风险"
        }
      ]
    });
  };

  const result = await monitor.runOnce("test");
  const start = db.calls.find((call) => call.name === "start");

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 4);
  assert.equal(upserts.length, 4);
  const finish = db.calls.find((call) => call.name === "finish");
  assert.equal(finish.row.jobStats.length, 4);
  assert.equal(finish.row.jobStats.every((job) => job.candidate_count === 1), true);
  assert.equal(finish.row.jobStats.reduce((sum, job) => sum + job.saved_count, 0), 4);
  assert.match(start.prompt, /## main/);
  assert.match(start.prompt, /## gate_spacex/);
  assert.match(start.prompt, /## cex_launch/);
  assert.match(start.prompt, /## cex_stablecoin_earn/);
  assert.doesNotMatch(start.prompt, /## cex_pre_ipo/);
  assert.match(start.prompt, /source_url 必须是可追踪的 X 帖子链接/);
  assert.match(start.prompt, /source_published_at 必须填 X 帖发布时间的 UTC ISO/);
  assert.match(start.prompt, /不要填交易所首页、Earn 首页或泛产品首页/);
  assert.match(start.prompt, /不能确认固定截止时间时 deadline_source="unverified"/);
});

test("OpportunityMonitor records normalization drop reasons per query job", async () => {
  const db = createDbStub();
  const upserts = [];
  db.upsertOpportunity = (item) => upserts.push(item);
  db.markExpiredOpportunities = () => {};
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: false,
      opportunityQueryMatrixEnabled: false,
      opportunityMaxQueryJobs: 1
    },
    db
  });

  monitor.callHermes = async () =>
    JSON.stringify({
      opportunities: [
        {
          activity_name: "Low APR USDC Earn",
          type: "stablecoin_earn",
          section: "cex",
          exchange: "Binance",
          venue: "Binance Earn",
          asset: "USDC",
          stablecoin: "USDC",
          apy: 6.5,
          expected_yield: "6.5% APY",
          reward: "Low APR",
          duration: "7 days",
          deadline_at: "2099-01-01T00:00:00.000Z",
          source_published_at: new Date().toISOString(),
          participation: "Subscribe USDC",
          source_user: "@binance",
          source_url: "https://x.com/binance/status/low-apr",
          credibility: "official",
          risk_note: "APY too low"
        }
      ]
    });

  const result = await monitor.runOnce("test");
  const finish = db.calls.find((call) => call.name === "finish");

  assert.equal(result.ok, true);
  assert.equal(result.items, 0);
  assert.equal(upserts.length, 0);
  assert.equal(finish.row.jobStats[0].candidate_count, 1);
  assert.equal(finish.row.jobStats[0].normalized_count, 0);
  assert.equal(finish.row.jobStats[0].drop_count, 1);
  assert.equal(finish.row.jobStats[0].drop_reasons[0].reason, "apy_below_threshold");
  assert.equal(finish.row.jobStats[0].drop_reasons[0].label, "APY 低于 8%");
});

test("OpportunityMonitor inserts coverage gap search job from current opportunities", async () => {
  const db = createDbStub();
  const upserts = [];
  db.upsertOpportunity = (item) => upserts.push(item);
  db.markExpiredOpportunities = () => {};
  db.getDisplayOpportunities = () => [
    {
      activity_name: "Existing Binance USD1 Earn",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      stablecoin: "USD1",
      apy: 10,
      status: "active"
    }
  ];

  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: true,
      opportunityQueryMatrixEnabled: true,
      opportunityMaxQueryJobs: 4,
      opportunityStaleAfterHours: 96
    },
    db
  });

  const prompts = [];
  let callIndex = 0;
  monitor.callHermes = async (prompt) => {
    callIndex += 1;
    prompts.push(prompt);
    return JSON.stringify({
      opportunities: [
        {
          activity_name: `缺口补查测试 ${callIndex}`,
          type: "short_term",
          section: "cex",
          exchange: "OKX",
          venue: "OKX",
          asset: "USDT",
          expected_yield: "测试奖励",
          reward: "测试奖励",
          duration: "48 小时",
          deadline_at: "2099-01-01T00:00:00.000Z",
          source_published_at: new Date().toISOString(),
          participation: "按官方入口参与",
          source_user: "@okx",
          source_url: `https://x.com/okx/status/${callIndex}`,
          credibility: "official",
          risk_note: "测试风险"
        }
      ]
    });
  };

  const result = await monitor.runOnce("test");
  const start = db.calls.find((call) => call.name === "start");

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 4);
  assert.equal(upserts.length, 4);
  assert.match(start.prompt, /## cex_coverage_gaps/);
  assert.match(start.prompt, /当前网页覆盖矩阵的空白缺口/);
  assert.match(start.prompt, /OKX \/ Pre-TGE/);
  assert.match(start.prompt, /Pre-TGE token generation whitelist/);
});

test("OpportunityMonitor exposes next query plan with coverage gaps", () => {
  const db = createDbStub();
  db.getLatestOpportunityRun = () => ({ id: 7 });
  db.getDisplayOpportunities = () => [
    {
      activity_name: "Existing Binance USD1 Earn",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      stablecoin: "USD1",
      apy: 10,
      status: "active"
    }
  ];
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: false,
      opportunityIntervalSec: 900,
      opportunityLookbackHours: 72,
      opportunityFocusedQueriesEnabled: true,
      opportunityQueryMatrixEnabled: true,
      opportunityMaxQueryJobs: 4,
      opportunityStaleAfterHours: 96
    },
    db
  });

  const plan = monitor.getQueryPlan();

  assert.equal(plan.enabled, false);
  assert.equal(plan.job_count, 4);
  assert.equal(plan.jobs[0].name, "main");
  assert.equal(plan.jobs[2].name, "cex_coverage_gaps");
  assert.equal(plan.jobs[2].type, "coverage_gap");
  assert.equal(plan.jobs[2].gaps[0].exchange, "Binance");
  assert.equal(plan.jobs[2].gaps[0].label, "Pre-TGE");
});

test("OpportunityMonitor daily plan only collects launch and Pre-TGE", () => {
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityIntervalSec: 86400,
      opportunityLookbackHours: 24,
      opportunityCollectionTypes: ["launch", "pre_tge"],
      opportunityMaxQueryJobs: 3
    },
    db: createDbStub()
  });

  const plan = monitor.getQueryPlan();

  assert.equal(plan.interval_sec, 86400);
  assert.equal(plan.lookback_hours, 24);
  assert.deepEqual(plan.jobs.map((job) => job.name), ["cex_launch", "onchain_launch", "pre_tge"]);
  assert.match(plan.jobs[1].label, /链上打新/);
  const preTgePrompt = buildPreTgePrompt({ opportunityLookbackHours: 24 });
  assert.match(preTgePrompt, /任何测试网、激励测试网、devnet/);
  assert.match(preTgePrompt, /免费刷活跃、做测试网或等待未来可能空投/);
});

test("OpportunityMonitor saver plan keeps main plus one rotating matrix job", () => {
  const db = createDbStub();
  db.getLatestOpportunityRun = () => ({ id: 0 });
  db.getDisplayOpportunities = () => [
    {
      activity_name: "Existing Binance USD1 Earn",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      stablecoin: "USD1",
      apy: 10,
      status: "active"
    }
  ];
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityIntervalSec: 21600,
      opportunityLookbackHours: 72,
      opportunityFocusedQueriesEnabled: false,
      opportunityQueryMatrixEnabled: true,
      opportunityMaxQueryJobs: 2,
      opportunityStaleAfterHours: 1440
    },
    db
  });

  const plan = monitor.getQueryPlan();

  assert.equal(plan.enabled, true);
  assert.equal(plan.interval_sec, 21600);
  assert.equal(plan.max_jobs, 2);
  assert.equal(plan.job_count, 2);
  assert.equal(plan.jobs[0].name, "main");
  assert.equal(plan.jobs[1].name, "cex_pre_ipo");
  assert.equal(plan.jobs.some((job) => job.name === "gate_spacex"), false);
  assert.equal(plan.jobs.some((job) => job.name === "cex_coverage_gaps"), false);
});

test("OpportunityMonitor adapts query plan after main query timeout", () => {
  const db = createDbStub();
  db.getLatestOpportunityRun = () => ({
    id: 8,
    status: "partial",
    error: "main:hermes_timeout_after_240000ms",
    job_stats: [
      {
        name: "main",
        status: "error",
        error: "hermes_timeout_after_240000ms"
      }
    ]
  });
  db.getDisplayOpportunities = () => [
    {
      activity_name: "Existing Binance USD1 Earn",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      stablecoin: "USD1",
      apy: 10,
      status: "active"
    }
  ];
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: false,
      opportunityIntervalSec: 900,
      opportunityLookbackHours: 72,
      opportunityFocusedQueriesEnabled: true,
      opportunityQueryMatrixEnabled: true,
      opportunityAdaptiveQueryPlanEnabled: true,
      opportunityMaxQueryJobs: 4,
      opportunityStaleAfterHours: 96
    },
    db
  });

  const plan = monitor.getQueryPlan();

  assert.equal(plan.adaptive, true);
  assert.equal(plan.adaptations[0].key, "skip_main_after_timeout");
  assert.equal(plan.adaptations[0].affected_job, "main");
  assert.equal(plan.jobs.some((job) => job.name === "main"), false);
  assert.equal(plan.jobs[0].name, "gate_spacex");
  assert.equal(plan.jobs[1].name, "cex_coverage_gaps");
});

test("OpportunityMonitor run skips main query after recent main timeout", async () => {
  const db = createDbStub();
  const upserts = [];
  db.getLatestOpportunityRun = () => ({
    id: 2,
    status: "partial",
    error: "main:hermes_timeout_after_240000ms"
  });
  db.upsertOpportunity = (item) => upserts.push(item);
  db.markExpiredOpportunities = () => {};
  const monitor = new OpportunityMonitor({
    config: {
      opportunityMonitorEnabled: true,
      opportunityLookbackHours: 72,
      opportunityMaxFollowups: 0,
      opportunityFocusedQueriesEnabled: true,
      opportunityQueryMatrixEnabled: true,
      opportunityAdaptiveQueryPlanEnabled: true,
      opportunityMaxQueryJobs: 4
    },
    db
  });

  let callIndex = 0;
  monitor.callHermes = async () => {
    callIndex += 1;
    return JSON.stringify({
      opportunities: [
        {
          activity_name: `自适应测试活动 ${callIndex}`,
          type: "short_term",
          section: "cex",
          exchange: "Binance",
          venue: "Binance",
          asset: "USDT",
          expected_yield: "测试奖励",
          reward: "测试奖励",
          duration: "48 小时",
          deadline_at: "2099-01-01T00:00:00.000Z",
          source_published_at: new Date().toISOString(),
          participation: "按官方入口参与",
          source_user: "@binance",
          source_url: `https://x.com/binance/status/adaptive-${callIndex}`,
          credibility: "official",
          risk_note: "测试风险"
        }
      ]
    });
  };

  const result = await monitor.runOnce("test");
  const start = db.calls.find((call) => call.name === "start");
  const finish = db.calls.find((call) => call.name === "finish");

  assert.equal(result.ok, true);
  assert.equal(upserts.length, 4);
  assert.doesNotMatch(start.prompt, /## main/);
  assert.match(start.prompt, /## gate_spacex/);
  assert.equal(finish.row.jobStats.some((job) => job.name === "main"), false);
  assert.equal(finish.row.jobStats.length, 4);
});

test("OpportunityMonitor enriches existing deadline candidates with bounded fallback", async () => {
  const db = createDbStub();
  const upserts = [];
  db.getOpportunityDeadlineEnrichmentCandidates = () => [
    {
      dedup_key: "existing",
      activity_name: "Existing USDC Earn",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      venue: "Simple Earn",
      asset: "USDC",
      stablecoin: "USDC",
      apy: 10,
      expected_yield: "10% APY",
      reward: "APR boost",
      duration: "灵活",
      deadline_at: null,
      source_published_at: new Date().toISOString(),
      participation: "查看活动中心",
      source_user: "@binance",
      source_url: "https://x.com/binance/status/99",
      credibility: "official",
      risk_note: "需核验额度",
      status: "unverified"
    }
  ];
  db.upsertOpportunity = (item) => upserts.push(item);

  const monitor = new OpportunityMonitor({
    config: {
      opportunityEnrichmentEnabled: true,
      opportunityExistingEnrichmentMaxItems: 1,
      opportunityGrokDeadlineFallbackEnabled: true,
      opportunityGrokDeadlineFallbackMax: 1
    },
    db
  });
  monitor.callHermes = async () =>
    JSON.stringify({
      deadline_at: "2099-01-03T00:00:00.000Z",
      deadline_source: "grok",
      deadline_confidence: 0.6,
      deadline_text: "Ends Jan 3, 2099"
    });

  const count = await monitor.enrichExistingOpportunities(new Set());

  assert.equal(count, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].deadline_at, "2099-01-03T00:00:00.000Z");
  assert.equal(upserts[0].deadline_source, "grok");
});
