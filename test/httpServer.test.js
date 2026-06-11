import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/httpServer.js";

function createDbStub(healthRecords) {
  return {
    getStats: () => ({ total_events: 0, total_pushes: 0, now_sec: 0 }),
    getLatestRegimeStatus: () => ({
      regime: "Neutral",
      regime_probability: 50,
      risk_score: 0,
      market_confirmation: 0
    }),
    getLastHighEvents: () => [],
    recordHealth: (module, status, detail = "") => {
      healthRecords.push({ module, status, detail });
    },
    getActiveOpportunities: () => [],
    getLatestOpportunityRun: () => null,
    getOpportunityRuns: () => []
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("TradingView webhook rejects requests when enabled without a configured secret", async () => {
  const savedSignals = [];
  const healthRecords = [];
  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: true,
      tradingViewWebhookSecret: ""
    },
    db: createDbStub(healthRecords),
    getRuntimeStatus: () => ({ updated_at: "2026-05-30T00:00:00.000Z" }),
    tradingViewSignalStore: { save: (signal) => savedSignals.push(signal) }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/webhook/tradingview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "BTCUSDT", direction: "risk_off" })
    });
    const body = await response.json();

    assert.ok([401, 403, 503].includes(response.status));
    assert.equal(body.ok, false);
    assert.equal(body.error, "webhook_secret_missing");
    assert.equal(savedSignals.length, 0);
    assert.ok(
      healthRecords.some(
        (record) =>
          record.module === "tradingview_webhook" &&
          record.status === "error" &&
          record.detail.includes("secret_missing")
      )
    );
  } finally {
    await closeServer(server);
  }
});

test("TradingView webhook stays explicitly rejected when disabled", async () => {
  const savedSignals = [];
  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      tradingViewWebhookSecret: "configured"
    },
    db: createDbStub([]),
    getRuntimeStatus: () => ({}),
    tradingViewSignalStore: { save: (signal) => savedSignals.push(signal) }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/webhook/tradingview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tradingview-secret": "configured"
      },
      body: JSON.stringify({ symbol: "BTCUSDT", direction: "risk_off" })
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, "webhook_disabled");
    assert.equal(savedSignals.length, 0);
  } finally {
    await closeServer(server);
  }
});

