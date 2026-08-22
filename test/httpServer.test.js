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
    assert.equal(body.coverage.summary.total_cells, 10);
    assert.equal(body.coverage.summary.covered_cells, 0);
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Binance").cells[0].status, "missing");
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Binance").cells[0].label, "打新");
    assert.equal(body.coverage.rows.find((row) => row.exchange === "Bybit").cells[1].label, "Pre-TGE");
    assert.equal(body.coverage.rows.find((row) => row.exchange === "OKX").cells[0].status, "missing");
    assert.deepEqual(body.coverage.summary.empty_exchanges, ["Binance", "OKX", "Bybit", "Gate", "Bitget"]);
    assert.equal(body.coverage.summary.missing_by_category.launch, 5);
    assert.equal(body.coverage.summary.missing_by_category.pre_tge, 5);
    assert.equal(body.coverage.gaps.length, 10);
    assert.equal(body.coverage.gaps[0].exchange, "Binance");
    assert.equal(body.coverage.gaps[0].type, "pre_tge");
    assert.equal(body.coverage.gaps[0].priority, "high");
    assert.match(body.coverage.gaps[0].suggested_query, /Pre-TGE token generation/);
    assert.equal(body.stablecoin_summary.total, 2);
    assert.equal(body.stablecoin_summary.cex_total, 2);
    assert.deepEqual(body.stablecoin_summary.by_coin, { USDC: 2 });
    assert.equal(body.stablecoin_summary.highest.exchange, "Bybit");
    assert.equal(body.stablecoin_summary.highest.stablecoin, "USDC");
    assert.equal(body.stablecoin_summary.highest.apy, 16);
    assert.equal(body.stablecoin_summary.highest.base_apy, 16);
    assert.equal(body.stablecoin_summary.highest.apy_source, "stored");
    assert.equal(body.stablecoin_summary.highest.is_promotional_high, false);
    assert.ok(body.stablecoin_summary.highest.condition_tags.includes("含新户档"));
    assert.match(body.stablecoin_summary.highest.yield_summary, /含新户档/);
    assert.equal(body.display_filter.input_count, 3);
    assert.equal(body.display_filter.kept_count, 3);
    assert.equal(body.display_filter.excluded_count, 0);
    assert.equal(body.display_filter.watch_count, 1);
    assert.equal(body.display_filter.stablecoin_yield_count, 2);
    assert.equal(body.display_filter.quick_opportunity_count, 0);
    assert.deepEqual(body.display_filter.excluded_examples, []);
    assert.equal(body.display_filter.watch_examples[0].activity_name, "DEX Points Boost");
    assert.deepEqual(
      body.items.slice(0, 2).map((item) => item.activity_name),
      ["Bybit EU Fixed Earn USDC High APR", "Binance USDC Earn Boost"]
    );
    assert.equal(body.field_gaps.total_items_with_gap, 2);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "deadline").count, 0);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "official_url").count, 1);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "participation").count, 2);
    assert.equal(body.field_gaps.fields.find((field) => field.key === "unverified").count, 1);
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
    assert.equal(body.collection_diagnostics.action_items[0].title, "补查 Binance · Pre-TGE");
    assert.match(body.collection_diagnostics.action_items[0].suggested_query, /Binance.*Pre-TGE/);
    assert.ok(body.collection_diagnostics.strengths.some((item) => item.key === "stablecoin_found"));
    const binanceItem = body.items.find((item) => item.activity_name === "Binance USDC Earn Boost");
    assert.equal(binanceItem.display_category, "stablecoin_yield");
    assert.match(binanceItem.display_reason, /USDC APY/);
    assert.equal(binanceItem.data_quality.level, "high");
    assert.deepEqual(binanceItem.data_quality.missing, ["参与方式"]);
    assert.equal(binanceItem.participation_guidance.generated, true);
    assert.match(binanceItem.participation_guidance.text, /Binance.*Earn\/理财页面/);
    assert.equal(binanceItem.participation_guidance.official_url, "https://www.binance.com/en/earn");
    assert.ok(binanceItem.participation_guidance.steps.some((step) => step.includes("APY")));
    assert.equal(binanceItem.urgency.level, "normal");
    assert.equal(binanceItem.freshness.level, "new");
    assert.equal(binanceItem.freshness.basis, "source_published_at");
    assert.equal(binanceItem.risk_profile.level, "低");
    assert.equal(binanceItem.yield_profile.label, "理财收益");
    assert.ok(binanceItem.yield_profile.qualifiers.includes("促销加成"));
    assert.ok(binanceItem.yield_profile.qualifiers.includes("额度有限"));
    assert.equal(binanceItem.campaign_profile.event_type, "活期");
    assert.equal(binanceItem.campaign_profile.platform_path, "Binance 主站 → 活期");
    assert.equal(binanceItem.campaign_profile.quota_label, "额度有限");
    assert.match(binanceItem.campaign_profile.estimated_return_label, /\$10,000 本金预期收益 \$100\.00/);
    const dexItem = body.items.find((item) => item.activity_name === "DEX Points Boost");
    assert.equal(dexItem.display_category, "watch_opportunity");
    assert.equal(dexItem.review.label, "待核验");
    assert.match(dexItem.display_reason, /非 active 状态/);
    const bybitItem = body.items.find((item) => item.activity_name === "Bybit EU Fixed Earn USDC High APR");
    assert.equal(bybitItem.display_category, "stablecoin_yield");
    assert.equal(bybitItem.data_quality.level, "high");
    assert.deepEqual(bybitItem.data_quality.missing, []);
    assert.equal(bybitItem.participation_guidance.generated, false);
    assert.equal(bybitItem.urgency.level, "watch");
    assert.equal(bybitItem.freshness.level, "new");
    assert.equal(bybitItem.risk_profile.level, "低");
    assert.equal(bybitItem.yield_profile.label, "理财收益");
    assert.equal(bybitItem.review.label, "观察项");
    assert.equal(bybitItem.review.tone, "info");
    assert.match(bybitItem.participation_guidance.text, /Bybit.*Earn\/理财页面/);
    assert.ok(bybitItem.yield_profile.qualifiers.includes("固定期限"));
    assert.equal(bybitItem.yield_profile.base_apy, 16);
    assert.equal(bybitItem.yield_profile.max_apy, 16);
    assert.equal(bybitItem.yield_profile.max_apy_source, "stored");
    assert.ok(bybitItem.yield_profile.qualifiers.includes("含新户档"));
    assert.equal(bybitItem.campaign_profile.event_type, "锁定");
    assert.equal(bybitItem.campaign_profile.platform_path, "Bybit 主站 → 锁定");
    assert.equal(bybitItem.campaign_profile.lock_label, "锁仓 30 天");
    assert.match(bybitItem.campaign_profile.estimated_return_label, /\$131\.51/);
    assert.equal(bybitItem.freshness.basis, "first_seen_at");
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

