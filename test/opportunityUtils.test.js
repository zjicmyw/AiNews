import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DbClient } from "../src/db.js";
import {
  normalizeOpportunity,
  normalizeOpportunityBatch,
  normalizeOpportunityBatchWithReport,
  parseMaxApyPercent,
  parseXintelOpportunities
} from "../src/opportunityUtils.js";

const NOW = new Date("2026-06-10T08:00:00.000Z");

function baseOpportunity(overrides = {}) {
  return {
    activity_name: "Binance USDC Earn Boost",
    type: "stablecoin_earn",
    section: "cex",
    exchange: "Binance",
    venue: "Binance Earn",
    asset: "USDC",
    stablecoin: "USDC",
    apy: 12,
    expected_yield: "12% APY",
    reward: "Boosted earn rate",
    duration: "7 days",
    deadline_at: "2026-06-11T00:00:00.000Z",
    source_published_at: "2026-06-10T01:00:00.000Z",
    participation: "Subscribe USDC in Earn",
    source_user: "@binance",
    source_url: "https://x.com/binance/status/1",
    credibility: "official",
    risk_note: "Check quota and regional limits.",
    ...overrides
  };
}

function withTempDb(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ainews-opportunities-"));
  const dbPath = path.join(dir, "test.db");
  let db;
  try {
    db = new DbClient(dbPath);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error.code === "ERR_DLOPEN_FAILED") {
      t.skip(`better-sqlite3 native module is not compatible with this Node.js runtime: ${error.message.split("\n")[0]}`);
      return;
    }
    throw error;
  }
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parseXintelOpportunities parses direct JSON payloads", () => {
  const raw = JSON.stringify({ opportunities: [baseOpportunity()] });
  const parsed = parseXintelOpportunities(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.opportunities.length, 1);
  assert.equal(parsed.opportunities[0].activity_name, "Binance USDC Earn Boost");
});

test("parseXintelOpportunities parses markdown fenced JSON payloads", () => {
  const raw = "```json\n" + JSON.stringify({ opportunities: [baseOpportunity()] }) + "\n```";
  const parsed = parseXintelOpportunities(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.opportunities.length, 1);
});

test("parseXintelOpportunities ignores explanatory text after a balanced JSON payload", () => {
  const raw =
    JSON.stringify({
      opportunities: [
        baseOpportunity({
          risk_note: 'Check "quota" and regional limits.'
        })
      ]
    }) + "\n以上为结果。";
  const parsed = parseXintelOpportunities(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.opportunities.length, 1);
  assert.equal(parsed.opportunities[0].risk_note, 'Check "quota" and regional limits.');
});

test("parseXintelOpportunities rejects non JSON payloads", () => {
  const parsed = parseXintelOpportunities("No results found");

  assert.equal(parsed.ok, false);
  assert.equal(parsed.opportunities.length, 0);
});

test("normalizeOpportunity drops incomplete stablecoin opportunities", () => {
  const missingName = normalizeOpportunity({ ...baseOpportunity(), activity_name: "" }, NOW);
  const lowApy = normalizeOpportunity({ ...baseOpportunity(), apy: 7.99 }, NOW);
  const unsupportedCoin = normalizeOpportunity({ ...baseOpportunity(), stablecoin: "DAI", asset: "DAI" }, NOW);

  assert.equal(missingName, null);
  assert.equal(lowApy, null);
  assert.equal(unsupportedCoin, null);
});

test("normalizeOpportunity keeps stablecoin APY above the threshold", () => {
  const item = normalizeOpportunity(baseOpportunity({ apy: "10.5%" }), NOW);

  assert.equal(item.type, "stablecoin_earn");
  assert.equal(item.stablecoin, "USDC");
  assert.equal(item.apy, 10.5);
  assert.equal(item.status, "active");
});

test("normalizeOpportunity parses APY strings without treating duration as yield", () => {
  const item = normalizeOpportunity(
    baseOpportunity({
      apy: "7-day new users up to 100% APR / 30-day existing users up to 16% APR",
      expected_yield: "Promotional high APR"
    }),
    NOW
  );

  assert.equal(item.apy, 100);
  assert.equal(item.status, "active");
});

test("normalizeOpportunity parses APY strings without treating quota as yield", () => {
  const item = normalizeOpportunity(
    baseOpportunity({
      apy: "max 2,000 USDC quota; 10.5% APR",
      expected_yield: "Limited quota promotional APR"
    }),
    NOW
  );

  assert.equal(item.apy, 10.5);
  assert.equal(item.status, "active");
});