test("opportunities API returns active and unverified opportunities grouped by section and type", async () => {
  const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [
    {
      activity_name: "Binance USDC Earn Boost",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      venue: "Binance Earn",
      stablecoin: "USDC",
      apy: 12,
      source_user: "@binance",
      source_url: "https://x.com/binance/status/1",
      source_published_at: hoursAgo(2),
      credibility: "official",
      status: "active",
      deadline_at: "2099-01-01T00:00:00.000Z",
      deadline_source: "official_page",
      official_url: "https://www.binance.com/en/earn",
      risk_note: "Check quota."
    },
    {
      activity_name: "DEX Points Boost",
      type: "onchain",
      section: "onchain",
      venue: "Example DEX",
      apy: 20,
      source_user: "@example",
      source_url: "https://x.com/example/status/2",
      source_published_at: hoursAgo(30),
      credibility: "kol",
      status: "unverified",
      deadline_source: "no_fixed_deadline",
      risk_note: "Onchain risk."
    },
    {
      activity_name: "Bybit EU Fixed Earn USDC High APR",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Bybit",
      venue: "Fixed Earn",
      stablecoin: "USDC",
      apy: 16,
      source_user: "@BybitNordic",
      source_url: "https://x.com/BybitNordic/status/3",
      first_seen_at: hoursAgo(5),
      credibility: "official",
      status: "active",
      deadline_source: "no_fixed_deadline",
      official_url: "https://www.bybit.eu/en-EU/earn",
      official_url_source: "official_product",
      duration: "7-day (new users up to 100% APR) / 30-day (existing up to 16% APR)",
      participation: "Subscribe Bybit EU Fixed Earn USDC",
      risk_note: "Limited pool."
    }
  ];
  db.getLatestOpportunityRun = () => ({
    status: "ok",
    item_count: 2,
    job_stats: [
      {
        name: "main",
        label: "主查询",
        type: "cex",
        status: "ok",
        duration_ms: 43000,
        raw_length: 1200,
        candidate_count: 2,
        normalized_count: 2,
        saved_count: 2,
        drop_count: 1,
        duplicate_count: 0,
        drop_reasons: [
          {
            reason: "apy_below_threshold",
            label: "APY 低于 8%",
            count: 1,
            examples: ["Low APR USDC Earn"]
          }
        ],
        error: ""
      }
    ]
  });
  db.getOpportunityRuns = () => [
    {
      id: 7,
      started_at: hoursAgo(1),
      finished_at: hoursAgo(1),
      status: "ok",
      duration_ms: 43000,
      error: "",
      item_count: 2,
      job_stats: [
        {
          name: "main",
          label: "主查询",
          type: "cex",
          status: "ok",
          duration_ms: 43000,
          raw_length: 1200,
          candidate_count: 2,
          normalized_count: 2,
          saved_count: 2,
          drop_count: 1,
          duplicate_count: 0,
          drop_reasons: [
            {
              reason: "apy_below_threshold",
              label: "APY 低于 8%",
              count: 1,
              examples: ["Low APR USDC Earn"]
            }
          ],
          error: ""
        }
      ]
    }
  ];
  db.getOpportunityDeadlineEnrichmentCandidates = () => [
    {
      dedup_key: "okx-spacex-missing-deadline",
      activity_name: "OKX SpaceX Pre-IPO Missing Deadline",
      type: "pre_ipo",
      section: "cex",
      exchange: "OKX",
      venue: "OKX",
      asset: "SPCX",
      source_user: "@OKX",
      source_url: "https://x.com/okx/status/4",
      credibility: "official",
      status: "unverified",
      deadline_at: null,
      deadline_source: null,
      official_url: null,
      enriched_at: "2026-06-10T00:00:00.000Z",
      enrichment_error: "official_fetch_404"
    }
  ];

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 96
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({
      enabled: true,
      job_count: 3,
      lookback_hours: 72,
      jobs: [
        { name: "main", label: "主查询", type: "cex", gaps: [] },
        {
          name: "cex_coverage_gaps",
          label: "CEX 覆盖缺口补查",
          type: "coverage_gap",
          gaps: [{ exchange: "OKX", label: "稳定币理财", suggested_query: "OKX USDT APR" }]
        }
      ]
    }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/opportunities`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.total, 3);
    assert.equal(body.active_total, 2);
    assert.equal(body.actionable_total, 1);
    assert.equal(body.unverified_total, 1);
    assert.equal(body.watch_total, 1);
    assert.deepEqual(body.deadline_quality, { confirmed: 1, no_fixed_deadline: 2, pending: 0 });
    assert.deepEqual(body.official_quality, { linked: 2, missing: 1 });
    assert.deepEqual(body.data_quality, { average_score: 90, high: 2, medium: 1, low: 0 });
    assert.deepEqual(body.urgency, { urgent_48h: 0, soon_7d: 0, within_7d: 0, no_fixed_deadline: 2, pending: 0 });
    assert.deepEqual(body.freshness, { new_6h: 2, within_24h: 2, within_72h: 3, stale_or_unknown: 0 });
    assert.deepEqual(body.risk, { extreme: 0, high: 1, medium: 0, low: 2 });
    assert.equal(body.coverage.summary.total_cells, 20);
    assert.equal(body.coverage.summary.covered_cells, 2);
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Binance").cells[0].status, "covered");
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Binance").cells[0].highest_apy, 12);
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Bybit").cells[0].status, "watch");
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Bybit").cells[0].highest_apy, 100);
    assert.equal(body.coverage.rows.find((row) => row.exchange === "OKX").cells[0].status, "missing");
    assert.deepEqual(body.coverage.summary.empty_exchanges, ["OKX", "Gate", "Bitget"]);
    assert.equal(body.coverage.summary.missing_by_category.stablecoin_earn, 3);
    assert.equal(body.coverage.summary.missing_by_category.launch, 5);
    assert.equal(body.coverage.gaps.length, 18);
    assert.equal(body.coverage.gaps[0].exchange, "OKX");
    assert.equal(body.coverage.gaps[0].type, "stablecoin_earn");
    assert.equal(body.coverage.gaps[0].priority, "high");
    assert.match(body.coverage.gaps[0].suggested_query, /USDT OR USDC OR USD1/);
    assert.equal(body.stablecoin_summary.total, 2);
    assert.equal(body.stablecoin_summary.cex_total, 2);
    assert.deepEqual(body.stablecoin_summary.by_coin, { USDC: 2 });
    assert.equal(body.stablecoin_summary.highest.exchange, "Bybit");
    assert.equal(body.stablecoin_summary.highest.stablecoin, "USDC");
    assert.equal(body.stablecoin_summary.highest.apy, 100);
    assert.equal(body.stablecoin_summary.highest.base_apy, 16);
    assert.equal(body.stablecoin_summary.highest.apy_source, "text");
    assert.equal(body.stablecoin_summary.highest.is_promotional_high, true);
    assert.ok(body.stablecoin_summary.highest.condition_tags.includes("最高促销 APY"));
    assert.match(body.stablecoin_summary.highest.yield_summary, /新户限定/);
    assert.equal(body.field_gaps.total_items_with_gap, 2);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "deadline").count, 0);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "official_url").count, 1);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "participation").count, 2);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "unverified").examples[0].activity_name, "DEX Points Boost");
    assert.equal(body.enrichment_backlog.enabled, true);
    assert.equal(body.enrichment_backlog.cooldown_hours, 12);
    assert.equal(body.enrichment_backlog.ready_count, 1);
    assert.equal(body.enrichment_backlog.waiting_cooldown_count, 0);
    assert.equal(body.enrichment_backlog.ready[0].activity_name, "OKX SpaceX Pre-IPO Missing Deadline");
    assert.deepEqual(body.enrichment_backlog.ready[0].reasons, ["缺截止时间", "缺官方入口", "上次补查失败"]);
    assert.equal(body.enrichment_backlog.ready[0].retry_after_at, "2026-06-10T12:00:00.000Z");
    assert.equal(body.collection_diagnostics.status, "needs_attention");
    assert.equal(body.collection_diagnostics.label, "需重点补查");
    assert.ok(body.collection_diagnostics.score < 100);
    assert.ok(body.collection_diagnostics.issues.some((issue) => issue.key === "coverage_gap"));
    assert.ok(body.collection_diagnostics.issues.some((issue) => issue.key === "field_gap"));
    assert.ok(body.collection_diagnostics.issues.some((issue) => issue.key === "candidate_filtering"));
    assert.equal(body.collection_diagnostics.filter_summary.drop_count, 1);
    assert.equal(body.collection_diagnostics.filter_summary.top_reasons[0].label, "APY 低于 8%");
    assert.equal(body.collection_diagnostics.action_items[0].title, "补查 OKX · 稳定币理财");
    assert.match(body.collection_diagnostics.action_items[0].suggested_query, /OKX/);
    assert.ok(body.collection_diagnostics.strengths.some((item) => item.key === "stablecoin_found"));
    assert.equal(body.items[0].data_quality.level, "high");
    assert.deepEqual(body.items[0].data_quality.missing, ["参与方式"]);
    assert.equal(body.items[0].participation_guidance.generated, true);
    assert.match(body.items[0].participation_guidance.text, /Binance.*Earn\/理财页面/);
    assert.equal(body.items[0].participation_guidance.official_url, "https://www.binance.com/en/earn");
    assert.ok(body.items[0].participation_guidance.steps.some((step) => step.includes("APY")));
    assert.equal(body.items[0].urgency.level, "normal");
    assert.equal(body.items[0].freshness.level, "new");
    assert.equal(body.items[0].freshness.basis, "source_published_at");
    assert.equal(body.items[0].risk_profile.level, "低");
    assert.equal(body.items[0].yield_profile.label, "理财收益");
    assert.ok(body.items[0].yield_profile.qualifiers.includes("促销加成"));
    assert.ok(body.items[0].yield_profile.qualifiers.includes("额度有限"));
    assert.equal(body.items[1].data_quality.level, "medium");
    assert.deepEqual(body.items[1].data_quality.missing, ["官方入口", "参与方式"]);
    assert.equal(body.items[1].participation_guidance.generated, true);
    assert.match(body.items[1].participation_guidance.text, /官方 DApp/);
    assert.equal(body.items[1].urgency.level, "watch");
    assert.equal(body.items[1].freshness.level, "recent_72");
    assert.equal(body.items[1].risk_profile.level, "高");
    assert.equal(body.items[1].yield_profile.label, "链上收益");
    assert.ok(body.items[1].yield_profile.qualifiers.includes("链上收益"));
    assert.equal(body.items[2].review.label, "观察项");
    assert.equal(body.items[2].participation_guidance.generated, false);
    assert.match(body.items[2].participation_guidance.text, /Bybit.*Earn\/理财页面/);
    assert.equal(body.items[2].review.tone, "info");
    assert.ok(body.items[2].yield_profile.qualifiers.includes("固定期限"));
    assert.equal(body.items[2].yield_profile.base_apy, 16);
    assert.equal(body.items[2].yield_profile.max_apy, 100);
    assert.equal(body.items[2].yield_profile.max_apy_source, "text");
    assert.ok(body.items[2].yield_profile.qualifiers.includes("最高促销 APY"));
    assert.equal(body.items[2].urgency.level, "watch");
    assert.equal(body.items[2].freshness.basis, "first_seen_at");
    assert.equal(body.deadline_sources.official_page, 1);
    assert.equal(body.deadline_sources.no_fixed_deadline, 2);
    assert.equal(body.sections.cex.length, 2);
    assert.equal(body.sections.onchain.length, 1);
    assert.equal(body.categories.stablecoin_earn.length, 2);
    assert.equal(body.latest_run.status, "ok");
    assert.equal(body.run_health.status, "ok");
    assert.equal(body.run_health.label, "成功");
    assert.equal(body.run_health.issue_count, 0);
    assert.equal(body.recent_runs.length, 1);
    assert.equal(body.recent_runs[0].run_health.label, "成功");
    assert.equal(body.recent_runs[0].run_health.duration_ms, 43000);
    assert.equal(body.recent_runs[0].job_stats[0].label, "主查询");
    assert.equal(body.recent_runs[0].job_stats[0].saved_count, 2);
    assert.equal(body.latest_run.job_stats[0].candidate_count, 2);
    assert.equal(body.latest_run.job_stats[0].drop_reasons[0].reason, "apy_below_threshold");
    assert.equal(body.query_plan.job_count, 3);
    assert.equal(body.query_plan.jobs[1].name, "cex_coverage_gaps");
    assert.equal(body.query_plan.jobs[1].gaps[0].exchange, "OKX");
  } finally {
    await closeServer(server);
  }
});

test("opportunities API returns structured run health for partial xintel failures", async () => {
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [];
  db.getLatestOpportunityRun = () => ({
    status: "partial",
    item_count: 12,
    duration_ms: 241000,
    error: "main:hermes_timeout_after_240000ms; cex_launch:xintel_parse_failed:invalid_json"
  });

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 96
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({ enabled: false, job_count: 0, jobs: [] }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/opportunities`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.run_health.status, "partial");
    assert.equal(body.run_health.summary, "部分成功：已保存 12 条，2 个查询需复查");
    assert.equal(body.run_health.issues[0].job_label, "主查询");
    assert.equal(body.run_health.issues[0].type, "timeout");
    assert.equal(body.run_health.issues[0].label, "240 秒超时");
    assert.equal(body.run_health.issues[1].job_label, "CEX 打新专题");
    assert.equal(body.run_health.issues[1].type, "parse_failed");
    assert.equal(body.latest_run.job_stats.length, 2);
    assert.equal(body.latest_run.job_stats[0].name, "main");
    assert.equal(body.latest_run.job_stats[0].fallback, true);
    assert.equal(body.latest_run.job_stats[1].status, "parse_failed");
  } finally {
    await closeServer(server);
  }
});

