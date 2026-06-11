import assert from "node:assert/strict";
import test from "node:test";

test("config defaults Level2 threshold to V1 value 60 without relying on .env", async () => {
  const original = process.env.LEVEL2_THRESHOLD;
  process.env.LEVEL2_THRESHOLD = "";

  try {
    const { config } = await import(`../src/config.js?level2-default=${Date.now()}`);
    assert.equal(config.level2Threshold, 60);
  } finally {
    if (original === undefined) {
      delete process.env.LEVEL2_THRESHOLD;
    } else {
      process.env.LEVEL2_THRESHOLD = original;
    }
  }
});

test("config exposes opportunity monitor defaults", async () => {
  const original = {
    OPPORTUNITY_MONITOR_ENABLED: process.env.OPPORTUNITY_MONITOR_ENABLED,
    OPPORTUNITY_INTERVAL_SEC: process.env.OPPORTUNITY_INTERVAL_SEC,
    OPPORTUNITY_HERMES_PROFILE: process.env.OPPORTUNITY_HERMES_PROFILE,
    OPPORTUNITY_HERMES_TIMEOUT_SEC: process.env.OPPORTUNITY_HERMES_TIMEOUT_SEC,
    OPPORTUNITY_FOCUSED_QUERIES_ENABLED: process.env.OPPORTUNITY_FOCUSED_QUERIES_ENABLED,
    OPPORTUNITY_QUERY_MATRIX_ENABLED: process.env.OPPORTUNITY_QUERY_MATRIX_ENABLED,
    OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED: process.env.OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED,
    OPPORTUNITY_MAX_QUERY_JOBS: process.env.OPPORTUNITY_MAX_QUERY_JOBS,
    OPPORTUNITY_ENRICHMENT_ENABLED: process.env.OPPORTUNITY_ENRICHMENT_ENABLED,
    OPPORTUNITY_ENRICHMENT_MAX_ITEMS: process.env.OPPORTUNITY_ENRICHMENT_MAX_ITEMS,
    OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS: process.env.OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS,
    OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS: process.env.OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS,
    OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC: process.env.OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC,
    OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED: process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED,
    OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX: process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX
  };
  delete process.env.OPPORTUNITY_MONITOR_ENABLED;
  delete process.env.OPPORTUNITY_INTERVAL_SEC;
  delete process.env.OPPORTUNITY_HERMES_PROFILE;
  delete process.env.OPPORTUNITY_HERMES_TIMEOUT_SEC;
  delete process.env.OPPORTUNITY_FOCUSED_QUERIES_ENABLED;
  delete process.env.OPPORTUNITY_QUERY_MATRIX_ENABLED;
  delete process.env.OPPORTUNITY_ADAPTIVE_QUERY_PLAN_ENABLED;
  delete process.env.OPPORTUNITY_MAX_QUERY_JOBS;
  delete process.env.OPPORTUNITY_ENRICHMENT_ENABLED;
  delete process.env.OPPORTUNITY_ENRICHMENT_MAX_ITEMS;
  delete process.env.OPPORTUNITY_EXISTING_ENRICHMENT_MAX_ITEMS;
  delete process.env.OPPORTUNITY_ENRICHMENT_RETRY_COOLDOWN_HOURS;
  delete process.env.OPPORTUNITY_OFFICIAL_CRAWL_TIMEOUT_SEC;
  delete process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_ENABLED;
  delete process.env.OPPORTUNITY_GROK_DEADLINE_FALLBACK_MAX;

  try {
    const { config } = await import(`../src/config.js?opportunity-defaults=${Date.now()}`);
    assert.equal(config.opportunityMonitorEnabled, true);
    assert.equal(config.opportunityIntervalSec, 900);
    assert.equal(config.opportunityHermesProfile, "xintel");
    assert.equal(config.opportunityHermesTimeoutSec, 240);
    assert.equal(config.opportunityFocusedQueriesEnabled, true);
    assert.equal(config.opportunityQueryMatrixEnabled, true);
    assert.equal(config.opportunityAdaptiveQueryPlanEnabled, true);
    assert.equal(config.opportunityMaxQueryJobs, 5);
    assert.equal(config.opportunityEnrichmentEnabled, true);
    assert.equal(config.opportunityEnrichmentMaxItems, 5);
    assert.equal(config.opportunityExistingEnrichmentMaxItems, 2);
    assert.equal(config.opportunityEnrichmentRetryCooldownHours, 12);
    assert.equal(config.opportunityOfficialCrawlTimeoutSec, 15);
    assert.equal(config.opportunityGrokDeadlineFallbackEnabled, true);
    assert.equal(config.opportunityGrokDeadlineFallbackMax, 2);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