test("opportunities API classifies displayable yield, quick opportunities, and watch items", async () => {
  const base = {
    section: "cex",
    exchange: "Binance",
    venue: "Launchpad",
    source_user: "@official",
    source_url: "https://x.com/official/status/base",
    source_published_at: new Date().toISOString(),
    credibility: "official",
    status: "active",
    deadline_source: "no_fixed_deadline",
    official_url: "https://example.com",
    risk_note: "需核验条款。"
  };
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [
    {
      ...base,
      activity_name: "USDC 10% Earn 不应展示",
      type: "stablecoin_earn",
      stablecoin: "USDC",
      apy: 10
    },
    {
      ...base,
      activity_name: "DAI 20% Earn 不应展示",
      type: "stablecoin_earn",
      stablecoin: "DAI",
      apy: 20
    },
    {
      ...base,
      activity_name: "USDT 10.01% Earn 应展示",
      type: "stablecoin_earn",
      stablecoin: "USDT",
      apy: 10.01
    },
    {
      ...base,
      activity_name: "Launch 10分钟固定奖励",
      type: "launch",
      asset: "NEW",
      reward: "固定奖励 10 USDT",
      participation: "预计 10分钟 完成申购任务"
    },
    {
      ...base,
      activity_name: "Pre-IPO 2小时低收益不展示",
      type: "pre_ipo",
      asset: "SPCX",
      reward: "固定奖励 49 USDT",
      participation: "预计 2小时 完成"
    },
    {
      ...base,
      activity_name: "Pre-token 按天年化机会",
      type: "pre_ipo",
      asset: "PRE",
      expected_yield: "年化 11%",
      duration: "3天"
    },
    {
      ...base,
      activity_name: "CandyBomb 交易比赛不展示",
      type: "short_term",
      asset: "WLD",
      reward: "交易量排名瓜分 31500 WLD",
      participation: "CandyBomb 交易竞赛"
    },
    {
      ...base,
      activity_name: "邀请好友奖励不展示",
      type: "short_term",
      reward: "邀请好友获得 20 USDT",
      participation: "邀请好友注册"
    },
    {
      ...base,
      activity_name: "Trade-to-Earn 不展示",
      type: "short_term",
      reward: "share pool by volume",
      participation: "Trade-to-Earn volume competition"
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
    const body = await (await fetch(`http://127.0.0.1:${port}/api/opportunities`)).json();
    const names = body.items.map((item) => item.activity_name);

    assert.equal(names.length, 9);
    assert.ok(names.includes("USDT 10.01% Earn 应展示"));
    assert.ok(names.includes("Pre-token 按天年化机会"));
    assert.ok(names.includes("Launch 10分钟固定奖励"));
    assert.ok(names.includes("CandyBomb 交易比赛不展示"));
    assert.equal(body.display_filter.input_count, 9);
    assert.equal(body.display_filter.kept_count, 9);
    assert.equal(body.display_filter.excluded_count, 0);
    assert.equal(body.display_filter.watch_count, 6);
    assert.equal(body.display_filter.stablecoin_yield_count, 1);
    assert.equal(body.display_filter.quick_opportunity_count, 2);
    assert.deepEqual(body.display_filter.excluded_examples, []);
    assert.equal(body.display_filter.watch_examples.length, 6);
    assert.ok(body.items.some((item) => item.display_reason === "USDT APY 10.01%"));
    assert.ok(body.items.some((item) => item.display_reason.includes("10 分钟")));
    assert.ok(body.items.some((item) => item.display_reason.includes("年化 11%")));
    const candyBomb = body.items.find((item) => item.activity_name === "CandyBomb 交易比赛不展示");
    assert.equal(candyBomb.display_category, "watch_opportunity");
    assert.equal(candyBomb.review.label, "观察项");
    assert.match(candyBomb.display_reason, /排除邀请/);

    const csv = await (await fetch(`http://127.0.0.1:${port}/api/opportunities/export.csv`)).text();
    assert.match(csv, /USDT 10\.01% Earn 应展示/);
    assert.match(csv, /CandyBomb/);
    assert.match(csv, /邀请好友/);
    assert.match(csv, /Trade-to-Earn/);
    assert.match(csv, /DAI 20%/);
  } finally {
    await closeServer(server);
  }
});

test("opportunities API sorts by current-user yield and filters new-user-only yields", async () => {
  const base = {
    type: "stablecoin_earn",
    section: "cex",
    venue: "Earn",
    source_user: "@official",
    source_url: "https://x.com/official/status/base-yield",
    source_published_at: new Date().toISOString(),
    credibility: "official",
    status: "active",
    deadline_source: "no_fixed_deadline",
    official_url: "https://example.com",
    participation: "Subscribe in Earn",
    risk_note: "需核验额度和地区限制。"
  };
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [
    {
      ...base,
      activity_name: "Binance USD1 Simple Earn Flexible",
      exchange: "Binance",
      stablecoin: "USD1",
      asset: "USD1",
      apy: 10.5,
      expected_yield: "最高10.5% APR（含阶梯 bonus），普通用户限额2000 USD1/人，基础 APR 5.2%-6.24%",
      reward: "实时 APR 奖励 + 额外阶梯 bonus",
      duration: "灵活，无锁仓"
    },
    {
      ...base,
      activity_name: "Gate USD1 Soft Staking",
      exchange: "Gate",
      stablecoin: "USD1",
      asset: "USD1",
      apy: 20,
      expected_yield: "20% APR",
      duration: "持续中，无固定期限",
      participation: "Subscribe in Earn; unlimited quota; daily payout; no lockup"
    },
    {
      ...base,
      activity_name: "New User Only USDC Earn",
      exchange: "Bybit",
      stablecoin: "USDC",
      asset: "USDC",
      apy: 100,
      expected_yield: "New users up to 100% APR",
      participation: "New users only",
      duration: "7 days"
    }
  ];

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 1440
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({ enabled: false, job_count: 0, jobs: [] }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/opportunities`)).json();
    const names = body.items.map((item) => item.activity_name);

    assert.deepEqual(names, ["Gate USD1 Soft Staking", "Binance USD1 Simple Earn Flexible"]);
    assert.equal(body.display_filter.input_count, 3);
    assert.equal(body.display_filter.kept_count, 2);
    assert.equal(body.display_filter.excluded_count, 1);
    assert.equal(body.display_filter.excluded_new_user_count, 1);
    assert.equal(body.display_filter.excluded_examples[0].activity_name, "New User Only USDC Earn");
    assert.equal(body.stablecoin_summary.highest.exchange, "Gate");
    assert.equal(body.stablecoin_summary.highest.apy, 20);

    const binance = body.items.find((item) => item.activity_name === "Binance USD1 Simple Earn Flexible");
    assert.equal(binance.yield_profile.max_apy, 10.5);
    assert.equal(binance.display_reason, "USD1 APY 10.5%");
    assert.equal(binance.display_reason.includes("2000"), false);

    const gate = body.items.find((item) => item.activity_name === "Gate USD1 Soft Staking");
    assert.equal(gate.campaign_profile.event_type, "活期");
    assert.equal(gate.campaign_profile.quota_label, "无限额");
    assert.equal(gate.campaign_profile.payout_label, "每天派息");
    assert.equal(gate.campaign_profile.lock_label, "无锁仓");
    assert.equal(gate.campaign_profile.time_left_label, "长期");
    assert.match(gate.campaign_profile.estimated_return_label, /\$166\.67/);
    assert.equal(gate.yield_profile.qualifiers.includes("固定期限"), false);
  } finally {
    await closeServer(server);
  }
});

test("opportunities API merges duplicate campaign sources by platform and asset", async () => {
  const nowIso = new Date().toISOString();
  const base = {
    type: "stablecoin_earn",
    section: "cex",
    venue: "Earn",
    source_published_at: nowIso,
    credibility: "official",
    status: "active",
    deadline_source: "no_fixed_deadline",
    official_url: "https://example.com",
    participation: "Subscribe in Earn",
    risk_note: "需核验额度和地区限制。"
  };
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [
    {
      ...base,
      activity_name: "Gate.io USD1 灵活质押赚取",
      exchange: "Gate",
      venue: "Gate.io Earn",
      stablecoin: "USD1",
      asset: "USD1",
      apy: 20,
      source_user: "@gate_a",
      source_url: "https://x.com/gate_a/status/1",
      duration: "灵活，无锁仓"
    },
    {
      ...base,
      activity_name: "Gate.io USD1 Soft Staking",
      exchange: "Gate",
      venue: "Soft Staking",
      stablecoin: "USD1",
      asset: "USD1",
      apy: 20,
      source_user: "@gate_b",
      source_url: "https://x.com/gate_b/status/2",
      status: "unverified",
      duration: "Flexible no lockup"
    },
    {
      ...base,
      activity_name: "Bitget USDGO Flexible Earn",
      exchange: "Bitget",
      venue: "Flexible Earn",
      stablecoin: "USDT",
      asset: "USDGO",
      apy: 12,
      source_user: "@bitget_a",
      source_url: "https://x.com/bitget_a/status/1",
      duration: "Flexible no lockup"
    },
    {
      ...base,
      activity_name: "Bitget USDGO 灵活储蓄",
      exchange: "Bitget",
      venue: "Bitget Earn",
      stablecoin: "USDT",
      asset: "USDGO",
      apy: 14,
      source_user: "@bitget_b",
      source_url: "https://x.com/bitget_b/status/2",
      status: "unverified",
      duration: "灵活，无锁仓"
    },
    {
      ...base,
      activity_name: "USD1 Simple Earn Flexible",
      exchange: "Binance",
      venue: "Simple Earn",
      stablecoin: "USD1",
      asset: "USD1",
      apy: 10.5,
      source_user: "@binance",
      source_url: "https://x.com/binance/status/1",
      duration: "灵活，无锁仓"
    },
    {
      ...base,
      activity_name: "Binance USD1 限额赚取",
      exchange: "Binance",
      venue: "Binance Earn / Yield Arena",
      stablecoin: "USD1",
      asset: "USD1",
      apy: 10.5,
      source_user: "@binance_fan",
      source_url: "https://x.com/binance_fan/status/2",
      duration: "灵活，限额"
    }
  ];

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 1440
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({ enabled: false, job_count: 0, jobs: [] }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/opportunities`)).json();
    const names = body.items.map((item) => item.activity_name);

    assert.equal(body.display_filter.input_count, 6);
    assert.equal(body.display_filter.pre_dedup_kept_count, 6);
    assert.equal(body.display_filter.kept_count, 3);
    assert.equal(body.display_filter.duplicate_group_count, 3);
    assert.equal(body.display_filter.duplicate_item_count, 3);
    assert.deepEqual(names, ["Gate.io USD1 灵活质押赚取", "Bitget USDGO Flexible Earn", "USD1 Simple Earn Flexible"]);

    const gate = body.items.find((item) => item.exchange === "Gate");
    assert.equal(gate.duplicate_profile.source_count, 2);
    assert.deepEqual(gate.duplicate_profile.source_users, ["@gate_a", "@gate_b"]);
    assert.equal(gate.duplicate_profile.analysis.family, "earn");
    assert.equal(gate.duplicate_profile.analysis.subject, "USD1");
    assert.equal(gate.duplicate_profile.analysis.match_basis, "asset");

    const bitget = body.items.find((item) => item.exchange === "Bitget");
    assert.equal(bitget.yield_profile.max_apy, 12);
    assert.equal(bitget.duplicate_profile.apy_range_label, "12-14% APY");
    assert.deepEqual(bitget.duplicate_profile.source_users, ["@bitget_a", "@bitget_b"]);

    const binance = body.items.find((item) => item.exchange === "Binance");
    assert.equal(binance.duplicate_profile.source_count, 2);
    assert.deepEqual(binance.duplicate_profile.source_users, ["@binance", "@binance_fan"]);
    assert.equal(body.display_filter.duplicate_examples.length, 3);
  } finally {
    await closeServer(server);
  }
});