test("normalizeOpportunity can recover APY from yield detail fields", () => {
  const item = normalizeOpportunity(
    baseOpportunity({
      apy: null,
      apr: null,
      yield: null,
      expected_apy: null,
      expected_yield: "USDC fixed earn up to 12% APY",
      reward: "Limited quota"
    }),
    NOW
  );

  assert.equal(item.apy, 12);
  assert.equal(item.status, "active");
});

test("parseMaxApyPercent takes higher promotional APY from descriptive fields", () => {
  const apy = parseMaxApyPercent(
    baseOpportunity({
      apy: 16,
      duration: "7-day new users up to 100% APR / 30-day existing users up to 16% APR"
    })
  );

  assert.equal(apy, 100);
});

test("normalizeOpportunity preserves official deadline metadata", () => {
  const item = normalizeOpportunity(
      baseOpportunity({
        official_url: "https://www.binance.com/en/support/announcement/test",
        official_url_source: "official_page",
        deadline_source: "official_page",
      deadline_confidence: 0.9,
      deadline_text: "Campaign Period ends June 11, 2026"
    }),
    NOW
  );

  assert.equal(item.official_url, "https://www.binance.com/en/support/announcement/test");
  assert.equal(item.official_url_source, "official_page");
  assert.equal(item.deadline_source, "official_page");
  assert.equal(item.deadline_confidence, 0.9);
  assert.equal(item.deadline_text, "Campaign Period ends June 11, 2026");
});

test("normalizeOpportunity drops non-target CEX opportunities", () => {
  const item = normalizeOpportunity(
    baseOpportunity({
      exchange: "MEXC",
      venue: "MEXC Earn",
      source_user: "@mexc",
      source_url: "https://x.com/mexc/status/1"
    }),
    NOW
  );

  assert.equal(item, null);
});

test("normalizeOpportunity keeps stablecoin-funded Pre-IPO without requiring APY", () => {
  const item = normalizeOpportunity(
    baseOpportunity({
      activity_name: "SpaceX Pre-IPO USDT allocation",
      type: "pre_ipo",
      asset: "USDT",
      stablecoin: "USDT",
      apy: null,
      expected_yield: "Allocation access",
      source_url: "https://x.com/okx/status/10",
      source_user: "@OKX",
      exchange: "OKX"
    }),
    NOW
  );

  assert.equal(item.type, "pre_ipo");
  assert.equal(item.stablecoin, "USDT");
  assert.equal(item.apy, null);
  assert.equal(item.status, "active");
});

test("normalizeOpportunity keeps onchain stablecoin opportunities in the onchain category", () => {
  const item = normalizeOpportunity(
    {
      activity_name: "DEX Points Boost",
      type: "onchain",
      section: "onchain",
      venue: "Example DEX",
      asset: "USDT",
      stablecoin: "USDT",
      apy: null,
      expected_yield: "Points boost",
      duration: "48 hours",
      deadline_at: "2026-06-11T00:00:00.000Z",
      source_published_at: "2026-06-10T01:00:00.000Z",
      participation: "Trade eligible pools",
      source_user: "@exampledex",
      source_url: "https://x.com/exampledex/status/2",
      credibility: "kol"
    },
    NOW
  );

  assert.equal(item.type, "onchain");
  assert.equal(item.section, "onchain");
  assert.equal(item.status, "active");
});

test("normalizeOpportunity marks missing recency or key deadlines as unverified", () => {
  const missingPublishedAt = normalizeOpportunity(baseOpportunity({ source_published_at: null }), NOW);
  const missingDeadline = normalizeOpportunity(baseOpportunity({ deadline_at: null }), NOW);

  assert.equal(missingPublishedAt.status, "unverified");
  assert.equal(missingDeadline.status, "unverified");
});

test("normalizeOpportunity drops posts outside configured lookback", () => {
  const item = normalizeOpportunity(
    baseOpportunity({ source_published_at: "2026-06-05T00:00:00.000Z" }),
    NOW,
    { lookbackHours: 72 }
  );

  assert.equal(item, null);
});

test("DbClient filters expired opportunities out of active results", (t) => {
  withTempDb(t, (db) => {
    const active = normalizeOpportunity(baseOpportunity({ source_url: "https://x.com/binance/status/2" }), NOW);
    const expired = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Expired USDT Earn",
        stablecoin: "USDT",
        asset: "USDT",
        source_url: "https://x.com/binance/status/3",
        deadline_at: "2026-06-09T00:00:00.000Z"
      }),
      NOW
    );

    db.upsertOpportunity(active);
    db.upsertOpportunity(expired);

    const rows = db.getActiveOpportunities(96, NOW.toISOString());
    assert.deepEqual(
      rows.map((row) => row.activity_name),
      ["Binance USDC Earn Boost"]
    );
  });
});