test("opportunities runs API returns recent run health", async () => {
  const db = createDbStub([]);
  db.getLatestOpportunityRun = () => ({
    id: 12,
    started_at: "2026-06-10T01:00:00.000Z",
    finished_at: "2026-06-10T01:04:01.000Z",
    status: "partial",
    duration_ms: 241000,
      error: "main:hermes_timeout_after_240000ms",
      item_count: 6,
      job_stats: [
        {
          name: "main",
          label: "主查询",
          type: "cex",
          status: "error",
          duration_ms: 240000,
          raw_length: 0,
          candidate_count: 0,
          normalized_count: 0,
          saved_count: 0,
          error: "hermes_timeout_after_240000ms"
        }
      ]
    });
  db.getOpportunityRuns = (limit) => [
    {
      id: 12,
      started_at: "2026-06-10T01:00:00.000Z",
      finished_at: "2026-06-10T01:04:01.000Z",
      status: "partial",
      duration_ms: 241000,
      error: "main:hermes_timeout_after_240000ms",
      item_count: 6,
      job_stats: [
        {
          name: "main",
          label: "主查询",
          type: "cex",
          status: "error",
          duration_ms: 240000,
          raw_length: 0,
          candidate_count: 0,
          normalized_count: 0,
          saved_count: 0,
          error: "hermes_timeout_after_240000ms"
        }
      ]
    },
    {
      id: 11,
      started_at: "2026-06-10T00:45:00.000Z",
      finished_at: "2026-06-10T00:45:38.000Z",
      status: "ok",
      duration_ms: 38000,
      error: "",
      item_count: 12,
      job_stats: [
        {
          name: "main",
          label: "主查询",
          type: "cex",
          status: "ok",
          duration_ms: 38000,
          raw_length: 3000,
          candidate_count: 12,
          normalized_count: 12,
          saved_count: 12,
          error: ""
        }
      ]
    }
  ].slice(0, limit);

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 96
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({ enabled: true, job_count: 4, jobs: [] }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/opportunities/runs`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.latest_run.id, 12);
    assert.equal(body.run_health.status, "partial");
    assert.equal(body.run_health.summary, "部分成功：已保存 6 条，1 个查询需复查");
    assert.equal(body.runs.length, 2);
    assert.equal(body.runs[0].run_health.issues[0].label, "240 秒超时");
    assert.equal(body.runs[0].job_stats[0].status, "error");
    assert.equal(body.runs[0].job_stats[0].duration_ms, 240000);
    assert.equal(body.runs[1].run_health.label, "成功");
  } finally {
    await closeServer(server);
  }
});

test("opportunities CSV export returns Chinese columns", async () => {
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [
    {
      activity_name: "Binance USDC Earn Boost",
      type: "stablecoin_earn",
      section: "cex",
      exchange: "Binance",
      venue: "Binance Earn",
      stablecoin: "USDC",
      apy: 12,
      duration: "7-day new users up to 25% APR / standard 12% APR",
      source_user: "@binance",
      source_url: "https://x.com/binance/status/1",
      source_published_at: new Date().toISOString(),
      credibility: "official",
      status: "active",
      deadline_at: "2099-01-01T00:00:00.000Z",
      deadline_source: "official_page",
      official_url: "https://www.binance.com/en/earn",
      participation: "通过 Binance Earn 认购 USDC",
      risk_note: "需核验额度和地区限制。"
    }
  ];

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 96
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({ enabled: false, job_count: 0, jobs: [] }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/opportunities/export.csv`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/csv/);
    assert.match(response.headers.get("content-disposition"), /opportunities\.csv/);
    assert.match(text, /活动名称,类型,状态,交易所\/项目/);
    assert.match(text, /APY,最高APY,入库\/常规APY,收益性质,收益条件,收益\/奖励/);
    assert.match(text, /参与方式,参与指引,来源账号/);
    assert.match(text, /Binance USDC Earn Boost,稳定币理财,可参与,Binance/);
    assert.match(text, /,12,25,12,/);
    assert.match(text, /最高促销 APY/);
    assert.match(text, /通过 Binance Earn 认购 USDC/);
    assert.match(text, /进入 Binance 的 Earn\/理财页面/);
    assert.match(text, /理财收益/);
  } finally {
    await closeServer(server);
  }
});