test("opportunities API analyzes and dedupes related activities beyond named examples", async () => {
  const nowIso = new Date().toISOString();
  const base = {
    type: "short_term",
    section: "cex",
    exchange: "Binance",
    source_published_at: nowIso,
    credibility: "official",
    status: "active",
    deadline_source: "official_page",
    deadline_at: "2099-01-01T00:00:00.000Z",
    official_url: "https://example.com/campaign",
    risk_note: "需核验地区限制、额度和活动条款。"
  };
  const db = createDbStub([]);
  db.getDisplayOpportunities = () => [
    {
      ...base,
      activity_name: "Binance Alpha TRUST Airdrop",
      venue: "Binance Alpha",
      asset: "TRUST",
      stablecoin: "USDT",
      reward: "$20 USDT reward",
      duration: "5 minutes",
      participation: "Open Binance Alpha and claim TRUST airdrop",
      source_user: "@binance_alpha",
      source_url: "https://x.com/binance_alpha/status/1"
    },
    {
      ...base,
      activity_name: "TRUST Alpha 空投活动",
      venue: "Binance Alpha",
      asset: "TRUST",
      stablecoin: "USDT",
      reward: "$20 USDT reward",
      duration: "5 minutes",
      participation: "在 Binance Alpha 参与 TRUST 空投",
      source_user: "@kol_alpha",
      source_url: "https://x.com/kol_alpha/status/2",
      credibility: "kol"
    },
    {
      ...base,
      activity_name: "Binance Alpha BLESS Airdrop",
      venue: "Binance Alpha",
      asset: "BLESS",
      stablecoin: "USDT",
      reward: "$20 USDT reward",
      duration: "5 minutes",
      participation: "Open Binance Alpha and claim BLESS airdrop",
      source_user: "@binance_alpha",
      source_url: "https://x.com/binance_alpha/status/3"
    },
    {
      ...base,
      activity_name: "Binance Wallet Football Prediction Cup",
      venue: "Binance Wallet",
      asset: "Prediction Markets",
      stablecoin: "USDT",
      reward: "$15 USDT reward",
      duration: "10 minutes",
      participation: "Use Binance Wallet Predict.fun football market",
      source_user: "@binance_wallet",
      source_url: "https://x.com/binance_wallet/status/4"
    },
    {
      ...base,
      activity_name: "Predict.fun Football Cup on Binance Wallet",
      venue: "Predict.fun",
      asset: "",
      stablecoin: "USDT",
      reward: "$15 USDT reward",
      duration: "10 minutes",
      participation: "进入 Binance Wallet 预测市场参与足球杯",
      source_user: "@football_kol",
      source_url: "https://x.com/football_kol/status/5",
      credibility: "kol"
    }
  ];

  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false,
      opportunityStaleAfterHours: 1440
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getOpportunityQueryPlan: () => ({ enabled: false, job_count: 0, jobs: [] }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/opportunities`)).json();

    assert.equal(body.display_filter.input_count, 5);
    assert.equal(body.display_filter.pre_dedup_kept_count, 5);
    assert.equal(body.display_filter.kept_count, 3);
    assert.equal(body.display_filter.duplicate_group_count, 2);
    assert.equal(body.display_filter.duplicate_item_count, 2);

    const trust = body.items.find((item) => item.duplicate_profile?.analysis?.subject === "TRUST");
    assert.equal(trust.duplicate_profile.source_count, 2);
    assert.equal(trust.duplicate_profile.analysis.family, "alpha_airdrop");
    assert.equal(trust.duplicate_profile.analysis.match_basis, "asset");
    assert.deepEqual(trust.duplicate_profile.source_users, ["@binance_alpha", "@kol_alpha"]);

    const football = body.items.find((item) => item.duplicate_profile?.analysis?.family === "football_prediction");
    assert.equal(football.duplicate_profile.source_count, 2);
    assert.equal(football.duplicate_profile.analysis.subject, "football");
    assert.equal(football.duplicate_profile.analysis.match_basis, "event_theme");
    assert.deepEqual(football.duplicate_profile.source_users, ["@binance_wallet", "@football_kol"]);

    const bless = body.items.find((item) => item.duplicate_profile?.analysis?.subject === "BLESS");
    assert.equal(bless.duplicate_profile.source_count, 1);
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
    assert.match(text, /活动名称,展示分类,展示理由,类型,状态,交易所\/项目/);
    assert.match(text, /APY,最高APY,入库\/常规APY,事件类型,平台路径,额度,派息,锁仓\/赎回,到期\/剩余,估算收益,收益性质,收益条件,收益\/奖励/);
    assert.match(text, /参与方式,参与指引,来源账号/);
    assert.match(text, /Binance USDC Earn Boost,稳定币高息,USDC APY 12%,稳定币理财,可参与,Binance/);
    assert.match(text, /,12,12,12,活期,Binance 主站 → 活期,额度有限,派息待核验,锁仓待核验,/);
    assert.match(text, /含新户档/);
    assert.match(text, /\$10,000 本金预期收益 \$100\.00/);
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
    assert.match(text, /高收益机会看板/);
    assert.match(text, /按当前用户可参与 APY 从高到低排序/);
    assert.match(text, /新户专属活动默认过滤/);
    assert.match(text, /color-scheme: dark/);
    assert.match(text, /--bg: #050509/);
    assert.match(text, /--accent: #ff2f92/);
    assert.match(text, /tag hot/);
    assert.match(text, /合并来源/);
    assert.match(text, /活动列表/);
    assert.match(text, /全部交易所/);
    assert.match(text, /不限额度/);
    assert.match(text, /不限赎回期/);
    assert.match(text, /实时年利率/);
    assert.match(text, /到期时间/);
    assert.match(text, /参数 \/ 到期/);
    assert.match(text, /稳定币高息/);
    assert.match(text, /短期机会/);
    assert.match(text, /观察项/);
    assert.match(text, /导出 CSV/);
    assert.match(text, /\/api\/opportunities\/export\.csv/);
    assert.match(text, /data-default-excludes-unverified="true"/);
    assert.match(text, /监控关闭/);
    assert.match(text, /还有 /);
    assert.match(text, /CEX覆盖/);
    assert.match(text, /下轮查询/);
    assert.match(text, /稳定币最高/);
    assert.match(text, /短期机会/);
    assert.match(text, /稳定币理财摘要/);
    assert.match(text, /APY > 10%/);
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
    assert.match(text, /资料完整度/);
    assert.match(text, /观察项/);
    assert.match(text, /即将截止/);
    assert.match(text, /高风险/);
    assert.match(text, /收益性质/);
    assert.match(text, /安全事件监控/);
    assert.match(text, /securityIncidentMetric/);
    assert.match(text, /\/api\/security-incidents/);
  } finally {
    await closeServer(server);
  }
});

test("security incidents API returns monitor state, summary, health, and recent items", async () => {
  const db = createDbStub([]);
  db.getSecurityIncidents = () => [
    {
      project: "Example CEX",
      incident_type: "exchange_incident",
      amount_usd: 5_000_000,
      chain_platform: "CEX",
      source_url: "https://x.com/example/status/1",
      source_user: "@example",
      source_type: "official",
      source_published_at: "2026-06-13T07:55:00.000Z",
      confidence: "high",
      evidence_score: 90,
      evidence_level: "high",
      summary: "热钱包异常提款。",
      alert_level: "critical",
      anomaly_pushed_at: null,
      critical_pushed_at: "2026-06-13T08:00:00.000Z",
      updated_at: "2026-06-13T08:00:00.000Z"
    }
  ];
  db.getSecurityIncidentSummary = () => ({ total: 1, critical: 1, anomaly: 0, watch: 0, pushed: 1 });
  db.getRecentHealth = (module) =>
    module === "security_incident_monitor"
      ? [
          {
            ts: "2026-06-13T08:00:01.000Z",
            module,
            status: "ok",
            detail:
              'trigger=test incidents=1 pushed=1 skipped=2 skip_reasons={"missing_source_url":1,"low_confidence":1} duration_ms=12'
          }
        ]
      : [];
  const server = createHttpServer({
    config: {
      appPort: 0,
      enableTradingViewWebhook: false
    },
    db,
    getRuntimeStatus: () => ({}),
    getOpportunityStatus: () => ({ enabled: true, running: false }),
    getSecurityIncidentStatus: () => ({ enabled: true, running: false, last_error: "" }),
    tradingViewSignalStore: { save: () => {} }
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/security-incidents`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.monitor, { enabled: true, running: false, last_error: "" });
    assert.deepEqual(body.summary, { total: 1, critical: 1, anomaly: 0, watch: 0, pushed: 1 });
    assert.deepEqual(body.skip_reasons, { missing_source_url: 1, low_confidence: 1 });
    assert.equal(body.latest_health.status, "ok");
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].project, "Example CEX");
    assert.equal(body.items[0].alert_level, "critical");
  } finally {
    await closeServer(server);
  }
});