test("DbClient display results include unverified but still filter expired rows", (t) => {
  withTempDb(t, (db) => {
    const active = normalizeOpportunity(baseOpportunity({ source_url: "https://x.com/binance/status/21" }), NOW);
    const unverified = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Gate SpaceX Pre-IPO 机会",
        type: "pre_ipo",
        exchange: "Gate",
        asset: "SPCX",
        stablecoin: "",
        apy: null,
        expected_yield: "Pre-IPO 配额",
        source_user: "@gate_io",
        source_url: "https://x.com/gate_io/status/22",
        source_published_at: "2026-06-10T01:00:00.000Z",
        deadline_at: null,
        credibility: "official"
      }),
      NOW
    );
    const expired = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Expired USDT Earn",
        stablecoin: "USDT",
        asset: "USDT",
        source_url: "https://x.com/binance/status/23",
        deadline_at: "2026-06-09T00:00:00.000Z"
      }),
      NOW
    );

    db.upsertOpportunity(active);
    db.upsertOpportunity(unverified);
    db.upsertOpportunity(expired);

    const rows = db.getDisplayOpportunities(96, NOW.toISOString());
    assert.deepEqual(
      rows.map((row) => [row.activity_name, row.status]),
      [
        ["Binance USDC Earn Boost", "active"],
        ["Gate SpaceX Pre-IPO 机会", "unverified"]
      ]
    );
  });
});

test("DbClient persists official deadline metadata", (t) => {
  withTempDb(t, (db) => {
    const item = normalizeOpportunity(
      baseOpportunity({
        source_url: "https://x.com/binance/status/30",
        official_url: "https://www.binance.com/en/support/announcement/test",
        official_url_source: "official_page",
        deadline_source: "official_page",
        deadline_confidence: 0.9,
        deadline_text: "Campaign Period ends June 11, 2026"
      }),
      NOW
    );

    db.upsertOpportunity(item);
    const [row] = db.getDisplayOpportunities(96, NOW.toISOString());

    assert.equal(row.official_url, "https://www.binance.com/en/support/announcement/test");
    assert.equal(row.official_url_source, "official_page");
    assert.equal(row.deadline_source, "official_page");
    assert.equal(row.deadline_confidence, 0.9);
    assert.equal(row.deadline_text, "Campaign Period ends June 11, 2026");
  });
});

test("DbClient excludes no-fixed-deadline rows from enrichment candidates", (t) => {
  withTempDb(t, (db) => {
    const item = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Ongoing USDC Earn",
        source_url: "https://x.com/binance/status/31",
        deadline_at: null
      }),
      NOW
    );

    db.upsertOpportunity({
      ...item,
      deadline_source: "no_fixed_deadline",
      deadline_confidence: 0.55,
      deadline_text: "无固定截止"
    });

    const rows = db.getOpportunityDeadlineEnrichmentCandidates(5);
    assert.equal(rows.length, 0);
  });
});

test("DbClient skips recently enriched deadline candidates until cooldown passes", (t) => {
  withTempDb(t, (db) => {
    const item = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Recently Checked USDC Earn",
        source_url: "https://x.com/binance/status/32",
        deadline_at: null
      }),
      NOW
    );

    db.upsertOpportunity({
      ...item,
      enriched_at: "2026-06-10T07:30:00.000Z"
    });

    const cooledDown = db.getOpportunityDeadlineEnrichmentCandidates(5, 12, "2026-06-10T20:00:00.000Z");
    const stillCooling = db.getOpportunityDeadlineEnrichmentCandidates(5, 12, "2026-06-10T08:00:00.000Z");

    assert.equal(stillCooling.length, 0);
    assert.equal(cooledDown.length, 1);
  });
});

test("DbClient prioritizes stablecoin deadline enrichment candidates", (t) => {
  withTempDb(t, (db) => {
    const shortTerm = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Recent Trading Cup",
        type: "short_term",
        source_url: "https://x.com/binance/status/40",
        deadline_at: null,
        apy: null,
        expected_yield: "Prize pool",
        reward: "Prize pool"
      }),
      NOW
    );
    const stablecoin = normalizeOpportunity(
      baseOpportunity({
        activity_name: "Older USDC Earn",
        type: "stablecoin_earn",
        source_url: "https://x.com/binance/status/41",
        deadline_at: null,
        last_seen_at: "2026-06-09T00:00:00.000Z"
      }),
      NOW
    );

    db.upsertOpportunity(shortTerm);
    db.upsertOpportunity(stablecoin);

    const rows = db.getOpportunityDeadlineEnrichmentCandidates(5, 0, NOW.toISOString());
    assert.equal(rows[0].activity_name, "Older USDC Earn");
  });
});

