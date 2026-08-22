import assert from "node:assert/strict";
import test from "node:test";
import { EnginePipeline } from "../src/pipeline.js";

test("daily report sends to the configured daily report chat", async () => {
  const sends = [];
  const savedReports = [];
  const db = {
    hasDailyReportSent: () => false,
    getDailySummaryInput: () => ({
      stats: {
        total_events: 2,
        scored_events: 1,
        pushed_ok: 0,
        score_bins: {}
      },
      events: [],
      top_event: null
    }),
    saveDailyReport: (report) => {
      savedReports.push(report);
    },
    recordHealth: () => {}
  };
  const pipeline = new EnginePipeline({
    config: {
      dailyReportEnabled: true,
      dailyReportTimeBj: "00:00",
      dailyReportChatId: "-5535517204",
      dailyReportMaxEvents: 5,
      dailyReportMessageMaxChars: 1200,
      keywordsFile: "/tmp/ainews-test-keywords-missing.txt",
      suppressKeywordsFile: "/tmp/ainews-test-suppress-missing.txt",
      opportunityMonitorEnabled: false,
      securityIncidentMonitorEnabled: false
    },
    db,
    tradingViewSignalStore: { save: () => {} }
  });
  pipeline.notifier = {
    send: async (payload) => {
      sends.push(payload);
      return { ok: true };
    }
  };
  pipeline.analyzer = {
    generateDailySummary: async () => ({
      summary_title: "No major changes",
      regime_summary: "Neutral",
      key_risks: ["No critical risk"],
      asset_outlook: [{ asset: "BTC", action: "watch", rationale: "No signal" }],
      risk_watch: ["Security monitor remains active"],
      overall_assessment: "Keep monitoring"
    })
  };

  await pipeline.maybeSendDailyReport("test");

  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, "-5535517204");
  assert.match(sends[0].message, /每日轻量总结/);
  assert.equal(savedReports.length, 1);
  assert.equal(savedReports[0].scheduledTime, "00:00");
});

test("opportunity daily report collects once and sends launch plus Pre-TGE", async () => {
  const sends = [];
  const savedReports = [];
  let collectionRuns = 0;
  const db = {
    hasDailyReportSent: () => false,
    hasOpportunityRunSince: () => false,
    getOpportunitiesSeenSince: () => [
      {
        activity_name: "Example Launchpool",
        type: "launch",
        exchange: "Binance",
        reward: "EXAMPLE rewards",
        deadline_at: "2026-08-10T00:00:00.000Z",
        participation: "Join the official Launchpool",
        source_url: "https://x.com/binance/status/1"
      },
      {
        activity_name: "Example Pre-TGE snapshot",
        type: "pre_tge",
        venue: "Example Protocol",
        reward: "TGE allocation",
        deadline_at: "2026-08-11T00:00:00.000Z",
        participation: "Complete the official task",
        source_url: "https://x.com/example/status/2"
      }
    ],
    saveDailyReport: (report) => savedReports.push(report),
    recordHealth: () => {}
  };
  const pipeline = new EnginePipeline({
    config: {
      opportunityMonitorEnabled: true,
      opportunityDailyReportEnabled: true,
      opportunityDailyReportTimeBj: "00:00",
      opportunityDailyReportChatId: "-5535517204",
      opportunityDailyReportMaxItems: 8,
      opportunityDailyReportMaxChars: 3500,
      opportunityCollectionTypes: ["launch", "pre_tge"],
      opportunityLookbackHours: 24,
      dailyReportTimeBj: "19:04",
      keywordsFile: "/tmp/ainews-test-keywords-missing.txt",
      suppressKeywordsFile: "/tmp/ainews-test-suppress-missing.txt",
      securityIncidentMonitorEnabled: false
    },
    db,
    tradingViewSignalStore: { save: () => {} }
  });
  pipeline.opportunityMonitor.runOnce = async () => {
    collectionRuns += 1;
    return { ok: true, items: 2 };
  };
  pipeline.notifier = {
    send: async (payload) => {
      sends.push(payload);
      return { ok: true };
    }
  };

  await pipeline.maybeSendOpportunityDailyReport("test");

  assert.equal(collectionRuns, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, "-5535517204");
  assert.match(sends[0].message, /每日打新 \/ Pre-TGE 日报/);
  assert.match(sends[0].message, /打新 1 \| Pre-TGE 1/);
  assert.equal(savedReports.length, 1);
  assert.match(savedReports[0].reportDate, /^opportunity:/);
});