test("opportunities page returns html", async () => {
  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false
    },
    db: createDbStub([]),
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({
      enabled: false,
      job_count: 2,
      lookback_hours: 72,
      jobs: [
        { name: "main", label: "主查询", type: "cex", gaps: [] },
        { name: "cex_coverage_gaps", label: "CEX 覆盖缺口补查", type: "coverage_gap", gaps: [] }
      ]
    }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/opportunities`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(text, /xintel 高收益机会监控/);
    assert.match(text, /可参与/);
    assert.match(text, /导出 CSV/);
    assert.match(text, /\/api\/opportunities\/export\.csv/);
    assert.match(text, /data-default-excludes-unverified="true"/);
    assert.match(text, /监控关闭/);
    assert.match(text, /还有 /);
    assert.match(text, /CEX覆盖/);
    assert.match(text, /下轮查询/);
    assert.match(text, /稳定币最高/);
    assert.match(text, /稳定币理财摘要/);
    assert.match(text, /入库\/常规 APY/);
    assert.match(text, /促销最高/);
    assert.match(text, /近期采集/);
    assert.match(text, /本轮任务明细/);
    assert.match(text, /任务明细/);
    assert.match(text, /过滤/);
    assert.match(text, /采集诊断/);
    assert.match(text, /过滤摘要/);
    assert.match(text, /下一步动作/);
    assert.match(text, /待补字段/);
    assert.match(text, /补查队列/);
    assert.match(text, /官方\/截止补查队列/);
    assert.match(text, /下轮补查/);
    assert.match(text, /下轮 xintel 查询计划/);
    assert.match(text, /CEX × 类别覆盖矩阵/);
    assert.match(text, /优先补查缺口/);
    assert.match(text, /截止质量/);
    assert.match(text, /官方链接/);
    assert.match(text, /新鲜度/);
    assert.match(text, /新发现/);
    assert.match(text, /资料完整度/);
    assert.match(text, /观察项/);
    assert.match(text, /即将截止/);
    assert.match(text, /高风险/);
    assert.match(text, /打开官方入口参与/);
    assert.match(text, /步骤：/);
    assert.match(text, /收益性质/);
  } finally {
    await closeServer(server);
  }
});