test("DbClient upserts duplicate opportunities by dedup key", (t) => {
  withTempDb(t, (db) => {
    const first = normalizeOpportunity(baseOpportunity({ apy: 10 }), NOW);
    const second = normalizeOpportunity(baseOpportunity({ apy: 15, reward: "Updated boost" }), NOW);

    db.upsertOpportunity(first);
    db.upsertOpportunity(second);

    const count = db.db.prepare("SELECT COUNT(*) AS cnt FROM opportunities").get();
    const row = db.db.prepare("SELECT apy, reward FROM opportunities WHERE dedup_key = ?").get(first.dedup_key);

    assert.equal(Number(count.cnt), 1);
    assert.equal(Number(row.apy), 15);
    assert.equal(row.reward, "Updated boost");
  });
});

test("DbClient persists opportunity run job stats", (t) => {
  withTempDb(t, (db) => {
    const runId = db.startOpportunityRun({
      startedAt: "2026-06-10T08:00:00.000Z",
      prompt: "test prompt"
    });

    db.finishOpportunityRun(runId, {
      status: "partial",
      durationMs: 240000,
      rawResponse: "raw",
      error: "main:hermes_timeout_after_240000ms",
      itemCount: 3,
      jobStats: [
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

    const latest = db.getLatestOpportunityRun();
    const rows = db.getOpportunityRuns(5);

    assert.equal(latest.status, "partial");
    assert.equal(latest.job_stats[0].name, "main");
    assert.equal(latest.job_stats[0].status, "error");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_stats[0].duration_ms, 240000);
  });
});

test("normalizeOpportunityBatch deduplicates repeated source links", () => {
  const rows = normalizeOpportunityBatch([baseOpportunity(), baseOpportunity({ apy: 14 })], NOW);

  assert.equal(rows.length, 1);
});

test("normalizeOpportunityBatchWithReport explains filtered candidates", () => {
  const { items, report } = normalizeOpportunityBatchWithReport(
    [
      baseOpportunity({ __xintel_job: "cex_stablecoin_earn" }),
      baseOpportunity({ __xintel_job: "cex_stablecoin_earn", source_url: "https://x.com/binance/status/1" }),
      baseOpportunity({ __xintel_job: "cex_stablecoin_earn", apy: 7.5, source_url: "https://x.com/binance/status/low" }),
      baseOpportunity({ __xintel_job: "cex_launch", exchange: "MEXC", source_url: "https://x.com/mexc/status/1" }),
      baseOpportunity({ __xintel_job: "cex_launch", source_published_at: "2026-06-05T00:00:00.000Z", source_url: "https://x.com/binance/status/old" })
    ],
    NOW,
    { lookbackHours: 72 }
  );

  assert.equal(items.length, 1);
  assert.equal(report.input_count, 5);
  assert.equal(report.normalized_count, 1);
  assert.equal(report.dropped_count, 4);
  assert.equal(report.duplicate_count, 1);
  assert.equal(report.drop_reasons.find((reason) => reason.reason === "duplicate").count, 1);
  assert.equal(report.drop_reasons.find((reason) => reason.reason === "apy_below_threshold").label, "APY 低于 8%");
  assert.equal(report.drop_reasons.find((reason) => reason.reason === "unsupported_cex").count, 1);
  assert.equal(report.drop_reasons.find((reason) => reason.reason === "outside_lookback").count, 1);
  assert.equal(report.by_job.cex_stablecoin_earn.dropped_count, 2);
  assert.equal(report.by_job.cex_launch.drop_reasons.length, 2);
});

test("normalizeOpportunityBatchWithReport keeps promotional APY strings above threshold", () => {
  const { items, report } = normalizeOpportunityBatchWithReport(
    [
      baseOpportunity({
        __xintel_job: "cex_stablecoin_earn",
        apy: "7-day new users up to 100% APR / 30-day existing up to 16% APR",
        source_url: "https://x.com/binance/status/promo"
      })
    ],
    NOW
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].apy, 100);
  assert.equal(report.dropped_count, 0);
});