test("opportunity daily report retry does not repeat the daily collection", async () => {
  let collectionRuns = 0;
  let telegramAttempts = 0;
  let hasRunToday = false;
  const db = {
    hasDailyReportSent: () => false,
    hasOpportunityRunSince: () => hasRunToday,
    getOpportunitiesSeenSince: () => [],
    saveDailyReport: () => {},
    recordHealth: () => {}
  };
  const pipeline = new EnginePipeline({
    config: {
      opportunityMonitorEnabled: true,
      opportunityDailyReportEnabled: true,
      opportunityDailyReportTimeBj: "00:00",
      opportunityDailyReportChatId: "-5535517204",
      opportunityCollectionTypes: ["launch", "pre_tge"],
      opportunityLookbackHours: 24,
      dailyReportTimeBj: "19:04",
      keywordsFile: "/tmp/ainews-test-keywords-missing.txt",
      suppressKeywordsFile: "/tmp/ainews-test-suppress-missing.txt",
      securityIncidentMonitorEnabled: false
    },
    db,
    tradingViewSignalStore: { save: () => {} }
  });
  pipeline.opportunityMonitor.runOnce = async () => {
    collectionRuns += 1;
    hasRunToday = true;
    return { ok: true, items: 0 };
  };
  pipeline.notifier = {
    send: async () => {
      telegramAttempts += 1;
      return telegramAttempts === 1 ? { ok: false, reason: "test_failure" } : { ok: true };
    }
  };

  await pipeline.maybeSendOpportunityDailyReport("first_attempt");
  await pipeline.maybeSendOpportunityDailyReport("retry");

  assert.equal(collectionRuns, 1);
  assert.equal(telegramAttempts, 2);
});

test("Binance major news collection can finish before the report send time", async () => {
  let collectionRuns = 0;
  let savedResult = null;
  const db = {
    getBinanceMajorNewsRun: () => savedResult,
    startBinanceMajorNewsRun: () => {},
    finishBinanceMajorNewsRun: (_date, result) => {
      savedResult = {
        status: result.status,
        finished_at: new Date().toISOString(),
        universe_count: result.universeCount,
        findings: result.items,
        diagnostics: result.diagnostics,
        error: result.error
      };
    },
    recordHealth: () => {}
  };
  const pipeline = new EnginePipeline({
    config: {
      binanceMajorNewsEnabled: true,
      binanceMajorNewsCollectionTimeBj: "00:00",
      binanceMajorNewsDailyTimeBj: "23:59",
      dailyReportTimeBj: "23:59",
      keywordsFile: "/tmp/ainews-test-keywords-missing.txt",
      suppressKeywordsFile: "/tmp/ainews-test-suppress-missing.txt",
      opportunityMonitorEnabled: false,
      securityIncidentMonitorEnabled: false
    },
    db,
    tradingViewSignalStore: { save: () => {} }
  });
  pipeline.binanceMajorNewsMonitor.run = async () => {
    collectionRuns += 1;
    return { status: "ok", universeCount: 467, items: [], diagnostics: [], error: "" };
  };

  await pipeline.maybeCollectBinanceMajorNewsDaily("test");
  await pipeline.maybeCollectBinanceMajorNewsDaily("retry");

  assert.equal(collectionRuns, 1);
  assert.equal(savedResult.universe_count, 467);
});
